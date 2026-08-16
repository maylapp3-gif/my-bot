// Admin-only commands wrapping the security primitives in `../security.ts`
// and the cold-storage backups in `../backup.ts`.

import TelegramBot from "node-telegram-bot-api";
import { isAdmin } from "./admin.js";
import { panicWipeDatabase, recordSuspiciousAdminAttempt } from "../security.js";
import {
  snapshotSubscribersNow,
  listSubscriberBackups,
  restoreSubscribersFromBackup,
} from "../backup.js";
import { logger } from "../../lib/logger.js";

const PANIC_PHRASE = "CONFIRM_NUKE";

export async function handlePanicWipe(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  arg: string | undefined,
) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) {
    recordSuspiciousAdminAttempt(bot, chatId, "/panic_wipe");
    return;
  }
  if (arg !== PANIC_PHRASE) {
    await bot.sendMessage(
      chatId,
      `🚨 *PANIC WIPE — confirmation required*\n\n` +
        `This instantly deletes *every* customer, order, product, cart, promo, ` +
        `subscriber, and tracked message from the database. *Cannot be undone.*\n\n` +
        `Your client snapshots in cold storage are preserved (subscribers + regulars ` +
        `+ trusted list) — you can restore them with \`/restore_subscribers\` afterwards.\n\n` +
        `If you really want to nuke everything, send:\n\n\`/panic_wipe ${PANIC_PHRASE}\``,
      { parse_mode: "Markdown" },
    );
    return;
  }
  // Snapshot the full client roster BEFORE the wipe so we always have the
  // freshest copy of subscribers + regulars + trusted.
  let snapshotInfo = "";
  try {
    const snap = await snapshotSubscribersNow();
    snapshotInfo =
      `\n\nFresh client snapshot saved: \`${snap.path}\` ` +
      `(${snap.count} subscribers, ${snap.regulars} regulars, ${snap.trusted} trusted).`;
  } catch (err) {
    logger.error({ err }, "panic_wipe pre-snapshot failed");
    snapshotInfo = `\n\n⚠️ Pre-wipe snapshot FAILED — you'll have to restore from yesterday's backup.`;
  }
  try {
    const result = await panicWipeDatabase();
    await bot.sendMessage(
      chatId,
      `☠️ *Wiped.*\n\n${result.tablesWiped.length} tables cleared.${snapshotInfo}\n\n` +
        `The bot is now empty. Restart the workflow and re-seed via /menu when ready. ` +
        `Use \`/restore_subscribers\` to bring the contact list back.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "panic_wipe failed");
    await bot.sendMessage(chatId, `❌ Wipe failed: ${(err as Error).message}`);
  }
}

export async function handleBackupNow(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) {
    recordSuspiciousAdminAttempt(bot, chatId, "/backup_now");
    return;
  }
  try {
    const snap = await snapshotSubscribersNow();
    await bot.sendMessage(
      chatId,
      `✅ Snapshot saved: \`${snap.path}\`\n` +
        `• ${snap.count} subscribers\n` +
        `• ${snap.regulars} regulars\n` +
        `• ${snap.trusted} trusted`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "backup_now failed");
    await bot.sendMessage(chatId, `❌ Backup failed: ${(err as Error).message}`);
  }
}

export async function handleListBackups(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) {
    recordSuspiciousAdminAttempt(bot, chatId, "/list_backups");
    return;
  }
  try {
    const backups = await listSubscriberBackups();
    if (backups.length === 0) {
      await bot.sendMessage(chatId, "_No backups yet. Run /backup_now to create one._", {
        parse_mode: "Markdown",
      });
      return;
    }
    // Cap visible list at 30 so the message doesn't blow past Telegram's
    // 4096-char limit once you've been running for years. Total still shown.
    const head = backups.slice(0, 30);
    const more = backups.length > head.length ? `\n_…and ${backups.length - head.length} older._` : "";
    const text =
      `*Subscriber backups* — newest first (${backups.length} total, kept forever)\n\n` +
      head.map((b) => `\`${b.date}\` — ${b.count} subs`).join("\n") +
      more +
      `\n\nRestore the most recent with \`/restore_subscribers\` ` +
      `or a specific date with \`/restore_subscribers YYYY-MM-DD\`.`;
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "list_backups failed");
    await bot.sendMessage(chatId, `❌ Couldn't list backups: ${(err as Error).message}`);
  }
}

export async function handleRestoreSubscribers(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  date: string | undefined,
) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) {
    recordSuspiciousAdminAttempt(bot, chatId, "/restore_subscribers");
    return;
  }
  try {
    const result = await restoreSubscribersFromBackup(date);
    await bot.sendMessage(
      chatId,
      `✅ Restored from \`${result.date}\`:\n` +
        `• ${result.inserted} subscribers (${result.skipped} duplicates/invalids skipped)\n` +
        `• ${result.regularsRestored} regulars\n` +
        `• ${result.trustedRestored} trusted\n\n` +
        `_Client roster only — orders, products & promos aren't backed up._`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "restore_subscribers failed");
    await bot.sendMessage(chatId, `❌ Restore failed: ${(err as Error).message}`);
  }
}
