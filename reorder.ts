import TelegramBot from "node-telegram-bot-api";
import {
  getLastOrderForChat,
  getOrderItems,
  findActiveVariantByLabels,
  clearCart,
  addToCart,
  getCart,
} from "../db.js";
import { openCart } from "./cart.js";
import { logger } from "../../lib/logger.js";

const CB_PREFIX = "re:";

export function isReorderCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

// Inline button shown on /start when the customer has prior orders.
export function reorderKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "🔁 Same as last time", callback_data: "re:last" }]],
  };
}

export async function handleReorderCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const chatId = query.from.id.toString();
  if (query.data !== "re:last") {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Strip the button immediately so a rapid double-tap can't race the
  // clearCart→addToCart window and end up with an empty cart.
  const msgChatIdEarly = query.message?.chat.id;
  const messageIdEarly = query.message?.message_id;
  if (msgChatIdEarly && messageIdEarly) {
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: msgChatIdEarly, message_id: messageIdEarly },
      );
    } catch {
      // best effort
    }
  }

  try {
    const last = await getLastOrderForChat(chatId);
    if (!last) {
      await bot.answerCallbackQuery(query.id, {
        text: "No past order to clone — tap Menu to start one.",
        show_alert: true,
      });
      return;
    }

    const items = await getOrderItems(last.id);
    if (items.length === 0) {
      await bot.answerCallbackQuery(query.id, {
        text: "Last order has no items to clone.",
        show_alert: true,
      });
      return;
    }

    let added = 0;
    let skipped = 0;
    // Clear current cart first — "same as last time" replaces, not appends.
    // Probe whether they had anything in the cart so the toast can warn them
    // we just nuked it (otherwise the silent wipe is a surprise).
    const priorCart = await getCart(chatId).catch(() => []);
    const hadPriorItems = priorCart.length > 0;
    await clearCart(chatId);
    for (const it of items) {
      const v = await findActiveVariantByLabels(it.productName, it.variantLabel);
      if (!v) {
        skipped++;
        continue;
      }
      try {
        await addToCart(chatId, v.id, it.quantity);
        added++;
      } catch (err) {
        skipped++;
        logger.warn({ err, productName: it.productName }, "reorder addToCart failed");
      }
    }

    if (added === 0) {
      await bot.answerCallbackQuery(query.id, {
        text: "Nothing from your last order is available right now.",
        show_alert: true,
      });
      return;
    }

    const skippedNote = skipped > 0 ? ` (${skipped} item${skipped === 1 ? "" : "s"} no longer available)` : "";
    const replacedNote = hadPriorItems ? " · replaced your existing cart" : "";
    await bot.answerCallbackQuery(query.id, {
      text: `✅ Cart restored${skippedNote}${replacedNote}`,
      show_alert: hadPriorItems,
    });

    await openCart(bot, chatId);
  } catch (err) {
    logger.error({ err, chatId }, "handleReorderCallback error");
    await bot.answerCallbackQuery(query.id, {
      text: "Couldn't restore cart — give it a sec and try again.",
      show_alert: true,
    });
  }
}
