import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { and, eq, lt, gt } from "drizzle-orm";
import { getModeratorIds } from "./moderation.js";
import { getRelays } from "./db.js";
import { isOpenNow } from "./hours.js";
import { TIMEZONE, LOCALE_DATEKEY } from "./brand.js";
import { logger } from "../lib/logger.js";
import { escapeMarkdown } from "./escape.js";

// Pending-order escalation. Two modes, both during open hours only:
//
//   1. Per-order reminder (open hours, recurring): cron every 5 min finds
//      any order still `pending` 15+ min after creation and fans out a
//      single warning to mods + relays. One reminder per order, ever.
//
//   2. Open-time digest (once per business day, on the first tick after
//      we transition from closed → open): batches every still-pending
//      order accumulated overnight into ONE message and fires it to
//      mods + relays. Those orders are then marked as already-reminded
//      so the per-order flow doesn't re-spam them.
//
// Outside open hours we are silent. Mods aren't on shift, the customer
// can't be served until 2pm anyway, and pinging phones overnight is just
// noise.
//
// Scope: only orders <24h old (data-retention deletes older anyway).
// In-memory state for `reminded` and `lastDigestDay` — restart may cause
// a re-remind or re-digest, acceptable cost vs missing a real one.
const REMINDER_AFTER_MS = 15 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const TICK_CRON = "*/5 * * * *"; // every 5 min

const reminded = new Set<number>();
let lastDigestDay = ""; // "YYYY-MM-DD" in the business timezone, set when digest fires

function businessDay(now: Date = new Date()): string {
  // en-CA gives ISO-style YYYY-MM-DD which is what we want as a key.
  return new Intl.DateTimeFormat(LOCALE_DATEKEY, {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function recipients(): Promise<string[]> {
  const mods = getModeratorIds();
  const relays = await getRelays().catch(() => [] as Awaited<ReturnType<typeof getRelays>>);
  const set = new Set<string>(mods);
  for (const r of relays) set.add(r.chatId);
  return Array.from(set);
}

function formatPriceCents(c: number | null | undefined): string {
  if (c == null) return "—";
  return `$${(c / 100).toFixed(2)}`;
}

async function fetchStalePending(now: number) {
  const upper = new Date(now - REMINDER_AFTER_MS);
  const lower = new Date(now - RETENTION_MS);
  return db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.status, "pending"),
        lt(ordersTable.createdAt, upper),
        gt(ordersTable.createdAt, lower),
      ),
    );
}

async function sendDigest(bot: TelegramBot, orders: Awaited<ReturnType<typeof fetchStalePending>>, targets: string[], now: number) {
  if (orders.length === 0) return false;
  const lines = orders.map((o) => {
    const ageMin = Math.floor((now - new Date(o.createdAt).getTime()) / 60000);
    const handle = o.customerUsername ? ` @${escapeMarkdown(o.customerUsername)}` : "";
    return (
      `*#${o.id}* — ${ageMin} min · ${formatPriceCents(o.totalCents)}\n` +
      `  ${escapeMarkdown(o.customerName)}${handle} · \`${o.chatId}\`\n` +
      `  ${escapeMarkdown(o.items)}` +
      (o.preferredTime ? `\n  ⏰ ${escapeMarkdown(o.preferredTime)}` : "") +
      `\n  \`/confirm_${o.id}\` · \`/cancel_${o.id}\``
    );
  });
  const body =
    `☀️ *OPEN — ${orders.length} pending order${orders.length === 1 ? "" : "s"} from overnight*\n\n` +
    lines.join("\n\n");
  let delivered = 0;
  for (const id of targets) {
    try {
      await bot.sendMessage(id, body, { parse_mode: "Markdown" });
      delivered++;
    } catch (err) {
      logger.error({ err, recipientId: id }, "Open-time digest fanout failed");
    }
  }
  if (delivered > 0) {
    for (const o of orders) reminded.add(o.id);
    logger.info({ count: orders.length, delivered }, "Open-time pending-order digest sent");
    return true;
  }
  return false;
}

async function sendPerOrder(bot: TelegramBot, orders: Awaited<ReturnType<typeof fetchStalePending>>, targets: string[], now: number) {
  for (const o of orders) {
    if (reminded.has(o.id)) continue;
    const ageMin = Math.floor((now - new Date(o.createdAt).getTime()) / 60000);
    const body =
      `⚠️ *PENDING ORDER REMINDER*\n\n` +
      `*Order #${o.id}* has been waiting *${ageMin} min* with no confirmation.\n\n` +
      `*Customer*  ${escapeMarkdown(o.customerName)}${o.customerUsername ? ` (@${escapeMarkdown(o.customerUsername)})` : ""}\n` +
      `*Chat*      \`${o.chatId}\`\n` +
      `*Items*     ${escapeMarkdown(o.items)}\n` +
      `*Total*     ${formatPriceCents(o.totalCents)}\n` +
      (o.deliveryArea ? `*Where*  ${escapeMarkdown(o.deliveryArea)}\n` : "") +
      (o.preferredTime ? `*When*   ${escapeMarkdown(o.preferredTime)}\n` : "") +
      `\nConfirm  \`/confirm_${o.id}\`\n` +
      `Decline  \`/cancel_${o.id}\``;
    let delivered = 0;
    for (const id of targets) {
      try {
        await bot.sendMessage(id, body, { parse_mode: "Markdown" });
        delivered++;
      } catch (err) {
        logger.error({ err, recipientId: id, orderId: o.id }, "Pending-order reminder fanout failed");
      }
    }
    if (delivered > 0) {
      reminded.add(o.id);
      logger.info({ orderId: o.id, ageMin, delivered }, "Pending-order reminder sent");
    }
  }
}

async function tick(bot: TelegramBot) {
  try {
    if (!isOpenNow()) return; // silent overnight; the digest catches it at open
    const now = Date.now();
    const stale = await fetchStalePending(now);
    if (stale.length === 0) return;

    const targets = await recipients();
    if (targets.length === 0) {
      logger.warn("Pending-order reminder: no mods or relays configured — nobody to notify");
      return;
    }

    const today = businessDay();
    if (lastDigestDay !== today) {
      // First open-hours tick of this business day — batch everything that
      // accumulated overnight into a single digest, then mark them reminded
      // so the per-order flow stays quiet.
      const ok = await sendDigest(bot, stale, targets, now);
      if (ok) lastDigestDay = today;
      return;
    }

    await sendPerOrder(bot, stale, targets, now);
  } catch (err) {
    logger.error({ err }, "Pending-order reminder tick error");
  }
}

export function startPendingOrderReminder(bot: TelegramBot) {
  cron.schedule(TICK_CRON, () => {
    void tick(bot);
  });
  logger.info(
    { tz: TIMEZONE },
    "Pending-order reminder scheduler started (every 5 min, open hours only; overnight orders batched into one digest at open)",
  );
}
