// Day-aware open/close math. The per-weekday schedule lives in brand.ts
// (WEEKLY_HOURS, Sun=0 … Sat=6); everything here derives from it AT CALL
// TIME so copy always reflects the right day — never cache these strings
// at module level.
import { TIMEZONE, LOCALE_DATEKEY, WEEKLY_HOURS, hourToHuman, type DayHours } from "./brand.js";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_FROM_SHORT: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Current weekday/hour/minute in the business timezone. en-US is used so the
// short weekday names are stable ("Sun" … "Sat") regardless of brand locale.
function businessParts(now: Date = new Date()): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = WEEKDAY_FROM_SHORT[get("weekday")] ?? 0;
  // "24" can appear in some Intl impls for midnight; normalise.
  let hour = parseInt(get("hour") || "0", 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get("minute") || "0", 10);
  return { weekday, hour, minute };
}

export function hoursForWeekday(weekday: number): DayHours {
  return WEEKLY_HOURS[((weekday % 7) + 7) % 7] ?? WEEKLY_HOURS[0]!;
}

export function todayHours(now: Date = new Date()): DayHours {
  return hoursForWeekday(businessParts(now).weekday);
}

// Current hour (0-23) in the business timezone. Used by schedulers that gate
// on "have we hit today's close yet".
export function businessHourNow(now: Date = new Date()): number {
  return businessParts(now).hour;
}

// "YYYY-MM-DD" key for the current business day — for once-per-day dedupe
// and the date-keyed pickup window.
export function businessDateKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat(LOCALE_DATEKEY, {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isOpenNow(now: Date = new Date()): boolean {
  const { weekday, hour } = businessParts(now);
  const { open, close } = hoursForWeekday(weekday);
  return hour >= open && hour < close;
}

// Inside today's DELIVERY sub-window right now? (Pickups run the whole open
// window; deliveries only inside this.) Informational — ordering is never
// blocked, the copy just sets expectations about when the drive happens.
export function isDeliveryOpenNow(now: Date = new Date()): boolean {
  const { weekday, hour } = businessParts(now);
  const { deliveryOpen, deliveryClose } = hoursForWeekday(weekday);
  return hour >= deliveryOpen && hour < deliveryClose;
}

// When closed, are we before today's open (pre-open) or after today's close
// (post-close)? Used to phrase "back at 3pm today" vs "back tomorrow at 2pm".
export type ClosedPhase = "pre_open" | "post_close";
export function closedPhase(now: Date = new Date()): ClosedPhase {
  const { weekday, hour } = businessParts(now);
  return hour < hoursForWeekday(weekday).open ? "pre_open" : "post_close";
}

// The next opening: today's open if we're pre-open, otherwise the next day
// that has hours (a ≤7-day scan so a fork with a closed day can't loop).
export interface NextOpen {
  openHuman: string; // e.g. "3pm"
  dayOffset: number; // 0 = today, 1 = tomorrow, …
  weekday: number; // 0–6 of the opening day
}
export function nextOpenInfo(now: Date = new Date()): NextOpen {
  const { weekday, hour } = businessParts(now);
  const today = hoursForWeekday(weekday);
  if (hour < today.open) {
    return { openHuman: hourToHuman(today.open), dayOffset: 0, weekday };
  }
  for (let d = 1; d <= 7; d++) {
    const wd = (weekday + d) % 7;
    const h = hoursForWeekday(wd);
    if (h.open < h.close) {
      return { openHuman: hourToHuman(h.open), dayOffset: d, weekday: wd };
    }
  }
  // Unreachable with a sane schedule; fall back to today's open tomorrow.
  return { openHuman: hourToHuman(today.open), dayOffset: 1, weekday };
}

// "today" / "tomorrow" / "on Sun" — pairs with nextOpenInfo().openHuman.
export function nextOpenDayWord(info: NextOpen): string {
  if (info.dayOffset === 0) return "today";
  if (info.dayOffset === 1) return "tomorrow";
  return `on ${DAY_LABELS[info.weekday]}`;
}

// The next opening hour as a human string — today's open when pre-open,
// otherwise the NEXT day's open (which can differ, e.g. Sat night → Sun 12pm).
export function nextOpenHuman(now: Date = new Date()): string {
  return nextOpenInfo(now).openHuman;
}

// ---------------------------------------------------------------------------
// Human strings — all call-time, all derived from the weekly table.
// ---------------------------------------------------------------------------

export function todayHoursHuman(now: Date = new Date()): string {
  const { open, close } = todayHours(now);
  return `${hourToHuman(open)} – ${hourToHuman(close)}`;
}

// "4pm – 8pm" — today's delivery sub-window.
export function todayDeliveryHuman(now: Date = new Date()): string {
  const { deliveryOpen, deliveryClose } = todayHours(now);
  return `${hourToHuman(deliveryOpen)} – ${hourToHuman(deliveryClose)}`;
}

export function openHourHumanToday(now: Date = new Date()): string {
  return hourToHuman(todayHours(now).open);
}

// Does today's delivery window span the whole open window? (If so the copy
// can skip the "delivery X–Y" qualifier — it'd just repeat the open hours.)
function deliveryIsFullWindow(h: DayHours): boolean {
  return h.deliveryOpen === h.open && h.deliveryClose === h.close;
}

// Same check for TODAY — lets copy in welcome/checkout skip a redundant
// "delivery X–Y" when it would just repeat the open hours (legacy forks).
export function todayDeliveryIsFullWindow(now: Date = new Date()): boolean {
  return deliveryIsFullWindow(todayHours(now));
}

// Compact one-liner for footers:
// "🕑 Open today 2pm – 10pm · 🚗 delivery 4pm – 8pm"
export function hoursLabelToday(now: Date = new Date()): string {
  const h = todayHours(now);
  const base = `🕑 Open today ${todayHoursHuman(now)}`;
  if (deliveryIsFullWindow(h)) return base;
  return `${base} · 🚗 delivery ${todayDeliveryHuman(now)}`;
}

// Group consecutive days (Mon-first) sharing the same full AND delivery hours:
// [["Mon–Wed", "3pm–10pm", "3pm–8pm"], ["Thu", "2pm–10pm", "3pm–9pm"], …]
// The third element is null when delivery = the full window.
function scheduleGroups(): Array<[string, string, string | null]> {
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon … Sun
  const groups: Array<{ start: number; end: number; hours: DayHours }> = [];
  for (const wd of order) {
    const h = hoursForWeekday(wd);
    const last = groups[groups.length - 1];
    if (
      last &&
      last.hours.open === h.open &&
      last.hours.close === h.close &&
      last.hours.deliveryOpen === h.deliveryOpen &&
      last.hours.deliveryClose === h.deliveryClose
    ) {
      last.end = wd;
    } else {
      groups.push({ start: wd, end: wd, hours: h });
    }
  }
  return groups.map((g) => {
    const label =
      g.start === g.end ? DAY_LABELS[g.start]! : `${DAY_LABELS[g.start]}–${DAY_LABELS[g.end]}`;
    const full = `${hourToHuman(g.hours.open)}–${hourToHuman(g.hours.close)}`;
    const delivery = deliveryIsFullWindow(g.hours)
      ? null
      : `${hourToHuman(g.hours.deliveryOpen)}–${hourToHuman(g.hours.deliveryClose)}`;
    return [label, full, delivery];
  });
}

// "Mon–Wed 3pm–10pm (delivery 3pm–8pm) · Thu 2pm–10pm (delivery 3pm–9pm) · …"
// The full window is when we're on (pickups run all of it); the bracket is
// when deliveries drive.
export function weeklyScheduleLine(): string {
  return scheduleGroups()
    .map(([days, full, delivery]) => `${days} ${full}${delivery ? ` (delivery ${delivery})` : ""}`)
    .join(" · ");
}

// Multi-line version for How-it-works / Contact / AI prompts:
// "Mon–Wed: 3pm–10pm · delivery 3pm–8pm\nThu: 2pm–10pm · delivery 3pm–9pm\n…"
export function weeklyScheduleLines(): string {
  return scheduleGroups()
    .map(([days, full, delivery]) => `${days}: ${full}${delivery ? ` · delivery ${delivery}` : ""}`)
    .join("\n");
}

// Bulleted weekly schedule for the Today's Hours page:
// "• Mon–Wed: 3pm–10pm · delivery 3pm–8pm\n• Thu: …"
export function weeklyScheduleBullets(): string {
  return scheduleGroups()
    .map(([days, full, delivery]) => `• ${days}: ${full}${delivery ? ` · delivery ${delivery}` : ""}`)
    .join("\n");
}

// Today's hours as a tidy bullet block — shared by the welcome message and
// the Today's Hours page so the two can never drift.
//   • Open: 2pm – 10pm
//   • 🚗 Delivery: 4pm – 8pm
//   • 🤝 Pickup: any time we're open
export function todayHoursBullets(now: Date = new Date()): string {
  const delivery = todayDeliveryIsFullWindow(now)
    ? `• 🚗 Delivery: all open hours`
    : `• 🚗 Delivery: ${todayDeliveryHuman(now)}`;
  return [`• Open: ${todayHoursHuman(now)}`, delivery, `• 🤝 Pickup: any time we're open`].join(
    "\n",
  );
}

// Live one-liner for the Today's Hours page. Informational only — ordering is
// never blocked; this just kills the "are they on right now?" guesswork.
export function openStatusLine(now: Date = new Date()): string {
  if (!isOpenNow(now)) {
    const next = nextOpenInfo(now);
    return `🔴 Closed right now — back ${nextOpenDayWord(next)} at ${next.openHuman}. You can still send an order any time.`;
  }
  if (todayDeliveryIsFullWindow(now) || isDeliveryOpenNow(now)) {
    return `🟢 Open right now — pickup and delivery both running.`;
  }
  return `🟢 Open right now — pickup running; deliveries head out ${todayDeliveryHuman(now)}.`;
}

export function afterHoursNotice(now: Date = new Date()): string {
  const next = nextOpenInfo(now);
  return (
    "🌙 *We're currently closed.*\n" +
    `🕑 Hours: ${weeklyScheduleLine()}\n\n` +
    `Your order is in the queue — we'll confirm when we're back on at ${next.openHuman} ${nextOpenDayWord(next)}.`
  );
}
