# AI promo broadcaster

Once per day during open hours the bot picks a product and fans out an
AI-generated promo to every active subscriber. The send window tracks
each day's schedule: one hour after open until one hour before close
(business timezone), so it shifts automatically with the per-weekday hours.

## Message shape — two halves
Every blast is AI copy on top + a facts footer below, always in that
order:

1. **AI copy (the flavour)** — 2–4 short lines about the ONE product:
   what it smells/tastes/feels like and what kind of session it suits.
   Information-first: the first line must teach something concrete, no
   self-praise, no "we/our house" talk, no hype adjectives, at most one
   dry line. If the product description is thin, it stays short and
   honest instead of inventing traits.
2. **Facts footer (the useful bit)** — built by code from trusted data,
   never the AI, so it can't be hallucinated: every size with its real
   price ("On the menu: 3.5g $50 · 7g $95"), today's open/delivery
   hours, and the "Tap Menu to order" CTA. This guarantees each blast
   carries actionable info even on the AI's worst day.

Safety rules unchanged: no city/currency naming, no medical or potency
claims, no invented details. Sent as plain text (not Markdown) to
survive any AI formatting wobbles. The product photo carries the
visual. `preview` shows exactly what customers would receive.

## Smart placement
Cron ticks every 30 min. Each tick inside the day's window is a "slot"
(e.g. 13 slots on a 3pm–9pm window). If we haven't fired today, roll a
1/(remaining slots) dice. Probability hits 100% on the last slot, so
the blast always fires by the window's end — but the time of day is uniformly
random, naturally different every day, and survives restarts (state in
object storage at `settings/promo-broadcaster.json`).

## Product picker
Only purchasable products (with at least one variant). 40% chance to
draw from "fresh" pool (added in last 14 days), else from the full
menu. Avoids repeating the last 3 promoted products.

## Race-safe state
State is re-read right before save so a mid-blast `off` toggle isn't
clobbered. Day is only marked "fired" if at least one customer
received the promo (a 0-delivered run retries next slot).

## Operator visibility
The scheduled daily blast is never silent:
- **Success** → every admin gets a DM with the same delivery report the
  manual "fire now" shows (product, delivered count, the copy that went
  out). Sent as plain text — the report embeds raw AI copy, and stray
  Markdown characters in it must never bounce the message.
- **Failure / skip** (no purchasable products, AI error, 0 delivered)
  → admins get a one-line warning, at most once per day, and the
  broadcaster retries on the next slot as before. Normal "dice didn't
  roll this slot" waits never alert.

Admin/mod chats are also exempt from the auto-deactivation that prunes
blocked/dead subscriber chats — a weird one-off delivery failure can't
silently drop the operator off their own promo list (it's logged
instead).

## Polling gate
Only the prod process runs the cron, same as backups/EOD. Dev never
blasts customers.

## Operator commands
The toggle/preview/now/status surface lives behind the operator
passphrase, not as visible slash commands.

## Broadcast one specific product (product manager)
The daily blast picks a product for you. To push a *specific* product
right now, open the product in the product manager (📋 My products →
tap the product) and tap **📣 Broadcast to all subscribers**. It asks
to confirm, then sends the same shape as the daily blast (product photo
+ AI blurb + today's real prices & hours) to every subscriber and DMs
you a delivery report.

The button only appears when the product is actually purchasable (shown
on menu + at least one in-stock size) — you can't blast something
customers can't buy. A manual broadcast **counts as that day's promo**,
so the automatic one won't also fire the same day (no double blast).
