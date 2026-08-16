import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { getOldMessages, deleteTrackedMessages, prunePickupWindows } from "./db.js";
import { businessDateKey } from "./hours.js";
import { logger } from "../lib/logger.js";

async function runCleanup(bot: TelegramBot) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Data minimization: pickup windows are day-scoped operational settings —
  // drop every row older than the current business day.
  try {
    await prunePickupWindows(businessDateKey());
  } catch (err) {
    logger.error({ err }, "Pickup window prune failed (non-fatal)");
  }
  try {
    const oldMessages = await getOldMessages(cutoff);
    if (oldMessages.length === 0) return;

    const deleted: number[] = [];
    for (const msg of oldMessages) {
      try {
        await bot.deleteMessage(msg.chatId, msg.messageId);
        deleted.push(msg.id);
      } catch (err: unknown) {
        // Message may already be deleted, too old (>48h Telegram limit), or bot lost permission.
        // Still remove from tracking so we don't retry forever.
        deleted.push(msg.id);
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ chatId: msg.chatId, messageId: msg.messageId, err: errMsg }, "Could not delete message (may already be gone)");
      }
    }

    await deleteTrackedMessages(deleted);
    logger.info({ count: deleted.length }, "Self-destruct cleanup complete");
  } catch (err) {
    logger.error({ err }, "Self-destruct scheduler error");
  }
}

export function startSelfDestructScheduler(bot: TelegramBot) {
  // Run every 15 minutes so the "24h auto-delete" promise is enforced in wall-clock time
  // (worst-case extra retention is 15 minutes, not 24 hours like a daily-only cron).
  cron.schedule("*/15 * * * *", () => {
    void runCleanup(bot);
  });

  logger.info("Self-destruct scheduler started (runs every 15 minutes; cutoff = 24h)");
}
