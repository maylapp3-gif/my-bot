import TelegramBot from "node-telegram-bot-api";
import { logger } from "../../lib/logger.js";
import {
  createBundle,
  addBundleItem,
  deleteBundle,
  listBundlesActive,
  getBundleItems,
  applyCartBundle,
  clearCartBundle,
  formatPriceCents,
  trackMessage,
} from "../db.js";
import { isAdmin } from "./admin.js";
import { escapeMarkdown } from "../escape.js";

const CB_PREFIX = "bn:";

export function isBundleCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

// ---- Admin commands ------------------------------------------------------
// /add_bundle <label> | <priceCents>
export async function handleAddBundle(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  raw: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const parts = raw.split("|").map((s) => s.trim());
  if (parts.length < 2) {
    await bot.sendMessage(
      chatId,
      "Usage: `/add_bundle <label> | <priceCents>`\nExample: `/add_bundle Friday Special | 4000`",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const label = parts[0];
  const priceCents = parseInt(parts[1], 10);
  if (!label || !Number.isFinite(priceCents) || priceCents <= 0) {
    await bot.sendMessage(chatId, "Bad input. Need a label and a positive price in cents.");
    return;
  }
  try {
    const created = await createBundle({ label, priceCents, description: "", position: 0, active: true });
    await bot.sendMessage(
      chatId,
      `🎁 Bundle created (ID *${created.id}*).\n\nNow add items:\n\`/bundle_item ${created.id} | <productName> | <variantLabel> | <qty>\``,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "/add_bundle failed");
    await bot.sendMessage(chatId, "Couldn't create bundle — check logs.");
  }
}

// /bundle_item <bundleId> | <productName> | <variantLabel> | <qty>
export async function handleBundleItem(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  raw: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const parts = raw.split("|").map((s) => s.trim());
  if (parts.length < 4) {
    await bot.sendMessage(
      chatId,
      "Usage: `/bundle_item <bundleId> | <productName> | <variantLabel> | <qty>`",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const bundleId = parseInt(parts[0], 10);
  const qty = parseInt(parts[3], 10);
  if (!Number.isFinite(bundleId) || !Number.isFinite(qty) || qty < 1 || qty > 99) {
    await bot.sendMessage(chatId, "Bad input. Need numeric bundleId and qty 1-99.");
    return;
  }
  try {
    await addBundleItem({ bundleId, productName: parts[1], variantLabel: parts[2], quantity: qty });
    await bot.sendMessage(
      chatId,
      `✓ Added ${qty}× ${parts[2]} ${parts[1]} to bundle *${bundleId}*.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "/bundle_item failed");
    await bot.sendMessage(chatId, "Couldn't add bundle item — check the bundle ID.");
  }
}

// /list_bundles
export async function handleListBundles(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const bundles = await listBundlesActive();
  if (bundles.length === 0) {
    await bot.sendMessage(
      chatId,
      "_No active bundles. Use_ `/add_bundle <label> | <priceCents>` _to add one._",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const lines: string[] = ["*Bundles*\n"];
  for (const b of bundles) {
    const items = await getBundleItems(b.id);
    const itemDesc =
      items.length === 0
        ? "_(no items yet — add with /bundle_item)_"
        : items.map((it) => `${it.quantity}× ${it.variantLabel} ${it.productName}`).join(", ");
    lines.push(
      `*${b.id}* — ${escapeMarkdown(b.label)}  ·  ${formatPriceCents(b.priceCents)}\n  ${itemDesc}`,
    );
  }
  await bot.sendMessage(chatId, lines.join("\n\n"), { parse_mode: "Markdown" });
}

// /del_bundle <id>
export async function handleDelBundle(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  idStr: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id)) return;
  await deleteBundle(id);
  await bot.sendMessage(chatId, `✓ Bundle *${id}* removed.`, { parse_mode: "Markdown" });
}

// ---- Customer-facing helpers --------------------------------------------
// Surface the bundle "shelf" at the top of the customer menu.
export async function renderBundlesSection(bot: TelegramBot, chatId: string): Promise<void> {
  const bundles = await listBundlesActive();
  if (bundles.length === 0) return;
  for (const b of bundles) {
    const items = await getBundleItems(b.id);
    if (items.length === 0) continue;
    const itemList = items
      .map(
        (it) =>
          `  • ${it.quantity}× ${escapeMarkdown(it.variantLabel)} ${escapeMarkdown(it.productName)}`,
      )
      .join("\n");
    const body =
      `🎁 *${escapeMarkdown(b.label)}*  ·  *${formatPriceCents(b.priceCents)}*\n` +
      (b.description ? `_${escapeMarkdown(b.description)}_\n\n` : "\n") +
      `${itemList}`;
    try {
      await bot.sendMessage(chatId, body, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `🎁 Add bundle  ·  ${formatPriceCents(b.priceCents)}`,
                callback_data: `${CB_PREFIX}add:${b.id}`,
              },
            ],
          ],
        },
      });
    } catch (err) {
      logger.warn({ err, bundleId: b.id }, "renderBundlesSection: send failed");
    }
  }
}

// Callback router: bn:add:<id> | bn:rm
export async function handleBundleCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id.toString();
  if (!chatId) {
    try { await bot.answerCallbackQuery(query.id); } catch {}
    return;
  }
  const parts = data.slice(CB_PREFIX.length).split(":");
  const op = parts[0];
  try {
    if (op === "rm") {
      await clearCartBundle(chatId);
      await bot.answerCallbackQuery(query.id, { text: "Bundle removed." });
      const { openCart } = await import("./cart.js");
      await openCart(bot, chatId);
      return;
    }
    if (op === "add") {
      const id = parseInt(parts[1] ?? "", 10);
      if (!Number.isFinite(id)) {
        await bot.answerCallbackQuery(query.id);
        return;
      }
      const result = await applyCartBundle(chatId, id);
      if (!result.ok) {
        await bot.answerCallbackQuery(query.id, {
          text: result.reason ?? "Couldn't add bundle.",
          show_alert: true,
        });
        return;
      }
      await bot.answerCallbackQuery(query.id, {
        text: `🎁 Bundle added · save ${formatPriceCents(result.discountCents)}`,
      });
      const { openCart } = await import("./cart.js");
      await openCart(bot, chatId);
      return;
    }
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    logger.error({ err, data }, "bundle callback error");
    try {
      await bot.answerCallbackQuery(query.id, {
        text: "Something glitched — give it a sec.",
        show_alert: true,
      });
    } catch {}
  }
}
