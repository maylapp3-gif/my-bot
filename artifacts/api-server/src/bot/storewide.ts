import { logger } from "../lib/logger.js";

// Env-driven store-wide auto discount. A flat amount knocked off EVERY cart,
// no promo code required, for a bounded window. Default OFF.
//
// Fail-closed by design: the discount is only active when BOTH a positive
// amount AND a valid expiry are configured, and the current time is inside the
// window. A missing/invalid expiry => inactive, so a misconfiguration can
// never leave a discount running forever.
//
//   STOREWIDE_DISCOUNT_CENTS  — flat discount in cents (e.g. 1000 = $10). >0 to arm.
//   STOREWIDE_DISCOUNT_UNTIL  — ISO timestamp; active while now < until. Required.
//   STOREWIDE_DISCOUNT_FROM   — optional ISO timestamp; active only once now >= from.
//   STOREWIDE_DISCOUNT_LABEL  — optional display label. Defaults to "Today's special".

export type StorewideDiscountState = {
  active: boolean;
  cents: number;
  label: string;
};

const DEFAULT_LABEL = "Today's special";

function parseIntSafe(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

let warned = false;

// Strip characters that could break Telegram Markdown or a code fence if the
// operator misconfigures the label (backticks, newlines). Defensive only — the
// label is operator-set, not customer-set.
function sanitizeLabel(raw: string | undefined): string {
  const cleaned = (raw ?? "").replace(/[`\r\n]/g, " ").trim();
  return cleaned || DEFAULT_LABEL;
}

export function getStorewideDiscount(now: Date = new Date()): StorewideDiscountState {
  const cents = parseIntSafe(process.env.STOREWIDE_DISCOUNT_CENTS, 0);
  const label = sanitizeLabel(process.env.STOREWIDE_DISCOUNT_LABEL);
  const inactive: StorewideDiscountState = { active: false, cents: 0, label };

  if (cents <= 0) return inactive;

  const until = parseDate(process.env.STOREWIDE_DISCOUNT_UNTIL);
  const from = parseDate(process.env.STOREWIDE_DISCOUNT_FROM);

  // Fail-closed: an armed amount with no valid expiry is a misconfiguration.
  if (!until) {
    if (!warned) {
      logger.warn(
        "STOREWIDE_DISCOUNT_CENTS is set but STOREWIDE_DISCOUNT_UNTIL is missing/invalid — discount disabled (fail-closed).",
      );
      warned = true;
    }
    return inactive;
  }

  const started = !from || now >= from;
  const active = started && now < until;
  return { active, cents: active ? cents : 0, label };
}
