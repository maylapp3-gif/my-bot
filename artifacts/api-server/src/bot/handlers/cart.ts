import TelegramBot from "node-telegram-bot-api";
import {
  getCart,
  getCartItem,
  getCartItemCount,
  addToCart,
  setCartItemQuantity,
  removeCartItem,
  clearCart,
  getCartPromo,
  setCartPromo,
  clearCartPromo,
  findPromoByCode,
  getVariantWithProduct,
  computeCartTotals,
  formatPriceCents,
  createOrderFromCart,
  OrderValidationError,
  getRelays,
  trackMessage,
  isRegular,
  getCartBundle,
  clearCartBundle,
  revalidateCartBundle,
  getSubscriber,
  getLoyaltyProgress,
  isNewcomerWithPending,
  type CartLine,
  type PromoCode,
  type CartTotals,
} from "../db.js";
import { orderAlertKeyboard } from "./orderActions.js";
import { cancelFallback } from "../moderation.js";
import { getOrderRecipients } from "../orderRecipients.js";
import { logger } from "../../lib/logger.js";
import { escapeMarkdown, cleanInput } from "../escape.js";
import {
  isOpenNow,
  afterHoursNotice,
  hoursLabelToday,
  todayHoursHuman,
  todayDeliveryHuman,
  todayDeliveryIsFullWindow,
} from "../hours.js";
import { isFarLateOrder } from "../deliveryFee.js";
import { pickupWindowLineForToday } from "./pickup.js";
import { emojiFor } from "../emoji.js";
import { getHappyHourState } from "../happyHour.js";
import { getStorewideDiscount } from "../storewide.js";
import { aiSanityCheck } from "./sanityCheck.js";

// ===========================================================================
// In-memory sessions
// ---------------------------------------------------------------------------
// Two short-lived flows live in memory:
//   1. "checkout"  — after Send Order, we collect area → time → notes
//   2. "promo"     — after Apply Promo, we wait for a promo code message
// Both auto-expire after 30 min and reset on bot restart (acceptable: we
// don't want stale 24h sessions blocking AI fallback).
// ===========================================================================
type CheckoutStep = "awaiting_fulfilment" | "awaiting_group" | "awaiting_area" | "awaiting_time" | "awaiting_notes";
type Fulfilment = "delivery" | "pickup";
type CheckoutSession = {
  step: CheckoutStep;
  fulfilment?: Fulfilment;
  deliveryArea?: string;
  preferredTime?: string;
  // Snapshot of the delivery fee picked at the area step. `null` = geocode
  // failed → mod will confirm at the meet. `undefined` = not computed yet
  // (e.g. pickup, or step not reached). 0 = pickup or in-zone free.
  deliveryFeeCents?: number | null;
  // Neighbour-grouping consent (delivery only), captured at the awaiting_group
  // step. Fail-closed: only an explicit "yes" tap sets true.
  groupOptin?: boolean;
  startedAt: number;
};
function fulfilmentLabel(f: Fulfilment | undefined): string {
  return f === "pickup" ? "Pickup" : "Delivery";
}

// Checkout prompt strings shared between the fulfilment + group callbacks so
// the delivery area prompt reads identically whether the customer went through
// the neighbour-grouping offer or (pickup) skipped straight past it.
const DELIVERY_AREA_PROMPT =
  `*Step 2 of 4 — Where we dropping?*\n` +
  `Suburb + a cross-street or landmark — enough that we can find you.\n\n` +
  `_type /cancel to bail._`;
// Built at call time — the pickup window (if the admin set one today) is
// rendered from stored numbers, never from raw admin input.
function pickupAreaPrompt(pickupLine: string | null): string {
  const windowNote = pickupLine
    ? `⏰ *Extra pickup times today: ${pickupLine}* — on top of normal open hours.\n\n`
    : "";
  return (
    `*Step 2 of 4 — Which area suits you for pickup?*\n` +
    `A suburb + rough cross-street so we can pick a spot to meet.\n\n` +
    windowNote +
    `_Heads up: pickup means you'll meet us in person. After you Send Order, the team will message you here to lock in the exact spot + time._\n\n` +
    `_type /cancel to bail._`
  );
}
// Step-1 copy shared by startCheckout and the cart "Send Order" callback.
// Windows are rendered at call time so they always show TODAY's schedule:
// pickups run the whole open window, deliveries only the delivery sub-window.
function checkoutStep1Text(pickupLine: string | null): string {
  return (
    `*Checkout — Step 1 of 4*\n\n*Delivery or pickup?*\n\n` +
    `🚗 *Delivery* — we come to you${todayDeliveryIsFullWindow() ? "" : ` (runs *${todayDeliveryHuman()}* today)`}. Fee depends on suburb (free in close zone).\n` +
    `🤝 *Pickup* — you meet us in person, any time we're on today (*${todayHoursHuman()}*).${pickupLine ? ` Extra pickup times today: *${pickupLine}* (on top of normal hours).` : ""} After you Send Order, the team will message you here to lock in the spot and time.`
  );
}
// Neighbour-grouping offer — an un-numbered interstitial (keeps the numbered
// flow at 4 steps for both delivery + pickup). No fee amounts, no locations,
// and it NEVER promises an outcome: the customer is never told whether we
// actually paired them (that signal, tied to their area, would leak another
// nearby customer). Any waiver is applied verbally at the meet.
const GROUP_OFFER_TEXT =
  `🤝 *Free delivery — fancy sharing a run?*\n\n` +
  `If you're happy for us to group your drop with another order heading out near you around the same time, we'll waive your delivery fee.\n\n` +
  `Got a mate or neighbour nearby who's also ordering? Time it together. Flying solo is fine too — we'll pair you with another nearby drop if we can.\n\n` +
  `_Totally optional — pickup and normal delivery are unchanged._`;
const SESSION_TTL_MS = 30 * 60 * 1000;
const checkoutSessions = new Map<string, CheckoutSession>();
const promoSessions = new Map<string, { startedAt: number }>();

function isExpired(s: { startedAt: number }): boolean {
  return Date.now() - s.startedAt > SESSION_TTL_MS;
}

export function hasCheckoutSession(chatId: string): boolean {
  const s = checkoutSessions.get(chatId);
  if (!s) return false;
  if (isExpired(s)) {
    checkoutSessions.delete(chatId);
    return false;
  }
  return true;
}

export function clearCheckoutSession(chatId: string): void {
  checkoutSessions.delete(chatId);
}

// Public entry — used by Flash Drop + One-Tap Reorder to skip the cart
// view and dive the customer straight into "Delivery or pickup?". The
// caller is responsible for making sure the cart isn't empty.
export async function startCheckout(bot: TelegramBot, chatId: string): Promise<void> {
  checkoutSessions.set(chatId, { step: "awaiting_fulfilment", startedAt: Date.now() });
  await bot.sendMessage(
    chatId,
    checkoutStep1Text(await pickupWindowLineForToday()),
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "🚗 Delivery", callback_data: "ca:fulfil:delivery" },
          { text: "🤝 Pickup", callback_data: "ca:fulfil:pickup" },
        ]],
      },
    },
  );
}

export function hasPromoSession(chatId: string): boolean {
  const s = promoSessions.get(chatId);
  if (!s) return false;
  if (isExpired(s)) {
    promoSessions.delete(chatId);
    return false;
  }
  return true;
}

export function clearPromoSession(chatId: string): void {
  promoSessions.delete(chatId);
}

// Combined helper for the global router — true if we should consume the
// next text message as part of an active cart-side session.
export function hasCartSession(chatId: string): boolean {
  return hasCheckoutSession(chatId) || hasPromoSession(chatId);
}

// ---------------------------------------------------------------------------
// Per-chat finalize mutex. Closes the double-tap race where two concurrent
// /checkouts can both pass isNewcomerWithPending or both clear the AI sanity
// check (which is async + may take seconds). In-memory is enough for the
// current single-process deployment; if we ever scale-out, swap for a
// pg_advisory_xact_lock on hashtext(chatId) inside createOrderFromCart's tx.
// ---------------------------------------------------------------------------
const finalizeInFlight = new Map<string, Promise<void>>();
export async function withFinalizeLock<T>(chatId: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (finalizeInFlight.has(chatId)) {
    // Already finalizing — drop the duplicate silently. The first call will
    // emit either a success or error message; we don't want to double-message.
    return undefined;
  }
  let resolveOuter: () => void = () => {};
  const gate = new Promise<void>((r) => { resolveOuter = r; });
  finalizeInFlight.set(chatId, gate);
  try {
    return await fn();
  } finally {
    finalizeInFlight.delete(chatId);
    resolveOuter();
  }
}

// ===========================================================================
// Rendering
// ===========================================================================
function summarizeLine(l: CartLine): string {
  return `${l.quantity}× ${l.variantLabel} ${l.productName}`;
}

function summarizeCart(lines: CartLine[]): string {
  return lines.map(summarizeLine).join(" · ");
}

function renderCartText(
  lines: CartLine[],
  promo: PromoCode | null,
  totals: CartTotals,
  promoCodeApplied: string | null,
  promoNote?: string,
  customerIsRegular?: boolean,
  loyaltyProgress?: { ordersUntilNext: number; rewardCents: number } | null,
): string {
  if (lines.length === 0) {
    const perksLine = customerIsRegular
      ? `\n\n✨ _Regular pricing locked in — free delivery up to 15km + $10 off every cart._`
      : `\n\n💎 _Not the price you usually pay? Tap *Contact* and ask about regular pricing._`;
    return (
      `🛒 *Your Cart*\n\n` +
      `_Empty._\n\n` +
      `Tap *Menu* to add items, then come back here to send your order.${perksLine}\n\n` +
      `${hoursLabelToday()}`
    );
  }

  const lineBlocks = lines.map((l, i) => {
    const emoji = emojiFor({ emoji: l.productEmoji, name: l.productName });
    return (
      `*${i + 1}.* ${emoji} *${escapeMarkdown(l.productName)}* — ${escapeMarkdown(l.variantLabel)}\n` +
      `    ${formatPriceCents(l.unitPriceCents)} × ${l.quantity} = *${formatPriceCents(l.lineTotalCents)}*`
    );
  });

  let footer = `\n──────────────\n*Subtotal*  ${formatPriceCents(totals.subtotalCents)}`;
  if (totals.introApplied && totals.introDiscountCents > 0) {
    footer += `\n*🎁 New-customer 50% off*  −${formatPriceCents(totals.introDiscountCents)}`;
  }
  if (promoCodeApplied) {
    if (totals.promoApplied) {
      footer += `\n*Promo* \`${escapeMarkdown(promoCodeApplied)}\`  −${formatPriceCents(totals.discountCents)}`;
    } else {
      footer += `\n_Promo \`${escapeMarkdown(promoCodeApplied)}\` couldn't be applied — ${escapeMarkdown(totals.promoReason ?? "invalid")}_`;
    }
  }
  if (totals.regularDiscountCents > 0) {
    footer += `\n*Regular* −${formatPriceCents(totals.regularDiscountCents)}`;
  }
  if (totals.storewideActive && totals.storewideDiscountCents > 0) {
    footer += `\n*${escapeMarkdown(totals.storewideLabel)}* −${formatPriceCents(totals.storewideDiscountCents)}`;
  }
  if (totals.bundleLabel && totals.bundleDiscountCents > 0) {
    footer += `\n*Bundle* _${escapeMarkdown(totals.bundleLabel)}_  −${formatPriceCents(totals.bundleDiscountCents)}`;
  }
  if (totals.happyHourActive && totals.happyHourDiscountCents > 0) {
    footer += `\n*Happy hour* (${totals.happyHourPercent}%)  −${formatPriceCents(totals.happyHourDiscountCents)}`;
  }
  if (totals.creditAppliedCents > 0) {
    footer += `\n*Credit*  −${formatPriceCents(totals.creditAppliedCents)}`;
  }
  footer += `\n*Total*     *${formatPriceCents(totals.totalCents)}*`;
  if (promoNote) footer += `\n\n_${escapeMarkdown(promoNote)}_`;
  // Parked-perk notes — discounts never combine, but a parked perk is never
  // lost either. Explain instead of silently dropping the line.
  if (totals.creditParked) {
    footer += `\n\n💳 _Your store credit is parked — discounts don't combine. It stays banked and auto-applies on your next eligible order._`;
  }
  // Offer still in the bank but this cart is over the $250 cap — tell them
  // how to use it rather than silently skipping it.
  if (totals.introEligible && !totals.introApplied && totals.subtotalCents > 0) {
    footer += `\n\n🎁 _Your 50% new-customer discount covers orders up to $250 — trim the cart under that to use it (it keeps until you do)._`;
  }
  // Surface regular vs non-regular status — non-regulars get the nudge to
  // DM the mod for upgraded pricing; regulars get the perks reminder. When
  // the $10 is parked (another perk holds the slot), say so — free delivery
  // is unaffected either way.
  if (customerIsRegular && totals.regularParked) {
    footer += `\n\n✨ _Regular perks: free delivery up to 15km. Your $10 regular discount is parked this order — discounts don't combine._`;
  } else if (customerIsRegular) {
    footer += `\n\n✨ _Regular pricing applied — free delivery up to 15km + $10 off your cart._`;
  } else {
    footer += `\n\n💎 _Not the price you usually pay? Tap *Contact* and ask about regular pricing._`;
  }
  footer += `\n\n💚 _Mix and match — tap *Menu* to add another strain or size to the same order._`;
  // Loyalty step-up nudge — sits between the perks line and the cash/hours
  // footer so it's visible right above Send Order. Skipped when the
  // customer is already at threshold (next confirm pays out automatically)
  // and when the lookup returned null (no subscriber row yet).
  if (loyaltyProgress && loyaltyProgress.ordersUntilNext > 0) {
    const noun = loyaltyProgress.ordersUntilNext === 1 ? "order" : "orders";
    footer += `\n\n🎯 _${loyaltyProgress.ordersUntilNext} more confirmed ${noun} → +${formatPriceCents(loyaltyProgress.rewardCents)} loyalty credit._`;
  }
  footer += `\n\n_cash on delivery · in person · ${hoursLabelToday()}_`;
  if (!isOpenNow()) footer += `\n\n${afterHoursNotice()}`;

  return `🛒 *Your Cart*\n\n${lineBlocks.join("\n\n")}\n${footer}`;
}

function renderCartKeyboard(
  lines: CartLine[],
  promoCodeApplied: string | null,
  bundleLabel?: string | null,
  introApplied?: boolean,
): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  // Per-line controls: −  +  🗑   (label tells admin which line: "1", "2"…)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    rows.push([
      { text: `${i + 1}.  −`, callback_data: `ca:dec:${l.cartItemId}` },
      { text: `${i + 1}.  +`, callback_data: `ca:inc:${l.cartItemId}` },
      { text: `${i + 1}.  🗑`, callback_data: `ca:rm:${l.cartItemId}` },
    ]);
  }

  if (lines.length > 0) {
    if (promoCodeApplied) {
      rows.push([{ text: `🎟 Remove promo (${promoCodeApplied})`, callback_data: "ca:rmpromo" }]);
    } else if (!introApplied) {
      // While the 50% intro offer is on, promos can't combine — hide the
      // button instead of offering a dead end.
      rows.push([{ text: "🎟 Apply promo code", callback_data: "ca:promo" }]);
    }
    if (bundleLabel) {
      rows.push([{ text: `🎁 Remove bundle (${bundleLabel})`, callback_data: "bn:rm" }]);
    }
    rows.push([{ text: "✅ Send Order", callback_data: "ca:checkout" }]);
    rows.push([{ text: "🧹 Clear cart", callback_data: "ca:clear" }]);
  } else {
    rows.push([{ text: "🛍 Open Menu", callback_data: "cm:browse" }]);
  }

  return { inline_keyboard: rows };
}

async function buildCartView(chatId: string): Promise<{
  text: string;
  keyboard: TelegramBot.InlineKeyboardMarkup;
  lines: CartLine[];
  totals: CartTotals;
  promo: PromoCode | null;
  promoCodeApplied: string | null;
}> {
  const lines = await getCart(chatId);
  const cartPromo = await getCartPromo(chatId);
  const customerIsRegular = await isRegular(chatId);
  let promo: PromoCode | null = null;
  if (cartPromo) {
    const found = await findPromoByCode(cartPromo.code);
    promo = found ?? null;
  }
  // Read the live bundle snapshot + available credit + happy-hour state so
  // the cart view matches what createOrderFromCart will compute at submit.
  const bundleRow = await getCartBundle(chatId).catch(() => undefined);
  const sub = await getSubscriber(chatId).catch(() => undefined);
  const hh = getHappyHourState();
  const storewide = getStorewideDiscount();
  // Loyalty progress is best-effort — a slow DB shouldn't block the cart
  // render. Null result silently suppresses the nudge.
  const loyaltyProgress = await getLoyaltyProgress(chatId).catch(() => null);
  const totals = computeCartTotals(lines, promo, {
    isRegular: customerIsRegular,
    bundleLabel: bundleRow?.label ?? null,
    bundleDiscountCents: bundleRow?.discountCents ?? 0,
    happyHourPercent: hh.active ? hh.percent : 0,
    storewideDiscountCents: storewide.active ? storewide.cents : 0,
    storewideLabel: storewide.label,
    availableCreditCents: sub?.creditCents ?? 0,
    introOfferEligible: sub?.verified === true && sub?.introOfferAvailable === true,
  });
  // If the stored promo no longer applies (expired/used out/inactive), clear it
  // silently so the view doesn't get stuck showing a broken promo line forever.
  // EXCEPT while the intro offer suppresses it — then the promo is only
  // "parked" and must survive so it comes back on the next (non-intro) cart.
  if (cartPromo && !totals.promoApplied && !totals.introApplied) {
    await clearCartPromo(chatId);
  }
  const promoCodeApplied = cartPromo && totals.promoApplied ? cartPromo.code : null;
  const promoNote =
    cartPromo && totals.introApplied
      ? `Promo ${cartPromo.code} is parked — it can't combine with your 50% new-customer offer and will be available again afterwards.`
      : undefined;
  return {
    text: renderCartText(lines, promo, totals, promoCodeApplied, promoNote, customerIsRegular, loyaltyProgress),
    keyboard: renderCartKeyboard(lines, promoCodeApplied, totals.bundleLabel, totals.introApplied),
    lines,
    totals,
    promo,
    promoCodeApplied,
  };
}

// ===========================================================================
// Public entry: open the cart in the chat (sends a fresh message).
// ===========================================================================
export async function openCart(bot: TelegramBot, chatId: string): Promise<void> {
  try {
    const view = await buildCartView(chatId);
    const sent = await bot.sendMessage(chatId, view.text, {
      parse_mode: "Markdown",
      reply_markup: view.keyboard,
    });
    await trackMessage(chatId, sent.message_id);
  } catch (err) {
    logger.error({ err }, "openCart error");
    await bot.sendMessage(chatId, "_Couldn't open your cart just now. Give it a sec and try again._", {
      parse_mode: "Markdown",
    });
  }
}

async function refreshCartMessage(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  noteForRender?: string,
): Promise<void> {
  const chatId = query.message?.chat.id?.toString();
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;
  const view = await buildCartView(chatId);
  const text = noteForRender
    ? `${view.text}\n\n_${escapeMarkdown(noteForRender)}_`
    : view.text;
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: view.keyboard,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("message is not modified")) return;
    // If the original message was a photo or any non-text origin we couldn't
    // edit — fall through to a fresh send so the customer always sees state.
    logger.warn({ err, chatId }, "refreshCartMessage edit failed, sending new cart message");
    await openCart(bot, chatId);
  }
}

// ===========================================================================
// "Add to cart" — called by the menu card variant buttons (cm:add:<vid>).
// ===========================================================================
export async function addVariantToCart(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  variantId: number,
): Promise<void> {
  const chatId = query.message?.chat.id?.toString();
  if (!chatId) return;

  const vp = await getVariantWithProduct(variantId);
  if (!vp || !vp.product.available) {
    await bot.answerCallbackQuery(query.id, { text: "No longer available.", show_alert: true });
    return;
  }
  await addToCart(chatId, variantId, 1);
  const count = await getCartItemCount(chatId);
  await bot.answerCallbackQuery(query.id, {
    text: `Added ${vp.variant.label} ${vp.product.name} — ${count} in cart`,
  });
}

// ===========================================================================
// Cart callback router (ca:*)
// ===========================================================================
const CB_PREFIX = "ca:";
export function isCartCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

export async function handleCartCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? "";
  if (!data.startsWith(CB_PREFIX)) return;
  const chatId = query.message?.chat.id?.toString();
  if (!chatId) return;
  const parts = data.slice(CB_PREFIX.length).split(":");
  const action = parts[0];

  try {
    switch (action) {
      case "open": {
        await bot.answerCallbackQuery(query.id);
        await openCart(bot, chatId);
        return;
      }
      case "inc":
      case "dec":
      case "rm": {
        const cartItemId = parseInt(parts[1] ?? "", 10);
        if (Number.isNaN(cartItemId)) {
          await bot.answerCallbackQuery(query.id);
          return;
        }
        const item = await getCartItem(cartItemId);
        if (!item || item.chatId !== chatId) {
          await bot.answerCallbackQuery(query.id, { text: "Item gone." });
          await refreshCartMessage(bot, query);
          return;
        }
        if (action === "inc") {
          await setCartItemQuantity(cartItemId, item.quantity + 1);
        } else if (action === "dec") {
          await setCartItemQuantity(cartItemId, item.quantity - 1);
        } else {
          await removeCartItem(cartItemId);
        }
        await revalidateCartBundle(chatId);
        await bot.answerCallbackQuery(query.id);
        await refreshCartMessage(bot, query);
        return;
      }
      case "clear": {
        await clearCart(chatId);
        await bot.answerCallbackQuery(query.id, { text: "Cart cleared." });
        await refreshCartMessage(bot, query);
        return;
      }
      case "promo": {
        // Stale-keyboard guard: if the 50% intro offer applies to the live
        // cart, promos can't combine — the fresh keyboard hides this button,
        // but an old message may still show it.
        const liveView = await buildCartView(chatId);
        if (liveView.totals.introApplied) {
          await bot.answerCallbackQuery(query.id, {
            text: "Your 50% new-customer offer is already applied — promos can't combine with it.",
            show_alert: true,
          });
          await refreshCartMessage(bot, query);
          return;
        }
        promoSessions.set(chatId, { startedAt: Date.now() });
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          `*Apply Promo*\n\nSend the promo code (e.g. \`LOCAL10\`).\n\n_type /cancel to bail._`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      case "rmpromo": {
        await clearCartPromo(chatId);
        await bot.answerCallbackQuery(query.id, { text: "Promo removed." });
        await refreshCartMessage(bot, query);
        return;
      }
      case "checkout": {
        const lines = await getCart(chatId);
        if (lines.length === 0) {
          await bot.answerCallbackQuery(query.id, {
            text: "Cart's empty — add something from the Menu first.",
            show_alert: true,
          });
          return;
        }
        await bot.answerCallbackQuery(query.id);
        checkoutSessions.set(chatId, { step: "awaiting_fulfilment", startedAt: Date.now() });
        await bot.sendMessage(
          chatId,
          checkoutStep1Text(await pickupWindowLineForToday()),
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "🚗 Delivery", callback_data: "ca:fulfil:delivery" },
                { text: "🤝 Pickup", callback_data: "ca:fulfil:pickup" },
              ]],
            },
          },
        );
        return;
      }
      case "fulfil": {
        const choice = parts[1];
        if (choice !== "delivery" && choice !== "pickup") {
          await bot.answerCallbackQuery(query.id);
          return;
        }
        const session = checkoutSessions.get(chatId);
        if (!session || session.step !== "awaiting_fulfilment") {
          await bot.answerCallbackQuery(query.id, { text: "Tap 🛒 Cart to start again." });
          return;
        }
        session.fulfilment = choice;
        await bot.answerCallbackQuery(query.id, { text: choice === "delivery" ? "Delivery" : "Pickup" });
        if (choice === "delivery") {
          // Delivery only: offer neighbour-grouping BEFORE asking for the area.
          // It's an un-numbered interstitial so the numbered "Step X of 4" flow
          // stays 4 steps for both paths.
          session.step = "awaiting_group";
          checkoutSessions.set(chatId, session);
          await bot.sendMessage(chatId, GROUP_OFFER_TEXT, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "🤝 Yes, group my drop", callback_data: "ca:group:yes" },
                { text: "No thanks", callback_data: "ca:group:no" },
              ]],
            },
          });
          return;
        }
        // Pickup: no delivery fee and no drive to batch → skip the offer.
        session.step = "awaiting_area";
        checkoutSessions.set(chatId, session);
        await bot.sendMessage(chatId, pickupAreaPrompt(await pickupWindowLineForToday()), { parse_mode: "Markdown" });
        return;
      }
      case "group": {
        const choice = parts[1];
        if (choice !== "yes" && choice !== "no") {
          await bot.answerCallbackQuery(query.id);
          return;
        }
        const session = checkoutSessions.get(chatId);
        if (!session || session.step !== "awaiting_group") {
          await bot.answerCallbackQuery(query.id, { text: "Tap 🛒 Cart to start again." });
          return;
        }
        // Record consent only. INVARIANT: we NEVER later tell the customer
        // whether a pairing actually happened — that signal, correlated with the
        // area they're about to type, would leak the existence/location of
        // another nearby customer. Any fee waiver is applied verbally at the meet.
        session.groupOptin = choice === "yes";
        session.step = "awaiting_area";
        checkoutSessions.set(chatId, session);
        await bot.answerCallbackQuery(query.id, {
          text: choice === "yes" ? "You're in — nice one" : "No worries",
        });
        await bot.sendMessage(chatId, DELIVERY_AREA_PROMPT, { parse_mode: "Markdown" });
        return;
      }
      case "cancel": {
        clearCheckoutSession(chatId);
        clearPromoSession(chatId);
        await bot.answerCallbackQuery(query.id, { text: "Cancelled." });
        return;
      }
      default:
        await bot.answerCallbackQuery(query.id);
        return;
    }
  } catch (err) {
    logger.error({ err, data }, "handleCartCallback error");
    try {
      await bot.answerCallbackQuery(query.id, { text: "Something glitched.", show_alert: true });
    } catch {}
  }
}

// ===========================================================================
// Promo code text input
// ===========================================================================
export async function handlePromoTextStep(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!hasPromoSession(chatId)) return;
  const text = cleanInput(msg.text);
  if (text === "/cancel" || !text) {
    clearPromoSession(chatId);
    await bot.sendMessage(chatId, "_Promo cancelled._", { parse_mode: "Markdown" });
    return;
  }
  const code = text.toUpperCase().replace(/\s+/g, "");
  const promo = await findPromoByCode(code);
  if (!promo) {
    clearPromoSession(chatId);
    await bot.sendMessage(chatId, `_Promo \`${escapeMarkdown(code)}\` not found._`, { parse_mode: "Markdown" });
    await openCart(bot, chatId);
    return;
  }
  // Validate it would actually apply against the current cart before storing.
  const lines = await getCart(chatId);
  const totals = computeCartTotals(lines, promo);
  if (!totals.promoApplied) {
    clearPromoSession(chatId);
    await bot.sendMessage(
      chatId,
      `_Couldn't apply \`${escapeMarkdown(code)}\` — ${escapeMarkdown(totals.promoReason ?? "invalid")}._`,
      { parse_mode: "Markdown" },
    );
    await openCart(bot, chatId);
    return;
  }
  await setCartPromo(chatId, code);
  clearPromoSession(chatId);
  await bot.sendMessage(chatId, `✅ Promo \`${escapeMarkdown(code)}\` applied.`, { parse_mode: "Markdown" });
  await openCart(bot, chatId);
}

// ===========================================================================
// Checkout step handler — area → time → notes → place order
// ===========================================================================
const MIN_AREA_LEN = 3;
const MIN_TIME_LEN = 2;

export async function handleCheckoutStep(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  const session = checkoutSessions.get(chatId);
  if (!session) return;
  if (isExpired(session)) {
    clearCheckoutSession(chatId);
    await bot.sendMessage(chatId, "_Your checkout session timed out. Tap 🛒 Cart to start again._", {
      parse_mode: "Markdown",
    });
    return;
  }
  const text = cleanInput(msg.text);
  if (text === "/cancel") {
    clearCheckoutSession(chatId);
    await bot.sendMessage(chatId, "_Checkout cancelled. Your cart is still saved._", { parse_mode: "Markdown" });
    return;
  }

  if (session.step === "awaiting_group") {
    // The offer is button-only. Nudge rather than consume typed text so a
    // customer who types instead of tapping doesn't get stuck.
    await bot.sendMessage(
      chatId,
      "_Tap a button above — 🤝 group my drop, or No thanks._",
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (session.step === "awaiting_area") {
    if (text.length < MIN_AREA_LEN) {
      await bot.sendMessage(chatId, "_Suburb + a cross-street or landmark, please._", { parse_mode: "Markdown" });
      return;
    }

    // We never compute or reveal the delivery fee at this step. Exposing
    // distance-band outcomes (free / $10 / $20 / out-of-range) here would
    // let customers build a geographic oracle that triangulates the private
    // service origin. The fee is always confirmed at the meet. For PICKUP:
    // fee is always 0.
    if (session.fulfilment === "delivery") {
      session.deliveryFeeCents = null; // mod confirms at the meet
    } else {
      session.deliveryFeeCents = 0;
    }

    session.deliveryArea = text;
    session.step = "awaiting_time";
    checkoutSessions.set(chatId, session);
    await bot.sendMessage(
      chatId,
      `*Step 3 of 4 — When?*\n\n_e.g. now · in an hour · 6pm tonight · 11am tomorrow_`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (session.step === "awaiting_time") {
    if (text.length < MIN_TIME_LEN) {
      await bot.sendMessage(chatId, "_A rough time is fine — even just 'now' or 'tonight'._", {
        parse_mode: "Markdown",
      });
      return;
    }
    session.preferredTime = text;
    session.step = "awaiting_notes";
    checkoutSessions.set(chatId, session);
    await bot.sendMessage(
      chatId,
      `*Step 4 of 4 — Anything else?*\n\nBuzzer code, door colour, how to spot you.\n\n_Type 'skip' if there's nothing._`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (session.step !== "awaiting_notes") return;

  const lower = text.toLowerCase();
  const notes = lower === "skip" || lower === "none" || lower === "" ? undefined : text;

  await finalizeOrder(bot, msg, session, notes);
}

async function finalizeOrder(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  session: CheckoutSession,
  notes?: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  // Per-chat mutex: drop a duplicate Send-Order tap silently. Closes the
  // double-tap race where two concurrent finalizes can both pass the
  // newcomer cooldown or both clear the AI sanity check.
  await withFinalizeLock(chatId, () => finalizeOrderInner(bot, msg, session, notes));
}

async function finalizeOrderInner(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  session: CheckoutSession,
  notes?: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  const customerName =
    cleanInput([msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ")) || "Unknown";

  try {
    const lines = await getCart(chatId);
    if (lines.length === 0) {
      clearCheckoutSession(chatId);
      await bot.sendMessage(chatId, "_Your cart is empty. Tap Menu to add items._", {
        parse_mode: "Markdown",
      });
      return;
    }
    const cartPromo = await getCartPromo(chatId);
    const promo = cartPromo ? (await findPromoByCode(cartPromo.code)) ?? null : null;
    // Snapshot regular status here (the customer's last cart view used the
    // same flag). createOrderFromCart honors this snapshot so admin removing
    // a regular mid-checkout can't change the total the customer confirmed.
    const customerIsRegular = await isRegular(chatId);
    // Newcomer cooldown — block a brand-new customer (joined < 1h) who already
    // has a pending order from queueing a second one. Friendly text, not a
    // ban — they can come back after their first order is confirmed.
    if (await isNewcomerWithPending(chatId)) {
      clearCheckoutSession(chatId);
      await bot.sendMessage(
        chatId,
        `_We're still processing your first order — hang tight, the team will hit you up shortly. Tap *My Orders* to track it. Your cart is saved._`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    // AI sanity check — gated by AI_SANITY_CHECK_ENABLED. Fails open. If it
    // flags something, block the order. Customer sees a GENERIC message
    // (model output may name addresses/categories — never echo to customer).
    // Mods see the full model reason in the relay below.
    const orderTextForCheck =
      `Items: ${lines.map((l) => `${l.quantity}× ${l.variantLabel} ${l.productName}`).join(", ")}\n` +
      `Where: ${session.deliveryArea ?? ""}\n` +
      `When: ${session.preferredTime ?? ""}\n` +
      `Notes: ${notes ?? ""}`;
    const sanity = await aiSanityCheck(orderTextForCheck);
    if (!sanity.ok) {
      clearCheckoutSession(chatId);
      await bot.sendMessage(
        chatId,
        `_We couldn't auto-send that one — the team will reach out shortly. Your cart is saved._`,
        { parse_mode: "Markdown" },
      );
      const peerMsg =
        `🚧 *Order auto-blocked* by sanity check\n\n` +
        `Customer: \`${chatId}\` (${escapeMarkdown(customerName)})\n` +
        `Reason: _${escapeMarkdown(sanity.reason)}_\n\n` +
        `Order text:\n\`\`\`\n${orderTextForCheck.slice(0, 800)}\n\`\`\``;
      for (const id of await getOrderRecipients()) {
        try {
          await bot.sendMessage(id, peerMsg, { parse_mode: "Markdown" });
        } catch (err) {
          logger.error({ err, peer: id }, "sanity check recipient notify failed");
        }
      }
      return;
    }
    // Compute the cart-render-time totals snapshot. createOrderFromCart will
    // re-compute authoritatively inside the tx using live bundle + credit
    // values; this snapshot is only used for delivery-fee math + relay text.
    const bundleRow = await getCartBundle(chatId).catch(() => undefined);
    const sub = await getSubscriber(chatId).catch(() => undefined);
    const hh = getHappyHourState();
    const storewide = getStorewideDiscount();
    const totals = computeCartTotals(lines, promo, {
      isRegular: customerIsRegular,
      bundleLabel: bundleRow?.label ?? null,
      bundleDiscountCents: bundleRow?.discountCents ?? 0,
      happyHourPercent: hh.active ? hh.percent : 0,
      storewideDiscountCents: storewide.active ? storewide.cents : 0,
      storewideLabel: storewide.label,
      availableCreditCents: sub?.creditCents ?? 0,
      introOfferEligible: sub?.verified === true && sub?.introOfferAvailable === true,
    });

    const itemsSummary = lines.map((l) => `${l.quantity}× ${l.variantLabel} ${l.productName}`).join(" · ");

    let result: Awaited<ReturnType<typeof createOrderFromCart>>;
    try {
      result = await createOrderFromCart({
        chatId,
        customerName,
        customerUsername: msg.from?.username ?? null,
        deliveryArea: `[${fulfilmentLabel(session.fulfilment)}] ${session.deliveryArea ?? ""}`,
        preferredTime: session.preferredTime ?? "",
        notes,
        itemsSummary,
        cartLines: lines,
        totals,
        promoCode: totals.promoApplied && cartPromo ? cartPromo.code : null,
        deliveryFeeCents: session.deliveryFeeCents,
        groupOptin: session.fulfilment === "delivery" && session.groupOptin === true,
        happyHourPercent: hh.active ? hh.percent : 0,
      });
    } catch (err) {
      if (err instanceof OrderValidationError) {
        clearCheckoutSession(chatId);
        // The promo paths also clear the stuck cart promo so re-rendering the
        // cart doesn't keep showing a discount that no longer applies.
        if (
          err.code === "PROMO_INVALID" ||
          err.code === "PROMO_EXPIRED" ||
          err.code === "PROMO_USED_OUT"
        ) {
          await clearCartPromo(chatId);
        }
        const userMsg =
          err.code === "EMPTY_CART"
            ? "_Your cart is empty. Tap Menu to add items._"
            : err.code === "CART_CHANGED"
              ? "_One of your items changed (size removed or price updated) while you were checking out. Tap 🛒 Cart, take a look, and Send Order again._"
              : err.code === "PROMO_USED_OUT"
                ? "_That promo just got fully redeemed. We removed it — tap 🛒 Cart and Send Order again._"
                : err.code === "PROMO_EXPIRED"
                  ? "_That promo expired. We removed it — tap 🛒 Cart and Send Order again._"
                  : "_That promo isn't valid anymore. We removed it — tap 🛒 Cart and Send Order again._";
        await bot.sendMessage(chatId, userMsg, { parse_mode: "Markdown" });
        return;
      }
      throw err;
    }

    clearCheckoutSession(chatId);
    // Cancel any pending AI fallback timer — the customer just transacted,
    // they don't need the AI checking in 5 min later.
    cancelFallback(chatId);

    // Use the AUTHORITATIVE values returned from the transaction — never the
    // pre-tx `lines`/`totals`/`cartPromo` snapshot, which could be stale.
    const order = result.order;
    const authLines = result.authoritativeLines;
    const authTotals = result.authoritativeTotals;
    const authPromo = result.authoritativePromoCode;
    const open = isOpenNow();
    // Neighbour-grouping consent for THIS order (delivery only). Drives the
    // receipt line, the copy block, and the team badge. We never surface a
    // pairing OUTCOME to the customer — see the ordersTable.groupOptin invariant.
    const grouped = session.fulfilment === "delivery" && session.groupOptin === true;
    // TEAM-SIDE FAR+LATE advisory. Computed once here, shown ONLY on the
    // mod/relay card — never in any customer-facing message (see the oracle
    // invariant in deliveryFee.ts). Fail-quiet: any error means no flag.
    let farLate = false;
    if (session.fulfilment === "delivery") {
      try {
        farLate = await isFarLateOrder(session.deliveryArea ?? "");
      } catch {
        farLate = false;
      }
    }

    // ---- Customer confirmation ----
    // Pre-order awareness: tag each pre-order line and, if any, show a
    // banner near the top so the customer isn't surprised that their
    // contact has to confirm a drop date.
    const hasPreorder = authLines.some((l) => l.productPreorder);
    const itemBlocks = authLines
      .map((l) => {
        const e = emojiFor({ emoji: l.productEmoji, name: l.productName });
        const tag = l.productPreorder ? " 🕒" : "";
        return `${e} *${escapeMarkdown(l.productName)}*${tag} — ${escapeMarkdown(l.variantLabel)} × ${l.quantity}  =  *${formatPriceCents(l.lineTotalCents)}*`;
      })
      .join("\n");
    const preorderBanner = hasPreorder
      ? `\n🕒 _Includes pre-order items — your contact will confirm the drop date._\n`
      : "";

    let summary =
      `*Order #${order.id} — locked in*\n${preorderBanner}\n` +
      `${itemBlocks}\n\n` +
      `*Subtotal*  ${formatPriceCents(authTotals.subtotalCents)}\n`;
    if (authTotals.introApplied && authTotals.introDiscountCents > 0) {
      summary += `*🎁 New-customer 50% off*  −${formatPriceCents(authTotals.introDiscountCents)}\n`;
    }
    if (authPromo) {
      summary += `*Promo* \`${escapeMarkdown(authPromo)}\`  −${formatPriceCents(authTotals.discountCents)}\n`;
    }
    if (authTotals.regularDiscountCents > 0) {
      summary += `*Regular* −${formatPriceCents(authTotals.regularDiscountCents)}\n`;
    }
    if (authTotals.storewideActive && authTotals.storewideDiscountCents > 0) {
      summary += `*${escapeMarkdown(authTotals.storewideLabel)}* −${formatPriceCents(authTotals.storewideDiscountCents)}\n`;
    }
    if (authTotals.bundleLabel && authTotals.bundleDiscountCents > 0) {
      summary += `*Bundle* _${escapeMarkdown(authTotals.bundleLabel)}_ −${formatPriceCents(authTotals.bundleDiscountCents)}\n`;
    }
    if (authTotals.happyHourActive && authTotals.happyHourDiscountCents > 0) {
      summary += `*Happy hour* (${authTotals.happyHourPercent}%) −${formatPriceCents(authTotals.happyHourDiscountCents)}\n`;
    }
    if (authTotals.creditAppliedCents > 0) {
      summary += `*Credit* −${formatPriceCents(authTotals.creditAppliedCents)}\n`;
    }
    if (session.fulfilment === "delivery") {
      if (!authTotals.deliveryFeeKnown) {
        summary += `*Delivery*  _confirmed at meet_\n`;
      } else if (authTotals.deliveryFeeCents === 0) {
        summary += `*Delivery*  free 🎉\n`;
      } else {
        summary += `*Delivery*  ${formatPriceCents(authTotals.deliveryFeeCents)}\n`;
      }
    }
    summary +=
      `*Total*     *${formatPriceCents(authTotals.totalCents)}*${authTotals.deliveryFeeKnown ? "" : "  _(+ delivery TBC)_"}\n\n` +
      `*${fulfilmentLabel(session.fulfilment)}*  ${escapeMarkdown(session.deliveryArea ?? "")}\n` +
      `*Time*  ${escapeMarkdown(session.preferredTime ?? "")}\n` +
      (notes ? `*Notes* ${escapeMarkdown(notes)}\n` : "") +
      (grouped
        ? `\n🤝 _Neighbour grouping is on — if we can pair your drop with another order nearby, delivery's on us._\n`
        : "") +
      `\n_cash on arrival · in person_\n` +
      (open ? "" : `\n${afterHoursNotice()}\n`);

    const sent = await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });
    await trackMessage(chatId, sent.message_id);

    // Second message: bare order text inside a Markdown code fence. On
    // Telegram mobile, code blocks render with a native "Copy" overlay — one
    // tap copies the whole block. The customer then pastes it back to the
    // human they were chatting with before. The bot never names that human
    // (no @, no link, no hint — protects the account separation).
    const copyName = customerName.replace(/[\r\n`]/g, " ");
    const copyLines = authLines
      .map((l) => `- ${l.quantity}x ${l.variantLabel} ${l.productName} = ${formatPriceCents(l.lineTotalCents)}`)
      .join("\n");
    let copyBlock =
      `Order #${order.id} — ${copyName}\n` +
      `${copyLines}\n` +
      `Subtotal: ${formatPriceCents(authTotals.subtotalCents)}\n`;
    if (authTotals.introDiscountCents > 0) copyBlock += `New-customer 50% off: -${formatPriceCents(authTotals.introDiscountCents)}\n`;
    if (authTotals.discountCents > 0 && authPromo) copyBlock += `Promo ${authPromo}: -${formatPriceCents(authTotals.discountCents)}\n`;
    if (authTotals.regularDiscountCents > 0) copyBlock += `Regular: -${formatPriceCents(authTotals.regularDiscountCents)}\n`;
    if (authTotals.storewideDiscountCents > 0) copyBlock += `${authTotals.storewideLabel}: -${formatPriceCents(authTotals.storewideDiscountCents)}\n`;
    if (authTotals.bundleDiscountCents > 0 && authTotals.bundleLabel) copyBlock += `Bundle (${authTotals.bundleLabel}): -${formatPriceCents(authTotals.bundleDiscountCents)}\n`;
    if (authTotals.happyHourDiscountCents > 0) copyBlock += `Happy hour: -${formatPriceCents(authTotals.happyHourDiscountCents)}\n`;
    if (authTotals.creditAppliedCents > 0) copyBlock += `Credit: -${formatPriceCents(authTotals.creditAppliedCents)}\n`;
    if (session.fulfilment === "delivery") {
      copyBlock += authTotals.deliveryFeeKnown
        ? `Delivery: ${authTotals.deliveryFeeCents === 0 ? "free" : formatPriceCents(authTotals.deliveryFeeCents)}\n`
        : `Delivery: TBC at meet\n`;
    }
    copyBlock +=
      `Total: ${formatPriceCents(authTotals.totalCents)} (cash)\n` +
      `${fulfilmentLabel(session.fulfilment)}: ${session.deliveryArea ?? ""}\n` +
      `Time: ${session.preferredTime ?? ""}\n` +
      (notes ? `Notes: ${notes}\n` : "") +
      (grouped ? `Grouping: happy to share a run (free delivery if paired)\n` : "");
    const customerCopy =
      `📋 *Tap to copy, then paste to the person you spoke to before:*\n` +
      "```\n" + copyBlock + "```";
    const copySent = await bot.sendMessage(chatId, customerCopy, { parse_mode: "Markdown" });
    await trackMessage(chatId, copySent.message_id);

    // ---- Fan out to mods + relays (deduped) ----
    const safeUsername = msg.from?.username ? ` (@${escapeMarkdown(msg.from.username)})` : "";
    const relayLines = authLines
      .map(
        (l) => {
          const tag = l.productPreorder ? " 🕒" : "";
          return `  • ${l.quantity}× ${escapeMarkdown(l.variantLabel)} ${escapeMarkdown(l.productName)}${tag}  —  ${formatPriceCents(l.lineTotalCents)}`;
        },
      )
      .join("\n");
    // Mod fanout: if any line is pre-order, surface a banner right under
    // the header so the mod knows they have to confirm a drop date in DM
    // before treating this like a same-day order.
    const preorderBannerMod = hasPreorder
      ? `\n⚠️ *PRE-ORDER ITEMS* — confirm a drop date with the customer in DM.\n`
      : "";
    let relayBody =
      `*Order #${order.id} — new*${preorderBannerMod}\n\n` +
      `*Customer*  ${escapeMarkdown(customerName)}${safeUsername}\n` +
      `*Chat*      \`${chatId}\`\n\n` +
      `*Items*\n${relayLines}\n\n` +
      `*Subtotal*  ${formatPriceCents(authTotals.subtotalCents)}\n`;
    if (authTotals.introApplied && authTotals.introDiscountCents > 0) {
      relayBody += `*New-customer 50% off* −${formatPriceCents(authTotals.introDiscountCents)}  🎁 _(first order)_\n`;
    }
    if (authPromo) {
      relayBody += `*Promo* \`${escapeMarkdown(authPromo)}\`  −${formatPriceCents(authTotals.discountCents)}\n`;
    }
    if (authTotals.regularDiscountCents > 0) {
      relayBody += `*Regular* −${formatPriceCents(authTotals.regularDiscountCents)}  ✨\n`;
    }
    if (authTotals.storewideActive && authTotals.storewideDiscountCents > 0) {
      relayBody += `*${escapeMarkdown(authTotals.storewideLabel)}* −${formatPriceCents(authTotals.storewideDiscountCents)}  🏷\n`;
    }
    if (authTotals.bundleLabel && authTotals.bundleDiscountCents > 0) {
      relayBody += `*Bundle* _${escapeMarkdown(authTotals.bundleLabel)}_ −${formatPriceCents(authTotals.bundleDiscountCents)}  🎁\n`;
    }
    if (authTotals.happyHourActive && authTotals.happyHourDiscountCents > 0) {
      relayBody += `*Happy hour* (${authTotals.happyHourPercent}%) −${formatPriceCents(authTotals.happyHourDiscountCents)}  ⏰\n`;
    }
    if (authTotals.creditAppliedCents > 0) {
      relayBody += `*Credit* −${formatPriceCents(authTotals.creditAppliedCents)}  💰\n`;
    }
    if (session.fulfilment === "delivery") {
      if (!authTotals.deliveryFeeKnown) {
        relayBody += `*Delivery*  TBC (geocode failed — confirm at meet)\n`;
      } else if (authTotals.deliveryFeeCents === 0) {
        relayBody += `*Delivery*  free (in-zone)\n`;
      } else {
        relayBody += `*Delivery*  ${formatPriceCents(authTotals.deliveryFeeCents)}\n`;
      }
    }
    if (grouped) {
      relayBody += `🤝 *GROUP-OK* — happy to be batched with a nearby order. Pair by area & waive delivery on a grouped run.\n`;
    }
    if (farLate) {
      relayBody += `⏰ *FAR + LATE* — long run at this hour. Consider lining this one up for tomorrow instead of a second trip out.\n`;
    }
    relayBody +=
      `*Total*     *${formatPriceCents(authTotals.totalCents)}*${authTotals.deliveryFeeKnown ? "" : "  _(+ delivery TBC)_"}  (cash)\n\n` +
      `*${fulfilmentLabel(session.fulfilment)}*  ${escapeMarkdown(session.deliveryArea ?? "")}\n` +
      `*Time*  ${escapeMarkdown(session.preferredTime ?? "")}\n` +
      (notes ? `*Notes* ${escapeMarkdown(notes)}\n` : "") +
      `\n_Tap *Confirm*, *Decline*, or *💬 Reply* below._`;

    const recipients = await collectRecipients();
    const keyboard = orderAlertKeyboard(order.id, chatId);
    for (const id of recipients) {
      try {
        await bot.sendMessage(id, relayBody, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      } catch (err) {
        logger.error({ err, recipientId: id }, "Failed to fan out order");
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, "finalizeOrder error");
    clearCheckoutSession(chatId);
    await bot.sendMessage(
      chatId,
      "_Something glitched placing your order. Tap 🛒 Cart and try Send Order again._",
      { parse_mode: "Markdown" },
    );
  }
}

async function collectRecipients(): Promise<string[]> {
  // Orders go to relay channels only when at least one is configured. Falls
  // back to mod DMs only if no relay exists yet, so orders never disappear
  // during initial setup. See orderRecipients.ts for the shared policy.
  return getOrderRecipients();
}

// Re-exported helper for the customer-menu handler to render an "added — N in cart" toast.
export async function getCartCount(chatId: string): Promise<number> {
  return getCartItemCount(chatId);
}

// Internal helper — not exported widely. Used by openCart's empty-state link.
export { summarizeCart };
