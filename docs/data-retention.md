# Data retention (two layers)

Hard rule: nothing customer-traceable lives anywhere in the system
longer than 24 hours. Exceptions are the contact list and admin-managed
config (products, variants, promos, relays, mod_status,
regular_customers).

## Layer 1 — Chat surface (Telegram messages)
- Every bot-sent message and every customer-sent message (except
  moderators') is tracked in `bot_messages`.
- Cron every 15 minutes sweeps anything older than 24h and deletes via
  Telegram's `deleteMessage` API.
- Worst-case overshoot: 15 min.

## Layer 2 — Database
- `bot/dataRetention.ts` runs hourly + once at boot.
- Hard-deletes from: `orders` (cascades to `order_items`),
  `cart_items`, `cart_promos`, `conversations` (cascades to
  `messages`).
- This is in addition to layer 1.

## Side effect
EOD/sales analytics only ever see the trailing 24h. Intentional for
forensic minimization on a sensitive product.

## Exception — new-customer verification state
The subscriber row carries the verification gate state
(`verifyStatus`, `leafedoutUsername`, plus reviewer/timestamp/counter
fields). This is part of the contact-list exception, so it deliberately
outlives the 24h purge: a customer who has been approved must stay
approved, and a rejected/abusive one must not be able to reset by
waiting a day.
- `leafedoutUsername` is the only new customer-traceable field that
  persists. Keep it minimal — store the handle only, never DM contents.
- The one-time proof code (`verifyCode`) is **ephemeral**. It's cleared
  the instant verification resolves (auto-approve / admin approve /
  reject). For sessions a customer *abandons* mid-flow, the hourly purge
  also wipes the code from any `collecting` row whose `verifyCodeIssuedAt`
  is older than the 24h cutoff (see `clearStaleVerifyCodes`), so a stray
  code never lingers. The cutoff is keyed on issue time so a slow-but-legit
  customer (or a day-later retry) isn't nuked mid-session.
- Both the per-customer `purgeSubscriber` row-delete and the
  `WIPE_TABLES` subscribers TRUNCATE remove every verification column
  along with the row, so the panic paths still erase it fully.
