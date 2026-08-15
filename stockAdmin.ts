import TelegramBot from "node-telegram-bot-api";
import { logger } from "../../lib/logger.js";
import { setVariantStock, getVariant, getProduct } from "../db.js";
import { isAdmin } from "./admin.js";
import { notifyTeamStockChange } from "../stockCheck.js";

// /stock <variantId> <in_stock|low|sold_out>
// Variant IDs are visible from /stock_report or the product manager
// keyboard. Idempotent — safe to re-run. Always fans a team DM via
// notifyTeamStockChange so no path is silent.
export async function handleStock(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  variantIdStr: string,
  state: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const variantId = parseInt(variantIdStr, 10);
  if (!Number.isFinite(variantId)) {
    await bot.sendMessage(chatId, "Variant ID must be a number.");
    return;
  }
  const norm = state.toLowerCase();
  if (norm !== "in_stock" && norm !== "low" && norm !== "sold_out") {
    await bot.sendMessage(
      chatId,
      "State must be one of: `in_stock`, `low`, `sold_out`.",
      { parse_mode: "Markdown" },
    );
    return;
  }
  try {
    const updated = await setVariantStock(variantId, norm);
    if (!updated) {
      await bot.sendMessage(chatId, `No variant with ID *${variantId}*.`, { parse_mode: "Markdown" });
      return;
    }
    await bot.sendMessage(
      chatId,
      `✓ Variant *${variantId}* set to *${norm}*.`,
      { parse_mode: "Markdown" },
    );
    // Push to the whole team via the shared notifier — same channel the
    // stock-check button taps use. The caller is skipped (they already
    // saw the ✓ confirmation above). Skips lookups silently on failure
    // so a bad join doesn't block the primary state change.
    try {
      const variant = await getVariant(variantId);
      const product = variant ? await getProduct(variant.productId) : undefined;
      if (variant && product) {
        const actor = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name ?? chatId;
        await notifyTeamStockChange(bot, {
          productName: product.name,
          productEmoji: product.emoji ?? "🌿",
          variantLabel: variant.label,
          variantId: variant.id,
          targetState: norm,
          actor,
          actorChatId: chatId,
          source: "stock_cli",
        });
      }
    } catch (err) {
      logger.warn({ err, variantId }, "/stock: team notify failed (non-fatal)");
    }
  } catch (err) {
    logger.error({ err, variantId }, "/stock failed");
    await bot.sendMessage(chatId, "Couldn't update stock — check logs.");
  }
}
