// Security primitives: suspicious-admin-attempt tracker (alerts mods if
// someone is probing) and the panic-wipe DB nuke.
//
// IMPORTANT: this is NOT a real intrusion-detection system. It can't see
// network interception, server compromise, or Telegram-side surveillance.
// It can only see Telegram messages addressed to this bot. The alarm and
// the wipe are an *operator* tool — the human admin makes the call to wipe.

import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getModeratorIds } from "./moderation.js";

// ===========================================================================
// Suspicious-attempt tracker (in-memory sliding window)
// ===========================================================================
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 min
const ALERT_THRESHOLD = 5; // 5 failed admin attempts in window → alert
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't spam — at most one alert per 30 min

type Attempt = { chatId: string; command: string; ts: number };
const recentAttempts: Attempt[] = [];
let lastAlertAt = 0;

export function recordSuspiciousAdminAttempt(
  bot: TelegramBot | null,
  chatId: string,
  command: string,
): void {
  const now = Date.now();
  recentAttempts.push({ chatId, command, ts: now });
  while (recentAttempts.length > 0 && now - recentAttempts[0].ts > ATTEMPT_WINDOW_MS) {
    recentAttempts.shift();
  }
  if (recentAttempts.length < ALERT_THRESHOLD) return;
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  void dispatchSuspiciousActivityAlert(bot, [...recentAttempts]);
}

async function dispatchSuspiciousActivityAlert(
  bot: TelegramBot | null,
  attempts: Attempt[],
): Promise<void> {
  if (!bot) {
    logger.warn({ attempts: attempts.length }, "Suspicious activity detected but bot is null — can't alert");
    return;
  }
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const modIds = getModeratorIds();
  const recipients = Array.from(new Set([...adminIds, ...modIds]));
  const uniqueAttackers = new Set(attempts.map((a) => a.chatId));
  const lines = attempts
    .slice(-10)
    .map((a) => {
      const ago = Math.round((Date.now() - a.ts) / 1000);
      return `  • \`${a.chatId}\` tried \`${a.command}\` ${ago}s ago`;
    })
    .join("\n");
  const text =
    `🚨 *SECURITY ALERT*\n\n` +
    `${attempts.length} failed admin attempts in the last 5 min from ${uniqueAttackers.size} chat(s):\n\n` +
    `${lines}\n\n` +
    `If you don't recognise these chat IDs, hit \`/panic_wipe CONFIRM_NUKE\` to nuke the database. ` +
    `Subscriber backups in cold storage will survive.`;
  for (const id of recipients) {
    try {
      await bot.sendMessage(id, text, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err, id }, "Failed to dispatch security alert to recipient");
    }
  }
  logger.warn(
    { attemptCount: attempts.length, attackerCount: uniqueAttackers.size, recipients: recipients.length },
    "Security alert dispatched",
  );
}

// ===========================================================================
// Panic wipe — TRUNCATE every customer/business table.
// ===========================================================================
// Does NOT touch object-storage backups (those live in a different system).
// Does NOT touch env secrets (those live in Replit's secret store).
// Does NOT touch the userbot session strings (those are env secrets too).
const WIPE_TABLES = [
  "messages",
  "conversations",
  "bot_messages",
  "order_items",
  "orders",
  "cart_items",
  "cart_promos",
  "promo_codes",
  "product_variants",
  "products",
  "subscribers",
  "regular_customers",
  "trusted_broadcast",
  "cart_bundles",
  "bundles",
  "bundle_items",
  "drops",
  "relays",
  "mod_status",
];

export async function panicWipeDatabase(): Promise<{ tablesWiped: string[] }> {
  const list = WIPE_TABLES.map((t) => `"${t}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
  logger.warn({ tables: WIPE_TABLES }, "PANIC WIPE EXECUTED — all customer/business data dropped");
  return { tablesWiped: WIPE_TABLES };
}
