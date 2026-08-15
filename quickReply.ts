import TelegramBot from "node-telegram-bot-api";
import { getActiveClaims, isModerator, getClaimer, cancelFallback, getModeratorIds } from "../moderation.js";
import { trackMessage } from "../db.js";
import { logger } from "../../lib/logger.js";
import { escapeMarkdown } from "../escape.js";

const CB_PREFIX = "qr:";

export function isQrCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

// Preset reply templates. Keep them short, plain, and on-tone (no slang
// the operator already vetoed; warm but not over-friendly).
const TEMPLATES: Record<string, { label: string; text: string }> = {
  omw: { label: "🛵 On my way", text: "On my way." },
  "5min": { label: "⏱ 5 min out", text: "5 minutes out." },
  "10late": { label: "🕓 ~10 late", text: "Running about 10 minutes late, sorry." },
  arr: { label: "📍 Arrived", text: "I'm here." },
};

export function templateKeyboard(customerChatId: string): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  const keys = Object.keys(TEMPLATES);
  for (let i = 0; i < keys.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [];
    for (const k of keys.slice(i, i + 2)) {
      row.push({ text: TEMPLATES[k].label, callback_data: `qr:s:${customerChatId}:${k}` });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

export async function handleQr(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return;

  const mine = getActiveClaims().filter((c) => c.moderatorId === modId);
  if (mine.length === 0) {
    await bot.sendMessage(
      modId,
      "_No claimed chats. Use /take <chatId> first, then /qr to fire a quick reply._",
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (mine.length === 1) {
    const cid = mine[0].customerChatId;
    await bot.sendMessage(modId, `*Quick reply* → \`${cid}\``, {
      parse_mode: "Markdown",
      reply_markup: templateKeyboard(cid),
    });
    return;
  }

  // Multiple claimed → let the mod pick which chat first.
  const rows: TelegramBot.InlineKeyboardButton[][] = mine.map((c) => [
    { text: `→ ${c.customerChatId}`, callback_data: `qr:p:${c.customerChatId}` },
  ]);
  await bot.sendMessage(modId, `*Quick reply* — pick a chat:`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

export async function handleQrCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const modId = query.from.id.toString();
  if (!isModerator(modId)) {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  const data = query.data ?? "";
  const parts = data.split(":");
  // qr:p:<chatId>           — picker → show templates
  // qr:s:<chatId>:<key>     — send template

  if (parts[1] === "p" && parts[2]) {
    const cid = parts[2];
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId) {
      try {
        await bot.editMessageText(`*Quick reply* → \`${cid}\``, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: templateKeyboard(cid),
        });
      } catch (err) {
        logger.warn({ err }, "qr picker edit failed");
      }
    }
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (parts[1] === "s" && parts[2] && parts[3]) {
    const customerChatId = parts[2];
    const tpl = TEMPLATES[parts[3]];
    if (!tpl) {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const claimer = getClaimer(customerChatId);
    if (claimer && claimer !== modId) {
      await bot.answerCallbackQuery(query.id, {
        text: `Held by ${claimer} — coordinate first.`,
        show_alert: true,
      });
      return;
    }

    let sent: TelegramBot.Message;
    try {
      sent = await bot.sendMessage(customerChatId, tpl.text);
    } catch (err) {
      logger.error({ err, customerChatId }, "qr send failed");
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Couldn't deliver. They may have blocked the bot.",
        show_alert: true,
      });
      return;
    }
    try {
      await trackMessage(customerChatId, sent.message_id);
    } catch (err) {
      logger.error({ err }, "qr trackMessage failed");
    }
    cancelFallback(customerChatId);

    await bot.answerCallbackQuery(query.id, { text: `Sent: ${tpl.label.replace(/^[^\s]+\s/, "")}` });

    // Edit the picker message to show what was sent.
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    if (chatId && messageId) {
      try {
        await bot.editMessageText(
          `📤 Sent to \`${customerChatId}\`:\n\n> ${escapeMarkdown(tpl.text)}`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] },
          },
        );
      } catch (err) {
        logger.warn({ err }, "qr post-send edit failed");
      }
    }

    // Mirror to other mods.
    const peerMsg =
      `📤 *Quick-reply sent to* \`${customerChatId}\` *by* \`${modId}\`\n\n` +
      `> ${escapeMarkdown(tpl.text)}`;
    for (const id of getModeratorIds()) {
      if (id === modId) continue;
      try {
        await bot.sendMessage(id, peerMsg, { parse_mode: "Markdown" });
      } catch (err) {
        logger.error({ err, peer: id }, "qr peer mirror failed");
      }
    }
    return;
  }

  await bot.answerCallbackQuery(query.id);
}
