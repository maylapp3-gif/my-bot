# Weekly security sweep

The bot runs an automatic weekly self-check ("the sweep") and DMs a plain-language
report to every admin. You can also fire it any time with `/sweep` — the report
comes back to just you.

Nothing in the sweep changes anything. It only *looks* and *reports*. It is safe
to run as often as you like.

## When it runs

- **Automatically:** once a week, Monday 9am (business timezone), to every admin.
- **On demand:** send `/sweep`. Admin-only. The report is DM'd back to you.

## What it checks

The sweep is split into independent "agencies", each covering one area. Every
area comes back with ✅ (all good), ℹ️ (just so you know), ⚠️ (worth a look),
or 🚨 (urgent).

| Area | What it's looking for |
|---|---|
| **Settings & keys** | The bot token and other required settings are present and well-formed. A delivery origin that's set but malformed (would silently fall back to quote-at-meet) is flagged. |
| **Team access** | At least one admin is configured, and every admin/moderator entry is a valid numeric chat ID (a typo'd entry silently does nothing). |
| **Auto-delete (24h)** | Confirms the 24h auto-wipe is actually keeping up — counts any customer-related rows (orders, carts, chats, raffle entries, verify codes) still around past 24h, and any contact-list backups past the retention window. |
| **New-customer gate** | No unverified customer is holding a live order (a sign the verification gate leaked), and no LeafedOut handle is tied to more than one Telegram account. |
| **Orders & money** | Order totals aren't negative, the one-time first-order offer isn't in a contradictory state, no promo has been used past its cap, and no product size is priced at $0. |
| **Wording check** | Scans your menu and promo copy for words customers shouldn't see (category words, city names). Names the item to fix — it never repeats the offending text back in full. |

## Reading the report

The report leads with a one-line verdict:

- **✅ All clear** — nothing needs you.
- **⚠️ N things to look at** — non-urgent; fix when convenient.
- **🚨 N things need attention** — do these soon.

Each flagged line tells you what and, where you'd need it to act, the exact chat
IDs or promo codes involved.

## Privacy

The report is built for forensic minimization, same as everything else:

- It carries **counts**, not customer records. The only per-record detail it ever
  includes is a Telegram chat ID (the same IDs already on your order cards), and
  only where you'd need it to act.
- It never includes customer names, usernames, notes, delivery areas, or LeafedOut
  handles.
- The wording check names the product/promo and the single matched word — it never
  echoes a full customer-facing string that contains an off-limits word.
- The report goes only to admins, never to moderators or customers.

## Related settings

- `AI_PER_CHAT_HOURLY` / `AI_GLOBAL_DAILY` — caps on paid AI free-text replies
  (spend/abuse guard on the "ask us anything" fallback).
- `BACKUP_RETENTION_DAYS` — how long subscriber-roster snapshots live in cold
  storage before they're pruned (default 14 days). The sweep flags backups that
  overran this window.
