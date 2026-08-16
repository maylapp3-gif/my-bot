# Pending order reminder

Catches the case where a customer placed an order but every mod's
phone notification got buried.

## Two modes (both during open hours only — silent overnight)

### Per-order reminder (open hours, recurring)
- Cron every 5 min finds any order still `pending` 15+ min after
  creation and fans out a single warning to mods + relays.
- One reminder per order, ever (per process lifetime).

### Open-time digest (once per business day)
- On the first tick after the bot transitions closed → open each day,
  every still-pending order accumulated overnight is batched into ONE
  message and fanned out.
- Those orders are then marked as already-reminded so the per-order
  flow stays quiet.

## Why silent overnight
Mods aren't on shift, the customer can't be served until we open,
pinging phones is just noise.

## Recipients
Same as the original order alert: mods union relays.

## Implementation
- `bot/pendingOrderReminder.ts`
- In-memory `reminded` Set + `lastDigestDay` string. Restart may cause
  a re-remind or re-digest, acceptable cost vs missing a real one.
- Polling-gated like all other crons (only runs in the prod process).
