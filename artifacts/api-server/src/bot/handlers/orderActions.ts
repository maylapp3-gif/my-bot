import TelegramBot from "node-telegram-bot-api";
import {
  transitionPendingOrder,
  revertOrderToPending,
  getOrders,
  awardLoyaltyIfDue,
  awardReferralIfDue,
  autoPromoteRegularIfDue,
  formatPriceCents,
  refundIntroOffer,
  reconsumeIntroOffer,
} from "../db.js";
import { isAdmin } from "./admin.js";
import { isModerator } from "../moderation.js";
import { getOrderRecipients } from "../orderRecipients.js";
import { escapeMarkdown } from "../escape.js";
import { logger } from "../../lib/logger.js";

// Inline-button callback prefix for order alerts: `ord:cnf:<id>` / `ord:cxl:<id>`.
// One shared helper so the text command (/confirm_<id>) and the button both
// flow through the same atomic pending→status flip.

const CB_PREFIX = "ord:";

export function isOrderActionCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

// Build the inline keyboard placed under every order fan-out message.
// Includes a one-tap 💬 Reply button so a mod can message the customer
// without typing /reply <chatId>.
export function orderAlertKeyboard(
  orderId: number,
  customerChatId: string,
): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirm", callback_data: `ord:cnf:${orderId}` },
        { text: "❌ Decline", callback_data: `ord:cxl:${orderId}` },
      ],
      [
        { text: "💬 Reply", callback_data: `mod:rp:${customerChatId}` },
        { text: "⚡ Quick", callback_data: `mod:qr:${customerChatId}` },
      ],
    ],
  };
}

// Shared core. Atomic pending→status flip, customer notify, mod ack,
// peer-mod mirror. Used by both /confirm_<id> text command and the buttons.
export async function applyOrderTransition(
  bot: TelegramBot,
  orderId: number,
  toStatus: "confirmed" | "cancelled",
  actorChatId: string,
): Promise<{ ok: boolean; alreadyProcessed?: boolean; mapsLink?: string }> {
  const row = await transitionPendingOrder(orderId, toStatus);
  if (!row) return { ok: false, alreadyProcessed: true };

  // If a cancelled order was carrying the one-time new-customer discount,
  // give the offer back (guarded: only when no other live order holds it).
  let introRefunded = false;
  if (toStatus === "cancelled" && (row.introDiscountCents ?? 0) > 0) {
    try {
      introRefunded = await refundIntroOffer(row.chatId, orderId);
    } catch (err) {
      logger.error({ err, orderId }, "refundIntroOffer on cancel failed");
    }
  }

  // Notify customer (best effort).
  try {
    await bot.sendMessage(
      row.chatId,
      toStatus === "confirmed"
        ? `🔥 Your Order #${orderId} is *confirmed* — we're on the way. 🛵`
        : `❌ Your Order #${orderId} has been *cancelled*. Contact us if you have questions.` +
          (introRefunded
            ? `\n\n🎁 _Your 50% new-customer discount is back — it'll apply to your next order (up to $250)._`
            : ""),
      {
        parse_mode: "Markdown",
        reply_markup:
          toStatus === "confirmed"
            ? {
                inline_keyboard: [[
                  { text: "🔁 Same again", callback_data: "re:last" },
                ]],
              }
            : undefined,
      },
    );
  } catch (err) {
    logger.error({ err, orderId }, "applyOrderTransition: failed to notify customer");
  }

  // On confirm, run loyalty + referral payouts. Both helpers are idempotent
  // (anchor / boolean guards) so a duplicate confirm can't double-pay. We
  // notify the customer of any credit they just earned in a follow-up so
  // they see it before their next checkout. We also auto-promote to Regular
  // once they cross the threshold — one-time congrats DM, addRegular is an
  // upsert so repeated confirms can't double-trigger.
  if (toStatus === "confirmed") {
    try {
      const loyalty = await awardLoyaltyIfDue(row.chatId);
      const referral = await awardReferralIfDue(row.chatId);
      const totalCents = loyalty.cents + (referral.paidReferred ? referral.cents : 0);
      if (totalCents > 0) {
        try {
          await bot.sendMessage(
            row.chatId,
            `💰 *+${formatPriceCents(totalCents)} store credit added* — auto-applies to your next order.`,
            { parse_mode: "Markdown" },
          );
        } catch (err) {
          logger.error({ err, orderId }, "credit-grant notify failed");
        }
      }
    } catch (err) {
      logger.error({ err, orderId }, "loyalty/referral payout failed");
    }
    try {
      const promo = await autoPromoteRegularIfDue(row.chatId);
      if (promo.promoted) {
        try {
          await bot.sendMessage(
            row.chatId,
            `🌟 *You're now a Regular!*\n\nAfter ${promo.count} orders, you're on the house list — free delivery up to 15km + $10 off every cart, automatically. Thanks for the love.`,
            { parse_mode: "Markdown" },
          );
        } catch (err) {
          logger.error({ err, orderId }, "auto-regular notify failed");
        }
      }
    } catch (err) {
      logger.error({ err, orderId }, "auto-regular promotion failed");
    }
  }

  // Build a one-click Maps link from the saved delivery area so the team
  // (and the actor) don't have to copy/paste the address into Maps. We
  // include it in (a) the actor's strip-buttons footer and (b) the peer
  // mirror. Only on confirm — declined orders aren't going anywhere.
  const mapsLink =
    toStatus === "confirmed" && row.deliveryArea
      ? `https://maps.google.com/?q=${encodeURIComponent(row.deliveryArea)}`
      : null;
  const mapsMarkdown = mapsLink ? ` · [🗺 Open in Maps](${mapsLink})` : "";

  // Mirror to the order channels (relay groups, or mod DMs as fallback) so
  // the team sees who actioned it. Skip the chat the actor pressed from.
  const verb = toStatus === "confirmed" ? "✅ confirmed" : "❌ declined";
  const peerMsg = `${verb} *Order #${orderId}* by \`${actorChatId}\`.${mapsMarkdown}`;
  for (const id of await getOrderRecipients()) {
    if (id === actorChatId) continue;
    try {
      await bot.sendMessage(id, peerMsg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } catch (err) {
      logger.error({ err, peer: id, orderId }, "applyOrderTransition: peer mirror failed");
    }
  }

  return { ok: true, mapsLink: mapsLink ?? undefined };
}

export async function handleOrderActionCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? "";
  const actorChatId = query.from.id.toString();

  if (!isAdmin(actorChatId) && !isModerator(actorChatId)) {
    await bot.answerCallbackQuery(query.id, { text: "That button's for the team.", show_alert: false });
    return;
  }

  // ord:cnf:<id> | ord:cxl:<id> | ord:rev:<id>  (rev = undo, see below)
  const parts = data.split(":");
  const op = parts[1];
  const orderId = parseInt(parts[2] ?? "", 10);
  if (isNaN(orderId) || (op !== "cnf" && op !== "cxl" && op !== "rev")) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // -----------------------------------------------------------------------
  // Undo path. Mods occasionally fat-finger Confirm/Decline; this lets the
  // actor (or any mod) put the order back into "pending" so the original
  // Confirm/Decline buttons return. Conditional on current status so a
  // race with another mod's re-action can't silently overwrite their work.
  // Loyalty/referral payouts are NOT unwound — both are idempotent.
  // -----------------------------------------------------------------------
  if (op === "rev") {
    const all = await getOrders().catch((): Awaited<ReturnType<typeof getOrders>> => []);
    const cur = all.find((o) => o.id === orderId);
    if (!cur || (cur.status !== "confirmed" && cur.status !== "cancelled")) {
      await bot.answerCallbackQuery(query.id, {
        text: cur ? `Can't undo — order is ${cur.status}.` : "Order not found.",
        show_alert: false,
      });
      return;
    }
    // If we're undoing a CANCEL of an order that carried the one-time intro
    // discount, the offer must be locked again FIRST — otherwise the same
    // discount could sit on this revived order AND a new cart at once. If the
    // customer already spent it elsewhere, the undo is refused (fail-closed).
    const needsReconsume = cur.status === "cancelled" && (cur.introDiscountCents ?? 0) > 0;
    if (needsReconsume) {
      let ok = false;
      try {
        ok = await reconsumeIntroOffer(cur.chatId);
      } catch (err) {
        logger.error({ err, orderId }, "reconsumeIntroOffer on undo failed");
      }
      if (!ok) {
        await bot.answerCallbackQuery(query.id, {
          text: "Can't undo — this order had the new-customer discount and the customer has since re-used it. Handle manually via /reply.",
          show_alert: true,
        });
        return;
      }
    }
    const reverted = await revertOrderToPending(
      orderId,
      cur.status as "confirmed" | "cancelled",
    );
    if (!reverted) {
      // Compensate: we locked the offer for an undo that didn't happen.
      if (needsReconsume) {
        try {
          await refundIntroOffer(cur.chatId, orderId);
        } catch (err) {
          logger.error({ err, orderId }, "compensating refundIntroOffer failed");
        }
      }
      await bot.answerCallbackQuery(query.id, {
        text: "Couldn't undo — order moved on.",
        show_alert: false,
      });
      return;
    }
    await bot.answerCallbackQuery(query.id, { text: `↩️ #${orderId} back to pending` });

    // Restore the Confirm/Decline keyboard so the team can re-action it.
    await tryReplaceFooter(
      bot,
      query,
      `_↩️ reverted to pending by_ \`${actorChatId}\``,
      orderAlertKeyboard(orderId, reverted.chatId),
    );

    // Quiet peer mirror so the rest of the team knows the undo happened.
    const peerMsg = `↩️ *Order #${orderId}* reverted to pending by \`${actorChatId}\`.`;
    for (const id of await getOrderRecipients()) {
      if (id === actorChatId) continue;
      try {
        await bot.sendMessage(id, peerMsg, { parse_mode: "Markdown" });
      } catch (err) {
        logger.error({ err, peer: id, orderId }, "applyOrderTransition: undo peer mirror failed");
      }
    }
    return;
  }

  const toStatus: "confirmed" | "cancelled" = op === "cnf" ? "confirmed" : "cancelled";

  // Look up the order so we can show a useful toast even if already processed.
  const all = await getOrders().catch((): Awaited<ReturnType<typeof getOrders>> => []);
  const order = all.find((o) => o.id === orderId);

  const result = await applyOrderTransition(bot, orderId, toStatus, actorChatId);

  if (!result.ok && result.alreadyProcessed) {
    const currentStatus = order?.status ?? "unknown";
    await bot.answerCallbackQuery(query.id, {
      text: `Already ${currentStatus} — no change.`,
      show_alert: false,
    });
    // Strip buttons so nobody else taps them.
    await tryReplaceFooter(bot, query, `_Order #${orderId} — already ${currentStatus}._`);
    return;
  }

  const verbToast = toStatus === "confirmed" ? `Confirmed #${orderId}` : `Declined #${orderId}`;
  await bot.answerCallbackQuery(query.id, { text: `✅ ${verbToast}` });

  // Edit the original alert: swap the Confirm/Decline buttons for a single
  // Undo button so the actor (or any mod) can revert a fat-finger.
  const verb = toStatus === "confirmed" ? "✅ confirmed" : "❌ declined";
  const mapsFooter = result.mapsLink ? `\n[🗺 Open in Maps](${result.mapsLink})` : "";
  await tryReplaceFooter(
    bot,
    query,
    `_${verb} by_ \`${actorChatId}\`${mapsFooter}`,
    { inline_keyboard: [[{ text: "↩️ Undo", callback_data: `ord:rev:${orderId}` }]] },
  );
}

// Edit the original alert: append a footer line and swap the inline keyboard.
// Pass `keyboard={inline_keyboard:[]}` (or omit) to strip buttons; pass a
// real keyboard to replace them (used for Undo and Restore-after-Undo).
async function tryReplaceFooter(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  footerLine: string,
  keyboard: TelegramBot.InlineKeyboardMarkup = { inline_keyboard: [] },
): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const original = query.message?.text;
  if (!chatId || !messageId || !original) return;
  // `query.message.text` is the rendered plain text — Telegram already stripped
  // the formatting markers, but any LITERAL markdown chars in customer notes /
  // delivery area (e.g. an underscore or bracket) survive and would be
  // re-interpreted as unbalanced markup, triggering "can't parse entities".
  // Escape the original body so it re-renders verbatim; the footer is built
  // from trusted values (numeric chat id + URL-encoded maps link) so it stays
  // markdown.
  const safeOriginal = escapeMarkdown(original);
  try {
    await bot.editMessageText(`${safeOriginal}\n\n${footerLine}`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("message is not modified")) return;
    logger.warn({ err }, "orderActions: edit failed");
  }
}
