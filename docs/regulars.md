# Regular customer pricing

A pricing tier the operator manually applies to repeat customers.

## Onboarding
Operator flags a customer by chatId. State lives in `regular_customers`
(chatId PK + notes + addedBy + addedAt). Removed by chatId. Listed via
the operator menu.

There is no self-serve signup. Non-regulars see a `💎 Not the price you
usually pay? DM directly for regular pricing access.` footer in their
cart — that's the customer-facing upsell route.

## Perks (auto-applied at every cart open + at order finalize)
- **$10 off** the cart subtotal — but customer perks never combine
  (one per order: intro 50% > promo code > store credit > regular
  $10). If the customer applies a promo, has banked credit, or is on
  their intro offer, the $10 is *parked* for that order and resumes
  automatically on the next one. Capped so the total can never go
  negative. Stored on the order as `regular_discount_cents`.
- **Free delivery up to 15km** (vs 12km default) — NOT part of the
  one-perk rule; applies on every order regardless. Beyond 15km the
  same paid tiers apply (15–20km → $10, 20–35km → $20, >35km →
  rejected).

Store-run sales (storewide special, bundle, happy hour) are not
customer perks — they still stack on top of whichever single perk
applied.

## Display
Cart view shows the discount as a `*Regular* −$10.00` line + an
`✨ Regular pricing applied — free delivery up to 15km + $10 off`
footer. When the $10 is parked, the footer instead says so explicitly
(free delivery still applies) so it never looks silently dropped.

## Race safety
Regular status is re-checked inside the order tx (single source of
truth — can't be gamed by add/remove during checkout). Delivery fee
is confirmed at the meet; regular status at order-creation time is
recorded on the order for the mod's reference.
