# Telegram ordering bot

A private Telegram bot that lets customers self-serve a cart-and-checkout
flow and routes finished orders to a small team.

## Stack
- Node.js (ESM), Express
- `node-telegram-bot-api` (long-polling) for the customer-facing bot
- `gramjs` for the per-moderator companion listener
- PostgreSQL via Drizzle ORM
- OpenAI via Replit AI Integrations
- `node-cron` for schedulers

## Two surfaces
- **Bot** — standard Telegram bot. Self-serve menu, cart, promos,
  checkout, order fanout to the team. Admin product manager.
- **Companion listener** — a per-moderator gramjs session that helps
  the mod handle DMs on their personal account. Setup walkthrough in
  `docs/userbot-setup.md`.

## Project structure (high level)
```
artifacts/api-server/src/
  index.ts                     — Server entry
  app.ts                       — Express app
  bot/
    index.ts                   — Bot setup, command registrations, message router
    handlers/                  — Per-feature command handlers
    db.ts                      — Database helpers
    hours.ts                   — Open-hours helpers
    moderation.ts              — Mod handover
    selfDestruct.ts            — Daily message cleanup
    eod.ts                     — End-of-day summary
  userbot/
    index.ts                   — gramjs listeners
    loginCli.ts                — One-time login CLI

lib/db/src/schema/             — Drizzle table definitions
```

## Environment
| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. |
| `BOT_POLLING_ENABLED` | Force-enable polling + companion listeners. Defaults: prod yes, dev no (avoids duplicate-message + duplicate-session races). Set `true` in dev only when prod is stopped. |
| `NEW_ACCOUNT_ID_THRESHOLD` | Optional. Tunes the crude "recent account" annotation on suspicious-stranger alerts: Telegram user IDs at/above this number are annotated likely-new. Annotation only — never gates or blocks. Default `7500000000`; bump over time as IDs drift upward. |
| `FOLLOWUP_ENABLED` | Optional. Customer-facing follow-up on orders that fell through (still `pending` past the delay). One generic nudge per order, open hours only. Set `false`/`0` to disable. Default on. |
| `FOLLOWUP_AFTER_MINUTES` | Optional. Minutes an order must sit `pending` before its single auto follow-up fires. Never repeated, never to blocked / mod-claimed / unverified / cancelled customers. Clamped to 30–1380. Default `120`. |
| `AI_PER_CHAT_HOURLY` | Optional. Cap on paid AI free-text replies to a single customer per rolling hour (spend/DoS guard on the uncaptured-message fallback). Over the cap, that customer gets the cheap static "DM the team" redirect instead. Default `15`. |
| `AI_GLOBAL_DAILY` | Optional. Cap on total paid AI free-text replies across all customers per rolling day. Over the cap, everyone gets the static redirect until the window rolls. Default `800`. |
| `BACKUP_RETENTION_DAYS` | Optional. Rolling window for subscriber-roster snapshots in object storage; older snapshots are pruned each time a new one is written (forensic minimization — the cold store mirrors the live DB rather than archiving forever). Default `14`. |
| `ADMIN_CHAT_IDS` | Comma-separated chat IDs with admin access (also implicitly moderators). |
| `MODERATOR_CHAT_IDS` | Comma-separated mod-only chat IDs. Optional. Union'd with `ADMIN_CHAT_IDS`. |
| `MOD_HANDLE` | The shared @ customers are redirected to after placing an order. Strip the leading `@`. |
| `BOT_USERNAME` | The bot's own @ — used inside the companion listener's auto-reply CTA. Strip the leading `@`. |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | From https://my.telegram.org. Required for the companion listener. |
| `USERBOT_SESSION_<chatId>` | One per moderator. The string-session printed by the login CLI. Treat like a password. |
| `DELIVERY_ORIGIN` | The private delivery origin as `"lat,lng"`. Lives ONLY in secrets — deliberately never committed to the repo. Unset/invalid → delivery fee lookups read TBC-at-meet (orders still flow). |
| `FAR_FLAG_AFTER_HOUR` / `FAR_FLAG_KM` | Optional pair. Team-side ⏰ FAR+LATE advisory on new-order cards: flags delivery orders placed at/after this business-timezone hour whose area is at least this many km out, so the team schedules them for tomorrow's run instead of doubling back. Values live only in secrets. Advisory only — never shown to or gated on for customers. Either missing → off. |
| `OPS_PASSPHRASE` | Optional. See `docs/ops-extras.md`. |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` | Auto-set by Replit AI Integrations. |
| `DATABASE_URL` | Auto-set by Replit PostgreSQL. |

### Brand / locale / vertical (optional — defaults match current bot)
Every knob below has a neutral default, so leaving them unset changes
nothing. They exist so the whole business identity can be configured by
editing one file (`artifacts/api-server/src/bot/brand.ts`) or setting
these env vars. See `SETUP.md` for the full setup checklist.

| Variable | Purpose | Default |
|---|---|---|
| `BRAND_NAME` | Display name in welcome / menu / help / AI prompts. | `YourBrand` |
| `BRAND_DESCRIPTOR` | One-line "what kind of business" for AI prompts. | `discreet cannabis service` |
| `VERTICAL_NOUN` | Single-word category used in AI emoji picker prompt. | `cannabis` |
| `TIMEZONE` | IANA timezone for open-hours math. | `UTC` |
| `WEEKLY_HOURS` | Per-weekday FULL hours (pickups run the whole window) as comma-separated `day=open-close` tokens, e.g. `mon=9-17,sun=10-16` (days: sun mon tue wed thu fri sat; hours 0–23, open < close). Overrides individual days; malformed tokens are ignored. | 12–22 every day |
| `WEEKLY_DELIVERY_HOURS` | Per-weekday DELIVERY sub-window, same token format, applied last and clamped inside that day's full window (fail-safe: an empty overlap falls back to the full window). | full window every day |
| `OPEN_HOUR` / `CLOSE_HOUR` | Legacy single pair. If BOTH are set (and valid), the pair applies to **every** day (delivery = full window), then the weekly vars override individual days on top. Leave unset to use the weekly schedule. | unset |
| `GEOCODE_BIAS` | Region suffix appended to suburb lookups. | `(unset)` |
| `GEOCODE_COUNTRY_CODE` | ISO 3166-1 alpha-2 country filter for Nominatim. | `au` |
| `NOMINATIM_USER_AGENT` | Contactable UA for the Nominatim policy. | derived from `BRAND_NAME` |
| `AI_FORBIDDEN_WORDS` | Pipe-separated words the AI must never echo to customers. Add your local city names. Set to `""` to disable. | category vocab |

## Customer flow
0. **New-customer verification gate (automated).** A brand-new customer is
   locked out of every business action until verified. They enter their
   LeafedOut username, get a one-time code, and drop it on their **public**
   LeafedOut profile. The bot then fetches that public profile itself,
   confirms the code, and self-approves — **no one needs LeafedOut access**.
   If the auto-check can't confirm the code after a few tries (e.g. profile
   not public, or LeafedOut unreachable), the customer falls back to an
   **admin-only** manual queue (see `/verify_queue`). Moderators stay out of
   verification, with one audited exception: `/bypass` (see the moderator
   command table). Ordering stays blocked until approved.
   Existing/grandfathered customers read as already-allowed and never see
   the gate. One LeafedOut handle can only ever verify **one** Telegram
   account — a second account entering an already-verified handle is
   silently re-shown the gate (never told why), and the verify-queue card
   warns admins about the conflict.
0b. **New-customer intro offer.** Approval (auto or admin) banks a one-time
   **50% off the first order**, but only for carts with a subtotal of
   **$250 or less** (constants live in `bot/db.ts`). Over the cap, the
   offer parks and the cart explains how to use it. Customer perks never
   combine — one per order, precedence intro 50% > promo code > store
   credit > regular $10 (parked perks come back afterwards; store-run
   sales like storewide/bundle/happy hour still stack on top). The
   discount is consumed atomically at checkout; declining that order gives
   the offer back automatically, and un-declining re-locks it (fail-closed
   if the customer already re-used it). Grandfathered customers never get
   it — it's granted only at the moment of verification approval.
1. `/start` → reply keyboard: 🕑 Today's Hours (top row — live open/closed status + today + full week) · Menu · 🛒 Cart · My Orders · Contact · How it works · Rules · Ask us.
2. Tap **Menu** → product cards (photo + name + price-from + description) with variant size buttons in a 2-column grid. Tapping a size adds 1 to the cart.
3. Tap **🛒 Cart** → numbered lines with `−`, `+`, `🗑`, subtotal, optional promo, total, **Send Order** + **Apply promo** + **Clear cart**.
4. **Send Order** → 3-step checkout: where to meet → when → notes (or skip). Order is created atomically and fanned out to the team with `/confirm_<id>` + `/cancel_<id>` shortcuts. Customer is told to DM the shared mod handle to lock in the meet.

## Bot commands

### Customer
| Command | Description |
|---|---|
| `/start` | Welcome + register |
| `/help` | Command menu |
| `/products` or `/menu` | Browse menu cards |
| `/cart` or `/order` | Open the cart |
| `/cancel` | Cancel an active checkout step |
| `/orders` | Your past 5 orders |
| `/raffle CODE` | Enter an active raffle by its code (entry counts once an admin approves it) |
| `/contact` · `/howitworks` · `/legal` | Self-explanatory |

### Admin (visible)
| Command | Description |
|---|---|
| `/admin` | Admin panel |
| `/menu` | Open the product manager (admin sees admin menu, customer sees customer menu) |
| `/add_product` · `/list_products` | Product manager shortcuts |
| `/pending_orders` · `/all_orders` · `/eod` | Order management (EOD includes flagged stock) |
| `/stock_report` | Full per-variant stock snapshot |
| `/sweep` | Run the automated security check on demand and DM the report to yourself. Same check runs weekly on its own. See `docs/security-sweep.md`. |
| `/pickup` | Advertise **extra** pickup times for today, on top of normal open hours (pickups always run during open hours): `/pickup 10am-1pm` sets it, `/pickup off` clears it. Today only; old days auto-prune. |
| `/send` | Pick exactly who gets a message — tick a checklist of customers, then compose & send (starts blank each time; nothing saved). Compose step includes a one-tap "N delivery windows to your neighbourhood this week" template — tap a number 1–5 instead of typing. |
| `/verify_queue` | Manual-review fallback: lists new customers the auto-check couldn't confirm; re-issues Approve/Reject buttons. Admin-only. |
| `/confirm_<id>` · `/cancel_<id>` | Confirm/cancel an order, notifies customer |
| `/confirmall` | Bulk-confirm every pending order |
| `/promos` · `/add_promo CODE percent 10` · `/add_promo CODE fixed 1500` · `/del_promo CODE` | Promo manager |
| `/raffles` · `/add_raffle CODE <prize>` · `/draw_raffle CODE [count]` · `/del_raffle CODE` | Raffle manager — same-day 24h giveaways, entry by code (see **Raffles**) |
| `/backfill_variants` | Re-run boot-time backfill (creates "Each" variants for legacy products) |
| `/regen_emojis` | AI re-picks emoji for every product |
| `/add_relay <label>` · `/remove_relay` · `/list_relays` | Relay channels |
| `/myid` | Anyone — replies with your chat ID |

### Moderator (mods or admins)
| Command | Description |
|---|---|
| `/take <chatId>` · `/release <chatId>` · `/forcerelease <chatId>` | Claim / drop / override a customer chat |
| `/bypass <@user or id>` | Manually wave a still-gated customer through verification (exceptions only). Refuses banned handles and handle conflicts; never grants the intro offer; every use is fanned out to admins for audit |
| `/reply <chatId> <msg>` | Send a message to a customer through the bot |
| `/active` · `/mods` | List claimed chats / configured mods |
| `/driving [<text>\|reset]` | View / set / clear the companion listener's auto-reply text |

## Raffles
Lightweight giveaways. `/add_raffle CODE <prize>` starts one; the prize is free
text and is only ever shown to admins (never echoed to customers). There is
**no announcement** — the operator hands the code out directly. Customers enter
with `/raffle CODE` — one entry each, re-entering is a no-op. **Every entry
needs a manual OK**: it lands as *pending*, each admin gets a prompt with
✅ Approve / ⛔ Reject buttons, and only approved entries make the draw
(fail-closed — an unreviewed entry is never drawn). Reject sends the customer a
neutral one-liner and keeps the row flagged rejected, so re-sending the code
can't re-ping the team (rejected rows are swept with everything else in ≤24h).
`/raffles` shows approved vs waiting counts and re-issues buttons for anything
still pending. A raffle is a
**same-day 24h event**: entries live at most 24h (forensic minimization), so
hand out the code and `/draw_raffle CODE [count]` the same day. The draw picks
winner(s) at random from the approved pool, wipes every entry atomically, and
DMs each winner a *generic* congrats (no prize text, no forbidden words). Admin
sees who won — follow up with the prize via `/reply <id> <message>`.
`/del_raffle CODE` removes a raffle and clears its entries. Undrawn raffles'
entries are also swept by the 24h purge.

## Adding a relay channel
1. Add the bot to the group (or start a private chat).
2. Send `/add_relay Kitchen Team` (replace label as needed).
3. The bot will fan out every new order to that chat (deduped against `MODERATOR_CHAT_IDS`).

## Operational docs
Long-form playbooks live in `docs/`. Each doc is self-contained — read
only the one you need:

- `docs/mod-guide.md` — Quick reference for moderators (day-to-day usage).
- `docs/userbot-setup.md` — One-time Telegram API setup + per-moderator login.
- `docs/userbot-internals.md` — How the companion listener decides when (and when not) to auto-reply.
- `docs/cart-and-emoji.md` — Variants, cart persistence, promo validation, emoji picker.
- `docs/delivery-fees.md` — Radius rules.
- `docs/regulars.md` — Repeat-customer pricing tier.
- `docs/data-retention.md` — Two-layer 24h purge (chat + DB).
- `docs/pending-reminder.md` — 15-min reminder + open-time digest.
- `docs/promo-broadcaster.md` — AI daily promo blaster.
- `docs/ops-extras.md` — Operator-only surface. Keep this one private.
- `docs/security-sweep.md` — Weekly automated security self-check + `/sweep`.

## User preferences
- Plain-language, concise replies. The operator is non-technical.
- Forensic minimization is a hard requirement. Default to fail-closed.
- Don't centralize sensitive details in any single file.
