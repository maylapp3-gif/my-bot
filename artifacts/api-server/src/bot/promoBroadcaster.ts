import cron from "node-cron";
import type TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import {
  getActiveSubscribers,
  getAvailableProducts,
  getProductVariants,
  removeSubscriber,
  trackMessage,
} from "./db.js";
import type { Product, ProductVariant } from "@workspace/db/schema";
import { generatePromoCopy } from "./aiPromo.js";
import { getJson, putJson } from "./objectStorage.js";
import { isAdmin, getAdminIds } from "./handlers/admin.js";
import { isModerator } from "./moderation.js";
import { TIMEZONE, LOCALE_DATEKEY } from "./brand.js";
import { todayHours, hoursLabelToday } from "./hours.js";

// ---------------------------------------------------------------------------
// AI-powered daily promo broadcaster.
//
// Once per day, during open hours (15:00–21:00 business time), we pick a product
// (favouring fresh-in-rotation drops, avoiding repeats), have the AI write a
// short promo in the brand voice, and fan it out to every active subscriber
// — with the product photo as the hero when available.
//
// Time-of-day randomisation strategy (the "smart placement" requirement):
// - Cron ticks every 30 min.
// - Each tick that lands inside the window is a "slot" (13 slots).
// - If we haven't fired today, roll a 1/(remaining slots) dice. Probability
//   reaches 100% on the last slot, so we always fire by 21:00. The expected
//   firing time is uniformly distributed across the window — which means a
//   different time every day, naturally, with zero hand-tuning. And it
//   survives restarts: state is persisted to object storage.
// ---------------------------------------------------------------------------

const STATE_KEY = "settings/promo-broadcaster.json";

interface PromoState {
  enabled: boolean;
  lastFiredAtIso: string | null;
  lastFiredLocalDate: string | null; // YYYY-MM-DD
  recentlyPromotedIds: number[]; // most recent first, capped at 3
}

const DEFAULT_STATE: PromoState = {
  enabled: true,
  lastFiredAtIso: null,
  lastFiredLocalDate: null,
  recentlyPromotedIds: [],
};

const FRESH_WINDOW_DAYS = 14;
const RECENT_AVOIDANCE = 3;
const FRESH_POOL_BIAS = 0.4; // 40% chance to draw from fresh pool when non-empty
// Slot window in the business timezone. By default it tracks each day's
// open hours (open+1 .. close-1 — never in the first or last open hour),
// so it moves with the per-weekday schedule in brand.ts. If BOTH
// PROMO_SLOT_FIRST_HOUR and PROMO_SLOT_LAST_HOUR env vars are set (and
// valid), that fixed pair applies to every day instead.
const SLOT_FIRST_ENV = parseSlotHour(process.env.PROMO_SLOT_FIRST_HOUR, -1);
const SLOT_LAST_ENV = parseSlotHour(process.env.PROMO_SLOT_LAST_HOUR, -1);
const SLOT_ENV_FIXED = SLOT_FIRST_ENV >= 0 && SLOT_LAST_ENV >= 0 && SLOT_FIRST_ENV < SLOT_LAST_ENV;
function parseSlotHour(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) return def;
  return n;
}
function fmtHour12(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${period}`;
}
// Today's firing window. Derived per-call — never cache: hours vary by day.
function slotWindow(now: Date = new Date()): { first: number; last: number } {
  if (SLOT_ENV_FIXED) return { first: SLOT_FIRST_ENV, last: SLOT_LAST_ENV };
  const { open, close } = todayHours(now);
  const first = open + 1;
  const last = close - 1;
  // Degrade gracefully if a fork configures a very short day.
  return first <= last ? { first, last } : { first: open, last: Math.max(open, close - 1) };
}
function slotWindowHuman(now: Date = new Date()): string {
  const w = slotWindow(now);
  return `${fmtHour12(w.first)}–${fmtHour12(w.last)}`;
}
const BROADCAST_DELAY_MS = 36; // ~28 msgs/sec — same pacing as /broadcast

let started = false;
let inFlight = false;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
async function loadState(): Promise<PromoState> {
  try {
    const s = await getJson<PromoState>(STATE_KEY);
    if (!s) return { ...DEFAULT_STATE };
    return {
      enabled: typeof s.enabled === "boolean" ? s.enabled : true,
      lastFiredAtIso: s.lastFiredAtIso ?? null,
      lastFiredLocalDate: s.lastFiredLocalDate ?? null,
      recentlyPromotedIds: Array.isArray(s.recentlyPromotedIds) ? s.recentlyPromotedIds.slice(0, RECENT_AVOIDANCE) : [],
    };
  } catch (err) {
    logger.error({ err }, "promoBroadcaster: failed to load state, using defaults");
    return { ...DEFAULT_STATE };
  }
}

async function saveState(s: PromoState): Promise<void> {
  await putJson(STATE_KEY, s);
}

// ---------------------------------------------------------------------------
// Business-timezone helpers — local copies to keep this self-contained.
// ---------------------------------------------------------------------------
function localParts(now: Date = new Date()): { date: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat(LOCALE_DATEKEY, {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = parseInt(get("hour"), 10);
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: hour === 24 ? 0 : hour,
    minute: parseInt(get("minute"), 10),
  };
}

// Slots are every half hour inside today's window, e.g. Mon (4pm–8pm):
// 16:00, 16:30, ..., 20:00 → 9 slots. Slot count varies by weekday, so both
// helpers take `now` and derive from the SAME day's window.
function totalSlots(now: Date = new Date()): number {
  const w = slotWindow(now);
  return (w.last - w.first) * 2 + 1;
}

function currentSlotIndex(now: Date = new Date()): number | null {
  const { hour, minute } = localParts(now);
  const w = slotWindow(now);
  if (hour < w.first) return null;
  if (hour > w.last) return null;
  if (hour === w.last && minute >= 30) return null; // past last slot
  // Snap minute to 0 or 30. Allow a few minutes of cron jitter.
  const slotMinute = minute < 30 ? 0 : 30;
  const idx = (hour - w.first) * 2 + (slotMinute === 30 ? 1 : 0);
  return idx;
}

// ---------------------------------------------------------------------------
// Product picker
// ---------------------------------------------------------------------------
interface PickedProduct {
  product: Product;
  variants: ProductVariant[];
  isFresh: boolean;
}

// Build a PickedProduct for ONE specific product (admin "broadcast this
// product" button). Unlike pickProduct it never randomises — but it enforces
// the same guardrails: the product must be live on the menu and have at least
// one buyable size, so a broadcast can never point customers at something
// hidden or fully sold out. Returns a plain-language skip reason otherwise.
async function pickSpecificProduct(productId: number): Promise<PickedProduct | { skipped: string }> {
  const products = await getAvailableProducts();
  const p = products.find((x) => x.id === productId);
  if (!p) return { skipped: "that product isn't live on the menu right now (hidden or removed), so customers couldn't buy it" };
  const variants = await getProductVariants(p.id).catch(() => [] as ProductVariant[]);
  const buyable = variants.filter((v) => v.stock !== "sold_out");
  if (!buyable.length) return { skipped: "every size of that product is sold out — nothing to promote" };
  const freshThreshold = Date.now() - FRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const createdMs = p.createdAt instanceof Date ? p.createdAt.getTime() : new Date(p.createdAt).getTime();
  return { product: p, variants: buyable, isFresh: createdMs >= freshThreshold };
}

async function pickProduct(state: PromoState): Promise<PickedProduct | null> {
  const products = await getAvailableProducts();
  if (!products.length) return null;

  // Hydrate variants and filter to purchasable products only.
  const hydrated: { product: Product; variants: ProductVariant[]; isFresh: boolean }[] = [];
  const freshThreshold = Date.now() - FRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  for (const p of products) {
    const variants = await getProductVariants(p.id).catch(() => [] as ProductVariant[]);
    // Only promote sizes the customer can actually buy. A product whose every
    // size is sold out must never be promoted; a mixed product is still
    // promotable but only its buyable sizes are carried forward, so the AI
    // copy's "Sizes available" line can never name a sold-out size. 'low' is
    // buyable (just a customer-facing badge) — match the convention in ai.ts.
    const buyable = variants.filter((v) => v.stock !== "sold_out");
    if (!buyable.length) continue; // nothing buyable → can't promote this product
    const createdMs = p.createdAt instanceof Date ? p.createdAt.getTime() : new Date(p.createdAt).getTime();
    hydrated.push({ product: p, variants: buyable, isFresh: createdMs >= freshThreshold });
  }
  if (!hydrated.length) return null;

  const recent = new Set(state.recentlyPromotedIds);

  const fresh = hydrated.filter((h) => h.isFresh && !recent.has(h.product.id));
  const allFiltered = hydrated.filter((h) => !recent.has(h.product.id));

  // If filtering by recency wiped the pool (small catalogue), fall back to all.
  const allPool = allFiltered.length > 0 ? allFiltered : hydrated;

  let pool: typeof hydrated;
  if (fresh.length > 0 && Math.random() < FRESH_POOL_BIAS) {
    pool = fresh;
  } else {
    pool = allPool;
  }

  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------
function isPermanentDeliveryFailure(err: unknown): boolean {
  const e = err as { response?: { body?: { error_code?: number; description?: string } }; code?: number };
  const code = e?.response?.body?.error_code ?? e?.code;
  const desc = (e?.response?.body?.description ?? "").toLowerCase();
  if (code === 403) return true;
  if (
    desc.includes("bot was blocked") ||
    desc.includes("user is deactivated") ||
    desc.includes("chat not found") ||
    desc.includes("user not found") ||
    desc.includes("group chat was deactivated")
  ) {
    return true;
  }
  return false;
}

interface BroadcastReport {
  productId: number;
  productName: string;
  delivered: number;
  removed: number;
  transientFailures: number;
  totalSubscribers: number;
  copy: string;
  hadPhoto: boolean;
}

// ---------------------------------------------------------------------------
// Facts footer — the actionable half of the blast, built from TRUSTED data
// (DB rows + hours config), never the AI. Sizes with real prices, today's
// hours, and the CTA. This guarantees every blast carries useful info even
// when the AI copy above it has an off day, and prices can't be hallucinated.
// ---------------------------------------------------------------------------
function centsHuman(c: number): string {
  return c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
}

function buildFactsFooter(picked: PickedProduct): string {
  const sizes = [...picked.variants]
    .sort((a, b) => a.priceCents - b.priceCents)
    .map((v) => `${v.label} ${centsHuman(v.priceCents)}`)
    .join(" · ");
  const lines = [
    sizes ? `On the menu: ${sizes}` : "",
    hoursLabelToday(),
    "Tap Menu to order.",
  ].filter(Boolean);
  return lines.join("\n");
}

async function fanOutPromo(bot: TelegramBot, picked: PickedProduct, copy: string): Promise<BroadcastReport> {
  const subs = await getActiveSubscribers();
  let delivered = 0;
  let removed = 0;

  const hasPhoto = !!picked.product.imageUrl;

  // Track every delivered promo so the 24h chat sweep deletes it like every
  // other bot message (forensic minimization is non-negotiable). If tracking
  // throws, delete the message we just sent rather than leave a customer-facing
  // message that would escape the sweep — fail-closed, mirrors
  // followUpReminder / selfDestruct.
  const trackOrDelete = async (chatId: string, messageId: number): Promise<void> => {
    try {
      await trackMessage(chatId, messageId);
    } catch (trackErr) {
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (delErr) {
        logger.error({ err: delErr, subChatId: chatId }, "promoBroadcaster: cleanup delete failed (untracked promo may survive past 24h)");
      }
      logger.error({ err: trackErr, subChatId: chatId }, "promoBroadcaster: trackMessage failed — promo deleted to honour 24h purge");
    }
  };

  // Send AI output as plain text — the AI might emit unbalanced Markdown
  // (mismatched *, _, [, etc.) which would make Telegram reject the entire
  // message with parse_mode set. Plain text is the safe path for an
  // untrusted-shape generator. The visual punch comes from the photo.
  for (const sub of subs) {
    try {
      let sent: TelegramBot.Message;
      if (hasPhoto && picked.product.imageUrl) {
        try {
          sent = await bot.sendPhoto(sub.chatId, picked.product.imageUrl, {
            caption: copy,
          });
        } catch (photoErr) {
          // If the photo fails (e.g. Telegram rejects the URL for one user),
          // fall through to a text send for that subscriber so they still get
          // the promo. Re-throw permanent failures so the outer catch handles
          // subscriber removal.
          if (isPermanentDeliveryFailure(photoErr)) throw photoErr;
          logger.warn({ err: photoErr, subChatId: sub.chatId }, "promoBroadcaster: photo send failed, falling back to text");
          sent = await bot.sendMessage(sub.chatId, copy);
        }
      } else {
        sent = await bot.sendMessage(sub.chatId, copy);
      }
      await trackOrDelete(sub.chatId, sent.message_id);
      delivered++;
    } catch (err) {
      if (isPermanentDeliveryFailure(err)) {
        // NEVER auto-deactivate the operator's own chats. A transient
        // Telegram hiccup that *looks* permanent (or a mis-set env) would
        // otherwise silently drop an admin/mod off the subscriber list —
        // and they'd stop seeing the daily promo with zero explanation.
        if (isAdmin(sub.chatId) || isModerator(sub.chatId)) {
          logger.error({ err, subChatId: sub.chatId }, "promoBroadcaster: permanent-looking failure on an ADMIN/MOD chat — NOT deactivating");
        } else {
          try {
            await removeSubscriber(sub.chatId);
            removed++;
          } catch (deactErr) {
            logger.error({ err: deactErr, subChatId: sub.chatId }, "promoBroadcaster: failed to deactivate dead subscriber");
          }
          logger.info({ subChatId: sub.chatId }, "promoBroadcaster: auto-deactivated subscriber after permanent failure");
        }
      } else {
        logger.error({ err, subChatId: sub.chatId }, "promoBroadcaster: send failed (transient)");
      }
    }
    await new Promise((r) => setTimeout(r, BROADCAST_DELAY_MS));
  }

  return {
    productId: picked.product.id,
    productName: picked.product.name,
    delivered,
    removed,
    transientFailures: subs.length - delivered - removed,
    totalSubscribers: subs.length,
    copy,
    hadPhoto: hasPhoto,
  };
}

// ---------------------------------------------------------------------------
// Core fire — picks product, writes copy, fans out, updates state.
// `forced=true` skips the "already fired today" guard so admins can blast.
// ---------------------------------------------------------------------------
async function fireOnce(bot: TelegramBot, opts: { forced: boolean; productId?: number }): Promise<BroadcastReport | { skipped: string }> {
  if (inFlight) return { skipped: "another broadcast is already in flight" };
  inFlight = true;
  try {
    const state = await loadState();
    const today = localParts().date;

    if (!opts.forced) {
      if (!state.enabled) return { skipped: "broadcaster disabled" };
      if (state.lastFiredLocalDate === today) return { skipped: "already fired today" };
    }

    let picked: PickedProduct;
    if (opts.productId != null) {
      // Admin picked a specific product to blast (menu → 📣 Broadcast).
      const res = await pickSpecificProduct(opts.productId);
      if ("skipped" in res) return res;
      picked = res;
    } else {
      const p = await pickProduct(state);
      if (!p) return { skipped: "no purchasable products with variants found" };
      picked = p;
    }

    const aiCopy = await generatePromoCopy({
      product: picked.product,
      variants: picked.variants,
      isFresh: picked.isFresh,
    });
    const copy = `${aiCopy}\n\n${buildFactsFooter(picked)}`;

    const report = await fanOutPromo(bot, picked, copy);

    // Re-read state right before save so we don't clobber an admin's
    // `/promo_broadcast off` toggle that landed mid-blast. Only mark the
    // day as "fired" if at least one customer actually received the promo
    // — a 0-delivered run means something went wrong (e.g. all sends were
    // transient failures) and we want the next slot to retry.
    const fresh = await loadState();
    const dayMarker = report.delivered > 0 ? today : fresh.lastFiredLocalDate;
    const next: PromoState = {
      enabled: fresh.enabled,
      lastFiredAtIso: report.delivered > 0 ? new Date().toISOString() : fresh.lastFiredAtIso,
      lastFiredLocalDate: dayMarker,
      recentlyPromotedIds:
        report.delivered > 0
          ? [picked.product.id, ...fresh.recentlyPromotedIds.filter((id) => id !== picked.product.id)].slice(0, RECENT_AVOIDANCE)
          : fresh.recentlyPromotedIds,
    };
    await saveState(next);

    logger.info(
      { productId: picked.product.id, productName: picked.product.name, delivered: report.delivered, total: report.totalSubscribers, forced: opts.forced },
      "promoBroadcaster: daily promo sent",
    );
    return report;
  } finally {
    inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Cron tick — the dice roll lives here.
// ---------------------------------------------------------------------------
async function tick(bot: TelegramBot): Promise<void> {
  const now = new Date();
  const slot = currentSlotIndex(now);
  if (slot === null) return; // outside the firing window

  const state = await loadState();
  if (!state.enabled) return;

  const today = localParts().date;
  if (state.lastFiredLocalDate === today) return;

  const remaining = totalSlots(now) - slot; // includes this slot
  const probability = 1 / Math.max(1, remaining);
  const dice = Math.random();

  if (dice >= probability) {
    logger.debug({ slot, remaining, probability, dice }, "promoBroadcaster: dice did not roll, skipping this slot");
    return;
  }

  logger.info({ slot, remaining, probability }, "promoBroadcaster: dice rolled, firing");
  try {
    const result = await fireOnce(bot, { forced: false });
    if ("skipped" in result) {
      // Abnormal skip (e.g. no purchasable products) — tell the admins,
      // once per day, so a silently-dead promo never goes unnoticed.
      await notifyAdminsOncePerDay(bot, `⚠️ Daily promo did NOT go out: ${result.skipped}.`);
    } else if (result.delivered > 0) {
      // Positive confirmation: the operator gets the same report the manual
      // /promo_broadcast now path shows, so "did it fire today?" is never a
      // mystery — even when their own chat missed the customer blast.
      await notifyAdmins(bot, fmtReport(result));
    } else {
      await notifyAdminsOncePerDay(bot, "⚠️ Daily promo fired but reached 0 subscribers (all sends failed). Will retry in the next slot.");
    }
  } catch (err) {
    logger.error({ err }, "promoBroadcaster: fireOnce threw");
    await notifyAdminsOncePerDay(bot, "⚠️ Daily promo failed with an error (check logs). Will retry in the next slot.");
  }
}

// ---------------------------------------------------------------------------
// Admin notifications for the SCHEDULED path. Reports are sent as plain text
// (no parse_mode) because they embed raw AI copy — unbalanced Markdown in it
// would bounce the whole message. Best-effort: a failed DM never breaks the
// blast.
// ---------------------------------------------------------------------------
async function notifyAdmins(bot: TelegramBot, text: string): Promise<void> {
  for (const adminId of getAdminIds()) {
    try {
      await bot.sendMessage(adminId, text);
    } catch (err) {
      logger.error({ err, adminId }, "promoBroadcaster: admin report DM failed");
    }
  }
}

// Throttle for failure/skip alerts: at most one per business day, so a
// skip re-evaluated every 30-min slot doesn't spam the operator. In-memory —
// a restart may repeat the alert once, which is acceptable.
let lastAdminAlertDate: string | null = null;
async function notifyAdminsOncePerDay(bot: TelegramBot, text: string): Promise<void> {
  const today = localParts().date;
  if (lastAdminAlertDate === today) return;
  lastAdminAlertDate = today;
  await notifyAdmins(bot, text);
}

export function startPromoBroadcaster(bot: TelegramBot | null): void {
  if (started) return;
  if (!bot) {
    logger.info("promoBroadcaster: no bot instance (polling disabled), scheduler not started");
    return;
  }
  started = true;
  cron.schedule(
    "*/30 * * * *",
    () => {
      tick(bot).catch((err) => logger.error({ err }, "promoBroadcaster: tick threw"));
    },
    { timezone: "UTC" },
  );
  logger.info({ windowToday: slotWindowHuman(), tz: TIMEZONE }, "promoBroadcaster: scheduler started (every 30 min, fires once daily inside the day's slot window)");
}

// ---------------------------------------------------------------------------
// Admin commands — `/promo_broadcast on|off|now|preview|status`
// ---------------------------------------------------------------------------
// Plain text on purpose — r.copy is raw AI output and r.productName is
// operator-entered; either can contain unbalanced Markdown that would make
// Telegram reject the whole report with parse_mode set. Callers MUST send
// this without parse_mode.
function fmtReport(r: BroadcastReport): string {
  return (
    `📣 Promo blast complete — ${r.productName} (#${r.productId})\n` +
    `• Delivered: ${r.delivered}/${r.totalSubscribers}\n` +
    (r.removed > 0 ? `• Auto-removed (blocked / deleted): ${r.removed}\n` : "") +
    (r.transientFailures > 0 ? `• Transient failures: ${r.transientFailures}\n` : "") +
    `• Photo: ${r.hadPhoto ? "yes" : "no"}\n\n` +
    `─── copy ───\n${r.copy}`
  );
}

function escapeMd(s: string): string {
  // Telegram Markdown V1 hazardous chars. Missing any of these has
  // historically caused entire team-fanout messages to bounce with
  // "can't parse entities" — see pendingOrderReminder.ts for the
  // failure mode. Keep this list in sync with bot/escape.ts.
  return s.replace(/([_*`\[\]()])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// Broadcast ONE specific product on demand (product manager → 📣 Broadcast).
// Reuses the full daily-blast pipeline (AI copy + facts footer + photo hero +
// fan-out + daily-state update), so a manual product blast also counts as
// "fired today" and won't double up with the scheduled one. Returns a
// plain-text report (safe to send without parse_mode) or a skip reason.
// ---------------------------------------------------------------------------
export async function broadcastProductNow(
  bot: TelegramBot,
  productId: number,
): Promise<{ ok: true; report: string } | { ok: false; reason: string }> {
  const result = await fireOnce(bot, { forced: true, productId });
  if ("skipped" in result) return { ok: false, reason: result.skipped };
  return { ok: true, report: fmtReport(result) };
}

export async function handlePromoBroadcastCommand(bot: TelegramBot, msg: TelegramBot.Message, arg: string): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;

  const sub = (arg || "").trim().toLowerCase();
  const state = await loadState();

  if (!sub || sub === "status") {
    const today = localParts().date;
    const firedToday = state.lastFiredLocalDate === today;
    const lines = [
      `*Promo broadcaster status*`,
      `• Enabled: ${state.enabled ? "✅ on" : "⛔ off"}`,
      `• Window today: ${slotWindowHuman()}, one shot per day at a random time (window tracks each day's open hours)`,
      `• Today: ${firedToday ? "✅ already fired" : "⏳ not yet fired"}`,
      `• Last fired: ${state.lastFiredAtIso ? state.lastFiredAtIso : "never"}`,
      `• Recently promoted product IDs: ${state.recentlyPromotedIds.length ? state.recentlyPromotedIds.join(", ") : "(none)"}`,
      ``,
      `Commands:`,
      `\`/promo_broadcast on\` — enable scheduler`,
      `\`/promo_broadcast off\` — disable scheduler`,
      `\`/promo_broadcast now\` — fire one immediately to all subscribers`,
      `\`/promo_broadcast preview\` — generate + DM you only (no send)`,
    ];
    await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "on") {
    await saveState({ ...state, enabled: true });
    await bot.sendMessage(chatId, `✅ Promo broadcaster *enabled*. Will pick a random time today between ${slotWindowHuman()}.`, { parse_mode: "Markdown" });
    return;
  }

  if (sub === "off") {
    await saveState({ ...state, enabled: false });
    await bot.sendMessage(chatId, "⛔ Promo broadcaster *disabled*. No daily blasts will fire.", { parse_mode: "Markdown" });
    return;
  }

  if (sub === "preview") {
    await bot.sendMessage(chatId, "🧪 Generating preview…");
    const picked = await pickProduct(state);
    if (!picked) {
      await bot.sendMessage(chatId, "⚠️ No purchasable products with variants found. Add a size to a product first.");
      return;
    }
    let copy: string;
    try {
      const aiCopy = await generatePromoCopy({ product: picked.product, variants: picked.variants, isFresh: picked.isFresh });
      copy = `${aiCopy}\n\n${buildFactsFooter(picked)}`;
    } catch (err) {
      logger.error({ err }, "promoBroadcaster: preview generation failed");
      await bot.sendMessage(chatId, "⚠️ AI failed to generate a promo. Check logs.");
      return;
    }
    // Header sent separately (Markdown), copy sent exactly as customers will
    // receive it (plain text) — so the preview is a faithful replica and an
    // odd character in AI copy or a variant label can't break the send.
    await bot.sendMessage(chatId, `🧪 *Preview* — would promote *${escapeMd(picked.product.name)}*${picked.isFresh ? " _(fresh in rotation)_" : ""}`, { parse_mode: "Markdown" });
    if (picked.product.imageUrl) {
      try {
        await bot.sendPhoto(chatId, picked.product.imageUrl, { caption: copy });
        return;
      } catch (err) {
        logger.warn({ err }, "promoBroadcaster: preview photo failed, falling back to text");
      }
    }
    await bot.sendMessage(chatId, copy);
    return;
  }

  if (sub === "now") {
    await bot.sendMessage(chatId, "📣 Firing promo blast now…");
    try {
      const result = await fireOnce(bot, { forced: true });
      if ("skipped" in result) {
        await bot.sendMessage(chatId, `⏭ Skipped: ${result.skipped}`);
      } else {
        // Plain text — see fmtReport: the embedded AI copy can contain
        // unbalanced Markdown that would bounce the whole report.
        await bot.sendMessage(chatId, fmtReport(result));
      }
    } catch (err) {
      logger.error({ err }, "promoBroadcaster: manual fire failed");
      await bot.sendMessage(chatId, "⚠️ Promo blast failed. Check logs.");
    }
    return;
  }

  await bot.sendMessage(chatId, "Usage: `/promo_broadcast on|off|now|preview|status`", { parse_mode: "Markdown" });
}
