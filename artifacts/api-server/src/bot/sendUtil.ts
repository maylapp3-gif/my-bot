import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";

// Telegram caps a single message at 4096 characters. We chunk well under that
// so multibyte content (emoji count as 2+ UTF-16 units) can't tip a chunk over
// the limit and trigger a "message is too long" 400.
const TELEGRAM_SAFE_LEN = 3500;

// Split a body into Telegram-safe chunks on line boundaries. A single line
// longer than the limit is hard-split so it can never produce an over-long
// chunk on its own.
export function chunkForTelegram(body: string, maxLen = TELEGRAM_SAFE_LEN): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };
  for (const rawLine of body.split("\n")) {
    let line = rawLine;
    // Hard-split any single line that exceeds the limit on its own.
    while (line.length > maxLen) {
      flush();
      chunks.push(line.slice(0, maxLen));
      line = line.slice(maxLen);
    }
    if (current.length + line.length + 1 > maxLen) {
      flush();
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  flush();
  return chunks;
}

function isParseError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes("can't parse entities") || m.includes("can't find end");
}

// Send a possibly-long Markdown message safely. Chunks on line boundaries, and
// if a chunk fails Markdown parsing (an unbalanced marker slipped past
// escaping), retries that chunk as plain text so the recipient always receives
// the content rather than silently losing it. Intended for internal/admin
// messages without an inline keyboard.
export async function sendMarkdownSafe(
  bot: TelegramBot,
  chatId: string | number,
  text: string,
  extra: TelegramBot.SendMessageOptions = {},
): Promise<void> {
  for (const chunk of chunkForTelegram(text)) {
    if (!chunk) continue;
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown", ...extra });
    } catch (err) {
      if (isParseError(err)) {
        try {
          await bot.sendMessage(chatId, chunk, extra);
        } catch (err2) {
          logger.error({ err: err2, chatId }, "sendMarkdownSafe: plain-text fallback failed");
        }
        continue;
      }
      logger.error({ err, chatId }, "sendMarkdownSafe: send failed");
    }
  }
}
