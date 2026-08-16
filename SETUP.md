# Setup — new owner checklist

This is a clean, identity-free copy of the ordering bot. All features are
1:1 with the original system; nothing here identifies the previous
operator. Follow these steps in order and the bot is fully yours.

## 1. Import into Replit

Upload this folder (or the zip) into a fresh Replit App on your account.
Ask the Replit agent to install dependencies and start the API Server —
the workspace is a pnpm monorepo and each service has an `artifact.toml`
the agent uses to configure its workflow. Then ask the agent to:

1. Create a PostgreSQL database (built-in Replit database).
2. Set up App Storage (object storage bucket) — used for backups and promo state.
3. Set up the OpenAI AI integration (used for menu copy, promos, and emoji generation).
4. Push the database schema: `pnpm --filter @workspace/db run push`.

The database starts completely empty — no customers, no orders, no
products from anyone else.

## 2. Telegram credentials (Secrets pane — never commit these)

| Secret | Where it comes from |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Create a **new** bot in @BotFather |
| `BOT_USERNAME` | Your new bot's @ (no leading `@`) |
| `MOD_HANDLE` | The @ your customers DM after ordering (no `@`) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | Your own https://my.telegram.org account (only needed for the per-moderator companion listener) |
| `USERBOT_SESSION_<chatId>` | One per moderator — follow `docs/userbot-setup.md` |

## 3. Your team

Have each admin/moderator message the new bot and run `/myid`, then set:

- `ADMIN_CHAT_IDS` — comma-separated chat IDs, full admins
- `MODERATOR_CHAT_IDS` — comma-separated, mods only (optional)

## 4. Your identity & region

Everything lives in `artifacts/api-server/src/bot/brand.ts` (or the
matching env vars). The copy ships with neutral defaults — set at least:

- `BRAND_NAME` — your display name
- `TIMEZONE` — your IANA timezone (defaults to UTC until you set it)
- `WEEKLY_HOURS` / `WEEKLY_DELIVERY_HOURS` — your real schedule
  (defaults: 12pm–10pm every day)
- `GEOCODE_BIAS` + `GEOCODE_COUNTRY_CODE` — your region, for delivery
  suburb lookups (empty = worldwide, less accurate)
- `AI_FORBIDDEN_WORDS` — add your local city names to the category list
  so the AI never reveals your region

Delivery-fee secrets (optional): `DELIVERY_ORIGIN` as `"lat,lng"`, and
`FAR_FLAG_AFTER_HOUR` + `FAR_FLAG_KM` for the late/far advisory. Unset →
fees read "TBC at meet" and the advisory is off.

Optional ops: `OPS_PASSPHRASE` (see `docs/ops-extras.md`).

## 5. Products

Open a chat with your bot as an admin and use `/admin` → product manager
(`/add_product`). The menu lives in your database only.

Every other behavior knob (hours, happy hour, promo slots, follow-ups,
AI rate limits, discounts, etc.) is optional with a sensible default —
the full table lives in `replit.md` under "Configuration knobs".

## 6. Smoke test, then publish

`BOT_POLLING_ENABLED` is off in dev by default. Set it `true` once, send
`/start` from your phone, confirm the welcome card shows *your* brand
name, then unset it and publish. See `docs/mod-guide.md` for
day-to-day team usage.
