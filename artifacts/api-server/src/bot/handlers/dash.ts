import TelegramBot from "node-telegram-bot-api";
import { getOrders, getOrdersSince, getOrderItemsForOrders } from "../db.js";
import { getActiveClaims, isModerator } from "../moderation.js";
import { logger } from "../../lib/logger.js";
import { escapeMarkdown } from "../escape.js";
import { TIMEZONE, LOCALE_HOUR } from "../brand.js";

const CB_PREFIX = "dash:";

export function isDashCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

// Compute "00:00 today" in business-local time as a UTC Date.
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
  if (h === 24) h = 0;
  const m = get("minute");
  const s = get("second");
  return new Date(now.getTime() - ((h * 60 + m) * 60 + s) * 1000);
}

function fmtPriceCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

function fmtClock(now: Date = new Date()): string {
  return new Intl.DateTimeFormat(LOCALE_HOUR, {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

async function buildDashView(): Promise<{ text: string; keyboard: TelegramBot.InlineKeyboardMarkup }> {
  const since = startOfTodayLocal();
  const [todays, pending] = await Promise.all([
    getOrdersSince(since).catch(() => []),
    getOrders("pending").catch(() => []),
  ]);

  // Today's revenue = confirmed + completed totals.
  const earnedCents = todays
    .filter((o) => o.status === "confirmed" || o.status === "completed")
    .reduce((sum, o) => sum + (o.totalCents ?? 0), 0);

  // Top product today — sum quantities across order_items for today's orders
  // (any non-cancelled status counts toward "what we moved"). Single batched
  // query instead of one round-trip per order — the prior loop was an N+1
  // that scaled poorly on busy days.
  const productQty: Record<string, number> = {};
  const consideredIds = todays.filter((o) => o.status !== "cancelled").map((o) => o.id);
  const allItems = await getOrderItemsForOrders(consideredIds).catch(() => []);
  for (const it of allItems) {
    productQty[it.productName] = (productQty[it.productName] ?? 0) + it.quantity;
  }
  const topEntry = Object.entries(productQty).sort((a, b) => b[1] - a[1])[0];

  const claims = getActiveClaims();
  const claimLines = claims.length
    ? claims
        .slice(0, 5)
        .map((c) => {
          const ageMin = Math.round((Date.now() - c.claimedAt) / 60_000);
          return `  • \`${c.customerChatId}\` — \`${c.moderatorId}\` (${ageMin}m)`;
        })
        .join("\n")
    : "  _none_";

  const text =
    `📊 *Live Dashboard* — ${escapeMarkdown(fmtClock())}\n\n` +
    `*Today*\n` +
    `  • Orders: ${todays.length}\n` +
    `  • Earned (cash, confirmed): *${fmtPriceCents(earnedCents)}*\n` +
    `  • Top mover: ${topEntry ? `${escapeMarkdown(topEntry[0])} ×${topEntry[1]}` : "_n/a_"}\n\n` +
    `*Right now*\n` +
    `  • Pending: ${pending.length}\n` +
    `  • Active chats (${claims.length}):\n${claimLines}\n\n` +
    `_Tap refresh for the latest._`;

  const keyboard: TelegramBot.InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "dash:rfr" }]],
  };

  return { text, keyboard };
}

export async function handleDash(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isModerator(chatId)) return;
  try {
    const { text, keyboard } = await buildDashView();
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    logger.error({ err }, "/dash error");
    await bot.sendMessage(chatId, "Couldn't build the dash — check logs.");
  }
}

export async function handleDashCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const actor = query.from.id.toString();
  if (!isModerator(actor)) {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  if (query.data !== "dash:rfr") {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  try {
    const { text, keyboard } = await buildDashView();
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    await bot.answerCallbackQuery(query.id, { text: "Refreshed" });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("message is not modified")) {
      await bot.answerCallbackQuery(query.id, { text: "No change" });
      return;
    }
    logger.warn({ err }, "dash refresh failed");
    await bot.answerCallbackQuery(query.id, { text: "Refresh failed", show_alert: true });
  }
}
