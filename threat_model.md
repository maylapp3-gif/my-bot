# Threat Model

## Project Overview

Private Telegram ordering bot for a small team. The production system is a Node.js/Express service that runs three meaningful server-side surfaces: a customer-facing Telegram bot (`node-telegram-bot-api` long polling), moderator/admin command handling inside that bot, and per-moderator `gramjs` userbot listeners that send delayed auto-replies from moderators' personal Telegram accounts. PostgreSQL stores orders, carts, subscribers, moderator status, and pricing data. Replit object storage holds subscriber snapshots. OpenAI is used for customer FAQ replies on uncaptured free-text bot messages, admin product parsing, and userbot auto-replies.

Production scope for this repo is narrow: the real attack surface is Telegram-driven, not browser-driven. The Express app exposes only a health endpoint. Mockup sandbox assumptions from the scan environment apply: dev-only tooling and any non-production sandbox paths are out of scope unless separately shown reachable in production.

## Assets

- **Customer contact and identity data** — Telegram chat IDs, usernames, names, subscriber lists, moderator-linked DM peers. Exposure enables customer scraping, targeting, and privacy harm.
- **Order and cart data** — products, quantities, delivery area, notes, timing, order status, store credit, referral state. This is operationally sensitive and customer-traceable.
- **Moderator/admin authority** — admin chat IDs, moderator commands, hidden ops passphrase, moderation claims, userbot sessions. Compromise lets an attacker broadcast, wipe data, restore snapshots, impersonate moderators, or alter orders.
- **Application secrets and tokens** — Telegram bot token, Telegram API credentials, userbot session secrets, database URL, OpenAI integration credentials, object-storage credentials. Leakage would permit takeover of bot or backend capabilities.
- **Business-sensitive location and routing data** — delivery-fee origin logic, relay chats, operational handles, hidden operator workflows.
- **Availability and API spend** — the public bot can trigger paid external AI and geocoding work; abuse here can create direct cost and disrupt real order handling.

## Trust Boundaries

- **Telegram user to bot server** — all customer/admin/moderator input arrives from Telegram and must be treated as untrusted despite Telegram identity metadata.
- **Customer to moderator/admin boundary** — moderators and admins have privileged commands and receive customer/order data; customer-controlled content must never unlock moderator/admin behavior.
- **Bot server to PostgreSQL** — the app has broad write access to orders, carts, subscribers, promos, moderator status, and credits. Logic flaws here can directly alter money-value and privacy-sensitive data.
- **Bot server to external services** — OpenAI, Telegram APIs, Nominatim geocoding, and Replit object storage are outside the app trust boundary. External calls must avoid leaking secrets or over-sharing customer data, must resist abuse from untrusted users, and must fail safely.
- **Bot server to moderator personal accounts (userbot)** — userbot replies happen from personal Telegram accounts. Cross-surface leakage here is especially sensitive because it can deanonymize moderators or link separated identities.
- **Public HTTP to Express app** — production HTTP exposure exists, but current code only mounts a health route. Wider HTTP findings are out of scope unless new production routes appear.
- **Production vs dev-only boundary** — local helper files, login CLIs, docs, and sandbox-only surfaces are not findings unless they are shown reachable or shipped in production runtime behavior.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/bot/index.ts`, `artifacts/api-server/src/userbot/index.ts`.
- **Highest-risk areas:** bot command routing and callbacks under `artifacts/api-server/src/bot/handlers/`, hidden ops in `artifacts/api-server/src/bot/hiddenOps.ts`, persistence/business logic in `artifacts/api-server/src/bot/db.ts`, public free-text AI fallback in `artifacts/api-server/src/bot/index.ts` + `artifacts/api-server/src/bot/ai.ts`, and userbot auto-reply flow in `artifacts/api-server/src/userbot/index.ts`.
- **Public vs privileged surfaces:** customer Telegram messages and callbacks are public; moderator/admin commands are privileged by Telegram chat ID allowlists; hidden ops add a second passphrase gate for especially sensitive actions.
- **Usually ignore unless reachability changes:** Express router under `artifacts/api-server/src/routes/` (currently health only), one-time login CLI/docs, dev-only sandbox assumptions.

## Threat Categories

### Spoofing

The system trusts Telegram chat IDs to distinguish customers, moderators, and admins. The application must enforce every privileged action server-side using the configured admin/moderator allowlists, and userbot sessions must be bound to the intended moderator identity so one moderator session cannot silently operate as another. Hidden operator actions must not become discoverable or triggerable by ordinary customers.

### Tampering

Customers can influence carts, checkout flow, referral codes, delivery areas, and free-text notes. The server must derive prices, discounts, stock state, delivery fees, and order status from trusted server-side data rather than customer input. Moderator/admin callbacks and commands must not let customers alter order state, credits, or subscriber data by replaying or guessing identifiers.

### Repudiation

Orders, moderator actions, broadcasts, and panic-wipe style operations are sensitive business events. The system should preserve enough server-side audit evidence to attribute privileged actions to a Telegram chat ID, even while honoring the project's forensic-minimization goals for customer data. Retention minimization should not erase the ability to tell which moderator or admin performed a destructive action.

### Information Disclosure

The most important disclosure risks are customer lists, order details, moderator identity linkage, Telegram tokens/session strings, and operational location data. Logs, AI prompts, object-storage backups, admin summaries, and moderator tooling must not expose more information than each role requires. The userbot surface is especially sensitive because it must avoid linking a moderator's personal account to the public ordering bot.

### Denial of Service

The production surface is message-driven and can be abused with spam, repeated bot interactions, or resource-heavy external lookups. Publicly reachable paths must not permit an untrusted user to trigger unbounded work, excessive external API usage, or repeated destructive maintenance behavior. The uncaptured free-text AI fallback is in scope here because each message can trigger paid external work. External service failures must degrade safely rather than blocking order handling or leaking internal errors.

### Elevation of Privilege

Broken access control on admin commands, moderator callbacks, hidden ops, restores, broadcasts, or order-state transitions would immediately expose customer data or grant control over the business workflow. The system must ensure that customer-originated content cannot cross into admin/moderator execution paths, that database operations remain parameterized, and that restore/wipe features cannot be reached without the intended layered authorization checks.
