# Cart, promos & emoji picker

## Variants
Every product can have 1–8 sizes (label + priceCents + position).
Customers can only add a product to their cart via a variant button.
Products with zero variants render with a "View Cart" placeholder and
admin warning.

## Cart persistence
Cart sessions are in-memory (30 min TTL) — cleared on bot restart.
Cart line items themselves are persisted in `cart_items` (UPSERT on
`chatId+variantId`), so customers don't lose their cart between
messages.

## Promo codes
- Kinds: percent (1–99%) or fixed (cents).
- Validated against the cart at apply-time AND at order-finalize-time.
- `usedCount` is bumped atomically inside the order transaction.

## Perk exclusivity — discounts never combine
Customer perks are: the one-time intro 50% offer, an applied promo
code, banked store credit, and the regular $10 discount. **At most one
perk applies per order**, precedence in that order (intro > promo >
credit > regular). A perk that loses the slot is *parked*, never lost:
the promo survives on the cart, credit stays banked, regular resumes
next order — and the cart says so in plain words instead of silently
dropping a line.

Store-run sales (storewide special, bundle, happy hour) are NOT perks:
they stack on top of whichever single perk applied. The intro offer is
the exception — while it's on, everything else is suppressed.

At order finalize the totals are recomputed inside the transaction and
the order is **aborted (fail-closed, "re-open the cart")** if the
perk picture changed since the customer tapped Send — a died promo,
shifted credit, or the intro offer appearing/disappearing can never
silently change what they're charged or burn a perk on a total they
never saw. Store-run sales are deliberately re-read live and may
legitimately shift the total without aborting.

## One-time $5 welcome credit
Granted at the customer's first welcome (after verification approval).
Eligibility is a durable claim ticket (`welcome_credit_pending`) set
only when the subscriber row is first created and consumed atomically
by the grant — it does NOT depend on credit balance or order history,
both of which reset over time (24h purge). Resetting the chat,
deleting messages, or spending the credit can never re-arm it.

## Order finalize (single transaction)
1. Insert `orders` row.
2. Insert all `order_items` snapshots.
3. Clear `cart_items` + `cart_promos`.
4. Bump `promo_codes.usedCount`.

The cart is cleared even if the fanout to mods fails (the order still
exists in the DB).

## Emoji picker
Render-time priority:
1. `product.emoji` (admin-set or AI-extracted from paste).
2. AI re-pick (name-biased) → persisted.
3. Deterministic fallback (same name → same emoji, never 🌿/🍃).

Admin can override per product via the **🪄 Emoji** button in the
product editor. `/regen_emojis` AI-rebuilds emojis for every product
in one shot.
