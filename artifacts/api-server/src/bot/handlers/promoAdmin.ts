import TelegramBot from "node-telegram-bot-api";
import {
  listPromoCodes,
  createPromoCode,
  deletePromoCode,
  findPromoByCode,
  formatPriceCents,
} from "../db.js";
import { isAdmin } from "./admin.js";
import { escapeMarkdown } from "../escape.js";
import { logger } from "../../lib/logger.js";

// /promos — list every promo code with usage + status.
export async function handlePromos(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  try {
    const all = await listPromoCodes();
    if (all.length === 0) {
      await bot.sendMessage(
        chatId,
        `*Promo codes*\n\n_None yet._\n\nCreate one with:\n\`/add_promo CODE percent 10\`  (10% off)\n\`/add_promo CODE fixed 1500\`  ($15.00 off — value is in cents)`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    const lines = all.map((p) => {
      const value =
        p.kind === "percent" ? `${p.value}% off` : `${formatPriceCents(p.value)} off`;
      const status = p.active ? "🟢" : "⚪";
      const used =
        p.maxUses != null ? ` · used ${p.usedCount}/${p.maxUses}` : ` · used ${p.usedCount}`;
      const exp = p.expiresAt ? ` · exp ${new Date(p.expiresAt).toLocaleDateString()}` : "";
      return `${status} \`${escapeMarkdown(p.code)}\`  —  ${value}${used}${exp}`;
    });
    await bot.sendMessage(
      chatId,
      `*Promo codes* (${all.length})\n\n${lines.join("\n")}\n\nCommands:\n\`/add_promo CODE percent 10\`\n\`/add_promo CODE fixed 1500\`  (cents)\n\`/del_promo CODE\``,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "/promos error");
    await bot.sendMessage(chatId, "Couldn't load promos right now.");
  }
}

// /add_promo CODE percent 10
// /add_promo CODE fixed 1500
export async function handleAddPromo(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  args: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const parts = args.trim().split(/\s+/);
  if (parts.length < 3) {
    await bot.sendMessage(
      chatId,
      `Usage:\n\`/add_promo CODE percent 10\`  (10% off)\n\`/add_promo CODE fixed 1500\`  ($15.00 off — value is in cents)`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  const [rawCode, kindRaw, valueRaw] = parts;
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!code || code.length < 2) {
    await bot.sendMessage(chatId, "Code must be at least 2 letters/digits (A-Z, 0-9, _ or -).");
    return;
  }
  const kind = kindRaw.toLowerCase();
  if (kind !== "percent" && kind !== "fixed") {
    await bot.sendMessage(chatId, "Kind must be `percent` or `fixed`.", { parse_mode: "Markdown" });
    return;
  }
  const value = parseInt(valueRaw, 10);
  if (Number.isNaN(value) || value <= 0) {
    await bot.sendMessage(chatId, "Value must be a positive integer.");
    return;
  }
  if (kind === "percent" && (value < 1 || value > 99)) {
    await bot.sendMessage(chatId, "Percent value must be 1–99.");
    return;
  }
  const existing = await findPromoByCode(code);
  if (existing) {
    await bot.sendMessage(
      chatId,
      `Promo \`${escapeMarkdown(code)}\` already exists. Delete it first with \`/del_promo ${escapeMarkdown(code)}\`.`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  try {
    const created = await createPromoCode({
      code,
      kind,
      value,
      active: true,
      expiresAt: null,
      maxUses: null,
    });
    const valueLabel =
      created.kind === "percent" ? `${created.value}% off` : `${formatPriceCents(created.value)} off`;
    await bot.sendMessage(
      chatId,
      `✅ Created \`${escapeMarkdown(created.code)}\` — ${valueLabel}.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "/add_promo error");
    await bot.sendMessage(chatId, "Couldn't create that promo. Try again.");
  }
}

// /del_promo CODE
export async function handleDelPromo(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  rawCode: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const code = rawCode.trim().toUpperCase();
  const existing = await findPromoByCode(code);
  if (!existing) {
    await bot.sendMessage(chatId, `No promo \`${escapeMarkdown(code)}\` to delete.`, {
      parse_mode: "Markdown",
    });
    return;
  }
  try {
    await deletePromoCode(code);
    await bot.sendMessage(chatId, `🗑 Deleted \`${escapeMarkdown(code)}\`.`, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "/del_promo error");
    await bot.sendMessage(chatId, "Couldn't delete that promo. Try again.");
  }
}
