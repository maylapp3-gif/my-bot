# Delivery fees (radius-based, internal)

## Customer-visible behaviour
At the area step of checkout, the bot records the typed suburb/landmark and
moves on. No fee band is quoted during checkout — delivery fee is always
confirmed at the meet. Pickup orders are always $0.

The radius rules and the origin are NEVER surfaced to customers. Exposing
distance-band outcomes at checkout would let a customer build a geographic
oracle and triangulate the private service origin.

## Internal mechanism
- `deliveryFee.ts` geocodes a location and computes straight-line distance
  from a fixed internal origin. It is available for internal/mod use.
- The origin is **not in the codebase**: it comes only from the
  `DELIVERY_ORIGIN` env secret (`"lat,lng"`). Unset/invalid → every lookup
  returns "unknown" and the fee reads TBC-at-meet; orders still flow.
- Default tiers: ≤12km → free · 12–20km → $10 · 20–35km → $20 · >35km → out
  of range. (Radii only — no location data lives in the repo.)
- Regular customers (see `regulars.md`) get the free tier extended to 15km;
  the same paid tiers apply beyond.
- Pickup orders skip the lookup entirely (fee = $0).

## ⏰ FAR + LATE advisory (team-side only)
- A delivery order placed at/after `FAR_FLAG_AFTER_HOUR` (business-timezone
  hour) whose area geocodes to ≥ `FAR_FLAG_KM` from the origin gets a
  `⏰ FAR + LATE` line on the **team's** order card at fanout.
- Both knobs are env secrets — the hour and distance are never committed to
  the repo. Missing/invalid → advisory silently off.
- Advisory only, fail-quiet: geocode failure, missing origin, or any error
  just means no flag. Fanout is never blocked.
- **Invariant:** the flag must never influence anything the customer sees.
  Blocking or re-wording checkout for far areas after a cutoff would give
  customers a probe (type suburbs, watch what changes) that maps the far/near
  boundary — the same oracle the fee-hiding prevents.

## Storage
- Fee is set on the order after the mod confirms it at the meet.
- Stored in `orders.delivery_fee_cents` (NULL = TBC, 0 = free/pickup).
- Geocoding results cached in-memory for the process lifetime.
