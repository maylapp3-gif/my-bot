// Customer-facing /order, /orders helpers.
//
// HISTORY: this used to host a 4-step text wizard (items → area → time → notes).
// The bot is now cart-driven: customers add sizes from /menu, then tap
// "Send Order" in the cart, which kicks off a 3-step checkout (area → time →
// notes) handled in `cart.ts`.
//
// `handleOrder` is the entry point for the `/order` command and the legacy
// "Place Order" reply key — it routes the customer to the cart so they can
// either build one (if empty) or hit Send Order (if populated).

import TelegramBot from "node-telegram-bot-api";
import { getOrders, getOrderItems, formatPriceCents } from "./../db.js";
import { logger } from "../../lib/logger.js";
import { escapeMarkdown } from "../escape.js";
import { openCart } from "./cart.js";

export async function handleOrder(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  await openCart(bot, msg.chat.id.toString());
}

export async function handleMyOrders(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  try {
    const all = await getOrders();
    const mine = all.filter((o) => o.chatId === chatId);

    if (mine.length === 0) {
      return bot.sendMessage(
        chatId,
        `*Your Orders*\n\n_No orders yet. Tap Menu to start a cart, then Send Order._`,
        { parse_mode: "Markdown" },
      );
    }

    const STATUS: Record<string, string> = {
      pending: "○  Awaiting confirmation",
      confirmed: "◐  Confirmed",
      in_progress: "◑  On the way",
      completed: "●  Complete",
      cancelled: "✕  Cancelled",
    };

    let text = `*Your Orders*\n\n`;
    for (const o of mine.slice(-5)) {
      text += `*Order #${o.id}*   _${STATUS[o.status] ?? o.status}_\n`;
      // Prefer structured items if we have them (cart-era orders), else fall
      // back to the legacy `items` text blob (pre-cart orders).
      const items = await getOrderItems(o.id).catch(() => []);
      if (items.length > 0) {
        for (const it of items) {
          text += `  • ${it.quantity}× ${escapeMarkdown(it.variantLabel)} ${escapeMarkdown(it.productName)}  —  ${formatPriceCents(it.lineTotalCents)}\n`;
        }
      } else if (o.items) {
        text += `  ${escapeMarkdown(o.items)}\n`;
      }
      if (o.totalCents != null) {
        text += `  *Total* ${formatPriceCents(o.totalCents)}`;
        if (o.promoCode) text += `  (promo \`${escapeMarkdown(o.promoCode)}\`)`;
        text += `\n`;
      }
      if (o.deliveryArea) text += `  _${escapeMarkdown(o.deliveryArea)}_\n`;
      if (o.preferredTime) text += `  _${escapeMarkdown(o.preferredTime)}_\n`;
      text += `  _${new Date(o.createdAt).toLocaleDateString()}_\n\n`;
    }

    return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "handleMyOrders error");
    return bot.sendMessage(chatId, "_Couldn't load your orders just now. Give it a sec and try again._", {
      parse_mode: "Markdown",
    });
  }
}
