import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import {
  getFollowUpEligibleOrders,
  claimFollowUp,
  isBlocked,
  getSubscriber,
  trackMessage,
} from "./db.js";
import { isClaimed } from "./moderation.js";
import { isOpenNow } from "./hours.js";
import { TIMEZONE } from "./brand.js";
import { logger } from "../lib/logger.js";
import { escapeMarkdown } from "./escape.js";

// Customer-facing follow-up on orders that "fell through".
//
// The mod-facing pending-order reminder (pendingOrderReminder.ts) only pings
// the TEAM. This is its customer-facing complement: when an order has sat
// `pending` past a delay (default 2h, env-tunable) but is still inside the 24h
// retention window, the customer gets ONE gentle "still want this?" nudge so an
// otherwise-lost sale can be recovered.
//
// Hard boundaries (forensic minimization + don't re-engage dodgy customers):
//   * ONE nudge per order, ever. Enforced by claimFollowUp (a conditional
//     stamp on the order row) — survives restarts, no in-memory state.
//   * Open hours only. Silent overnight, same as the mod reminder.
//   * Never re-engage a customer the team is deliberately ignoring:
//       - hard-blocked (blocklist),
//       - currently mod-claimed (a human is actively on the chat),
//       - not approved through the verification gate (verified === false),
//       - mod-cancelled order (we require status `pending`, so a ❌ "didn't
//         happen" tap → cancelled → the order is permanently ineligible).
//   * Copy is deliberately generic: no product, price, quantity or location,
//     and contains none of the AI_FORBIDDEN_WORDS by construction.
//   * The nudge is sent through the tracked path so the 24h chat sweep
//     (selfDestruct.ts) deletes it like every other bot message.
const TICK_CRON = "*/5 * * * *"; // every 5 min, matches the mod reminder cadence

// Default ON — the operator explicitly asked for this. Disable with
// FOLLOWUP_ENABLED=false (or 0).
function followUpEnabled(): boolean {
  const v = process.env.FOLLOWUP_ENABLED;
  return !(v === "false" || v === "0");
}

// How long an order must sit `pending` before its single nudge fires. Clamped
// so it can never undercut the 15-min mod escalation or reach past the 24h
// retention purge.
function followUpAfterMs(): number {
  const DEFAULT_MIN = 120;
  const MIN_MIN = 30;
  const MAX_MIN = 23 * 60;
  const raw = parseInt(process.env.FOLLOWUP_AFTER_MINUTES ?? "", 10);
  const minutes = Number.isFinite(raw) ? raw : DEFAULT_MIN;
  const clamped = Math.min(Math.max(minutes, MIN_MIN), MAX_MIN);
  return clamped * 60 * 1000;
}

function followUpText(customerName: string, orderId: number): string {
  const name = customerName ? `, ${escapeMarkdown(customerName)}` : "";
  return (
    `👋 *Hey${name}!*\n\n` +
    `Just checking in — your *Order #${orderId}* is still open on our end and we'd hate for you to miss out.\n\n` +
    `If you still want it, reply here and the team will lock it in. Changed your mind? No worries at all — just ignore this. 🙌`
  );
}

// Layer the deliberate-ignore exclusions on top of the SQL-eligible set.
// Returns true when this customer should be left alone.
async function isDeliberatelyIgnored(chatId: string): Promise<boolean> {
  if (isClaimed(chatId)) return true; // a human is actively on this chat
  if (await isBlocked(chatId)) return true; // hard-blocked
  const sub = await getSubscriber(chatId);
  // Fail-closed: no row (purged / unknown) → don't message. verified === false
  // covers every not-yet-approved gate state (gated / pending / rejected);
  // NULL (grandfathered) and true (approved) are allowed.
  if (!sub || sub.verified === false) return true;
  return false;
}

async function tick(bot: TelegramBot): Promise<void> {
  try {
    if (!isOpenNow()) return; // silent overnight — mods aren't on, no point
    const now = Date.now();
    const eligible = await getFollowUpEligibleOrders(now, followUpAfterMs());
    if (eligible.length === 0) return;

    for (const o of eligible) {
      try {
        if (await isDeliberatelyIgnored(o.chatId)) continue;
        // Claim the single follow-up slot before sending. The conditional
        // UPDATE requires status='pending', so a mod confirm/cancel that landed
        // before we reached this order in the loop loses the race and the claim
        // no-ops — a cancelled/confirmed order can never be nudged.
        const claimed = await claimFollowUp(o.id);
        if (!claimed) continue;
        // A moderator may have claimed the chat during the claim's DB round
        // trip above. Re-check in-memory right before send so a chat a human
        // just took is left alone (the slot is burned, which is fine — we
        // never want to nudge a chat under active handling).
        if (isClaimed(claimed.chatId)) continue;
        const sent = await bot.sendMessage(
          claimed.chatId,
          followUpText(claimed.customerName, o.id),
          { parse_mode: "Markdown" },
        );
        // Track so the 24h chat sweep deletes it like every other bot message.
        // Retention is non-negotiable: if tracking fails the message would
        // escape the sweep, so delete it now rather than leave an untracked
        // customer-facing message lingering past 24h.
        try {
          await trackMessage(claimed.chatId, sent.message_id);
          logger.info({ orderId: o.id }, "Fell-through follow-up sent to customer");
        } catch (trackErr) {
          try {
            await bot.deleteMessage(claimed.chatId, sent.message_id);
          } catch (delErr) {
            logger.error({ err: delErr, orderId: o.id }, "Fell-through follow-up: cleanup delete failed (untracked message may survive)");
          }
          logger.error({ err: trackErr, orderId: o.id }, "Fell-through follow-up: trackMessage failed — message deleted to honour 24h purge");
        }
      } catch (err) {
        // A single bad send (e.g. the customer blocked the bot) must not stall
        // the rest of the batch. The slot is already claimed → no retry.
        logger.error({ err, orderId: o.id }, "Fell-through follow-up send failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "Fell-through follow-up tick error");
  }
}

export function startFollowUpReminder(bot: TelegramBot): void {
  if (!followUpEnabled()) {
    logger.warn("Fell-through customer follow-up DISABLED (FOLLOWUP_ENABLED=false)");
    return;
  }
  cron.schedule(TICK_CRON, () => {
    void tick(bot);
  });
  logger.info(
    { tz: TIMEZONE, afterMin: followUpAfterMs() / 60000 },
    "Fell-through customer follow-up scheduler started (every 5 min, open hours only, one nudge per order)",
  );
}
