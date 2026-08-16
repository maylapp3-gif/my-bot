import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { getOrdersSince, formatPriceCents } from "./db.js";
import { logger } from "../lib/logger.js";
import { escapeMarkdown } from "./escape.js";
import { sendMarkdownSafe } from "./sendUtil.js";
import { buildFlaggedStockSection } from "./handlers/stockReport.js";
import { businessDateKey, businessHourNow, todayHours } from "./hours.js";
import { TIMEZONE, LOCALE_HOUR } from "./brand.js";

// Compute the UTC Date corresponding to "00:00 today" in business-local time.
// Subtracting business wall-clock elapsed-today from `now` (UTC) lands at local midnight.
function startOfTodayLocal(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  let h = get("hour");
  if (h === 24) h = 0; // some Intl impls return 24 at midnight
  const m = get("minute");
  const s = get("second");
  const elapsedMs = ((h * 60 + m) * 60 + s) * 1000;
  return new Date(now.getTime() - elapsedMs);
}

function localDateLabel(now: Date = new Date()): string {
  return new Intl.DateTimeFormat(LOCALE_HOUR, {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(now);
}

function statusEmoji(s: string): string {
  return (
    ({
      pending: "⏳",
      confirmed: "🔥",
      in_progress: "🛵",
      completed: "💯",
      cancelled: "❌",
    } as Record<string, string>)[s] ?? "•"
  );
}

export async function buildEodSummary(now: Date = new Date()): Promise<string> {
  const since = startOfTodayLocal(now);
  const orders = await getOrdersSince(since);

  const date = localDateLabel(now);

  // Stock section runs regardless of whether there were orders — the admin
  // needs to see flagged stock every single day so nothing slips.
  const stockSection = await buildFlaggedStockSection().catch((err) => {
    logger.error({ err }, "EOD: buildFlaggedStockSection failed");
    return "";
  });

  if (orders.length === 0) {
    const base = `📊 *End-of-day summary — ${escapeMarkdown(date)}*\n\nNo orders today.`;
    return stockSection ? `${base}\n\n${stockSection}` : base;
  }

  // ---- Sales tally — independent of mod confirmations --------------------
  // The bot's automatic call: a sale = an order the customer actually placed,
  // EXCEPT the ones a mod tapped "❌ Decline" (status → cancelled = "didn't
  // happen"). Mods don't reliably confirm orders, so we count placement, not
  // confirmation. We then surface what mods HAVE confirmed next to the
  // automatic figure so the operator can compare the bot's call against the
  // mods' manual review.
  const isSale = (s: string) => s !== "cancelled";
  const isModConfirmed = (s: string) =>
    s === "confirmed" || s === "in_progress" || s === "completed";
  const sumCents = (rows: typeof orders) =>
    rows.reduce((acc, o) => acc + (o.totalCents ?? 0), 0);

  const saleOrders = orders.filter((o) => isSale(o.status));
  const confirmedOrders = orders.filter((o) => isModConfirmed(o.status));
  const awaitingOrders = orders.filter((o) => o.status === "pending");
  const droppedOrders = orders.filter((o) => o.status === "cancelled");

  const plural = (n: number) => (n === 1 ? "" : "s");

  let text = `📊 *End-of-day summary — ${escapeMarkdown(date)}*\n\n`;
  text += `💰 *Sales today: ${escapeMarkdown(formatPriceCents(sumCents(saleOrders)))}* across ${saleOrders.length} order${plural(saleOrders.length)}\n`;
  text += `_Counts every order placed, minus any a mod marked "didn't happen."_\n\n`;

  // Mod review, shown for comparison against the automatic figure above.
  text += `*Mod review (for comparison):*\n`;
  text += `  ✅ Confirmed by a mod: ${escapeMarkdown(formatPriceCents(sumCents(confirmedOrders)))} · ${confirmedOrders.length} order${plural(confirmedOrders.length)}\n`;
  text += `  ⏳ Awaiting a mod's confirm: ${escapeMarkdown(formatPriceCents(sumCents(awaitingOrders)))} · ${awaitingOrders.length} order${plural(awaitingOrders.length)}\n`;
  if (awaitingOrders.length > 0) {
    const ids = awaitingOrders
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((o) => `#${o.id}`)
      .join(", ");
    text += `    → Team: tap ✅/❌ on these before close to tighten the count — ${escapeMarkdown(ids)}\n`;
  }
  if (droppedOrders.length > 0) {
    text += `  ❌ Marked "didn't happen": ${droppedOrders.length} order${plural(droppedOrders.length)} · ${escapeMarkdown(formatPriceCents(sumCents(droppedOrders)))} not counted\n`;
  }
  text += `\n`;

  // Full per-status breakdown (includes cancelled) for completeness.
  const counts: Record<string, number> = {};
  for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
  text += `*Orders today (all): ${orders.length}*\n`;
  for (const [status, n] of Object.entries(counts).sort()) {
    text += `  ${statusEmoji(status)} ${escapeMarkdown(status)}: ${n}\n`;
  }
  text += `\n`;

  // Newest first
  const sorted = [...orders].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const o of sorted) {
    const username = o.customerUsername ? ` (@${escapeMarkdown(o.customerUsername)})` : "";
    text += `*#${o.id}* ${statusEmoji(o.status)} ${escapeMarkdown(o.status.toUpperCase())} — ${escapeMarkdown(o.customerName)}${username}\n`;
    text += `  📦 ${escapeMarkdown(o.items)}\n`;
    if (o.deliveryArea) text += `  📍 ${escapeMarkdown(o.deliveryArea)}\n`;
    if (o.preferredTime) text += `  🕐 ${escapeMarkdown(o.preferredTime)}\n`;
    if (o.notes) text += `  📝 ${escapeMarkdown(o.notes)}\n`;
    text += `  💬 \`${o.chatId}\`\n\n`;
  }

  if (stockSection) {
    text += `${stockSection}\n\n`;
  }

  text +=
    `_Note: order rows are auto-purged from the database 24h after they're created ` +
    `(same window as the chat-message wipe). Save this summary if you need a record._`;

  return text;
}

export async function sendEodSummary(bot: TelegramBot, chatId: string) {
  const summary = await buildEodSummary();
  // sendMarkdownSafe chunks to stay under Telegram's length cap and falls back
  // to plain text per-chunk if any markdown slips past escaping.
  await sendMarkdownSafe(bot, chatId, summary);
}

function getAdminChatIds(): string[] {
  return (process.env.ADMIN_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runDailyEod(bot: TelegramBot) {
  const admins = getAdminChatIds();
  if (admins.length === 0) {
    logger.warn("EOD scheduler fired but no ADMIN_CHAT_IDS configured");
    return;
  }
  try {
    const summary = await buildEodSummary();
    for (const adminId of admins) {
      try {
        await sendMarkdownSafe(bot, adminId, summary);
      } catch (err) {
        logger.error({ err, adminId }, "EOD: failed to send summary to admin");
      }
    }
    logger.info({ admins: admins.length }, "EOD summary delivered");
  } catch (err) {
    logger.error({ err }, "EOD summary build failed");
  }
}

// Close-of-business varies by weekday (see brand.ts WEEKLY_HOURS), so an
// hourly tick checks "have we reached today's close and not yet fired for
// this business day". The >= guard self-heals a skipped tick (e.g. a restart
// straddling the close hour); the in-memory day marker dedupes within a
// process, matching the lastDigestDay pattern used elsewhere.
let lastEodDay = "";

export function startEodScheduler(bot: TelegramBot) {
  cron.schedule(
    "0 * * * *",
    () => {
      const day = businessDateKey();
      if (lastEodDay === day) return;
      if (businessHourNow() < todayHours().close) return;
      lastEodDay = day;
      void runDailyEod(bot);
    },
    { timezone: TIMEZONE }
  );
  logger.info("EOD scheduler started (hourly tick, fires at each day's close hour)");
}
