import { logger } from "../lib/logger.js";
import { GEOCODE_BIAS, GEOCODE_COUNTRY_CODE, NOMINATIM_USER_AGENT } from "./brand.js";
import { businessHourNow } from "./hours.js";

// ===========================================================================
// Delivery fee tiers — keyed off straight-line distance from a fixed origin.
// ---------------------------------------------------------------------------
// The origin is INTENTIONALLY absent from this codebase. It is read only
// from the DELIVERY_ORIGIN env secret ("lat,lng"). Nothing location-specific
// may be committed to the repo, surfaced to customers (no "we deliver from X"
// copy, no "you're Ykm out" hints in user-facing strings), or logged.
// Customers only ever see the resulting fee — "free", "$10", "$20", or
// "out of range". If the origin is unset, every lookup degrades to
// "unknown" → fee reads TBC-at-meet, orders still flow.
// ===========================================================================

const TIER_FREE_KM_DEFAULT = 12;
const TIER_FREE_KM_REGULAR = 15;
const TIER_TEN_KM = 20;
const TIER_TWENTY_KM = 35; // also the hard cutoff
const FEE_TEN_CENTS = 1000;
const FEE_TWENTY_CENTS = 2000;

export const DELIVERY_MAX_KM = TIER_TWENTY_KM;

export type DeliveryFeeResult =
  | { kind: "free"; feeCents: 0; distanceKm: number }
  | { kind: "paid"; feeCents: number; distanceKm: number }
  | { kind: "out_of_range"; feeCents: 0; distanceKm: number }
  | { kind: "unknown"; feeCents: 0; reason: string };

type GeoPoint = { lat: number; lng: number };

function parseOrigin(): GeoPoint | null {
  const raw = (process.env.DELIVERY_ORIGIN ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0]!.trim());
  const lng = parseFloat(parts[1]!.trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Parsed once at boot. Never log the value — only whether it exists.
const ORIGIN = parseOrigin();
if (!ORIGIN) {
  logger.warn(
    "DELIVERY_ORIGIN is not set (or invalid) — delivery fee lookups will read TBC-at-meet",
  );
}

// Process-lifetime cache. Geocoding the same suburb over and over is wasteful
// and rate-limited by Nominatim (1 req/sec etiquette). Forever-cache is fine
// because suburbs don't move.
const geocodeCache = new Map<string, GeoPoint | null>();

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function geocode(area: string): Promise<GeoPoint | null> {
  const key = area.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    // Bias the query toward the operator's region so customers' freeform
    // suburb names land on a local match rather than a same-named town
    // overseas. Both knobs live in brand.ts.
    url.searchParams.set("q", GEOCODE_BIAS ? `${area}, ${GEOCODE_BIAS}` : area);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    if (GEOCODE_COUNTRY_CODE) url.searchParams.set("countrycodes", GEOCODE_COUNTRY_CODE);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, {
      headers: {
        // Nominatim usage policy requires a contactable User-Agent.
        "User-Agent": NOMINATIM_USER_AGENT,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      logger.warn({ status: res.status, area }, "Nominatim non-OK response");
      geocodeCache.set(key, null);
      return null;
    }
    const rows = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    if (!Array.isArray(rows) || rows.length === 0 || !rows[0].lat || !rows[0].lon) {
      geocodeCache.set(key, null);
      return null;
    }
    const point: GeoPoint = {
      lat: parseFloat(rows[0].lat),
      lng: parseFloat(rows[0].lon),
    };
    geocodeCache.set(key, point);
    return point;
  } catch (err) {
    logger.warn({ err, area }, "Geocode failed");
    geocodeCache.set(key, null);
    return null;
  }
}

export async function computeDeliveryFee(
  area: string,
  opts?: { isRegular?: boolean },
): Promise<DeliveryFeeResult> {
  const trimmed = area.trim();
  if (!trimmed) return { kind: "unknown", feeCents: 0, reason: "empty" };
  if (!ORIGIN) return { kind: "unknown", feeCents: 0, reason: "origin unconfigured" };
  const point = await geocode(trimmed);
  if (!point) return { kind: "unknown", feeCents: 0, reason: "geocode failed" };
  const distanceKm = haversineKm(ORIGIN, point);
  // Regulars get a wider free-delivery radius (15km vs 12km default).
  // Beyond that, the same paid tiers apply for everyone.
  const freeKm = opts?.isRegular ? TIER_FREE_KM_REGULAR : TIER_FREE_KM_DEFAULT;
  if (distanceKm > TIER_TWENTY_KM) {
    return { kind: "out_of_range", feeCents: 0, distanceKm };
  }
  if (distanceKm <= freeKm) {
    return { kind: "free", feeCents: 0, distanceKm };
  }
  if (distanceKm <= TIER_TEN_KM) {
    return { kind: "paid", feeCents: FEE_TEN_CENTS, distanceKm };
  }
  return { kind: "paid", feeCents: FEE_TWENTY_CENTS, distanceKm };
}

// ===========================================================================
// FAR + LATE advisory — TEAM-SIDE ONLY.
// ---------------------------------------------------------------------------
// Flags a delivery order that is both far away and placed late in the day,
// so the team can push it to tomorrow's run instead of doubling back.
//
// Both knobs live ONLY in env secrets — no cutoff hour and no distance is
// committed to the repo:
//   FAR_FLAG_AFTER_HOUR — business-timezone hour (0-23) from which orders
//                         count as "late".
//   FAR_FLAG_KM         — straight-line km from the origin from which an
//                         area counts as "far".
// If either is missing/invalid (or DELIVERY_ORIGIN is unset) the advisory
// silently disables.
//
// INVARIANT: the result must NEVER influence anything a customer sees.
// Gating customer-visible behaviour (blocking checkout, different copy) on
// far/near after a cutoff would hand customers a probe: type suburbs after
// the cutoff, watch which get refused, triangulate the private origin —
// exactly the oracle the fee-hiding above exists to prevent.
// ===========================================================================

function farLateConfig(): { afterHour: number; km: number } | null {
  const hourRaw = (process.env.FAR_FLAG_AFTER_HOUR ?? "").trim();
  const kmRaw = (process.env.FAR_FLAG_KM ?? "").trim();
  if (!hourRaw || !kmRaw) return null;
  const afterHour = parseInt(hourRaw, 10);
  const km = parseFloat(kmRaw);
  if (!Number.isInteger(afterHour) || afterHour < 0 || afterHour > 23) return null;
  if (!Number.isFinite(km) || km <= 0) return null;
  return { afterHour, km };
}

// True when a delivery order placed RIGHT NOW is both far (≥ configured km)
// and late (business-timezone hour ≥ configured hour). Advisory only — any
// failure (unconfigured, no origin, geocode miss) returns false so order
// fanout is never blocked or delayed by this check.
export async function isFarLateOrder(area: string, now: Date = new Date()): Promise<boolean> {
  const cfg = farLateConfig();
  if (!cfg || !ORIGIN) return false;
  // Cheap time gate first — skips the network lookup for most of the day.
  if (businessHourNow(now) < cfg.afterHour) return false;
  const trimmed = area.trim();
  if (!trimmed) return false;
  const point = await geocode(trimmed);
  if (!point) return false;
  return haversineKm(ORIGIN, point) >= cfg.km;
}
