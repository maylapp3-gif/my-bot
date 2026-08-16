// Daily client-list snapshot to Replit object storage.
//
// Why: the client roster is the most regenerable-from-history piece of
// business data. If panic_wipe nukes the DB or something goes sideways,
// having yesterday's roster in cold storage means the business can be rebuilt
// in seconds. The snapshot captures the FULL client picture:
//   - subscribers (the contact list)
//   - regulars    (the pricing tier)
//   - trusted     (the private broadcast list)
// so a restore brings back not just who the clients are, but their statuses.
//
// Storage layout:
//   <PRIVATE_OBJECT_DIR>/subscribers/snapshot-YYYY-MM-DD.json
//
// Each snapshot is a JSON blob: { date, count, subscribers, regulars, trusted }.
// `regulars`/`trusted` are optional so older subscriber-only snapshots still
// load. Retention: a rolling BACKUP_RETENTION_DAYS window (default 14). The
// snapshot is a mirror of customer-traceable data, so forensic minimization
// requires it to age out just like the live DB — anything older than the
// window is pruned every time a fresh snapshot is written. Enough history to
// recover from a bad day, never an indefinite roster archive.

import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import {
  subscribersTable,
  regularCustomersTable,
  trustedBroadcastTable,
  type InsertSubscriber,
} from "@workspace/db/schema";
import { putJson, getJson, listJsonRelPaths, deleteObject } from "./objectStorage.js";
import { logger } from "../lib/logger.js";

const BACKUP_PREFIX = "subscribers";
const BACKUP_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.BACKUP_RETENTION_DAYS ?? 14),
);

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function pathFor(date: string): string {
  return `${BACKUP_PREFIX}/snapshot-${date}.json`;
}

// chatId-keyed roster entries (regulars / trusted). addedAt is serialised as
// an ISO string so it survives a JSON round-trip and can be restored verbatim.
type RosterRecord = {
  chatId: string;
  notes: string | null;
  addedBy: string | null;
  addedAt: string | null;
};

type Snapshot = {
  date: string;
  count: number; // subscriber count — kept as the headline number for listings
  subscribers: Array<{
    chatId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    active: boolean;
  }>;
  regulars?: RosterRecord[];
  trusted?: RosterRecord[];
};

export async function snapshotSubscribersNow(): Promise<{
  date: string;
  count: number;
  path: string;
  regulars: number;
  trusted: number;
}> {
  const [subs, regulars, trusted] = await Promise.all([
    db.select().from(subscribersTable),
    db.select().from(regularCustomersTable),
    db.select().from(trustedBroadcastTable),
  ]);
  const date = todayKey();
  const path = pathFor(date);
  const blob: Snapshot = {
    date,
    count: subs.length,
    subscribers: subs.map((s) => ({
      chatId: s.chatId,
      username: s.username,
      firstName: s.firstName,
      lastName: s.lastName,
      active: s.active,
    })),
    regulars: regulars.map((r) => ({
      chatId: r.chatId,
      notes: r.notes,
      addedBy: r.addedBy,
      addedAt: r.addedAt ? r.addedAt.toISOString() : null,
    })),
    trusted: trusted.map((t) => ({
      chatId: t.chatId,
      notes: t.notes,
      addedBy: t.addedBy,
      addedAt: t.addedAt ? t.addedAt.toISOString() : null,
    })),
  };
  await putJson(path, blob);
  logger.info(
    { date, count: subs.length, regulars: regulars.length, trusted: trusted.length, path },
    "Client snapshot saved",
  );
  // Age out anything past the rolling window so the cold store mirrors the
  // live DB's minimization rather than accumulating an indefinite roster.
  await pruneOldSnapshots();
  return { date, count: subs.length, path, regulars: regulars.length, trusted: trusted.length };
}

// Delete snapshot blobs older than BACKUP_RETENTION_DAYS. Dates are compared
// as plain YYYY-MM-DD strings against a cutoff computed the same way, so this
// is timezone-agnostic and matches the UTC-dated file names. Best-effort: a
// failed delete is logged but never blocks the fresh snapshot from saving.
async function pruneOldSnapshots(): Promise<number> {
  const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  let removed = 0;
  try {
    const relPaths = await listJsonRelPaths(BACKUP_PREFIX);
    for (const p of relPaths) {
      const m = p.match(/snapshot-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      if (m[1] < cutoff) {
        try {
          await deleteObject(p);
          removed++;
        } catch (err) {
          logger.warn({ err, path: p }, "Failed to prune old subscriber snapshot");
        }
      }
    }
    if (removed > 0) {
      logger.info({ removed, retentionDays: BACKUP_RETENTION_DAYS }, "Pruned old subscriber snapshots");
    }
  } catch (err) {
    logger.warn({ err }, "Snapshot prune sweep failed (non-fatal)");
  }
  return removed;
}

export async function listSubscriberBackups(): Promise<
  Array<{ date: string; path: string; count: number }>
> {
  const all = await listJsonRelPaths(BACKUP_PREFIX);
  const dated = all
    .map((p) => {
      const m = p.match(/snapshot-(\d{4}-\d{2}-\d{2})\.json$/);
      return m ? { date: m[1], path: p } : null;
    })
    .filter((x): x is { date: string; path: string } => !!x)
    .sort((a, b) => b.date.localeCompare(a.date));
  const out: Array<{ date: string; path: string; count: number }> = [];
  for (const d of dated) {
    try {
      const data = await getJson<Snapshot>(d.path);
      out.push({ date: d.date, path: d.path, count: data?.count ?? 0 });
    } catch {
      out.push({ date: d.date, path: d.path, count: 0 });
    }
  }
  return out;
}

export async function restoreSubscribersFromBackup(
  date?: string,
): Promise<{
  date: string;
  inserted: number;
  skipped: number;
  regularsRestored: number;
  trustedRestored: number;
}> {
  let target: string;
  let resolvedDate: string;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must be YYYY-MM-DD");
    target = pathFor(date);
    resolvedDate = date;
  } else {
    const list = await listSubscriberBackups();
    if (list.length === 0) throw new Error("No backups available");
    target = list[0].path;
    resolvedDate = list[0].date;
  }
  const data = await getJson<Snapshot>(target);
  if (!data) throw new Error(`Backup not found: ${target}`);
  let inserted = 0;
  let skipped = 0;
  for (const sub of data.subscribers) {
    try {
      const row: InsertSubscriber = {
        chatId: sub.chatId,
        username: sub.username,
        firstName: sub.firstName,
        lastName: sub.lastName,
        active: sub.active,
      };
      const result = await db
        .insert(subscribersTable)
        .values(row)
        .onConflictDoNothing({ target: subscribersTable.chatId })
        .returning({ id: subscribersTable.id });
      if (result.length > 0) inserted++;
      else skipped++;
    } catch (err) {
      skipped++;
      logger.warn({ err, chatId: sub.chatId }, "Failed to restore one subscriber");
    }
  }

  // Roster statuses (regulars / trusted) — optional in older snapshots.
  // onConflictDoNothing so an existing live row is never clobbered by an
  // older backup. addedAt is restored verbatim when present.
  const regularsRestored = await restoreRoster(regularCustomersTable, data.regulars);
  const trustedRestored = await restoreRoster(trustedBroadcastTable, data.trusted);

  return { date: resolvedDate, inserted, skipped, regularsRestored, trustedRestored };
}

// Shared restore for the two chatId-keyed roster tables (regulars / trusted).
async function restoreRoster(
  table: typeof regularCustomersTable | typeof trustedBroadcastTable,
  records: RosterRecord[] | undefined,
): Promise<number> {
  if (!records || records.length === 0) return 0;
  let restored = 0;
  for (const rec of records) {
    try {
      // Validate addedAt before inserting — a malformed timestamp would make
      // Postgres reject the whole row. If it's unparseable, drop it and let
      // the column default to now() so the entry still restores.
      const parsed = rec.addedAt ? new Date(rec.addedAt) : null;
      const addedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
      const result = await db
        .insert(table)
        .values({
          chatId: rec.chatId,
          notes: rec.notes,
          addedBy: rec.addedBy,
          ...(addedAt ? { addedAt } : {}),
        })
        .onConflictDoNothing({ target: table.chatId })
        .returning({ chatId: table.chatId });
      if (result.length > 0) restored++;
    } catch (err) {
      logger.warn({ err, chatId: rec.chatId }, "Failed to restore one roster entry");
    }
  }
  return restored;
}

// Cron: 03:00 UTC daily. Off-peak globally; ~13:00–14:00 in AU depending on DST.
// node-cron uses the server's local TZ by default; we pin UTC for consistency
// since the file path uses UTC date.
//
// If the snapshot fails we DM all admins — silent failures defeat the whole
// purpose of having backups (you only find out when you need them and they're
// not there). Cooldown prevents spam if the failure is persistent.
let started = false;
let lastFailureAlertAt = 0;
const FAILURE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

async function alertAdminsOfBackupFailure(bot: TelegramBot, err: unknown): Promise<void> {
  const now = Date.now();
  if (now - lastFailureAlertAt < FAILURE_ALERT_COOLDOWN_MS) return;
  lastFailureAlertAt = now;
  const adminIds = (process.env.ADMIN_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const text =
    `⚠️ *Daily subscriber backup FAILED*\n\n` +
    `\`${(err as Error).message ?? String(err)}\`\n\n` +
    `Cold-storage snapshots are not running. Check the api-server logs and ` +
    `try \`/backup_now\` to confirm the failure mode. The contact list is at risk.`;
  for (const id of adminIds) {
    try {
      await bot.sendMessage(id, text, { parse_mode: "Markdown" });
    } catch (sendErr) {
      logger.error({ err: sendErr, id }, "Failed to alert admin of backup failure");
    }
  }
}

export function startBackupScheduler(bot: TelegramBot | null): void {
  if (started) return;
  started = true;
  cron.schedule(
    "0 3 * * *",
    () => {
      snapshotSubscribersNow().catch((err) => {
        logger.error({ err }, "Daily subscriber snapshot failed");
        if (bot) void alertAdminsOfBackupFailure(bot, err);
      });
    },
    { timezone: "UTC" },
  );
  logger.info("Subscriber backup scheduler started (03:00 UTC daily, 14-day retention)");
}
