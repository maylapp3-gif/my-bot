import TelegramBot from "node-telegram-bot-api";
import { isAdmin } from "./admin.js";
import { getPickupWindow, setPickupWindow, clearPickupWindow } from "../db.js";
import { businessDateKey } from "../hours.js";
import { logger } from "../../lib/logger.js";

// Admin-set daily pickup window — EXTRA pickup availability on top of the
// normal open hours (pickups are always possible during open hours; this
// just advertises additional times, e.g. a morning slot before open).
// Storage is numeric minutes-from-midnight keyed by business date, so
// everything customers see is RENDERED from those numbers — raw admin input
// is never echoed (Markdown-injection safe by construction). Unset or set,
// it never gates anything.

// "1pm" | "1:30pm" | "13" | "13:30" → minutes from midnight, or null.
function parseTimeToken(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  const m = /^([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const period = m[3];
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  if (period) {
    if (h < 1 || h > 12) return null;
    if (period === "pm" && h !== 12) h += 12;
    if (period === "am" && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

function formatMinutes(m: number): string {
  const h24 = Math.floor(m / 60) % 24;
  const min = m % 60;
  const period = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0 ? `${h12}${period}` : `${h12}:${String(min).padStart(2, "0")}${period}`;
}

// "1pm–4pm", or null when no window is set for today. Safe to interpolate
// into customer-facing Markdown — the output alphabet is [0-9:apm–] only.
// Fails closed to null (no window shown) so a DB hiccup can't break checkout.
export async function pickupWindowLineForToday(): Promise<string | null> {
  try {
    const w = await getPickupWindow(businessDateKey());
    if (!w) return null;
    return `${formatMinutes(w.startMinutes)}–${formatMinutes(w.endMinutes)}`;
  } catch (err) {
    logger.error({ err }, "pickupWindowLineForToday failed");
    return null;
  }
}

// /pickup            → view today's window + usage
// /pickup 1pm-4pm    → set today's window
// /pickup off        → clear today's window
export async function handlePickup(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  argRaw: string | undefined,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const arg = (argRaw ?? "").trim().toLowerCase();
  const today = businessDateKey();
  try {
    if (!arg) {
      const line = await pickupWindowLineForToday();
      // Plain text — /pickup contains no underscores but keep it consistent
      // with the admin panel (no Markdown parsing surprises).
      await bot.sendMessage(
        chatId,
        `🤝 Extra pickup times — today\n\n` +
          `Current: ${line ?? "not set"}\n\n` +
          `Pickups always run during normal open hours. This window is EXTRA availability on top (e.g. a morning slot).\n\n` +
          `Set: /pickup 10am-1pm\n` +
          `Also fine: /pickup 10:00-13:00 · /pickup 9:30am-1pm\n` +
          `Clear: /pickup off\n\n` +
          `Applies to TODAY only — old days clear out automatically. Customers see it when they pick Pickup at checkout.`,
      );
      return;
    }
    if (arg === "off" || arg === "clear" || arg === "reset") {
      await clearPickupWindow(today);
      await bot.sendMessage(chatId, "✅ Extra pickup times cleared for today. Pickups still run during normal open hours as usual.");
      return;
    }
    const m = /^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+)$/.exec(arg);
    const start = m ? parseTimeToken(m[1]!) : null;
    const end = m ? parseTimeToken(m[2]!) : null;
    if (start === null || end === null) {
      await bot.sendMessage(chatId, "Couldn't read that. Try: /pickup 10am-1pm (or /pickup off).");
      return;
    }
    if (end <= start) {
      await bot.sendMessage(chatId, "End has to be after start. Try: /pickup 10am-1pm.");
      return;
    }
    await setPickupWindow(today, start, end);
    await bot.sendMessage(
      chatId,
      `✅ Extra pickup times for today set to ${formatMinutes(start)}–${formatMinutes(end)} (on top of normal open hours). Customers will see it at checkout.`,
    );
  } catch (err) {
    logger.error({ err }, "/pickup handler error");
    await bot.sendMessage(chatId, "Something went wrong with the pickup window — try again.");
  }
}
