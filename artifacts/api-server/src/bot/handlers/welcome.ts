import TelegramBot from "node-telegram-bot-api";
import {
  getLastOrderForChat,
  grantWelcomeCreditIfFirstTime,
  formatPriceCents,
} from "../db.js";
import { logger } from "../../lib/logger.js";
import { escapeMarkdown } from "../escape.js";
import { customerReplyKeyboard } from "./customerMenu.js";
import { reorderKeyboard } from "./reorder.js";
import { BRAND_NAME } from "../brand.js";
import { todayHoursBullets } from "../hours.js";

// The real welcome: welcome text + persistent reply keyboard, welcome credit,
// and the returning-customer reorder offer. Lives in its own module so both
// /start (start.ts) and the Verify button callback (verify.ts) can call it
// without creating an import cycle between those two handlers.
export async function sendCustomerWelcome(
  bot: TelegramBot,
  chatId: string,
  firstNameRaw: string | undefined,
): Promise<TelegramBot.Message> {
  const firstName = escapeMarkdown(firstNameRaw ?? "there");

  const welcomeText =
    `*${BRAND_NAME}*\n\n` +
    `What's good, ${firstName}.\n\n` +
    `🕑 *Today*\n` +
    `${todayHoursBullets()}\n\n` +
    `Cash · in person · 18+\n\n` +
    `Full week's schedule is under *🕑 Today's Hours* below.\n` +
    `Tap a button to get moving, or just write — we read everything.\n\n` +
    `🔒 _chats wipe every 24h._`;

  const sent = await bot.sendMessage(chatId, welcomeText, {
    parse_mode: "Markdown",
    reply_markup: customerReplyKeyboard(),
  });

  // First-touch welcome credit. Idempotent at the DB layer (only fires when
  // the subscriber has $0 credit AND no order history), so re-hitting this
  // can't re-trigger. The DM is best-effort — we don't want a Telegram
  // hiccup to forfeit the grant.
  try {
    const granted = await grantWelcomeCreditIfFirstTime(chatId);
    if (granted > 0) {
      await bot
        .sendMessage(
          chatId,
          `🎁 *Welcome gift — ${formatPriceCents(granted)} store credit added.*\n\n_Auto-applies to a future order. Tap *Menu* to start._`,
          { parse_mode: "Markdown" },
        )
        .catch((err: unknown) => {
          logger.error({ err, chatId }, "welcome credit DM failed (credit still granted)");
        });
    }
  } catch (err) {
    logger.error({ err }, "welcome credit grant failed");
  }

  // Returning customer? Offer a one-tap reorder of their last order.
  // Sent as a follow-up message because Telegram only accepts ONE keyboard
  // (reply or inline) per message and the welcome above already uses the
  // persistent reply keyboard.
  try {
    const last = await getLastOrderForChat(chatId);
    if (last) {
      await bot.sendMessage(chatId, "_Want a repeat? Tap below to clone your last order._", {
        parse_mode: "Markdown",
        reply_markup: reorderKeyboard(),
      });
    }
  } catch (err) {
    logger.error({ err }, "reorder probe failed");
  }

  return sent;
}
