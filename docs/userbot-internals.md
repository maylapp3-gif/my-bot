# Userbot internals

> The userbot is the gramjs MTProto session running on a moderator's
> personal Telegram account (one per mod). For the one-time login flow
> see `userbot-setup.md`.

## Always armed
There is no on/off toggle. The userbot listens to every incoming DM on
the mod's account and decides whether to auto-reply.

## First-touch verification gate
The userbot will NEVER auto-reply to a brand-new peer. A peer becomes
"verified" (auto-reply unlocked) ONLY once the moderator has personally
touched the conversation. Two signals, both proof of human contact:

1. **Mod sent an outgoing message (this process)** — every outgoing
   event marks the peer verified immediately.
2. **Mod has ever replied (history)** — on first contact we run a
   one-shot `getMessages(peer, { limit: 100 })` and, if any past message
   is outgoing (`out === true`), mark verified. Cached per process via
   `historyChecked` so the lookup runs at most once per peer.

Nothing else verifies a peer. In particular, **"regular" status and the
age of the customer's first message are deliberately NOT used**:
- A global `regular` flag isn't proof *this moderator* personally knows
  the person — trusting it would let any regular trigger auto-replies
  from every mod account on first contact, deanonymising mods.
- Message age is trivially farmable (sit on a DM for 24h, then poke).

Brand-new peers the mod has never replied to still need a manual reply
before the auto-reply unlocks.

In-memory `verified` Set per userbot instance + `historyChecked` Set so
the lookup only runs once per peer per process.

## Suspicious-stranger flag (mod heads-up + one-tap Block & delete)
Reuses the verification gate's "newcomer" decision — it lives entirely
inside the newcomer branch, so it can NEVER change auto-reply behaviour
(a flagged newcomer still gets no auto-reply).

- **Candidate** = newcomer (mod has provably never replied) AND not
  "OK". "OK" = an approved customer on the bot (`verified` true or NULL
  grandfathered) OR an operator-marked regular. Telegram user ids are
  global, so the userbot peer id is the same id the bot stores for that
  person — we can look up bot-side approval/regular state directly.
- **Signals** in the alert (annotation only — none of them gate):
  - account-age heuristic — crude, derived from the numeric user id vs a
    configurable threshold (`NEW_ACCOUNT_ID_THRESHOLD`, default 7.5e9).
    Approximate and may be "unknown"; Telegram exposes no real account
    age to bots/userbots.
  - no `@username` set.
  - not a verified customer / regular.
- **Debounce / escalation** — alert on the 1st message and again on the
  3rd, per peer, in memory. Evicted on the same cooldown as the auto-
  reply debounce, and cleared the instant the mod replies (that peer is
  no longer a stranger). DB lookups happen only on the 1st and 3rd
  message, bounding work under spam.
- **Delivery** — the alert is sent through the BOT to the mod's bot DM
  (never from the personal account), carrying a single
  "🚫 Block & delete" button. The peer's message text and name are never
  included (forensic minimization) — only id, the @username if set, and
  the signal lines. The alert itself is tracked for the same 24h
  self-destruct as other bot DMs, so an untapped alert (which carries the
  stranger's id) doesn't linger past the purge window.

### What the button does
Authorised to moderators/admins only; the acting mod is derived from the
bot chat that holds the button, never from callback data (which is
forgeable). On tap it acts on BOTH surfaces, independently and
fail-closed:
- **Personal account** (this mod's gramjs session): `contacts.Block`
  then `messages.DeleteHistory({ revoke: true })`, looped until drained,
  to wipe the DM both sides. The InputPeer is stashed at detection time
  so even a never-resolved stranger has a usable handle; falls back to
  `getInputEntity` if it was evicted.
- **Bot**: writes the persistent blocklist row FIRST, then purges the
  subscriber. The blocklist is enforced fail-closed at three choke
  points (start, message router, callback router); admins/mods exempt.

The alert is edited in place to report each surface's result; a failure
on one side never blocks the other.

## Privacy posture — no cross-account leakage
The userbot account runs in a low-profile / privacy-locked posture. Its
auto-replies (both AI and the canned away pool) MUST NOT name, link, or
hint at the public bot account, the shared mod handle, or any other
team Telegram surface. Doing so creates a discoverable link between the
two accounts and undoes the separation we're protecting.

Enforcement:
- AI prompt explicitly forbids `@anything`, "the bot", "our other
  account", "DM us at", "menu link", etc. The fallback example for any
  "menu / link / where do I order" question is to say "I'll send through
  what's on as soon as I'm back to my phone".
- AI sanity check rejects any output containing an `@handle` or `t.me/`
  link, falls through to the canned pool.
- Canned away pool is hand-written without any `@-mention`.
- For "I sent the order" type messages, the reply asks the customer to
  forward the confirmation message — phrased generically, no surface
  name. The mod handles the cross-account turnaround manually.

## 5-minute grace window
When a customer DMs the mod's account, the userbot arms a 5-minute
timer. If the mod's account sends ANY outgoing message to that peer
inside the window, the timer is cancelled — the human got there first.
Briefly tried 90s; operator feedback was it fired too aggressively on
top of conversations the mod was already mid-replying to.

## Conversation-closer guard
If the customer's incoming message is a sign-off ("ok", "thanks",
"cheers", "👍", emoji-only, etc.) the userbot will NOT arm a timer and
will cancel any in-flight one. The conversation is done; the userbot
shouldn't speak up after a natural ending.

Heuristic: strip punctuation/emoji/whitespace, lowercase, check the
remainder against a closer-token set. Whole-message match only — "ok
cool what about runtz" is NOT a closer because there's still a real
question.

## (legacy heading kept for cross-ref) 5-minute grace window
When a customer DMs the mod's account, the userbot arms a 5-minute
timer. If the mod's account sends ANY outgoing message to that peer
inside the window, the timer is cancelled. If the timer fires with no
mod reply, the userbot sends one auto-reply.

Was 5 min originally. Shortened because real-world customers were
dropping off before the CTA hit.

## Per-customer debounce
Each peer gets at most one auto-reply per hour. New incoming messages
while a timer is already armed don't reset or stack the timer — they
just queue silently for the existing timer to fire or get cancelled.

## Reply selection (priority order, first match wins)
1. Mod's custom `/driving <text>` line — fixed string, no AI.
2. AI-generated reply (`bot/aiAutoReply.ts`) — answers the customer's
   actual question AND pivots to "send the order on the bot." Sanity
   check rejects empty/oversized output or replies missing the bot CTA.
3. Fixed pool fallback (rotating, time-aware) — used when AI fails or
   the customer sent only media:
   - **OPEN pool** (~12 lines, "tied up, back shortly") — during open
     hours (they vary by weekday; see `replit.md`).
   - **CLOSED pool** (~10 lines, conversion-focused) — outside hours.
     Pushes the customer to build the order on the bot now so it's
     queued for open.

`/driving` (no args) shows the mod which mode they're in and lists
both fallback pools.

## Polling gate
Userbot listeners only boot in the prod process (`BOT_POLLING_ENABLED`
defaults true in deployment, false in dev). Two listeners on the same
session would race and produce `AUTH_KEY_DUPLICATED`.

## Failure modes
- `USERBOT_SESSION_<chatId>` missing or revoked → no auto-reply, single
  boot warning.
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` missing → all userbots
  disabled, single boot warning.
- Identity guard: if the env-var chatId doesn't match the logged-in
  account, that listener refuses to start (impersonation guard).
