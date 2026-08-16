// Single source of truth for everything that changes when you fork this
// codebase into another business. Every knob here is either an env var or a
// constant you tweak once. After forking, edit this file (or the matching env
// vars) and the rest of the bot follows.
//
// What's NOT in here:
// - Telegram credentials (TELEGRAM_BOT_TOKEN, TELEGRAM_API_ID/HASH, userbot
//   sessions) — those are pure secrets, managed in the secrets pane.
// - Moderator/admin chat ID allowlists (ADMIN_CHAT_IDS, MODERATOR_CHAT_IDS)
//   — also env vars, handled where they're read.
// - The product menu — lives in the database, managed via /admin.
//
// See `SETUP.md` for the full setup checklist.

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

// The display name customers see (welcome card, help header, menu header,
// AI prompts). Keep it short — it's a header, not a tagline.
export const BRAND_NAME = process.env.BRAND_NAME || "YourBrand";

// One-line descriptor used inside AI system prompts so the model knows what
// kind of business it's speaking for. Be specific enough that the model
// stays in voice (e.g. "discreet cannabis service", "specialty coffee bar").
export const BRAND_DESCRIPTOR = process.env.BRAND_DESCRIPTOR || "discreet cannabis service";

// The category noun used inside AI prompts when picking emojis / describing
// products at a high level. Single word usually works best.
export const VERTICAL_NOUN = process.env.VERTICAL_NOUN || "cannabis";

// ---------------------------------------------------------------------------
// Hours & timezone
// ---------------------------------------------------------------------------

// IANA timezone the business operates in. Used for open-hours math, daily
// digest keys, and the promo broadcaster slot window. Customer-facing
// copy never names the timezone — this is internal.
export const TIMEZONE = process.env.TIMEZONE || "UTC";

// Locale used with Intl.DateTimeFormat. en-CA is handy for ISO-style
// YYYY-MM-DD day keys. Most
// businesses won't need to change this.
export const LOCALE_DATEKEY = "en-CA";
export const LOCALE_HOUR = "en-US";

// Per-weekday hours in TIMEZONE, 0–23, indexed Sun=0 … Sat=6.
//
// Each day has TWO windows:
//   - open/close        — the full window the business is on. Pickups run the
//                         entire window (the pickup-only bookends fall out of
//                         the difference with the delivery window).
//   - deliveryOpen/deliveryClose — the sub-window deliveries actually run,
//                         always clamped inside [open, close].
//
// Defaults: 12pm–10pm every day, delivery the full window. Set your real
// schedule via WEEKLY_HOURS / WEEKLY_DELIVERY_HOURS (see SETUP.md).
//
// Fork knobs (all optional — leaving them unset keeps the defaults):
// - OPEN_HOUR / CLOSE_HOUR: legacy single pair. If BOTH are set, the pair
//   applies to all 7 days (delivery = the full window, matching the
//   pre-delivery-window behaviour of old forks).
// - WEEKLY_HOURS: comma-separated `day=open-close` tokens that override
//   individual days' FULL window AFTER the legacy pair, e.g.
//   "mon=15-21,sun=12-20". Day names: sun mon tue wed thu fri sat. Hours are
//   0–23, open < close. A day overridden here gets its delivery window
//   clamped into the new full window (falls back to the full window if the
//   old delivery window no longer fits). Malformed tokens are ignored.
// - WEEKLY_DELIVERY_HOURS: same token format, overrides individual days'
//   DELIVERY window, applied last. Tokens that don't fit inside that day's
//   full window are clamped to it; malformed tokens are ignored.
//
// All customer-facing hour strings are derived from this table at call time
// (see hours.ts) so they stay in sync per-day.
export interface DayHours {
  open: number;
  close: number;
  deliveryOpen: number;
  deliveryClose: number;
}

const DEFAULT_WEEKLY_HOURS: DayHours[] = Array.from({ length: 7 }, () => ({
  open: 12,
  close: 22,
  deliveryOpen: 12,
  deliveryClose: 22,
}));

const DAY_TOKEN_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

// Parse one "day=HH-HH" token → [dayIndex, open, close], or null if malformed.
function parseDayToken(token: string): [number, number, number] | null {
  const m = token.trim().toLowerCase().match(/^([a-z]{3})=(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const idx = DAY_TOKEN_INDEX[m[1]!];
  const o = parseInt(m[2]!, 10);
  const c = parseInt(m[3]!, 10);
  if (idx === undefined) return null;
  if (!Number.isFinite(o) || !Number.isFinite(c)) return null;
  if (o < 0 || o > 23 || c < 0 || c > 23 || o >= c) return null;
  return [idx, o, c];
}

// Force a day's delivery window inside its full window; if the intersection
// is empty, delivery = the full window (fail-safe: never a dead window).
function clampDelivery(d: DayHours): DayHours {
  const dOpen = Math.max(d.deliveryOpen, d.open);
  const dClose = Math.min(d.deliveryClose, d.close);
  if (dOpen < dClose) return { ...d, deliveryOpen: dOpen, deliveryClose: dClose };
  return { ...d, deliveryOpen: d.open, deliveryClose: d.close };
}

function buildWeeklyHours(): DayHours[] {
  let week = DEFAULT_WEEKLY_HOURS.map((d) => ({ ...d }));

  // Legacy pair: both must be present AND valid to take effect. Legacy forks
  // predate the delivery sub-window, so delivery = the full window.
  const legacyOpenRaw = process.env.OPEN_HOUR;
  const legacyCloseRaw = process.env.CLOSE_HOUR;
  if (legacyOpenRaw && legacyCloseRaw) {
    const o = parseHour(legacyOpenRaw, -1);
    const c = parseHour(legacyCloseRaw, -1);
    if (o >= 0 && c >= 0 && o < c) {
      week = week.map(() => ({ open: o, close: c, deliveryOpen: o, deliveryClose: c }));
    }
  }

  // Per-day FULL-window overrides: "mon=15-21,sun=12-20". Bad tokens are
  // skipped. The day's delivery window is re-clamped into the new full window.
  for (const token of (process.env.WEEKLY_HOURS ?? "").split(",")) {
    const parsed = parseDayToken(token);
    if (!parsed) continue;
    const [idx, o, c] = parsed;
    week[idx] = clampDelivery({ ...week[idx]!, open: o, close: c });
  }

  // Per-day DELIVERY-window overrides, applied last, clamped to the full window.
  for (const token of (process.env.WEEKLY_DELIVERY_HOURS ?? "").split(",")) {
    const parsed = parseDayToken(token);
    if (!parsed) continue;
    const [idx, o, c] = parsed;
    week[idx] = clampDelivery({ ...week[idx]!, deliveryOpen: o, deliveryClose: c });
  }

  return week;
}

export const WEEKLY_HOURS: readonly DayHours[] = buildWeeklyHours();

// ---------------------------------------------------------------------------
// Geocoding (delivery fee lookup)
// ---------------------------------------------------------------------------

// Free-text suffix appended to customer-typed suburbs before geocoding, to
// bias the result toward the correct region. Format: "Region, Country".
// Set to "" to disable biasing.
export const GEOCODE_BIAS = process.env.GEOCODE_BIAS || "";

// ISO 3166-1 alpha-2 country code restriction for the Nominatim query.
// Set to "" to disable the country filter.
export const GEOCODE_COUNTRY_CODE = (process.env.GEOCODE_COUNTRY_CODE || "").toLowerCase();

// Nominatim usage policy requires a contactable User-Agent. Derived from
// BRAND_NAME by default; override with NOMINATIM_USER_AGENT if you want a
// custom contact string.
export const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ||
  `${BRAND_NAME.replace(/\s+/g, "")}Bot/1.0 (delivery fee lookup)`;

// ---------------------------------------------------------------------------
// Vertical-specific guardrails (AI safety filters)
// ---------------------------------------------------------------------------

// Words the AI must NEVER echo back to customers. Two purposes:
//   1) Category vocabulary the brand intentionally avoids (e.g. "cannabis",
//      "weed" — we sell by vibe, not specs).
//   2) Region names that would deanonymize the operator (e.g. city names).
// Used by the matchmaker post-filter. For a non-cannabis business, replace
// with the relevant category words for your vertical (or set to "" to skip
// category filtering — the region filter is still worth keeping).
//
// Format: pipe-separated word stems. Wrapped in \b...\b at the call site.
export const AI_FORBIDDEN_WORDS =
  process.env.AI_FORBIDDEN_WORDS ||
  "cannabis|weed|marijuana|indica|sativa|hybrid|flower|hash|edible|vape|concentrate|thc|cbd|kush";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHour(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) return def;
  return n;
}

// 14 -> "2pm", 22 -> "10pm", 0 -> "12am", 12 -> "12pm".
export function hourToHuman(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${period}`;
}
