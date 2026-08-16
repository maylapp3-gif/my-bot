import { logger } from "../lib/logger.js";
import { TIMEZONE } from "./brand.js";

// Env-driven happy-hour discount. Default OFF — set HAPPY_HOUR_PERCENT (1-99)
// to switch on. All times in the business timezone (brand.ts).
// Customer-facing messaging never names the city or timezone.
const TZ = TIMEZONE;

function parseIntSafe(v: string | undefined, def: number): number {
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function localDayHour(now: Date): { dayOfWeek: number; hour: number } {
  // dayOfWeek matches JS Date.getDay() — 0=Sunday..6=Saturday.
  // NOTE: deliberately a fixed "en-US" (NOT brand.ts LOCALE_HOUR): the weekday
  // map below matches English short names, so this must never follow a
  // fork-configured locale.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wk = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = parseInt(hourRaw, 10);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dayOfWeek: map[wk] ?? 0, hour: hour === 24 ? 0 : hour };
}

export type HappyHourState = {
  active: boolean;
  percent: number;
  startHour: number;
  endHour: number;
  days: number[];
};

let warned = false;

export function getHappyHourState(now: Date = new Date()): HappyHourState {
  const percent = parseIntSafe(process.env.HAPPY_HOUR_PERCENT, 0);
  const startHour = parseIntSafe(process.env.HAPPY_HOUR_START_HOUR, 16);
  const endHour = parseIntSafe(process.env.HAPPY_HOUR_END_HOUR, 18);
  const daysRaw = process.env.HAPPY_HOUR_DAYS;
  const days = daysRaw
    ? daysRaw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6)
    : [0, 1, 2, 3, 4, 5, 6];

  const sane =
    percent >= 1 &&
    percent <= 99 &&
    startHour >= 0 &&
    startHour <= 23 &&
    endHour >= 1 &&
    endHour <= 24 &&
    startHour < endHour &&
    days.length > 0;

  if (!sane) {
    if (!warned && percent > 0) {
      logger.warn(
        { percent, startHour, endHour, days },
        "Happy hour env vars set but invalid — disabled. Need PERCENT 1-99, START<END, days 0-6.",
      );
      warned = true;
    }
    return { active: false, percent: 0, startHour, endHour, days };
  }

  const { dayOfWeek, hour } = localDayHour(now);
  const active = days.includes(dayOfWeek) && hour >= startHour && hour < endHour;
  return { active, percent, startHour, endHour, days };
}

// Customer-facing window text — never includes a city or timezone name.
export function happyHourWindowLabel(): string | null {
  const s = getHappyHourState();
  if (s.percent < 1) return null;
  const fmt = (h: number) => {
    const m = h >= 12 && h < 24 ? "pm" : "am";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}${m}`;
  };
  return `${s.percent}% off · ${fmt(s.startHour)}–${fmt(s.endHour)}`;
}
