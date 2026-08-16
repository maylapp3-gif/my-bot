import TelegramBot from "node-telegram-bot-api";
import { addRegular, removeRegular, listRegulars } from "../db.js";
import { isAdmin } from "./admin.js";
import { escapeMarkdown } from "../escape.js";
import { logger } from "../../lib/logger.js";

// /add_regular <chatId> [free-form notes]
// Flags a customer for regular pricing — free delivery up to 15km (vs 12km
// default) and $10 off every cart. Idempotent: re-running with the same
// chatId refreshes notes/addedBy without erroring.
export async function handleAddRegular(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  argsRaw: string,
): Promise<void> {
  const adminId = msg.chat.id.toString();
  if (!isAdmin(adminId)) return;
  const args = argsRaw.trim();
  if (!args) {
    await bot.sendMessage(
      adminId,
      "Usage: `/add_regular <chatId> [notes]`\n\nThe customer's chat ID is the long number you see on their order alerts.",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const [targetChatId, ...rest] = args.split(/\s+/);
  if (!/^-?\d+$/.test(targetChatId)) {
    await bot.sendMessage(adminId, "Chat ID must be a number. Try `/add_regular 123456789 OG mate`.", {
      parse_mode: "Markdown",
    });
    return;
  }
  const notes = rest.length > 0 ? rest.join(" ") : null;
  try {
    const { created } = await addRegular(targetChatId, notes, adminId);
    await bot.sendMessage(
      adminId,
      created
        ? `✅ Added \`${targetChatId}\` as a *regular*.${notes ? `\n\n_Notes:_ ${escapeMarkdown(notes)}` : ""}\n\n_They now get free delivery up to 15km + $10 off every cart automatically._`
        : `🔄 Already a regular — refreshed notes for \`${targetChatId}\`.${notes ? `\n\n_Notes:_ ${escapeMarkdown(notes)}` : ""}`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err, targetChatId }, "addRegular failed");
    await bot.sendMessage(adminId, "Couldn't save that. Check the logs.");
  }
}

// /remove_regular <chatId>
export async function handleRemoveRegular(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  argsRaw: string,
): Promise<void> {
  const adminId = msg.chat.id.toString();
  if (!isAdmin(adminId)) return;
  const targetChatId = argsRaw.trim();
  if (!/^-?\d+$/.test(targetChatId)) {
    await bot.sendMessage(adminId, "Usage: `/remove_regular <chatId>`", { parse_mode: "Markdown" });
    return;
  }
  try {
    const removed = await removeRegular(targetChatId);
    await bot.sendMessage(
      adminId,
      removed
        ? `🗑 Removed \`${targetChatId}\` from regulars. Future carts pay standard pricing.`
        : `_No regular found for \`${targetChatId}\`. Nothing to remove._`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err, targetChatId }, "removeRegular failed");
    await bot.sendMessage(adminId, "Couldn't remove that. Check the logs.");
  }
}

// /list_regulars — admin-only roll-call.
export async function handleListRegulars(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const adminId = msg.chat.id.toString();
  if (!isAdmin(adminId)) return;
  try {
    const rows = await listRegulars();
    if (rows.length === 0) {
      await bot.sendMessage(adminId, "_No regulars yet. Use_ `/add_regular <chatId> [notes]` _to add one._", {
        parse_mode: "Markdown",
      });
      return;
    }
    // Telegram caps messages at 4096 chars. Cap to 50 entries per message
    // and chunk the rest so a long list never gets truncated/rejected.
    const lines = rows.map((r) => {
      const notes = r.notes ? ` — _${escapeMarkdown(r.notes)}_` : "";
      const added = r.addedAt.toISOString().slice(0, 10);
      return `• \`${r.chatId}\`${notes}  (added ${added})`;
    });
    const PAGE = 50;
    const totalPages = Math.ceil(lines.length / PAGE);
    for (let p = 0; p < totalPages; p++) {
      const slice = lines.slice(p * PAGE, (p + 1) * PAGE);
      const header =
        totalPages === 1
          ? `✨ *Regulars (${rows.length})*`
          : `✨ *Regulars (${rows.length})* — page ${p + 1}/${totalPages}`;
      const footer =
        p === totalPages - 1
          ? `\n\n_Each gets free delivery up to 15km + $10 off every cart._`
          : "";
      await bot.sendMessage(adminId, `${header}\n\n${slice.join("\n")}${footer}`, {
        parse_mode: "Markdown",
      });
    }
  } catch (err) {
    logger.error({ err }, "listRegulars failed");
    await bot.sendMessage(adminId, "Couldn't list regulars. Check the logs.");
  }
}
