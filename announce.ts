import TelegramBot from "node-telegram-bot-api";
import { getModeratorIds } from "../moderation.js";
import { isAdmin } from "./admin.js";
import { logger } from "../../lib/logger.js";

/**
 * Broadcast a plain-text announcement to every configured moderator (mods + admins).
 * Used for changelogs, schedule changes, policy updates — anything mods should
 * see in their own DM with the bot. Plain text only; no Markdown parsing so
 * stray characters in operator-typed text never break delivery.
 */
export async function broadcastToMods(bot: TelegramBot, body: string): Promise<{ sent: number; failed: number }> {
  // Plain text only. Operator-typed body could contain stray *, _, ` etc;
  // running it through Markdown would fail delivery on any unbalanced char.
  const text = `📣 Update for the team\n\n${body}`;
  let sent = 0;
  let failed = 0;
  for (const id of getModeratorIds()) {
    try {
      await bot.sendMessage(id, text);
      sent++;
    } catch (err) {
      failed++;
      logger.error({ err, modId: id }, "Failed to deliver mod announcement");
    }
  }
  return { sent, failed };
}

/**
 * /announce <text> — admin-only. Broadcasts the text body to all mods.
 * The mod who sent the command gets a delivery summary back.
 */
export async function handleAnnounce(bot: TelegramBot, msg: TelegramBot.Message, body: string): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;

  const trimmed = body.trim();
  if (!trimmed) {
    await bot.sendMessage(
      chatId,
      "Usage: `/announce <message>` — sends the message to every moderator's DM with the bot.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const { sent, failed } = await broadcastToMods(bot, trimmed);
  await bot.sendMessage(
    chatId,
    `✅ Announcement delivered — *${sent}* sent${failed ? `, *${failed}* failed` : ""}.`,
    { parse_mode: "Markdown" },
  );
}
