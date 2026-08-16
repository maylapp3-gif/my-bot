# Operator extras

> Treat this file as private. Do not commit a copy of it to public
> mirrors and do not paste it into AI chats.

## Decoy admin surface
The visible `/admin` panel intentionally lists ONLY ordering / products
/ relays / mods commands. A casual snooper sees a generic ordering bot.

All sensitive commands are gated by a private passphrase set in the
`OPS_PASSPHRASE` env var (≥6 chars). Type the passphrase alone in DM
with the bot to get the hidden menu, or `<phrase> <op> [args]` to run
an op directly.

If `OPS_PASSPHRASE` is unset (or <6 chars), the entire hidden surface
is disabled and a single boot warning is logged. Better to fail closed
than ship with a guessable default.

Non-admins who guess or learn the passphrase get NOTHING — no error,
no acknowledgement. There's no oracle for guessing.

## Vocabulary (case-insensitive)
- `<phrase>` → show menu
- `<phrase> contacts` → dump the contact list
- `<phrase> blast <message>` → broadcast to every contact
- `<phrase> autoblast [status|on|off|now|preview]` → AI daily promo blaster
- `<phrase> snapshot` → snapshot contacts to cold storage now
- `<phrase> snapshots` → list cold-storage snapshots
- `<phrase> restore [YYYY-MM-DD]` → restore contacts from snapshot (default: latest)
- `<phrase> regulars` → list regulars
- `<phrase> regular+ <chatId> [notes]` → flag as regular
- `<phrase> regular- <chatId>` → un-flag
- `<phrase> wipe CONFIRM_NUKE` → ☠️ panic-wipe everything

## Suspicious-activity alarm
In-memory sliding window. If 5+ failed admin attempts hit in 5 minutes
from non-admin chats, all admins + mods get a DM listing the attacker
chat IDs. 30-min cooldown so legit fat-fingering doesn't spam. Hooked
at `/admin` rejection (highest-signal probe) and at every sensitive
command's admin check. NOT auto-wipe — operator decides.

## Cold-storage backups
- Daily snapshot of subscribers at 03:00 UTC →
  `<PRIVATE_OBJECT_DIR>/subscribers/snapshot-YYYY-MM-DD.json`.
- Snapshots are kept forever (tiny JSON, cheap).
- Restore is UPSERT on chatId, default = most recent.

## Panic wipe
Single `TRUNCATE ... CASCADE` across every customer/business table:
subscribers, orders, order_items, products, product_variants,
cart_items, cart_promos, promo_codes, bot_messages, relays, mod_status,
conversations, messages, regular_customers.

Auto-snapshots subscribers to cold storage immediately before the wipe.
Object-storage backups + env secrets (incl. userbot sessions) survive.
Re-seed via `/menu` after.

## What this is NOT
Not real intrusion detection. Telegram itself sees every bot message;
network interception is invisible. The alarm and wipe are an operator
tool — the human admin decides to fire.

## Rotation
Rotate the passphrase by editing the secret. No redeploy needed; the
new value is read on next message.
