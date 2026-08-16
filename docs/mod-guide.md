# Mod Guide

Quick reference for moderators. Keep this on your phone.

---

## The two things on your phone

1. **The bot** (your bot's @username) — where customers build orders. You get
   alerts here when an order comes in.
2. **Your own Telegram account** — where customers DM you to lock in
   the meet. A helper is running quietly on your account that auto-replies
   if you don't answer within 5 minutes. The helper never names or links
   the bot account — that separation stays manual on your end.

---

## You are NOT part of customer verification

New customers have to prove they own a real LeafedOut account before they
can order. **That is fully off your plate — and deliberately so, for your
safety.** The bot does the whole check itself: the customer drops a one-time
code on their *public* LeafedOut profile, the bot reads that public page and
approves them automatically. No one on the team ever needs LeafedOut access.

- You never look at, log into, or touch LeafedOut.
- You are never exposed to a brand-new, unverified stranger for verification.
  New customers stay fully blocked from ordering until the bot clears them.
- If the bot can't auto-confirm someone (rare — e.g. their profile isn't
  public), it goes to the **owner/admin only** for a manual look. It never
  comes to you.

**One exception — `/bypass`.** If someone the team personally knows is stuck
at the gate (for example LeafedOut is down, or they genuinely can't use it),
you can wave that one account through yourself:

| Command | What it does |
|---|---|
| `/bypass 123456789` (or `/bypass @theirTelegram`) | Lets that customer skip verification |

Use it for genuine exceptions only. Guardrails you should know about:

- It only works on accounts still stuck at the gate — it can't touch anyone
  already in.
- It refuses accounts tied to a banned LeafedOut profile, and profiles
  already verified on another Telegram account (that's usually someone
  double-dipping). Those stay admin-only decisions.
- A bypassed customer does **not** get the 50%-off welcome offer.
- **Every bypass is reported to the admins automatically**, with your ID on
  it. That's not a gotcha — it's so the whole team knows who's been let in
  and why the usual proof isn't on file.

---

## When an order comes in

You'll get a message like this in your DM with the bot:

```
*Order #42 — new*
Customer  John (@john)
Chat      123456789
Items     ...
Total     $80.00
Where     Brunswick, near the tram stop
Time      ASAP
Reply     /reply 123456789 <message>

[ ✅ Confirm ]   [ ❌ Decline ]
```

- Tap **✅ Confirm** to take it. The customer is told it's confirmed.
- Tap **❌ Decline** if you can't. The customer is told it's cancelled.
- The text commands `/confirm_42` and `/cancel_42` still work as a fallback.
- If two mods tap at the same time, only one wins. No double-bookings — the
  buttons strip themselves once it's done.

**Tip:** if a pile of orders came in overnight, you'll get one digest
message at open listing them all. Knock them down one by one, or fire
`/confirmall` to clear them all at once.

---

## 🤝 Grouped drops (free delivery)

Some delivery orders now carry a **🤝 group-ok** badge — you'll see it on
the order alert and in `/pending_orders`. It means the customer is happy
for us to batch their drop with another order nearby so we can waive the
delivery fee.

- Scan the pending list for two or more **🤝 group-ok** orders in the
  **same area** around the **same time** — run them on one trip and waive
  the fee at the meet.
- The waiver happens **in person, at the meet**. There's nothing to toggle
  in the bot.
- **Never confirm or deny another nearby order to a customer.** If someone
  asks whether they got paired, who with, or if anyone else nearby ordered
  — don't say. Just handle their drop. One customer must never learn
  anything about another.

---

## ⏰ FAR + LATE flag

Some order alerts carry a **⏰ FAR + LATE** line. It means the order came
in late in the day AND the drop is a long way out — a prime candidate for
a wasted second trip.

- The customer has **not** been told anything — the order went through
  normally on their side. The flag is for your eyes only.
- Usual play: confirm it but line it up for **tomorrow's run** (agree the
  time in DM), or decline with a friendly "we'll get you first thing
  tomorrow" if it can't work.
- **Never tell the customer their area is "too far" or "outside the
  cutoff".** Distance talk is off-limits, same as with grouping — keep it
  to timing ("we're fully booked tonight, first run tomorrow?").

---

## /dash — one-screen snapshot

Type **`/dash`** any time for a quick read on the day:

- Orders today + cash earned (confirmed only)
- Top mover today
- Pending count + active claimed chats

Tap the **🔄 Refresh** button to update in place.

---

## /qr — quick-reply templates

When you've claimed a chat (`/take <chatId>`), type **`/qr`** to fire a
preset reply with one tap:

- 🛵 On my way
- ⏱ 5 min out
- 🕓 ~10 late
- 📍 Arrived

If you've got more than one chat claimed, you'll pick which one first.

---

## Bulk confirm

If you've got 5+ pending orders and you're taking them all:

```
/confirmall
```

Confirms every pending order in one shot. Each customer gets their own
confirmation.

---

## The 15-min reminder

If an order has been sitting `pending` for 15 min during open hours,
the bot will ping you again with a warning. One nudge per order, not
spam.

Outside open hours the bot is silent — the digest at open
catches everything.

---

## Your auto-reply (`/driving`)

The helper on your personal account auto-replies to customers who DM
you, **but only after 5 minutes of you not replying**. If you reply
within 5 min, the helper stays quiet — the human got there first.

The helper will never name or link the bot account, never send a menu
link, and never push the customer to your other surface. If a customer
asks where to order, it just says "I'll send through what's on as soon
as I'm back to my phone." If they say they've already placed an order,
it asks them to forward you the confirmation. You handle the bot-side
turnaround manually so the two accounts stay unlinked.

Default behaviour is fine for most cases. To customise:

| Command | What it does |
|---|---|
| `/driving` | Show your current auto-reply text |
| `/driving Out til 5, hit me back then` | Set a custom one-liner |
| `/driving reset` | Go back to the default |

Send these in your DM with the bot, not on your personal account.

---

## The verification gate (important)

The helper will **NEVER** auto-reply to a brand-new customer. So if a
total stranger DMs you for the first time today, the helper stays
silent — only you can decide whether to engage.

The helper auto-trusts a customer **only once you've personally replied
to them at least once** (any time in the past — it checks your chat
history). Until then they count as a stranger and the helper stays quiet.

So anyone you've talked to before is covered automatically. Only people
you've never replied to need a real first reply from you before the
helper will jump in.

## Heads-up: an unknown account messaged you

If someone you've **never replied to** DMs your personal account and they
don't look like one of our customers, the bot sends YOU a private
heads-up — in your DM with the bot, not on your personal account.
It looks like:

```
⚠️ An unverified account just messaged your personal Telegram.
• Telegram ID: 123456789
• Username: none set
• Looks like a recent / newly-made account
• Not a verified customer or a regular

[ 🚫 Block & delete ]
```

- **Know them?** Just reply to them as normal on your own account — the
  heads-ups stop on their own.
- **Don't want them?** Tap **🚫 Block & delete**. In one tap that blocks
  them on YOUR phone and wipes that chat, AND blocks them on the bot and
  erases their data.

You'll get this on their first message, and once more if they keep
messaging (3+ times) and still aren't a verified customer. It **never
blocks anyone by itself** — nothing happens unless you tap the button.

## When the helper stays quiet on purpose

If the customer just sent **"ok"**, **"thanks"**, **"cheers"**, a
**👍**, or anything that's clearly a sign-off — the helper won't reply.
The conversation is done; no point speaking up after a natural ending.

---

## Replying through the bot (rare)

Mostly you'll talk to customers on your own account. But if you ever
need to send a message **through the bot** (for example, to a customer
who hasn't DM'd you yet):

| Command | What it does |
|---|---|
| `/take 123456789` | Claim that customer chat |
| `/reply 123456789 Hey, on my way` | Send a message to them |
| `/release 123456789` | Drop your claim when done |
| `/forcerelease 123456789` | Override another mod's claim |
| `/active` | List who's claimed which chat |
| `/mods` | List configured mods |

**Sticky claims are auto-released after 10 minutes.** If you `/take` a
chat and don't `/reply` or `/qr` for 10 min, the bot drops your claim
and DMs you a heads-up. This stops the old failure where a mod takes
a chat, goes silent, and the customer hangs with no AI reply. If
you're actually still working it on your personal DM (which is the
normal case), no action needed — the auto-release just unblocks the
fallback for any new message. If you want the bot to suppress the AI
again, `/take` it back.

---

## Order management commands

| Command | What it does |
|---|---|
| `/pending_orders` | List all pending orders |
| `/all_orders` | Last 20 orders, any status |
| `/eod` | End-of-day sales summary (now includes flagged stock) |

---

## Stock — your daily chore

Customers see ZERO stock language on the menu. Sold-out sizes just
disappear; products with every size sold out disappear entirely. So
the menu always shows things people can actually buy. That only works
if you keep stock state honest.

**Twice a day (at open + 10:30pm)** the bot DMs each mod a quick stock
check — one tap per strain:

- 🟢 **Healthy** — every size of that product flips back to in-stock.
- 🟡 **Low** — every size flips to low (still buyable, but the admin
  knows to restock).
- 🔴 **Out** — every size flips to sold-out and the product disappears
  from the customer menu instantly.

Every tap fans an instant DM to the admin so they always see what you
saw. Zero miscommunication is the goal — if you skip the tap, the
admin doesn't know.

You can also fire the check on demand: `/stockcheck`.

### Per-size changes (rare)

When only one size of a product is off — say the 3.5g is gone but the
ounces are fine — use:

```
/stock <variantId> in_stock | low | sold_out
```

Variant IDs are shown next to every size in `/stock_report`. Each
`/stock` call also fans an instant DM to the admin.

### The admin's view

| Command | What it does |
|---|---|
| `/stock_report` | Full snapshot of every product × every size with state + variant IDs |
| `/eod` | Daily end-of-day report now includes a "Stock flagged" section listing every LOW or SOLD OUT size |

The admin gets a DM **the moment any stock state changes**, plus the
EOD summary at close, plus can pull `/stock_report` whenever they want.

---

## Don't do this

- ❌ Don't share your `USERBOT_SESSION_*` string with anyone. It's
  the password to your account.
- ❌ Don't run the userbot login CLI on a phone or shared computer.
- ❌ Don't install the helper on your account if you also use a 3rd
  party Telegram client — they can fight.
- ❌ Don't manually delete bot messages — they self-delete after 24h
  on their own.

---

## Trouble?

- **Helper is replying when I'm actively chatting:** you didn't reply
  within 5 minutes. Reply faster, or set a custom `/driving` line so
  the auto-reply matches what you'd say.
- **Helper isn't replying at all to a stranger:** that's the
  verification gate working. Reply to them once yourself; future
  silences will be covered.
- **I confirmed an order but the customer says they got nothing:**
  check `/pending_orders` to confirm it actually flipped. If the
  customer chat is broken, use `/reply <chatId> <msg>`.
- **Two of us confirmed the same order:** only one notification fires.
  The second `/confirm_<id>` will tell you it's already handled.

---

## Open hours

Hours vary by day (business timezone). Each day has a full window (pickups
run all of it) and a shorter **delivery** window inside it (that's when
the drives happen):

- **Mon–Wed** — 3pm–10pm · delivery 3pm–8pm
- **Thu** — 2pm–10pm · delivery 3pm–9pm
- **Fri–Sat** — 12pm–11pm · delivery 2pm–9pm
- **Sun** — 2pm–10pm · delivery 4pm–8pm

Outside the delivery window (but while we're open) it's pickup only.
Outside all hours the bot tells customers we're closed but lets them
queue an order for open.

## Extra pickup times

Pickups always run during normal open hours. On top of that, the admin
can advertise **extra** pickup availability for the day (say, a morning
slot before open): `/pickup 10am-1pm` sets it, `/pickup off` clears it,
`/pickup` on its own shows what's currently set. It applies to **today
only** and wipes itself each day. Customers see it at checkout when
they pick Pickup; exact spot + time still gets locked in by DM as
usual.
