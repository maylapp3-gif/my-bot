import { db } from "@workspace/db";
import {
  ordersTable,
  orderItemsTable,
  productsTable,
  productVariantsTable,
  cartItemsTable,
  cartPromosTable,
  promoCodesTable,
  subscribersTable,
  botMessagesTable,
  relaysTable,
  modStatusTable,
  regularCustomersTable,
  trustedBroadcastTable,
  blockedCustomersTable,
  bannedHandlesTable,
  bundlesTable,
  bundleItemsTable,
  cartBundlesTable,
  dropsTable,
  rafflesTable,
  raffleEntriesTable,
  pickupWindowsTable,
  type PickupWindow,
  type Drop,
  type Raffle,
  type RegularCustomer,
  type TrustedBroadcastMember,
  type InsertOrder,
  type InsertProduct,
  type InsertProductVariant,
  type InsertCartItem,
  type InsertOrderItem,
  type InsertPromoCode,
  type InsertSubscriber,
  type InsertRelay,
  type Product,
  type ProductVariant,
  type CartItem,
  type OrderItem,
  type PromoCode,
  type CartPromo,
  type ModStatus,
  type Subscriber,
  type Bundle,
  type InsertBundle,
  type BundleItem,
  type InsertBundleItem,
  type CartBundle,
} from "@workspace/db/schema";
import { eq, ne, lt, gt, gte, asc, desc, sql, and, or, isNull, isNotNull, inArray, notExists, aliasedTable } from "drizzle-orm";
import { getStorewideDiscount } from "./storewide.js";
import { hashHandle } from "./verifyCore.js";
import { logger } from "../lib/logger.js";

// Order IDs are random 4-digit numbers (1000-9999) — assigned by the app,
// not by a DB sequence. Customers see this as their order number, so it
// must be short and unguessable rather than monotonically increasing.
// 9000 slots is plenty given the 24h retention purge, but we still
// retry on the (rare) collision via the unique PK constraint.
const ORDER_ID_MIN = 1000;
const ORDER_ID_MAX = 9999;
const ORDER_ID_MAX_RETRIES = 25;
function generateRandomOrderId(): number {
  return Math.floor(Math.random() * (ORDER_ID_MAX - ORDER_ID_MIN + 1)) + ORDER_ID_MIN;
}
// Postgres unique-violation SQLSTATE — surfaced by node-postgres on the
// thrown error as `.code`. Used to detect PK collisions on orders.id.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// Thrown by createOrderFromCart when something changed between cart-render
// and order-finalize (variant deleted, promo expired/used out, etc). Caller
// surfaces a friendly message and asks the customer to re-check the cart.
export class OrderValidationError extends Error {
  constructor(
    public code:
      | "EMPTY_CART"
      | "CART_CHANGED"
      | "PROMO_INVALID"
      | "PROMO_USED_OUT"
      | "PROMO_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "OrderValidationError";
  }
}

// Re-export model types for handlers that consume them.
export type {
  Product,
  ProductVariant,
  CartItem,
  OrderItem,
  PromoCode,
  CartPromo,
  ModStatus,
  InsertProductVariant,
  InsertCartItem,
  InsertPromoCode,
};

// Subscribers
// Returns { created: true } only on a fresh insert (xmax = 0 in Postgres
// means the row hasn't been updated by ON CONFLICT). Callers use this to
// fire one-time first-touch effects like the welcome credit DM without
// re-firing on every /start.
export async function addSubscriber(
  data: InsertSubscriber,
): Promise<{ created: boolean }> {
  const rows = await db
    .insert(subscribersTable)
    // A genuinely new row is gated (verified=false). On conflict we do NOT
    // touch `verified`, so a returning customer keeps their state — NULL stays
    // NULL (grandfathered), an in-progress gate stays false, a verified one
    // stays true.
    // welcomeCreditPending=true is the one-time claim ticket for the $5
    // welcome credit — set ONLY here on the fresh insert (never in the
    // conflict branch), consumed atomically by grantWelcomeCreditIfFirstTime.
    .values({ ...data, verified: data.verified ?? false, welcomeCreditPending: true })
    .onConflictDoUpdate({
      target: subscribersTable.chatId,
      set: {
        active: true,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
      },
    })
    .returning({
      chatId: subscribersTable.chatId,
      created: sql<boolean>`(xmax = 0)`,
    });
  return { created: !!rows[0]?.created };
}

// Verification gate (new customers only). Returns true (gated) when:
//   - the subscriber row is missing entirely (unknown / purged / a failed
//     /start upsert) — fail closed so a row-less private chat can't slip
//     past into business content, OR
//   - the row exists and is explicitly unverified (verified === false).
// NULL (grandfathered existing base) and true (already verified) are NOT
// gated. Callers MUST scope this to private customer DMs; relay groups have
// no subscriber row and would otherwise be gated by the missing-row rule.
export async function needsVerification(chatId: string): Promise<boolean> {
  const [row] = await db
    .select({ verified: subscribersTable.verified })
    .from(subscribersTable)
    .where(eq(subscribersTable.chatId, chatId))
    .limit(1);
  if (!row) return true;
  return row.verified === false;
}

// Flip a gated customer to verified. Idempotent.
export async function markVerified(chatId: string): Promise<void> {
  await db
    .update(subscribersTable)
    .set({ verified: true })
    .where(eq(subscribersTable.chatId, chatId));
}

// ===========================================================================
// New-customer verification (automated LeafedOut proof-of-ownership).
// `verified` stays the final allow-flag (NULL grandfathered / false gated /
// true approved). verifyStatus tracks the multi-step flow for gated rows:
//   NULL → 'awaiting_username' → 'collecting' → 'approved' (auto, verified=true)
//        'collecting' → 'pending' (auto-check exhausted) → 'approved' | 'rejected'
// The bot self-approves by fetching the customer's public LeafedOut profile and
// confirming the code; the 'pending' admin queue is the manual fallback.
// Every forward/terminal transition is a conditional UPDATE keyed on the
// expected current status (and, for auto-approve, the exact username+code), so
// a double-tap, an approve-after-reject race, or a username change mid-check
// can't double-fire. Forensic note: the proof code is one-time and cleared on
// resolution (and swept from abandoned 'collecting' rows by the retention job);
// the LeafedOut handle persists because that Telegram↔LeafedOut link is the
// accountability feature.
// ===========================================================================

export type VerifyState = {
  verified: boolean | null;
  verifyStatus: string | null;
  leafedoutUsername: string | null;
  verifyCode: string | null;
  verifyRejections: number;
  verifyCheckAttempts: number;
  firstName: string | null;
  username: string | null;
};

export async function getVerifyState(
  chatId: string,
): Promise<VerifyState | undefined> {
  const [row] = await db
    .select({
      verified: subscribersTable.verified,
      verifyStatus: subscribersTable.verifyStatus,
      leafedoutUsername: subscribersTable.leafedoutUsername,
      verifyCode: subscribersTable.verifyCode,
      verifyRejections: subscribersTable.verifyRejections,
      verifyCheckAttempts: subscribersTable.verifyCheckAttempts,
      firstName: subscribersTable.firstName,
      username: subscribersTable.username,
    })
    .from(subscribersTable)
    .where(eq(subscribersTable.chatId, chatId))
    .limit(1);
  return row;
}

// Start (or restart) the flow: move a gated row to 'awaiting_username' and
// clear any half-entered username/code. Guarded on verified=false so it can
// never reset a verified (true) or grandfathered (NULL) account.
export async function beginVerification(chatId: string): Promise<void> {
  await db
    .update(subscribersTable)
    .set({ verifyStatus: "awaiting_username", leafedoutUsername: null, verifyCode: null })
    .where(and(eq(subscribersTable.chatId, chatId), eq(subscribersTable.verified, false)));
}

// Admin tool: force ANY subscriber back to the start of the verification gate,
// whatever their current state — grandfathered (NULL), already approved (true),
// or a half-finished gated row. Sets verified=false and clears every verify-flow
// field so the next gate check re-offers Start and issues a fresh code. Unlike
// beginVerification (guarded on verified=false), this is unconditional: it is
// the ONLY path that can un-grandfather or un-approve an account, so it must be
// admin-gated at the command layer. Returns true if a row was updated (false
// when the chatId is unknown).
export async function resetVerification(chatId: string): Promise<boolean> {
  const rows = await db
    .update(subscribersTable)
    .set({
      verified: false,
      verifyStatus: null,
      leafedoutUsername: null,
      verifyCode: null,
      verifyCodeIssuedAt: null,
      verifySubmittedAt: null,
      verifyRejections: 0,
      verifyCheckAttempts: 0,
    })
    .where(eq(subscribersTable.chatId, chatId))
    .returning({ chatId: subscribersTable.chatId });
  return rows.length > 0;
}

// Store the claimed username + issued code: awaiting_username → collecting.
// Conditional on the expected status so a stale/duplicate text can't overwrite
// a later state. Returns the row on success, undefined otherwise.
export async function setVerificationUsername(
  chatId: string,
  leafedoutUsername: string,
  verifyCode: string,
): Promise<{ chatId: string } | undefined> {
  const [row] = await db
    .update(subscribersTable)
    .set({
      leafedoutUsername,
      verifyCode,
      verifyCodeIssuedAt: new Date(),
      verifyStatus: "collecting",
      // Fresh username = fresh auto-check budget for this collecting cycle.
      verifyCheckAttempts: 0,
    })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.verifyStatus, "awaiting_username"),
        // Refuse a LeafedOut handle bound to a previous block. No row comes back,
        // so the caller just re-shows the gate (the ban is never revealed) and a
        // blocked person can't re-register the same profile on a new account.
        notExists(
          db
            .select({ x: sql`1` })
            .from(bannedHandlesTable)
            .where(eq(bannedHandlesTable.handleHash, hashHandle(leafedoutUsername))),
        ),
        // One LeafedOut profile ↔ one Telegram account. Refuse a handle that is
        // already VERIFIED on a different chatId. Same silent treatment as the
        // ban check above: no row → gate re-shows, nothing is revealed (telling
        // a stranger "that profile is taken" would leak who our customers are).
        // In-flight (collecting/pending) duplicates are deliberately NOT blocked
        // here — that would let a troll squat a handle they don't own; instead
        // the race resolves at the approval choke points below (first real
        // owner wins, the loser's approval is refused).
        notExists(
          db
            .select({ x: sql`1` })
            .from(otherSubscribers)
            .where(
              and(
                ne(otherSubscribers.chatId, chatId),
                eq(otherSubscribers.verified, true),
                sql`lower(${otherSubscribers.leafedoutUsername}) = lower(${leafedoutUsername})`,
              ),
            ),
        ),
      ),
    )
    .returning({ chatId: subscribersTable.chatId });
  return row;
}

// Self-join alias for "some other subscriber row" — used by the one-handle-
// one-account guards above/below.
const otherSubscribers = aliasedTable(subscribersTable, "other_subscribers");

// Admin-facing lookup: is this LeafedOut handle already verified (or waiting
// in the queue) on ANOTHER chat? Returns that chatId, or undefined. Used to
// warn admins on the manual-review card and to explain a refused approval.
// NEVER surface the result to customers — it would leak the customer list.
export async function findVerifiedHandleConflict(
  leafedoutUsername: string,
  excludeChatId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ chatId: subscribersTable.chatId })
    .from(subscribersTable)
    .where(
      and(
        ne(subscribersTable.chatId, excludeChatId),
        sql`lower(${subscribersTable.leafedoutUsername}) = lower(${leafedoutUsername})`,
        or(
          eq(subscribersTable.verified, true),
          inArray(subscribersTable.verifyStatus, ["collecting", "pending"]),
        ),
      ),
    )
    .limit(1);
  return rows[0]?.chatId;
}

// Atomically claim one auto-check attempt BEFORE the outbound LeafedOut fetch,
// so concurrent/looping "Check now" taps can't spawn unbounded fetches. The
// conditional UPDATE only fires while still 'collecting' AND under the cap;
// returns the claimed username+code+new count, or undefined if not collecting
// or the cap is already spent (caller distinguishes via getVerifyState).
export async function claimVerifyAttempt(
  chatId: string,
  cap: number,
): Promise<
  | { leafedoutUsername: string | null; verifyCode: string | null; verifyCheckAttempts: number }
  | undefined
> {
  const [row] = await db
    .update(subscribersTable)
    .set({ verifyCheckAttempts: sql`${subscribersTable.verifyCheckAttempts} + 1` })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.verifyStatus, "collecting"),
        lt(subscribersTable.verifyCheckAttempts, cap),
      ),
    )
    .returning({
      leafedoutUsername: subscribersTable.leafedoutUsername,
      verifyCode: subscribersTable.verifyCode,
      verifyCheckAttempts: subscribersTable.verifyCheckAttempts,
    });
  return row;
}

// Refund a claimed attempt when the fetch couldn't reach LeafedOut at all, so
// an outage never burns a legit customer's budget. Guarded so it can't go
// negative or touch a row that has since left 'collecting'.
export async function refundVerifyAttempt(chatId: string): Promise<void> {
  await db
    .update(subscribersTable)
    .set({ verifyCheckAttempts: sql`${subscribersTable.verifyCheckAttempts} - 1` })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.verifyStatus, "collecting"),
        gt(subscribersTable.verifyCheckAttempts, 0),
      ),
    );
}

// Automated approve: collecting → approved (verified=true). TOCTOU-guarded on
// the exact username+code that was checked, so a "Change username" during the
// ~8s fetch can't let a stale check approve a different claim. Clears the
// one-time code and stamps reviewer='auto' for attributability. Returns the
// row, or undefined if the claim changed / was already resolved.
export async function autoApproveVerification(
  chatId: string,
  leafedoutUsername: string,
  verifyCode: string,
): Promise<{ chatId: string; introOfferGranted: boolean } | undefined> {
  const [row] = await db
    .update(subscribersTable)
    .set({
      verified: true,
      verifyStatus: "approved",
      verifyCode: null,
      verifyCodeIssuedAt: null,
      verifyReviewedBy: "auto",
      verifyReviewedAt: new Date(),
      // Grant the one-time intro offer at the approval choke point — but only
      // if this account never spent one (re-grant guard for reset→re-approve).
      introOfferAvailable: sql`(${subscribersTable.introOfferUsedAt} IS NULL)`,
    })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.verifyStatus, "collecting"),
        eq(subscribersTable.leafedoutUsername, leafedoutUsername),
        eq(subscribersTable.verifyCode, verifyCode),
        // Backstop: if this handle was banned mid-flight (after it was set but
        // before the auto-check resolved), auto-approval can't complete.
        notExists(
          db
            .select({ x: sql`1` })
            .from(bannedHandlesTable)
            .where(eq(bannedHandlesTable.handleHash, hashHandle(leafedoutUsername))),
        ),
        // One-handle-one-account backstop: if this handle got verified on some
        // OTHER account mid-flight, this approval must not go through. The
        // customer falls back to the manual queue, where the admin card
        // carries an explicit conflict warning.
        notExists(
          db
            .select({ x: sql`1` })
            .from(otherSubscribers)
            .where(
              and(
                ne(otherSubscribers.chatId, chatId),
                eq(otherSubscribers.verified, true),
                sql`lower(${otherSubscribers.leafedoutUsername}) = lower(${leafedoutUsername})`,
              ),
            ),
        ),
      ),
    )
    .returning({
      chatId: subscribersTable.chatId,
      introOfferGranted: subscribersTable.introOfferAvailable,
    });
  return row;
}

// Customer confirmed they placed the code: collecting → pending. Returns the
// fields the mod fanout needs, or undefined if the row wasn't collecting.
export async function submitVerification(
  chatId: string,
): Promise<{ leafedoutUsername: string | null; verifyCode: string | null } | undefined> {
  const [row] = await db
    .update(subscribersTable)
    .set({ verifyStatus: "pending", verifySubmittedAt: new Date() })
    .where(and(eq(subscribersTable.chatId, chatId), eq(subscribersTable.verifyStatus, "collecting")))
    .returning({
      leafedoutUsername: subscribersTable.leafedoutUsername,
      verifyCode: subscribersTable.verifyCode,
    });
  return row;
}

// A capped/rejected customer asking again must never be sent to a moderator and
// must not be left stranded. Hand them to the admin-only manual queue instead:
// force the row to 'pending' so it surfaces in /verify_queue and the admin
// fanout. Conditional on a non-pending, still-gated row, so repeat taps are
// idempotent (the upstream 'pending' short-circuit then takes over and no
// second admin notification fires). verifyCode is kept if present so an admin
// can still eyeball the public profile themselves.
export async function forceManualReview(
  chatId: string,
): Promise<{ leafedoutUsername: string | null; verifyCode: string | null } | undefined> {
  const [row] = await db
    .update(subscribersTable)
    .set({ verifyStatus: "pending", verifySubmittedAt: new Date() })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        // Not already queued. `ne` is NULL-blind, so spell out the NULL-status
        // edge explicitly — a capped row must always end up actually queued,
        // never just shown the "under review" text without a row to back it.
        or(isNull(subscribersTable.verifyStatus), ne(subscribersTable.verifyStatus, "pending")),
        ne(subscribersTable.verified, true),
      ),
    )
    .returning({
      leafedoutUsername: subscribersTable.leafedoutUsername,
      verifyCode: subscribersTable.verifyCode,
    });
  return row;
}

// Admin approve (manual fallback): pending → approved (verified=true).
// Conditional on 'pending' so a double-tap or approve-after-reject can't
// re-fire the welcome. Clears the one-time code; stamps the reviewer for audit.
// Returns the row, or undefined if it was already handled.
export async function approveVerification(
  chatId: string,
  reviewerChatId: string,
): Promise<{ chatId: string; introOfferGranted: boolean } | undefined> {
  const [row] = await db
    .update(subscribersTable)
    .set({
      verified: true,
      verifyStatus: "approved",
      verifyCode: null,
      verifyCodeIssuedAt: null,
      verifyReviewedBy: reviewerChatId,
      verifyReviewedAt: new Date(),
      // Grant the one-time intro offer at the approval choke point — but only
      // if this account never spent one (re-grant guard for reset→re-approve).
      introOfferAvailable: sql`(${subscribersTable.introOfferUsedAt} IS NULL)`,
    })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.verifyStatus, "pending"),
        // One-handle-one-account backstop, mirroring autoApproveVerification:
        // an admin approve must not create a second verified account on a
        // handle that got verified elsewhere while this row sat in the queue.
        // The handler distinguishes this refusal from "already handled" via
        // findVerifiedHandleConflict and tells the admin why.
        notExists(
          db
            .select({ x: sql`1` })
            .from(otherSubscribers)
            .where(
              and(
                ne(otherSubscribers.chatId, chatId),
                eq(otherSubscribers.verified, true),
                sql`lower(${otherSubscribers.leafedoutUsername}) = lower(${subscribersTable.leafedoutUsername})`,
              ),
            ),
        ),
      ),
    )
    .returning({
      chatId: subscribersTable.chatId,
      introOfferGranted: subscribersTable.introOfferAvailable,
    });
  return row;
}

// Admin reject (manual fallback): pending → rejected. `verified` stays false
// (still gated). Clears the one-time code, stamps the reviewer, bumps the
// rejection counter (the retry cap reads this). Returns the row, or undefined
// if already handled.
export async function rejectVerification(
  chatId: string,
  reviewerChatId: string,
): Promise<{ chatId: string } | undefined> {
  const [row] = await db
    .update(subscribersTable)
    .set({
      verifyStatus: "rejected",
      verifyCode: null,
      verifyCodeIssuedAt: null,
      verifyReviewedBy: reviewerChatId,
      verifyReviewedAt: new Date(),
      verifyRejections: sql`${subscribersTable.verifyRejections} + 1`,
    })
    .where(and(eq(subscribersTable.chatId, chatId), eq(subscribersTable.verifyStatus, "pending")))
    .returning({ chatId: subscribersTable.chatId });
  return row;
}

// Moderator bypass: manually wave a still-gated account through WITHOUT
// LeafedOut proof — the escape hatch for genuine exceptions (someone the team
// personally knows, LeafedOut being down for days, etc). Deliberately narrower
// than an admin approve:
//   - only fires while the row is actually gated (verified=false), whatever
//     step of the flow it's on — it can never touch a verified or
//     grandfathered (NULL) account;
//   - NEVER grants the intro offer — money-value grants stay on the admin /
//     auto-approve choke points (fail-closed on discounts);
//   - refuses if the row's LeafedOut handle is already verified on another
//     account (same one-handle-one-account backstop as every approve path);
//   - stamps the reviewer as "bypass:<modChatId>" so the audit trail shows
//     both WHO let them in and THAT no proof was on file. Banned-handle
//     screening happens at the command layer (the handle string isn't in
//     scope here) — the handler refuses banned handles outright.
export async function bypassVerification(
  chatId: string,
  modChatId: string,
): Promise<{ chatId: string } | undefined> {
  const [row] = await db
    .update(subscribersTable)
    .set({
      verified: true,
      verifyStatus: "approved",
      verifyCode: null,
      verifyCodeIssuedAt: null,
      verifyReviewedBy: `bypass:${modChatId}`,
      verifyReviewedAt: new Date(),
    })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.verified, false),
        or(
          isNull(subscribersTable.leafedoutUsername),
          notExists(
            db
              .select({ x: sql`1` })
              .from(otherSubscribers)
              .where(
                and(
                  ne(otherSubscribers.chatId, chatId),
                  eq(otherSubscribers.verified, true),
                  sql`lower(${otherSubscribers.leafedoutUsername}) = lower(${subscribersTable.leafedoutUsername})`,
                ),
              ),
          ),
        ),
      ),
    )
    .returning({ chatId: subscribersTable.chatId });
  return row;
}

// Admin recovery view: everyone currently waiting in the manual-review queue,
// oldest first — so a missed fanout DM never strands a customer.
export async function listPendingVerifications(): Promise<
  {
    chatId: string;
    leafedoutUsername: string | null;
    verifyCode: string | null;
    firstName: string | null;
    username: string | null;
    verifySubmittedAt: Date | null;
  }[]
> {
  return db
    .select({
      chatId: subscribersTable.chatId,
      leafedoutUsername: subscribersTable.leafedoutUsername,
      verifyCode: subscribersTable.verifyCode,
      firstName: subscribersTable.firstName,
      username: subscribersTable.username,
      verifySubmittedAt: subscribersTable.verifySubmittedAt,
    })
    .from(subscribersTable)
    .where(eq(subscribersTable.verifyStatus, "pending"))
    .orderBy(asc(subscribersTable.verifySubmittedAt));
}

// Retention hygiene: wipe the one-time proof code from abandoned 'collecting'
// rows (customer started verifying, got a code, never finished) once the code
// is older than `cutoff`. Keyed on verifyCodeIssuedAt so a slow-but-legit
// session (or a day-later retry) isn't nuked mid-flow. Status is reset so the
// gate cleanly re-offers Start; the leafedoutUsername link is intentionally
// preserved. Pending (admin-queue) codes are left alone. Returns rows cleared.
export async function clearStaleVerifyCodes(cutoff: Date): Promise<number> {
  const rows = await db
    .update(subscribersTable)
    .set({
      verifyCode: null,
      verifyCodeIssuedAt: null,
      verifyStatus: null,
      verifyCheckAttempts: 0,
    })
    .where(
      and(
        eq(subscribersTable.verifyStatus, "collecting"),
        lt(subscribersTable.verifyCodeIssuedAt, cutoff),
      ),
    )
    .returning({ chatId: subscribersTable.chatId });
  return rows.length;
}

// One-time welcome credit. The eligibility signal is the durable
// welcomeCreditPending claim ticket set at the row's very first INSERT —
// NOT credit balance / loyalty / order history, all of which legitimately
// reset over time (24h order purge, spent credit) and used to let a
// customer farm a fresh $5 with every chat reset. Claim-first and atomic:
// one conditional UPDATE flips the ticket AND adds the credit, so two
// racing welcomes can't double-grant and the ticket can never burn without
// the credit landing. Safe to call from every /start. Returns cents
// granted (0 if none).
const WELCOME_CREDIT_CENTS = 500;
export async function grantWelcomeCreditIfFirstTime(
  chatId: string,
): Promise<number> {
  const updated = await db
    .update(subscribersTable)
    .set({
      welcomeCreditPending: false,
      creditCents: sql`${subscribersTable.creditCents} + ${WELCOME_CREDIT_CENTS}`,
    })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.welcomeCreditPending, true),
      ),
    )
    .returning({ chatId: subscribersTable.chatId });
  return updated.length > 0 ? WELCOME_CREDIT_CENTS : 0;
}

export async function removeSubscriber(chatId: string) {
  await db.update(subscribersTable).set({ active: false }).where(eq(subscribersTable.chatId, chatId));
}

// Look up subscribers by either a numeric chatId or an @username
// (case-insensitive, leading @ optional). Returns ALL matches so the caller
// can refuse to act on an ambiguous target rather than silently guessing.
//   - A purely numeric token resolves as a chatId ONLY (never as a username),
//     so a numeric username can't be hit by accident. chatId is unique, so
//     this returns at most one row.
//   - Anything else is a username lookup. username is NOT unique, so this can
//     return several rows; the caller must handle the collision.
export async function findSubscribers(identifier: string): Promise<Subscriber[]> {
  const raw = identifier.trim().replace(/^@/, "");
  if (!raw) return [];
  if (/^\d+$/.test(raw)) {
    return db.select().from(subscribersTable).where(eq(subscribersTable.chatId, raw)).limit(1);
  }
  return db
    .select()
    .from(subscribersTable)
    .where(sql`lower(${subscribersTable.username}) = lower(${raw})`);
}

// Hard-delete a subscriber and ALL their CUSTOMER-scoped live state in one
// transaction. This is a true wipe of customer data — every row keyed to
// their chatId across carts, orders, loyalty, and tracked messages is
// removed. Deliberately NOT touched:
//   - relays      → operator order-relay channels, not customers.
//   - mod_status  → operator moderation/away state. An operator who also
//                   /start-ed the bot would otherwise lose their mod state
//                   to a customer-cleanup command.
// Returns whether a subscriber row existed and how many orders were removed,
// for an honest report back to the admin.
export async function purgeSubscriber(
  chatId: string,
): Promise<{ existed: boolean; ordersDeleted: number }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ chatId: subscribersTable.chatId })
      .from(subscribersTable)
      .where(eq(subscribersTable.chatId, chatId))
      .limit(1);

    const orderRows = await tx
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.chatId, chatId));
    const orderIds = orderRows.map((o) => o.id);
    if (orderIds.length > 0) {
      await tx.delete(orderItemsTable).where(inArray(orderItemsTable.orderId, orderIds));
      await tx.delete(ordersTable).where(eq(ordersTable.chatId, chatId));
    }

    await tx.delete(cartItemsTable).where(eq(cartItemsTable.chatId, chatId));
    await tx.delete(cartPromosTable).where(eq(cartPromosTable.chatId, chatId));
    await tx.delete(cartBundlesTable).where(eq(cartBundlesTable.chatId, chatId));
    await tx.delete(botMessagesTable).where(eq(botMessagesTable.chatId, chatId));
    await tx.delete(regularCustomersTable).where(eq(regularCustomersTable.chatId, chatId));
    await tx.delete(trustedBroadcastTable).where(eq(trustedBroadcastTable.chatId, chatId));
    await tx.delete(subscribersTable).where(eq(subscribersTable.chatId, chatId));

    return { existed: existing.length > 0, ordersDeleted: orderIds.length };
  });
}

export async function getActiveSubscribers() {
  return db.select().from(subscribersTable).where(eq(subscribersTable.active, true));
}

// ---- Blocklist (suspicious-account flag) ----------------------------------
// A blocked chatId can never re-register or reach a business action. The
// blocklist row outlives purgeSubscriber so /start can't re-create the
// account. We keep only chatId + an enum reason code + who/when.

export async function isBlocked(chatId: string): Promise<boolean> {
  const rows = await db
    .select({ chatId: blockedCustomersTable.chatId })
    .from(blockedCustomersTable)
    .where(eq(blockedCustomersTable.chatId, chatId))
    .limit(1);
  return rows.length > 0;
}

// Block a chatId AND wipe all of its data. Order matters: write the blocklist
// row FIRST so that even if the purge throws we remain fail-closed (the chat
// stays blocked). Idempotent — re-blocking just refreshes the metadata.
export async function blockAndWipe(
  chatId: string,
  reason: string,
  blockedBy: string,
): Promise<{ existed: boolean; ordersDeleted: number }> {
  await db
    .insert(blockedCustomersTable)
    .values({ chatId, reason, blockedBy })
    .onConflictDoUpdate({
      target: blockedCustomersTable.chatId,
      set: { reason, blockedBy, blockedAt: new Date() },
    });

  // Also bind the ban to the LeafedOut profile — but ONLY when the customer
  // actually PROVED ownership of it (verified === true). Recording a merely
  // claimed (unproven) handle would let anyone get an innocent third party's
  // profile banned, so we never do that. Read it BEFORE purgeSubscriber wipes
  // the row. Best-effort: a failure here must not stop the chat-id block + wipe
  // (the chat-id block already landed above, so we stay fail-closed on the id).
  try {
    const [sub] = await db
      .select({
        verified: subscribersTable.verified,
        leafedoutUsername: subscribersTable.leafedoutUsername,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.chatId, chatId))
      .limit(1);
    if (sub?.verified === true && sub.leafedoutUsername) {
      await db
        .insert(bannedHandlesTable)
        .values({ handleHash: hashHandle(sub.leafedoutUsername), reason, bannedBy: blockedBy })
        .onConflictDoUpdate({
          target: bannedHandlesTable.handleHash,
          set: { reason, bannedBy: blockedBy, bannedAt: new Date() },
        });
    }
  } catch (err) {
    logger.error({ err, chatId }, "blockAndWipe — recording banned handle failed");
  }

  return purgeSubscriber(chatId);
}

// ---- Banned LeafedOut handles --------------------------------------------
// A LeafedOut profile barred from verifying ANY Telegram account. The live
// enforcement is wired directly into the verification UPDATEs above
// (setVerificationUsername + autoApproveVerification) so BOTH the bot and the
// userbot surfaces are covered by one race-safe rule. blockAndWipe records a
// handle here automatically whenever a VERIFIED customer is blocked. Only the
// one-way hash is stored — the plaintext handle is never persisted here.

// Proactively ban a LeafedOut profile by handle (admin types a known-bad one).
// Idempotent — re-banning just refreshes the metadata.
export async function banHandle(handle: string, bannedBy: string, reason = "manual"): Promise<void> {
  await db
    .insert(bannedHandlesTable)
    .values({ handleHash: hashHandle(handle), reason, bannedBy })
    .onConflictDoUpdate({
      target: bannedHandlesTable.handleHash,
      set: { reason, bannedBy, bannedAt: new Date() },
    });
}

// Lift a handle ban (recovery from a mistaken ban). Returns whether a ban
// actually existed for this handle.
export async function unbanHandle(handle: string): Promise<boolean> {
  const rows = await db
    .delete(bannedHandlesTable)
    .where(eq(bannedHandlesTable.handleHash, hashHandle(handle)))
    .returning({ handleHash: bannedHandlesTable.handleHash });
  return rows.length > 0;
}

// True if this LeafedOut handle is currently banned. (Admin tooling; the live
// gate enforces the ban inline in the UPDATEs above, not via this read.)
export async function isHandleBanned(handle: string): Promise<boolean> {
  const rows = await db
    .select({ handleHash: bannedHandlesTable.handleHash })
    .from(bannedHandlesTable)
    .where(eq(bannedHandlesTable.handleHash, hashHandle(handle)))
    .limit(1);
  return rows.length > 0;
}

// Tri-state approval used by the suspicious-account assessment:
//   "approved" → the gate would let them order (verified === true, or NULL
//                grandfathered).
//   "gated"    → verified === false (started but hasn't passed verification).
//   "missing"  → no subscriber row at all (never engaged the bot).
export async function getApprovalState(
  chatId: string,
): Promise<"approved" | "gated" | "missing"> {
  const rows = await db
    .select({ verified: subscribersTable.verified })
    .from(subscribersTable)
    .where(eq(subscribersTable.chatId, chatId))
    .limit(1);
  if (rows.length === 0) return "missing";
  return rows[0].verified === false ? "gated" : "approved";
}

// Products
export async function getAvailableProducts(): Promise<Product[]> {
  return db
    .select()
    .from(productsTable)
    .where(eq(productsTable.available, true))
    .orderBy(asc(productsTable.position), asc(productsTable.id));
}

export async function getAllProductsOrdered(): Promise<Product[]> {
  return db
    .select()
    .from(productsTable)
    .orderBy(asc(productsTable.position), asc(productsTable.id));
}

export async function getProduct(id: number): Promise<Product | undefined> {
  const rows = await db.select().from(productsTable).where(eq(productsTable.id, id));
  return rows[0];
}

export async function addProduct(data: InsertProduct) {
  // Place new products at the end of the order.
  const maxRow = await db
    .select({ max: sql<number>`COALESCE(MAX(${productsTable.position}), -1)` })
    .from(productsTable);
  const nextPosition = (maxRow[0]?.max ?? -1) + 1;
  return db
    .insert(productsTable)
    .values({ ...data, position: nextPosition })
    .returning();
}

export async function toggleProduct(id: number, available: boolean) {
  return db.update(productsTable).set({ available }).where(eq(productsTable.id, id));
}

export async function updateProductFields(
  id: number,
  fields: Partial<Pick<Product, "name" | "description" | "price" | "imageUrl" | "videoUrl" | "emoji" | "available" | "preorder">>
) {
  return db.update(productsTable).set(fields).where(eq(productsTable.id, id));
}

export async function deleteProduct(id: number) {
  return db.delete(productsTable).where(eq(productsTable.id, id));
}

// Normalize all product positions to a strictly-increasing sequence (0,1,2,...)
// in their current display order. Cheap to call before any reorder so legacy
// rows that all default to position=0 don't break swap behavior.
async function normalizePositions(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const rows = await tx
    .select({ id: productsTable.id })
    .from(productsTable)
    .orderBy(asc(productsTable.position), asc(productsTable.id));
  for (let i = 0; i < rows.length; i++) {
    await tx.update(productsTable).set({ position: i }).where(eq(productsTable.id, rows[i].id));
  }
}

// Swap the position of two products. Used by the up/down reorder buttons.
// Normalizes positions first so legacy rows (all position=0) reorder cleanly.
export async function swapProductPositions(idA: number, idB: number) {
  await db.transaction(async (tx) => {
    await normalizePositions(tx);
    const rows = await tx
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, idA));
    const a = rows[0];
    const rowsB = await tx
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, idB));
    const b = rowsB[0];
    if (!a || !b) return;
    // Two-step swap via a sentinel value to avoid collisions if a unique
    // constraint is ever added to position.
    await tx.update(productsTable).set({ position: -1 }).where(eq(productsTable.id, a.id));
    await tx.update(productsTable).set({ position: a.position }).where(eq(productsTable.id, b.id));
    await tx.update(productsTable).set({ position: b.position }).where(eq(productsTable.id, a.id));
  });
}

// ===========================================================================
// Product variants — each product has 0..N price points (e.g. 1g, 3.5g, 7g).
// ===========================================================================
export async function getProductVariants(productId: number): Promise<ProductVariant[]> {
  return db
    .select()
    .from(productVariantsTable)
    .where(eq(productVariantsTable.productId, productId))
    .orderBy(asc(productVariantsTable.position), asc(productVariantsTable.id));
}

export async function getVariantWithProduct(
  variantId: number,
): Promise<{ variant: ProductVariant; product: Product } | undefined> {
  const rows = await db
    .select({ variant: productVariantsTable, product: productsTable })
    .from(productVariantsTable)
    .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
    .where(eq(productVariantsTable.id, variantId));
  return rows[0];
}

export async function getVariant(id: number): Promise<ProductVariant | undefined> {
  const rows = await db.select().from(productVariantsTable).where(eq(productVariantsTable.id, id));
  return rows[0];
}

export async function addProductVariant(data: InsertProductVariant): Promise<ProductVariant> {
  const max = await db
    .select({ m: sql<number>`COALESCE(MAX(${productVariantsTable.position}), -1)` })
    .from(productVariantsTable)
    .where(eq(productVariantsTable.productId, data.productId));
  const position = (max[0]?.m ?? -1) + 1;
  const [row] = await db.insert(productVariantsTable).values({ ...data, position }).returning();
  return row;
}

export async function updateVariantFields(
  id: number,
  fields: Partial<Pick<ProductVariant, "label" | "priceCents" | "position">>,
) {
  return db.update(productVariantsTable).set(fields).where(eq(productVariantsTable.id, id));
}

export async function deleteVariant(id: number) {
  return db.delete(productVariantsTable).where(eq(productVariantsTable.id, id));
}

// ===========================================================================
// Cart — DB-backed so it survives restarts. UPSERT on (chatId, variantId).
// ===========================================================================
export type CartLine = {
  cartItemId: number;
  variantId: number;
  productId: number;
  productName: string;
  productEmoji: string | null;
  // Snapshot of products.preorder at cart/order-build time. Used to badge
  // lines in cart UI and to flag the mod fanout with "confirm drop date".
  productPreorder: boolean;
  variantLabel: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
};

export async function getCart(chatId: string): Promise<CartLine[]> {
  const rows = await db
    .select({
      cartItemId: cartItemsTable.id,
      variantId: productVariantsTable.id,
      productId: productsTable.id,
      productName: productsTable.name,
      productEmoji: productsTable.emoji,
      productPreorder: productsTable.preorder,
      variantLabel: productVariantsTable.label,
      unitPriceCents: productVariantsTable.priceCents,
      quantity: cartItemsTable.quantity,
    })
    .from(cartItemsTable)
    .innerJoin(productVariantsTable, eq(cartItemsTable.variantId, productVariantsTable.id))
    .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
    .where(eq(cartItemsTable.chatId, chatId))
    .orderBy(asc(cartItemsTable.addedAt));
  return rows.map((r) => ({ ...r, lineTotalCents: r.unitPriceCents * r.quantity }));
}

export async function getCartItemCount(chatId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COALESCE(SUM(${cartItemsTable.quantity}), 0)` })
    .from(cartItemsTable)
    .where(eq(cartItemsTable.chatId, chatId));
  return Number(rows[0]?.n ?? 0);
}

// Per-line cap. Plenty of headroom for "I want 14×7g" while still capping
// any future code path that accidentally writes garbage (negative, NaN,
// 1e9). Keeps int4 totals safe even at the max possible price point.
const MAX_CART_QTY = 99;

export async function addToCart(chatId: string, variantId: number, qty = 1) {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_CART_QTY) {
    throw new Error(`addToCart: invalid qty ${qty} (must be integer 1..${MAX_CART_QTY})`);
  }
  await db
    .insert(cartItemsTable)
    .values({ chatId, variantId, quantity: qty })
    .onConflictDoUpdate({
      target: [cartItemsTable.chatId, cartItemsTable.variantId],
      // Cap the resulting quantity defensively in SQL — protects against any
      // future caller bypassing the JS-side guard, and prevents overflow.
      set: {
        quantity: sql`LEAST(${cartItemsTable.quantity} + ${qty}, ${MAX_CART_QTY})`,
      },
    });
}

export async function setCartItemQuantity(cartItemId: number, qty: number) {
  if (!Number.isFinite(qty)) {
    throw new Error(`setCartItemQuantity: invalid qty ${qty}`);
  }
  if (qty <= 0) {
    return db.delete(cartItemsTable).where(eq(cartItemsTable.id, cartItemId));
  }
  const capped = Math.min(Math.floor(qty), MAX_CART_QTY);
  return db.update(cartItemsTable).set({ quantity: capped }).where(eq(cartItemsTable.id, cartItemId));
}

export async function getCartItem(cartItemId: number): Promise<CartItem | undefined> {
  const rows = await db.select().from(cartItemsTable).where(eq(cartItemsTable.id, cartItemId));
  return rows[0];
}

export async function removeCartItem(cartItemId: number) {
  return db.delete(cartItemsTable).where(eq(cartItemsTable.id, cartItemId));
}

export async function clearCart(chatId: string) {
  await db.delete(cartItemsTable).where(eq(cartItemsTable.chatId, chatId));
  await db.delete(cartPromosTable).where(eq(cartPromosTable.chatId, chatId));
  await db.delete(cartBundlesTable).where(eq(cartBundlesTable.chatId, chatId));
}

// ===========================================================================
// Promo codes
// ===========================================================================
export async function getCartPromo(chatId: string): Promise<CartPromo | undefined> {
  const rows = await db.select().from(cartPromosTable).where(eq(cartPromosTable.chatId, chatId));
  return rows[0];
}

export async function setCartPromo(chatId: string, code: string) {
  await db
    .insert(cartPromosTable)
    .values({ chatId, code: code.toUpperCase() })
    .onConflictDoUpdate({ target: cartPromosTable.chatId, set: { code: code.toUpperCase(), appliedAt: new Date() } });
}

export async function clearCartPromo(chatId: string) {
  await db.delete(cartPromosTable).where(eq(cartPromosTable.chatId, chatId));
}

export async function findPromoByCode(code: string): Promise<PromoCode | undefined> {
  const rows = await db.select().from(promoCodesTable).where(eq(promoCodesTable.code, code.toUpperCase()));
  return rows[0];
}

export async function listPromoCodes(): Promise<PromoCode[]> {
  return db.select().from(promoCodesTable).orderBy(asc(promoCodesTable.code));
}

export async function createPromoCode(data: InsertPromoCode): Promise<PromoCode> {
  const [row] = await db
    .insert(promoCodesTable)
    .values({ ...data, code: data.code.toUpperCase() })
    .returning();
  return row;
}

export async function deletePromoCode(code: string) {
  return db.delete(promoCodesTable).where(eq(promoCodesTable.code, code.toUpperCase()));
}

// ===========================================================================
// Raffles (admin-managed, entry-by-code)
// ===========================================================================
// A raffle is a HARD 24h event: joinable/drawable ONLY within 24h of createdAt,
// because entrant rows can never outlive the 24h retention window. Within the
// window "everyone who entered is in the draw" is literally true; after it, the
// raffle reads closed. Expiry is computed from createdAt — no scheduler needed.
// Entrant data is ephemeral: purged on draw, on delete, and by the hourly
// retention sweep. Customer-facing helpers never reveal counts or other entrants.
const RAFFLE_WINDOW_MS = 24 * 60 * 60 * 1000;
function raffleExpiryCutoff(): Date {
  return new Date(Date.now() - RAFFLE_WINDOW_MS);
}

export async function findRaffleByCode(code: string): Promise<Raffle | undefined> {
  const rows = await db.select().from(rafflesTable).where(eq(rafflesTable.code, code.toUpperCase()));
  return rows[0];
}

export async function createRaffle(code: string, prize: string): Promise<Raffle> {
  const [row] = await db
    .insert(rafflesTable)
    .values({ code: code.toUpperCase(), prize, active: true })
    .returning();
  return row;
}

// Admin-facing list: every raffle with its LIVE entry counts (entries <24h,
// split approved vs still-pending) and whether it is still joinable. Newest first.
export type RaffleWithMeta = Raffle & {
  approvedCount: number;
  pendingCount: number;
  live: boolean;
};
export async function listRafflesWithCounts(): Promise<RaffleWithMeta[]> {
  const cutoff = raffleExpiryCutoff();
  const raffles = await db.select().from(rafflesTable).orderBy(desc(rafflesTable.createdAt));
  const counts = await db
    .select({
      code: raffleEntriesTable.raffleCode,
      approved: sql<number>`(count(*) filter (where ${raffleEntriesTable.status} = 'approved'))::int`,
      pending: sql<number>`(count(*) filter (where ${raffleEntriesTable.status} = 'pending'))::int`,
    })
    .from(raffleEntriesTable)
    .where(gte(raffleEntriesTable.createdAt, cutoff))
    .groupBy(raffleEntriesTable.raffleCode);
  const byCode = new Map(counts.map((c) => [c.code, c]));
  return raffles.map((r) => ({
    ...r,
    approvedCount: byCode.get(r.code)?.approved ?? 0,
    pendingCount: byCode.get(r.code)?.pending ?? 0,
    live: r.active && r.createdAt >= cutoff,
  }));
}

// Delete a raffle AND all its entries (tx). Returns whether the raffle existed.
export async function deleteRaffle(code: string): Promise<boolean> {
  const upper = code.toUpperCase();
  return db.transaction(async (tx) => {
    await tx.delete(raffleEntriesTable).where(eq(raffleEntriesTable.raffleCode, upper));
    const removed = await tx
      .delete(rafflesTable)
      .where(eq(rafflesTable.code, upper))
      .returning({ code: rafflesTable.code });
    return removed.length > 0;
  });
}

// Customer sends a raffle code. Fail-closed and privacy-preserving:
//   "pending"  → entry recorded, awaiting manual admin approval
//   "already"  → already in (re-entry is a no-op — no odds stacking, no leak;
//                covers pending, approved AND rejected entries — a rejected
//                customer re-sending the code can't re-ping the admins)
//   "noraffle" → no such code, or it's closed / past its 24h window
// Never reveals entrant counts or any other customer. Entries start PENDING
// and only count for the draw once an admin approves them.
export type RaffleEntryAddResult =
  | { status: "pending"; entryId: number; raffleCode: string }
  | { status: "already" }
  | { status: "noraffle" };
export async function addRaffleEntry(
  code: string,
  chatId: string,
): Promise<RaffleEntryAddResult> {
  const raffle = await findRaffleByCode(code);
  if (!raffle || !raffle.active || raffle.createdAt < raffleExpiryCutoff()) {
    return { status: "noraffle" };
  }
  const inserted = await db
    .insert(raffleEntriesTable)
    .values({ raffleCode: raffle.code, chatId })
    .onConflictDoNothing({
      target: [raffleEntriesTable.raffleCode, raffleEntriesTable.chatId],
    })
    .returning({ id: raffleEntriesTable.id });
  return inserted.length > 0
    ? { status: "pending", entryId: inserted[0].id, raffleCode: raffle.code }
    : { status: "already" };
}

// Approve a pending entry (one-shot: only flips pending → approved, so the
// first admin to tap wins and a double-tap reads "already handled"). Returns
// the entry's chatId/raffleCode for the confirmation DM, or null if the entry
// is gone or was already handled.
export async function approveRaffleEntry(
  entryId: number,
): Promise<{ chatId: string; raffleCode: string } | null> {
  const rows = await db
    .update(raffleEntriesTable)
    .set({ status: "approved" })
    .where(and(eq(raffleEntriesTable.id, entryId), eq(raffleEntriesTable.status, "pending")))
    .returning({ chatId: raffleEntriesTable.chatId, raffleCode: raffleEntriesTable.raffleCode });
  return rows[0] ?? null;
}

// Reject a pending entry (one-shot: only flips pending → rejected). The row is
// KEPT — not deleted — so the (raffle_code, chat_id) unique index still
// dedupes and a rejected customer re-sending the code can't fan out fresh
// Approve/Reject prompts to every admin. Rejected rows never reach the draw
// and die with everything else (draw / delete / 24h sweep). Returns the
// entry's chatId/raffleCode, or null if gone / already handled.
export async function rejectRaffleEntry(
  entryId: number,
): Promise<{ chatId: string; raffleCode: string } | null> {
  const rows = await db
    .update(raffleEntriesTable)
    .set({ status: "rejected" })
    .where(and(eq(raffleEntriesTable.id, entryId), eq(raffleEntriesTable.status, "pending")))
    .returning({ chatId: raffleEntriesTable.chatId, raffleCode: raffleEntriesTable.raffleCode });
  return rows[0] ?? null;
}

// Every still-pending entry across LIVE raffles — lets /raffles re-issue
// Approve/Reject buttons so a missed notification never strands an entry
// (mirrors /verify_queue). Oldest first so the queue reads in arrival order.
export type PendingRaffleEntry = {
  id: number;
  raffleCode: string;
  chatId: string;
  createdAt: Date;
};
export async function listPendingRaffleEntries(): Promise<PendingRaffleEntry[]> {
  const cutoff = raffleExpiryCutoff();
  return db
    .select({
      id: raffleEntriesTable.id,
      raffleCode: raffleEntriesTable.raffleCode,
      chatId: raffleEntriesTable.chatId,
      createdAt: raffleEntriesTable.createdAt,
    })
    .from(raffleEntriesTable)
    .innerJoin(rafflesTable, eq(rafflesTable.code, raffleEntriesTable.raffleCode))
    .where(
      and(
        eq(raffleEntriesTable.status, "pending"),
        eq(rafflesTable.active, true),
        gte(rafflesTable.createdAt, cutoff),
      ),
    )
    .orderBy(asc(raffleEntriesTable.createdAt));
}

// Draw up to N winners for a raffle, atomically. In one tx we DELETE every entry
// RETURNING its chat id + status and flip the raffle inactive — so an entry
// racing the draw is either already committed-and-included, or refused (raffle
// now inactive). Only APPROVED entries make the draw pool; pending and rejected
// ones are wiped with everything else (fail-closed — an unreviewed entry can
// never win). Winners are chosen in memory. Entrant data is gone the instant
// the draw runs; nothing to purge afterward.
export type DrawResult =
  | { ok: false; reason: "noraffle" | "expired" | "noentries" }
  | { ok: true; winners: string[]; totalEntries: number; prize: string };
export async function drawRaffle(code: string, count: number): Promise<DrawResult> {
  const upper = code.toUpperCase();
  return db.transaction(async (tx) => {
    const [raffle] = await tx
      .select()
      .from(rafflesTable)
      .where(eq(rafflesTable.code, upper))
      .limit(1);
    if (!raffle) return { ok: false as const, reason: "noraffle" as const };
    if (raffle.createdAt < raffleExpiryCutoff()) {
      // Past its 24h window — close it out and refuse (draw same day).
      await tx.delete(raffleEntriesTable).where(eq(raffleEntriesTable.raffleCode, upper));
      await tx.update(rafflesTable).set({ active: false }).where(eq(rafflesTable.code, upper));
      return { ok: false as const, reason: "expired" as const };
    }
    const entries = await tx
      .delete(raffleEntriesTable)
      .where(eq(raffleEntriesTable.raffleCode, upper))
      .returning({ chatId: raffleEntriesTable.chatId, status: raffleEntriesTable.status });
    await tx.update(rafflesTable).set({ active: false }).where(eq(rafflesTable.code, upper));
    const ids = entries.filter((e) => e.status === "approved").map((e) => e.chatId);
    if (ids.length === 0) return { ok: false as const, reason: "noentries" as const };
    // Fisher–Yates shuffle, then take N.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const winners = ids.slice(0, Math.max(1, Math.min(count, ids.length)));
    return { ok: true as const, winners, totalEntries: ids.length, prize: raffle.prize };
  });
}

// ===========================================================================
// Cart math
// ===========================================================================
// Auto-applied $10 off for customers an admin has flagged as "regular".
// Capped at the post-promo subtotal so the cart never goes negative.
export const REGULAR_DISCOUNT_CENTS = 1000;

// One-time new-customer intro offer: 50% off the FIRST order after LeafedOut
// verification, only for carts up to $250. Exclusive — replaces promo/regular/
// storewide/bundle/happy-hour (store credit and delivery fee still apply).
export const INTRO_OFFER_PERCENT = 50;
export const INTRO_OFFER_MAX_SUBTOTAL_CENTS = 25000;

// Give the intro offer back after the discounted order is cancelled — but
// ONLY when no other live (non-cancelled) order is holding a consumed offer,
// so a cancel/reorder/cancel shuffle can never mint a second discount.
// Returns true if the offer was actually restored.
export async function refundIntroOffer(
  chatId: string,
  cancelledOrderId: number,
): Promise<boolean> {
  const rows = await db
    .update(subscribersTable)
    .set({ introOfferAvailable: true, introOfferUsedAt: null })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.introOfferAvailable, false),
        isNotNull(subscribersTable.introOfferUsedAt),
        notExists(
          db
            .select({ x: sql`1` })
            .from(ordersTable)
            .where(
              and(
                eq(ordersTable.chatId, chatId),
                ne(ordersTable.id, cancelledOrderId),
                gt(ordersTable.introDiscountCents, 0),
                ne(ordersTable.status, "cancelled"),
              ),
            ),
        ),
      ),
    )
    .returning({ chatId: subscribersTable.chatId });
  return rows.length > 0;
}

// Re-consume the offer when an admin UNDOes a cancel of the discounted order
// (the order goes back to pending with its discount intact, so the offer must
// be locked again). Returns false when the offer is no longer available —
// e.g. the customer already spent it on a new order — in which case the undo
// must be refused (fail-closed: never two live orders holding one offer).
export async function reconsumeIntroOffer(chatId: string): Promise<boolean> {
  const rows = await db
    .update(subscribersTable)
    .set({ introOfferAvailable: false, introOfferUsedAt: new Date() })
    .where(
      and(
        eq(subscribersTable.chatId, chatId),
        eq(subscribersTable.introOfferAvailable, true),
      ),
    )
    .returning({ chatId: subscribersTable.chatId });
  return rows.length > 0;
}

export type CartTotals = {
  subtotalCents: number;
  discountCents: number;
  // $10-off auto-applied when the customer is flagged as a regular. A PERK —
  // see the exclusivity rule below: it only applies when no other perk
  // (intro / promo / credit) is on this order. 0 for non-regulars, when
  // parked, or when the cart is already at $0 after promo.
  regularDiscountCents: number;
  isRegular: boolean;
  // True when the customer IS a regular but the $10 discount is parked this
  // order because another perk took the slot. Cart UI uses this to explain
  // why the line is missing rather than silently dropping it.
  regularParked: boolean;
  // Bundle attached to the cart (one per cart, snapshot from cart_bundles).
  // null if no bundle. Discount stacks AFTER promo+regular, BEFORE happy hour.
  bundleLabel: string | null;
  bundleDiscountCents: number;
  // Happy-hour percent discount. percent=0 means inactive (env not configured
  // or outside window). Discount is computed as percent × subtotal, capped
  // by what's left after promo+regular+bundle.
  happyHourActive: boolean;
  happyHourPercent: number;
  happyHourDiscountCents: number;
  // Store-wide flat auto discount (e.g. "$10 off everything today"). Env-driven
  // (see storewide.ts), no promo code needed. Stacks AFTER promo + regular,
  // BEFORE bundle/happy hour. 0 when inactive or nothing left to discount.
  storewideActive: boolean;
  storewideDiscountCents: number;
  storewideLabel: string;
  // Store credit applied at checkout. A PERK — only applies when neither
  // the intro offer nor a promo code is on this order (exclusivity), then
  // capped at the post-discount subtotal (we don't refund credit beyond the
  // cart total). Computed in advisory form at cart-render; final amount
  // applied is fixed atomically inside createOrderFromCart's tx using the
  // live subscribers.creditCents value.
  creditAppliedCents: number;
  // True when the customer HAS banked credit but it's parked this order
  // because a higher-precedence perk (intro / promo) took the slot. The
  // credit stays banked and auto-applies on a future eligible order.
  creditParked: boolean;
  // Delivery fee, in cents. 0 = pickup or free-zone delivery. Set by
  // createOrderFromCart from the value passed in by the checkout flow.
  // computeCartTotals leaves this 0 — it doesn't know the customer's address.
  deliveryFeeCents: number;
  // True when the delivery fee is a real number (free, $10, or $20).
  // False when the geocode failed and the mod will confirm at the meet.
  deliveryFeeKnown: boolean;
  totalCents: number;
  promoApplied: boolean;
  promoReason?: string;
  // One-time new-customer 50%-off intro offer. `introEligible` mirrors the
  // caller's opts (verified + offer still available); `introApplied` is true
  // only when it actually fired (eligible + non-empty cart ≤ the cap). When
  // applied it is EXCLUSIVE: every other perk (promo/credit/regular) AND all
  // store-run sales (storewide/bundle/happy-hour) are suppressed — only the
  // delivery fee still stacks on top.
  //
  // PERK EXCLUSIVITY RULE (customer perks never stack):
  //   at most ONE of { intro 50%, promo code, store credit, regular $10 }
  //   per order, precedence in that listed order. Store-run sales
  //   (storewide / bundle / happy hour) are NOT perks — they stack on top of
  //   whichever single perk applied (except under intro, which suppresses
  //   them too). Suppressed perks are "parked", never lost: promo codes
  //   survive on the cart, credit stays banked, regular resumes next order.
  introEligible: boolean;
  introApplied: boolean;
  introDiscountCents: number;
};

export function computeCartTotals(
  lines: CartLine[],
  promo?: PromoCode | null,
  opts?: {
    isRegular?: boolean;
    bundleLabel?: string | null;
    bundleDiscountCents?: number;
    happyHourPercent?: number;
    storewideDiscountCents?: number;
    storewideLabel?: string;
    availableCreditCents?: number;
    // True when the customer is verified AND their one-time intro offer is
    // still available. computeCartTotals then decides whether it actually
    // applies (cart non-empty and ≤ the cap).
    introOfferEligible?: boolean;
  },
): CartTotals {
  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  // New-customer 50% off — decided FIRST because when it applies it replaces
  // every other discount (promo/regular/storewide/bundle/happy-hour). Over
  // the cap it simply doesn't apply and the normal stack takes over.
  const introEligible = !!opts?.introOfferEligible;
  const introApplied =
    introEligible && subtotalCents > 0 && subtotalCents <= INTRO_OFFER_MAX_SUBTOTAL_CENTS;
  const introDiscountCents = introApplied
    ? Math.min(subtotalCents, Math.floor((subtotalCents * INTRO_OFFER_PERCENT) / 100))
    : 0;
  let discountCents = 0;
  let promoApplied = false;
  let promoReason: string | undefined;
  if (promo) {
    if (introApplied) {
      promoReason = "can't combine with your 50% new-customer offer";
    } else if (!promo.active) {
      promoReason = "promo not active";
    } else if (promo.expiresAt && promo.expiresAt < new Date()) {
      promoReason = "promo expired";
    } else if (promo.maxUses != null && promo.usedCount >= promo.maxUses) {
      promoReason = "promo fully used";
    } else if (subtotalCents === 0) {
      promoReason = "cart is empty";
    } else {
      if (promo.kind === "percent") {
        // Cap the percent at 100 defensively in case a misconfigured promo
        // row sneaks past /add_promo's 1-99 validation. Also cap discount
        // to subtotal so the displayed "-$X" line never exceeds the cart.
        const pct = Math.min(100, Math.max(0, promo.value));
        discountCents = Math.min(subtotalCents, Math.floor((subtotalCents * pct) / 100));
      } else {
        discountCents = Math.min(promo.value, subtotalCents);
      }
      promoApplied = true;
    }
  }
  // Perk exclusivity: at most ONE customer perk per order —
  // intro > promo > credit > regular. Whether credit takes the slot is
  // decided HERE (before the regular rung) even though the credit amount is
  // only computed at the end of the ladder, so the regular discount can't
  // sneak in alongside it.
  const isRegular = !!opts?.isRegular;
  const afterIntro = Math.max(0, subtotalCents - introDiscountCents);
  const afterPromo = Math.max(0, afterIntro - discountCents);
  const availableCredit = Math.max(0, opts?.availableCreditCents ?? 0);
  const creditTakesSlot =
    availableCredit > 0 && subtotalCents > 0 && !introApplied && !promoApplied;
  const regularDiscountCents =
    isRegular && !introApplied && !promoApplied && !creditTakesSlot
      ? Math.min(REGULAR_DISCOUNT_CENTS, afterPromo)
      : 0;
  // Bundle discount stacks after promo + regular, capped at remaining.
  const bundleLabel = opts?.bundleLabel ?? null;
  const bundleDiscountRaw = introApplied ? 0 : Math.max(0, opts?.bundleDiscountCents ?? 0);
  const afterPromoRegular = Math.max(0, afterPromo - regularDiscountCents);
  // Store-wide flat auto discount stacks after promo + regular, capped at
  // what's left so the cart can never go negative.
  const storewideRaw = introApplied ? 0 : Math.max(0, opts?.storewideDiscountCents ?? 0);
  const storewideDiscountCents = Math.min(storewideRaw, afterPromoRegular);
  const storewideActive = storewideDiscountCents > 0;
  const storewideLabel = opts?.storewideLabel ?? "Today's special";
  const afterStorewide = Math.max(0, afterPromoRegular - storewideDiscountCents);
  const bundleDiscountCents = Math.min(bundleDiscountRaw, afterStorewide);
  // Happy hour applies as percent × subtotal, capped at what's left.
  const happyHourPercent = Math.max(0, Math.min(99, opts?.happyHourPercent ?? 0));
  const happyHourActive = happyHourPercent > 0;
  const happyHourRaw =
    happyHourActive && !introApplied
      ? Math.floor((subtotalCents * happyHourPercent) / 100)
      : 0;
  const afterStack = Math.max(0, afterStorewide - bundleDiscountCents);
  const happyHourDiscountCents = Math.min(happyHourRaw, afterStack);
  const beforeCredit = Math.max(0, afterStack - happyHourDiscountCents);
  // Credit only applies when it holds the perk slot (no intro / promo),
  // capped at what's left after the store-run stack.
  const creditAppliedCents = creditTakesSlot
    ? Math.min(availableCredit, beforeCredit)
    : 0;
  const totalCents = Math.max(0, beforeCredit - creditAppliedCents);
  // Parked flags for the cart UI — a perk that exists but lost the slot is
  // explained, never silently dropped.
  const creditParked = availableCredit > 0 && subtotalCents > 0 && !creditTakesSlot;
  const regularParked =
    isRegular &&
    subtotalCents > 0 &&
    regularDiscountCents === 0 &&
    (introApplied || promoApplied || creditTakesSlot);
  return {
    subtotalCents,
    discountCents,
    regularDiscountCents,
    isRegular,
    regularParked,
    creditParked,
    bundleLabel,
    bundleDiscountCents,
    happyHourActive,
    happyHourPercent,
    happyHourDiscountCents,
    storewideActive,
    storewideDiscountCents,
    storewideLabel,
    creditAppliedCents,
    deliveryFeeCents: 0,
    deliveryFeeKnown: true,
    totalCents,
    promoApplied,
    promoReason,
    introEligible,
    introApplied,
    introDiscountCents,
  };
}

// ===========================================================================
// Regular customers (admin-managed) — see REGULAR_DISCOUNT_CENTS + delivery
// fee free-zone bump in deliveryFee.ts.
// ===========================================================================
export async function isRegular(chatId: string): Promise<boolean> {
  const rows = await db
    .select({ chatId: regularCustomersTable.chatId })
    .from(regularCustomersTable)
    .where(eq(regularCustomersTable.chatId, chatId))
    .limit(1);
  return rows.length > 0;
}

export async function addRegular(
  chatId: string,
  notes: string | null,
  addedBy: string,
): Promise<{ created: boolean }> {
  // Atomic upsert — concurrent /add_regular calls can't collide on the PK.
  // `xmax = 0` is a Postgres trick: it's 0 on a fresh insert and non-zero
  // on a row that was updated by ON CONFLICT, so we can tell created vs
  // refreshed in a single round-trip.
  const rows = await db
    .insert(regularCustomersTable)
    .values({ chatId, notes: notes ?? null, addedBy })
    .onConflictDoUpdate({
      target: regularCustomersTable.chatId,
      set: { notes: notes ?? null, addedBy },
    })
    .returning({
      chatId: regularCustomersTable.chatId,
      created: sql<boolean>`(xmax = 0)`,
    });
  return { created: rows[0]?.created ?? true };
}

export async function removeRegular(chatId: string): Promise<boolean> {
  const deleted = await db
    .delete(regularCustomersTable)
    .where(eq(regularCustomersTable.chatId, chatId))
    .returning({ chatId: regularCustomersTable.chatId });
  return deleted.length > 0;
}

export async function listRegulars(): Promise<RegularCustomer[]> {
  return db
    .select()
    .from(regularCustomersTable)
    .orderBy(asc(regularCustomersTable.addedAt));
}

// ===========================================================================
// Trusted broadcast list (admin-managed) — a separate, hand-curated audience
// used ONLY for private broadcasts. Distinct from regular_customers (pricing).
// ===========================================================================
export async function addTrusted(
  chatId: string,
  notes: string | null,
  addedBy: string,
): Promise<{ created: boolean }> {
  // Atomic upsert — re-adding the same chatId refreshes notes/addedBy instead
  // of erroring. `xmax = 0` distinguishes a fresh insert from an updated row.
  const rows = await db
    .insert(trustedBroadcastTable)
    .values({ chatId, notes: notes ?? null, addedBy })
    .onConflictDoUpdate({
      target: trustedBroadcastTable.chatId,
      set: { notes: notes ?? null, addedBy },
    })
    .returning({
      chatId: trustedBroadcastTable.chatId,
      created: sql<boolean>`(xmax = 0)`,
    });
  return { created: rows[0]?.created ?? true };
}

export async function removeTrusted(chatId: string): Promise<boolean> {
  const deleted = await db
    .delete(trustedBroadcastTable)
    .where(eq(trustedBroadcastTable.chatId, chatId))
    .returning({ chatId: trustedBroadcastTable.chatId });
  return deleted.length > 0;
}

export async function listTrusted(): Promise<TrustedBroadcastMember[]> {
  return db
    .select()
    .from(trustedBroadcastTable)
    .orderBy(asc(trustedBroadcastTable.addedAt));
}

export function formatPriceCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ===========================================================================
// Checkout — atomic: insert order + items, clear cart + promo, bump promo use.
// ===========================================================================
export async function createOrderFromCart(params: {
  chatId: string;
  customerName: string;
  customerUsername?: string | null;
  deliveryArea: string;
  preferredTime: string;
  notes?: string;
  itemsSummary: string;
  cartLines: CartLine[];
  totals: CartTotals;
  promoCode?: string | null;
  // Delivery fee in cents at order time. `null` = unknown (geocode failed,
  // mod confirms at the meet). 0 = pickup or in-zone free delivery.
  deliveryFeeCents?: number | null;
  // Happy-hour percent at submit time (caller computes from getHappyHourState).
  // Re-applied authoritatively inside the tx for snapshot fidelity.
  happyHourPercent?: number;
  // Neighbour-grouping opt-in. Fail-closed: caller only passes true for a
  // delivery order where the customer explicitly tapped "group my drop".
  groupOptin?: boolean;
}): Promise<{
  order: typeof ordersTable.$inferSelect;
  items: OrderItem[];
  authoritativeLines: CartLine[];
  authoritativeTotals: CartTotals;
  authoritativePromoCode: string | null;
}> {
  // Retry the whole transaction on a PK collision — the random order ID
  // we pick at insert time is the only thing that can collide, and a
  // collision aborts the tx so we re-roll and try again.
  let lastErr: unknown;
  for (let attempt = 0; attempt < ORDER_ID_MAX_RETRIES; attempt++) {
    const candidateOrderId = generateRandomOrderId();
    try {
      return await runCreateOrderFromCartTx(params, candidateOrderId);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Failed to allocate a unique order ID after retries");
}

async function runCreateOrderFromCartTx(
  params: Parameters<typeof createOrderFromCart>[0],
  candidateOrderId: number,
): Promise<Awaited<ReturnType<typeof createOrderFromCart>>> {
  return db.transaction(async (tx) => {
    // ---- Step 1: Re-fetch the cart inside the tx. The passed-in lines are
    //              treated as advisory only — DB is the source of truth.
    const cartRows = await tx
      .select({
        cartItemId: cartItemsTable.id,
        variantId: productVariantsTable.id,
        productId: productsTable.id,
        productName: productsTable.name,
        productEmoji: productsTable.emoji,
        productPreorder: productsTable.preorder,
        variantLabel: productVariantsTable.label,
        unitPriceCents: productVariantsTable.priceCents,
        quantity: cartItemsTable.quantity,
      })
      .from(cartItemsTable)
      .innerJoin(productVariantsTable, eq(cartItemsTable.variantId, productVariantsTable.id))
      .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
      .where(eq(cartItemsTable.chatId, params.chatId))
      .orderBy(asc(cartItemsTable.addedAt));
    const freshLines: CartLine[] = cartRows.map((r) => ({
      ...r,
      lineTotalCents: r.unitPriceCents * r.quantity,
    }));

    if (freshLines.length === 0) {
      throw new OrderValidationError("EMPTY_CART", "Your cart is empty.");
    }

    // ---- Step 2: Sanity-check the cart didn't shrink/change since the
    //              customer hit Send Order. If it did, abort so the
    //              customer can re-confirm rather than transact on stale prices.
    const beforeKey = params.cartLines
      .map((l) => `${l.variantId}x${l.quantity}@${l.unitPriceCents}`)
      .sort()
      .join("|");
    const afterKey = freshLines
      .map((l) => `${l.variantId}x${l.quantity}@${l.unitPriceCents}`)
      .sort()
      .join("|");
    if (beforeKey !== afterKey) {
      throw new OrderValidationError(
        "CART_CHANGED",
        "Your cart changed between rendering and submit.",
      );
    }

    // ---- Step 3: Re-validate the promo (if one is attached). Recompute
    //              totals from scratch using the authoritative DB state.
    let promo: PromoCode | null = null;
    if (params.promoCode) {
      const promoRows = await tx
        .select()
        .from(promoCodesTable)
        .where(eq(promoCodesTable.code, params.promoCode.toUpperCase()));
      const found = promoRows[0];
      if (!found || !found.active) {
        throw new OrderValidationError("PROMO_INVALID", "Promo no longer available.");
      }
      if (found.expiresAt && found.expiresAt.getTime() < Date.now()) {
        throw new OrderValidationError("PROMO_EXPIRED", "Promo expired.");
      }
      if (found.maxUses != null && found.usedCount >= found.maxUses) {
        throw new OrderValidationError("PROMO_USED_OUT", "Promo fully redeemed.");
      }
      promo = found;
    }
    // Honor the regular-status snapshot the customer was shown at cart-view
    // time. Only admin can change this state, so there's no abuse vector in
    // trusting the caller — and locking the snapshot prevents the bug where
    // an admin removing a regular mid-checkout would charge the customer a
    // higher total than they confirmed. Falls back to a fresh DB read for
    // legacy callers that don't populate `isRegular` on the totals object.
    const customerIsRegular =
      typeof params.totals.isRegular === "boolean"
        ? params.totals.isRegular
        : (
            await tx
              .select({ chatId: regularCustomersTable.chatId })
              .from(regularCustomersTable)
              .where(eq(regularCustomersTable.chatId, params.chatId))
              .limit(1)
          ).length > 0;
    // ---- Read live bundle snapshot + available credit inside the tx so
    //      cart-render-time staleness can't cheat the customer (or the shop).
    const bundleRow = (
      await tx.select().from(cartBundlesTable).where(eq(cartBundlesTable.chatId, params.chatId))
    )[0];
    // Defense-in-depth: verify the cart still satisfies the bundle's required
    // items before applying the discount. This catches any mutation path that
    // skips the pre-checkout revalidation (e.g. future API additions). If the
    // check fails, drop the bundle row atomically inside the tx so the stale
    // snapshot is gone before the order is committed.
    let bundleDiscountCents = bundleRow?.discountCents ?? 0;
    let bundleLabel: string | null = bundleRow?.label ?? null;
    if (bundleRow) {
      const bundleItems = await tx
        .select()
        .from(bundleItemsTable)
        .where(eq(bundleItemsTable.bundleId, bundleRow.bundleId));
      const cartQtyByVariant = new Map<number, number>();
      for (const line of freshLines) {
        cartQtyByVariant.set(line.variantId, (cartQtyByVariant.get(line.variantId) ?? 0) + line.quantity);
      }
      let bundleValid = true;
      for (const bi of bundleItems) {
        const variantRows = await tx
          .select({ id: productVariantsTable.id })
          .from(productVariantsTable)
          .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
          .where(
            and(
              eq(productsTable.name, bi.productName),
              eq(productVariantsTable.label, bi.variantLabel),
            ),
          )
          .limit(1);
        const vid = variantRows[0]?.id;
        if (!vid || (cartQtyByVariant.get(vid) ?? 0) < bi.quantity) {
          bundleValid = false;
          break;
        }
      }
      if (!bundleValid) {
        await tx.delete(cartBundlesTable).where(eq(cartBundlesTable.chatId, params.chatId));
        bundleDiscountCents = 0;
        bundleLabel = null;
      }
    }
    const subRow = (
      await tx
        .select({
          creditCents: subscribersTable.creditCents,
          verified: subscribersTable.verified,
          introOfferAvailable: subscribersTable.introOfferAvailable,
        })
        .from(subscribersTable)
        .where(eq(subscribersTable.chatId, params.chatId))
    )[0];
    const availableCreditCents = subRow?.creditCents ?? 0;
    // Intro-offer eligibility is read live inside the tx — never trusted from
    // the caller — so a stale cart view can't apply a spent offer.
    const introOfferEligible =
      subRow?.verified === true && subRow?.introOfferAvailable === true;

    // Store-wide auto discount is derived server-side at submit time (never
    // trusted from the caller) so the order total reflects the live window.
    const storewide = getStorewideDiscount();
    const cartOnlyTotals = computeCartTotals(freshLines, promo, {
      isRegular: customerIsRegular,
      bundleLabel,
      bundleDiscountCents,
      happyHourPercent: params.happyHourPercent ?? 0,
      storewideDiscountCents: storewide.active ? storewide.cents : 0,
      storewideLabel: storewide.label,
      availableCreditCents,
      introOfferEligible,
    });
    // Perk mismatch between the cart the customer confirmed and the live tx
    // recompute aborts in BOTH directions — never silently charge a total
    // they didn't tap "Send" on, and never silently consume a one-time perk
    // on a total they never saw. Under the one-perk-per-order rule this
    // matters beyond the intro offer: e.g. a promo dying mid-checkout
    // (expired / used out) would otherwise silently swap banked credit into
    // the slot, and a concurrent loyalty/referral payout would silently
    // debit MORE credit than the cart showed. Deliberately NOT comparing
    // totalCents — store-run sales (storewide/happy-hour) are re-read live
    // by design and may legitimately shift the total.
    if (
      params.totals.introApplied !== cartOnlyTotals.introApplied ||
      params.totals.promoApplied !== cartOnlyTotals.promoApplied ||
      params.totals.creditAppliedCents !== cartOnlyTotals.creditAppliedCents
    ) {
      throw new OrderValidationError(
        "CART_CHANGED",
        "Your discounts just changed for this cart — re-open the cart to see the updated total.",
      );
    }
    // Atomically debit the credit we actually used. Conditional update so a
    // concurrent referral payout / loyalty bump can't get clobbered.
    if (cartOnlyTotals.creditAppliedCents > 0) {
      const debit = await tx
        .update(subscribersTable)
        .set({
          creditCents: sql`${subscribersTable.creditCents} - ${cartOnlyTotals.creditAppliedCents}`,
        })
        .where(
          and(
            eq(subscribersTable.chatId, params.chatId),
            gte(subscribersTable.creditCents, cartOnlyTotals.creditAppliedCents),
          ),
        )
        .returning({ chatId: subscribersTable.chatId });
      if (debit.length === 0) {
        throw new OrderValidationError(
          "CART_CHANGED",
          "Your store credit just changed — re-open the cart.",
        );
      }
    }
    // Atomically consume the one-time intro offer. Conditional on it still
    // being available so two racing checkouts (or a parallel device) can
    // never both get 50% off — the loser's whole tx rolls back.
    if (cartOnlyTotals.introApplied) {
      const consumed = await tx
        .update(subscribersTable)
        .set({ introOfferAvailable: false, introOfferUsedAt: new Date() })
        .where(
          and(
            eq(subscribersTable.chatId, params.chatId),
            eq(subscribersTable.introOfferAvailable, true),
          ),
        )
        .returning({ chatId: subscribersTable.chatId });
      if (consumed.length === 0) {
        throw new OrderValidationError(
          "CART_CHANGED",
          "Your new-customer discount was already used — re-open the cart.",
        );
      }
    }
    // Layer the delivery fee on top of the cart-only total. `null` means
    // the geocode failed at checkout — store NULL on the row so mods see
    // "TBC" rather than $0.
    const deliveryFeeCents =
      params.deliveryFeeCents === undefined ? 0 : params.deliveryFeeCents;
    const deliveryFeeKnown = deliveryFeeCents !== null;
    const finalTotalCents = cartOnlyTotals.totalCents + (deliveryFeeCents ?? 0);
    const authoritativeTotals: CartTotals = {
      ...cartOnlyTotals,
      deliveryFeeCents: deliveryFeeCents ?? 0,
      deliveryFeeKnown,
      totalCents: finalTotalCents,
    };
    const authoritativePromoCode = authoritativeTotals.promoApplied && promo ? promo.code : null;

    // Rebuild the items summary from the fresh lines so the orders.items text
    // never reflects a stale view of the cart.
    const itemsSummary = freshLines
      .map((l) => `${l.quantity}× ${l.variantLabel} ${l.productName}`)
      .join(" · ");

    // ---- Step 4: Insert the order with authoritative totals.
    const [order] = await tx
      .insert(ordersTable)
      .values({
        id: candidateOrderId,
        chatId: params.chatId,
        customerName: params.customerName,
        customerUsername: params.customerUsername ?? undefined,
        items: itemsSummary,
        deliveryArea: params.deliveryArea,
        preferredTime: params.preferredTime,
        notes: params.notes ?? undefined,
        subtotalCents: authoritativeTotals.subtotalCents,
        discountCents: authoritativeTotals.discountCents,
        deliveryFeeCents: deliveryFeeKnown ? authoritativeTotals.deliveryFeeCents : null,
        regularDiscountCents: authoritativeTotals.regularDiscountCents,
        introDiscountCents: authoritativeTotals.introDiscountCents,
        totalCents: authoritativeTotals.totalCents,
        promoCode: authoritativePromoCode ?? undefined,
        status: "pending",
        groupOptin: params.groupOptin ?? false,
      })
      .returning();

    const itemRows: InsertOrderItem[] = freshLines.map((l) => ({
      orderId: order.id,
      productName: l.productName,
      variantLabel: l.variantLabel,
      unitPriceCents: l.unitPriceCents,
      quantity: l.quantity,
      lineTotalCents: l.lineTotalCents,
    }));
    const items = await tx.insert(orderItemsTable).values(itemRows).returning();

    await tx.delete(cartItemsTable).where(eq(cartItemsTable.chatId, params.chatId));
    await tx.delete(cartPromosTable).where(eq(cartPromosTable.chatId, params.chatId));
    await tx.delete(cartBundlesTable).where(eq(cartBundlesTable.chatId, params.chatId));

    // ---- Step 5: Bump usedCount with a guard so two simultaneous orders
    //              can't both consume the last redemption of a maxUses promo.
    if (authoritativePromoCode) {
      const updated = await tx
        .update(promoCodesTable)
        .set({ usedCount: sql`${promoCodesTable.usedCount} + 1` })
        .where(
          and(
            eq(promoCodesTable.code, authoritativePromoCode),
            eq(promoCodesTable.active, true),
            or(
              isNull(promoCodesTable.maxUses),
              sql`${promoCodesTable.usedCount} < ${promoCodesTable.maxUses}`,
            ),
          ),
        )
        .returning({ id: promoCodesTable.id });
      if (updated.length === 0) {
        // Race: between our re-check and the bump, another order finished
        // off the redemptions. Roll back the whole order.
        throw new OrderValidationError(
          "PROMO_USED_OUT",
          "Promo was just redeemed by someone else.",
        );
      }
    }

    return {
      order,
      items,
      authoritativeLines: freshLines,
      authoritativeTotals,
      authoritativePromoCode,
    };
  });
}

// ===========================================================================
// Mod status — driver "away/driving" mode
// ===========================================================================
export async function setModStatus(
  chatId: string,
  away: boolean,
  awayMessage?: string | null,
  awayUntil?: Date | null,
) {
  await db
    .insert(modStatusTable)
    .values({ chatId, away, awayMessage: awayMessage ?? null, awayUntil: awayUntil ?? null })
    .onConflictDoUpdate({
      target: modStatusTable.chatId,
      set: {
        away,
        awayMessage: awayMessage ?? null,
        awayUntil: awayUntil ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function getModStatuses(): Promise<ModStatus[]> {
  return db.select().from(modStatusTable);
}

export async function getModStatus(chatId: string): Promise<ModStatus | undefined> {
  const rows = await db.select().from(modStatusTable).where(eq(modStatusTable.chatId, chatId));
  return rows[0];
}

// ===========================================================================
// Pickup windows — the admin-set daily window customers see for pickup.
// One row per business day (dateKey "YYYY-MM-DD"), minutes-from-midnight.
// Past days are pruned by the self-destruct sweep (data minimization).
// ===========================================================================
export async function getPickupWindow(dateKey: string): Promise<PickupWindow | undefined> {
  const rows = await db.select().from(pickupWindowsTable).where(eq(pickupWindowsTable.dateKey, dateKey));
  return rows[0];
}

export async function setPickupWindow(dateKey: string, startMinutes: number, endMinutes: number): Promise<void> {
  await db
    .insert(pickupWindowsTable)
    .values({ dateKey, startMinutes, endMinutes })
    .onConflictDoUpdate({
      target: pickupWindowsTable.dateKey,
      set: { startMinutes, endMinutes, updatedAt: new Date() },
    });
}

export async function clearPickupWindow(dateKey: string): Promise<void> {
  await db.delete(pickupWindowsTable).where(eq(pickupWindowsTable.dateKey, dateKey));
}

// Delete every row from before the given business day ("YYYY-MM-DD" keys
// compare correctly as strings).
export async function prunePickupWindows(todayKey: string): Promise<void> {
  await db.delete(pickupWindowsTable).where(lt(pickupWindowsTable.dateKey, todayKey));
}

// ===========================================================================
// Order items (for relay/admin display)
// ===========================================================================
export async function getOrderItems(orderId: number): Promise<OrderItem[]> {
  return db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId)).orderBy(asc(orderItemsTable.id));
}

// ===========================================================================
// One-time migrations / maintenance — safe to call repeatedly, idempotent.
// ===========================================================================

// Loose price parser. Pulls the first decimal/integer out of a free-text
// price string and converts to cents. Returns null if nothing parses (caller
// should skip and let the admin add variants by hand).
function parsePriceToCents(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/[^\d.]/g, " ").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const f = parseFloat(m[1]);
  if (!isFinite(f) || f <= 0) return null;
  return Math.round(f * 100);
}

// Create a single "Each" variant for any product that currently has zero
// variants, parsing the legacy free-text `price` column into cents. Run at
// boot so the cart never shows a product the customer can't add to it.
export async function backfillVariantsForLegacyProducts(): Promise<{ created: number; skipped: number }> {
  const products = await db.select().from(productsTable);
  let created = 0;
  let skipped = 0;
  for (const p of products) {
    const variants = await db
      .select({ id: productVariantsTable.id })
      .from(productVariantsTable)
      .where(eq(productVariantsTable.productId, p.id));
    if (variants.length > 0) {
      skipped++;
      continue;
    }
    const cents = parsePriceToCents(p.price);
    if (cents == null) {
      skipped++;
      continue;
    }
    await db.insert(productVariantsTable).values({
      productId: p.id,
      label: "Each",
      priceCents: cents,
      position: 0,
    });
    created++;
  }
  return { created, skipped };
}

// Orders
// NOTE: prefer createOrderFromCart for the real customer flow — that path
// validates cart, prices, promos and assigns the random order ID inside
// the transaction. This helper exists for ad-hoc inserts and assigns its
// own random 4-digit ID with collision-retry to match.
export async function createOrder(data: InsertOrder) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < ORDER_ID_MAX_RETRIES; attempt++) {
    try {
      return await db.insert(ordersTable).values({ ...data, id: generateRandomOrderId() }).returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Failed to allocate a unique order ID after retries");
}

// Most recent CONFIRMED/COMPLETED order for a given customer chat — used by
// the one-tap reorder flow on /start. Pending or cancelled orders are
// excluded so the customer never gets a "Same as last time" prompt for an
// order that never actually happened. Returns undefined for first-timers.
export async function getLastOrderForChat(chatId: string) {
  const rows = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.chatId, chatId),
        inArray(ordersTable.status, ["confirmed", "completed"] as const),
      ),
    )
    .orderBy(desc(ordersTable.createdAt))
    .limit(1);
  return rows[0];
}

// Batched fetch for the dash view — pulls every order_item belonging to ANY
// of the given orderIds in a single round-trip. Replaces the per-order N+1
// loop in dash.ts. Returns rows keyed by orderId for easy aggregation.
export async function getOrderItemsForOrders(orderIds: number[]): Promise<OrderItem[]> {
  if (orderIds.length === 0) return [];
  return db
    .select()
    .from(orderItemsTable)
    .where(inArray(orderItemsTable.orderId, orderIds));
}

// Order_items snapshot product/variant labels (not IDs) so price history is
// preserved. To re-add a historical item to the cart we look up the current
// active variant by (product name, variant label). Inactive products or
// removed variants return undefined so the caller can skip + count.
export async function findActiveVariantByLabels(
  productName: string,
  variantLabel: string,
): Promise<ProductVariant | undefined> {
  const rows = await db
    .select({ v: productVariantsTable })
    .from(productVariantsTable)
    .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
    .where(
      and(
        eq(productsTable.name, productName),
        eq(productVariantsTable.label, variantLabel),
        eq(productsTable.available, true),
        // Reorder must skip sold-out variants — never let a customer reload
        // a cart with a size they can't actually buy right now.
        ne(productVariantsTable.stock, "sold_out"),
      ),
    )
    .limit(1);
  return rows[0]?.v;
}

export async function getOrders(status?: string) {
  if (status) {
    return db.select().from(ordersTable).where(eq(ordersTable.status, status as "pending" | "confirmed" | "in_progress" | "completed" | "cancelled"));
  }
  return db.select().from(ordersTable);
}

// Conditional transition: only flip the order if it's still pending. Returns
// the post-transition row, or undefined if it was already confirmed/cancelled
// by another admin. Use this for /confirm_<id> and /cancel_<id> so two
// admins can't both fire conflicting customer notifications.
export async function transitionPendingOrder(
  id: number,
  toStatus: "confirmed" | "cancelled",
): Promise<typeof ordersTable.$inferSelect | undefined> {
  const [row] = await db
    .update(ordersTable)
    .set({ status: toStatus })
    .where(and(eq(ordersTable.id, id), eq(ordersTable.status, "pending")))
    .returning();
  return row;
}

export async function updateOrderStatus(id: number, status: "pending" | "confirmed" | "in_progress" | "completed" | "cancelled") {
  return db.update(ordersTable).set({ status, updatedAt: new Date() }).where(eq(ordersTable.id, id));
}

// Mod fat-finger safety net — used by the Undo button after a Confirm/Decline.
// Atomic conditional flip: only reverts if the current status still matches
// `fromStatus`, so a race with another mod re-actioning the order can't
// silently overwrite their work. Returns the post-revert row, or undefined
// if the order moved on. Loyalty/referral payouts are NOT unwound here —
// they're idempotent, so a subsequent re-Confirm will not double-pay, and
// rare cases of "credit granted then truly cancelled" can be adjusted via
// /credit_adjust if you ever add one.
export async function revertOrderToPending(
  id: number,
  fromStatus: "confirmed" | "cancelled",
): Promise<typeof ordersTable.$inferSelect | undefined> {
  const [row] = await db
    .update(ordersTable)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(ordersTable.id, id), eq(ordersTable.status, fromStatus)))
    .returning();
  return row;
}

// Confirmed-order count for a customer. Used by the mod relay header
// ("Regular · 12 orders") and the auto-Regular promoter below.
export async function getConfirmedOrderCount(chatId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(ordersTable)
    .where(and(eq(ordersTable.chatId, chatId), eq(ordersTable.status, "confirmed")));
  return Number(rows[0]?.n ?? 0);
}

// Loyalty progress for the cart-side nudge. Returns the number of confirmed
// orders this customer needs to place before their NEXT $5 payout fires,
// and the payout amount. Returns null when the next payout is already
// queued by their current order (i.e. they're at 0 remaining), so the cart
// renderer can skip the nudge in that edge case.
export async function getLoyaltyProgress(
  chatId: string,
): Promise<{ ordersUntilNext: number; rewardCents: number } | null> {
  const sub = await getSubscriber(chatId);
  if (!sub) return null;
  const confirmed = await getConfirmedOrderCount(chatId);
  const sinceAnchor = confirmed - sub.loyaltyAnchor;
  const remaining = LOYALTY_THRESHOLD - sinceAnchor;
  if (remaining < 1 || remaining > LOYALTY_THRESHOLD) return null;
  return { ordersUntilNext: remaining, rewardCents: LOYALTY_REWARD_CENTS };
}

export async function getOrdersSince(since: Date) {
  return db.select().from(ordersTable).where(gte(ordersTable.createdAt, since));
}

// ---------------------------------------------------------------------------
// Fell-through customer follow-up (backs followUpReminder.ts).
// An order has "fallen through" when it's still `pending` past the configured
// delay, but still inside the 24h retention window, and hasn't been nudged yet.
// This returns just that SQL-eligible set; the scheduler layers the
// deliberate-ignore exclusions (blocked / mod-claimed / not-verified) on top
// before it sends anything.
// ---------------------------------------------------------------------------
export async function getFollowUpEligibleOrders(
  now: number,
  afterMs: number,
): Promise<Array<typeof ordersTable.$inferSelect>> {
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  // Clamp so we never reach past the retention purge (pointless to nudge an
  // order about to vanish) or below a sane floor.
  const safeAfter = Math.min(Math.max(afterMs, 0), RETENTION_MS - 60_000);
  const upper = new Date(now - safeAfter); // old enough to count as stalled
  const lower = new Date(now - RETENTION_MS); // young enough to still exist
  return db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.status, "pending"),
        isNull(ordersTable.followUpSentAt),
        lt(ordersTable.createdAt, upper),
        gt(ordersTable.createdAt, lower),
      ),
    );
}

// Atomically claim the single follow-up slot for one order BEFORE sending, so
// overlapping ticks (or a restart mid-batch) can never double-nudge. The
// conditional UPDATE only fires while the order is still `pending` AND has not
// already been followed up — so a mod confirm/cancel landing in the same
// instant wins the race and suppresses the nudge. Returns the chatId +
// customer name to address, or undefined if the slot was already taken / the
// order moved on. Fail-closed: the marker is stamped even though the send
// hasn't happened yet, so a failed send is never retried (better silent than
// spammy).
export async function claimFollowUp(
  orderId: number,
): Promise<{ chatId: string; customerName: string } | undefined> {
  const [row] = await db
    .update(ordersTable)
    .set({ followUpSentAt: new Date() })
    .where(
      and(
        eq(ordersTable.id, orderId),
        eq(ordersTable.status, "pending"),
        isNull(ordersTable.followUpSentAt),
      ),
    )
    .returning({ chatId: ordersTable.chatId, customerName: ordersTable.customerName });
  return row;
}

// Relays (admin users who receive order notifications)
export async function getRelays() {
  return db.select().from(relaysTable).where(eq(relaysTable.active, true));
}

export async function addRelay(data: InsertRelay) {
  return db.insert(relaysTable).values(data).onConflictDoUpdate({ target: relaysTable.chatId, set: { active: true, label: data.label } });
}

export async function removeRelay(chatId: string) {
  return db.update(relaysTable).set({ active: false }).where(eq(relaysTable.chatId, chatId));
}

// Bot messages (for self-destruct tracking)
export async function trackMessage(chatId: string, messageId: number) {
  await db.insert(botMessagesTable).values({ chatId, messageId });
}

export async function getOldMessages(olderThanDate: Date) {
  return db.select().from(botMessagesTable).where(lt(botMessagesTable.sentAt, olderThanDate));
}

export async function deleteTrackedMessages(ids: number[]) {
  for (const id of ids) {
    await db.delete(botMessagesTable).where(eq(botMessagesTable.id, id));
  }
}

// ===========================================================================
// Wave 2/3 additions: stock, bundles, credit, referral, loyalty, cooldown.
// All discounts compose through computeCartTotals — see CartTotals comments.
// ===========================================================================

// Stock state for a variant. "in_stock" (default) | "low" | "sold_out".
// Cart can never add a sold_out variant; "low" is just a customer-facing badge.
export async function setVariantStock(variantId: number, stock: string): Promise<boolean> {
  // Defense-in-depth: enforce the whitelist at the helper layer so non-CLI
  // callers (future admin UI, scripts) can't drift the column to garbage.
  // The column is text (not pgEnum) to avoid a destructive migration.
  if (stock !== "in_stock" && stock !== "low" && stock !== "sold_out") {
    throw new Error(`setVariantStock: invalid state "${stock}"`);
  }
  const updated = await db
    .update(productVariantsTable)
    .set({ stock })
    .where(eq(productVariantsTable.id, variantId))
    .returning({ id: productVariantsTable.id });
  return updated.length > 0;
}

// Flip EVERY variant of a product to one stock state in a single statement.
// Backs the product manager's one-tap "back in stock / sold out" control so a
// non-technical admin doesn't have to set each size individually. Returns the
// number of rows updated (0 = product has no sizes set yet).
export async function setAllVariantsStock(productId: number, stock: string): Promise<number> {
  if (stock !== "in_stock" && stock !== "low" && stock !== "sold_out") {
    throw new Error(`setAllVariantsStock: invalid state "${stock}"`);
  }
  const updated = await db
    .update(productVariantsTable)
    .set({ stock })
    .where(eq(productVariantsTable.productId, productId))
    .returning({ id: productVariantsTable.id });
  return updated.length;
}

// Every product plus a tiny stock rollup (total sizes + how many are buyable).
// Lets the product-manager list show each item's REAL customer visibility
// (on menu / sold out / hidden) instead of just the on/off switch. Two
// queries, merged in memory — fine for a small menu.
export async function getAllProductsWithVariantStock(): Promise<
  Array<{ product: Product; total: number; buyable: number }>
> {
  const products = await getAllProductsOrdered();
  const variants = await db.select().from(productVariantsTable);
  const byProduct = new Map<number, { total: number; buyable: number }>();
  for (const v of variants) {
    const entry = byProduct.get(v.productId) ?? { total: 0, buyable: 0 };
    entry.total += 1;
    if (v.stock !== "sold_out") entry.buyable += 1;
    byProduct.set(v.productId, entry);
  }
  return products.map((p) => ({
    product: p,
    total: byProduct.get(p.id)?.total ?? 0,
    buyable: byProduct.get(p.id)?.buyable ?? 0,
  }));
}

// ---- Subscriber lookup (full row, including referral + credit fields) ----
export async function getSubscriber(chatId: string): Promise<Subscriber | undefined> {
  const rows = await db
    .select()
    .from(subscribersTable)
    .where(eq(subscribersTable.chatId, chatId));
  return rows[0];
}

// ---- Referral helpers --------------------------------------------------
// Set the customer's own referral code IFF they don't already have one.
// Returns false on collision-or-already-set so caller can retry with a
// different code. App-side uniqueness — DB column is non-unique to avoid a
// destructive backfill (some legacy subscribers may have NULL forever).
export async function setReferralCode(chatId: string, code: string): Promise<boolean> {
  const updated = await db
    .update(subscribersTable)
    .set({ referralCode: code })
    .where(and(eq(subscribersTable.chatId, chatId), isNull(subscribersTable.referralCode)))
    .returning({ chatId: subscribersTable.chatId });
  return updated.length > 0;
}

export async function findSubscriberByReferralCode(code: string): Promise<Subscriber | undefined> {
  const rows = await db
    .select()
    .from(subscribersTable)
    .where(eq(subscribersTable.referralCode, code));
  return rows[0];
}

// Attach `referredBy` to a brand-new subscriber (no orders yet, no existing
// referredBy). Idempotent: returns false if either guard already failed.
// Self-referral (chatId == owner.chatId) is the caller's responsibility to
// reject — see referral.ts:tryAttachReferral.
export async function setReferredByIfBrandNew(chatId: string, code: string): Promise<boolean> {
  const orderCountRows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(ordersTable)
    .where(eq(ordersTable.chatId, chatId));
  const n = Number(orderCountRows[0]?.n ?? 0);
  if (n > 0) return false;
  const updated = await db
    .update(subscribersTable)
    .set({ referredBy: code })
    .where(and(eq(subscribersTable.chatId, chatId), isNull(subscribersTable.referredBy)))
    .returning({ chatId: subscribersTable.chatId });
  return updated.length > 0;
}

// ---- Loyalty + referral payouts (called from applyOrderTransition) ----
const LOYALTY_THRESHOLD = 5;
const LOYALTY_REWARD_CENTS = 500;
const REFERRAL_BONUS_CENTS = 500;
// Auto-promote to Regular once a customer hits this many confirmed orders.
// Mirrors `/add_regular` exactly — the row is inserted into regular_customers
// with addedBy="auto" so admins can spot auto-promotions in /list_regulars.
const REGULAR_AUTO_PROMOTE_THRESHOLD = 8;

// Idempotent auto-promotion. Returns { promoted: true } only on the
// confirmed→regular transition so callers can fire a one-time congrats DM.
// Safe to call after every confirmed order — addRegular is an upsert and
// isRegular short-circuits when already promoted.
export async function autoPromoteRegularIfDue(
  chatId: string,
): Promise<{ promoted: boolean; threshold: number; count: number }> {
  const count = await getConfirmedOrderCount(chatId);
  if (count < REGULAR_AUTO_PROMOTE_THRESHOLD) {
    return { promoted: false, threshold: REGULAR_AUTO_PROMOTE_THRESHOLD, count };
  }
  if (await isRegular(chatId)) {
    return { promoted: false, threshold: REGULAR_AUTO_PROMOTE_THRESHOLD, count };
  }
  const { created } = await addRegular(chatId, `auto-promoted @ ${count} orders`, "auto");
  return { promoted: created, threshold: REGULAR_AUTO_PROMOTE_THRESHOLD, count };
}

// Award $5 every 5 confirmed orders. Idempotent via loyaltyAnchor: we only
// pay when (confirmed_count - anchor) >= 5, then atomically bump anchor to
// the new count. Two simultaneous /confirm_<id> calls can't double-pay
// because the conditional update guards on the current anchor value.
export async function awardLoyaltyIfDue(
  chatId: string,
): Promise<{ paid: boolean; cents: number }> {
  return db.transaction(async (tx) => {
    const sub = (
      await tx.select().from(subscribersTable).where(eq(subscribersTable.chatId, chatId))
    )[0];
    if (!sub) return { paid: false, cents: 0 };
    const cnt = await tx
      .select({ n: sql<number>`COUNT(*)` })
      .from(ordersTable)
      .where(and(eq(ordersTable.chatId, chatId), eq(ordersTable.status, "confirmed")));
    const confirmed = Number(cnt[0]?.n ?? 0);
    if (confirmed - sub.loyaltyAnchor < LOYALTY_THRESHOLD) return { paid: false, cents: 0 };
    const updated = await tx
      .update(subscribersTable)
      .set({
        loyaltyAnchor: confirmed,
        creditCents: sql`${subscribersTable.creditCents} + ${LOYALTY_REWARD_CENTS}`,
      })
      .where(
        and(
          eq(subscribersTable.chatId, chatId),
          eq(subscribersTable.loyaltyAnchor, sub.loyaltyAnchor),
        ),
      )
      .returning({ chatId: subscribersTable.chatId });
    return { paid: updated.length > 0, cents: updated.length > 0 ? LOYALTY_REWARD_CENTS : 0 };
  });
}

// Pay $5 to the referee + $5 to the referrer on the referee's first
// confirmed order. Idempotent via referralRewarded boolean — the conditional
// update flips it from false→true atomically, so a double-confirm can't
// double-pay.
export async function awardReferralIfDue(
  chatId: string,
): Promise<{ paidReferred: boolean; paidReferrer: boolean; cents: number }> {
  return db.transaction(async (tx) => {
    const sub = (
      await tx.select().from(subscribersTable).where(eq(subscribersTable.chatId, chatId))
    )[0];
    if (!sub || !sub.referredBy || sub.referralRewarded) {
      return { paidReferred: false, paidReferrer: false, cents: 0 };
    }
    const flipped = await tx
      .update(subscribersTable)
      .set({
        referralRewarded: true,
        creditCents: sql`${subscribersTable.creditCents} + ${REFERRAL_BONUS_CENTS}`,
      })
      .where(
        and(
          eq(subscribersTable.chatId, chatId),
          eq(subscribersTable.referralRewarded, false),
        ),
      )
      .returning({ chatId: subscribersTable.chatId });
    if (flipped.length === 0) {
      return { paidReferred: false, paidReferrer: false, cents: 0 };
    }
    const ownerUpd = await tx
      .update(subscribersTable)
      .set({
        creditCents: sql`${subscribersTable.creditCents} + ${REFERRAL_BONUS_CENTS}`,
      })
      .where(eq(subscribersTable.referralCode, sub.referredBy))
      .returning({ chatId: subscribersTable.chatId });
    return {
      paidReferred: true,
      paidReferrer: ownerUpd.length > 0,
      cents: REFERRAL_BONUS_CENTS,
    };
  });
}

// ---- Bundle helpers -----------------------------------------------------
export async function createBundle(data: InsertBundle): Promise<Bundle> {
  const [row] = await db.insert(bundlesTable).values(data).returning();
  return row;
}

export async function addBundleItem(data: InsertBundleItem): Promise<void> {
  await db.insert(bundleItemsTable).values(data);
}

export async function deleteBundle(id: number): Promise<void> {
  // Items cascade via FK if defined, otherwise this leaves orphaned rows
  // — which is harmless because listBundlesActive filters by bundles.active.
  await db.delete(bundleItemsTable).where(eq(bundleItemsTable.bundleId, id));
  await db.delete(bundlesTable).where(eq(bundlesTable.id, id));
}

export async function listBundlesActive(): Promise<Bundle[]> {
  return db
    .select()
    .from(bundlesTable)
    .where(eq(bundlesTable.active, true))
    .orderBy(asc(bundlesTable.position), asc(bundlesTable.id));
}

export async function getBundleItems(bundleId: number): Promise<BundleItem[]> {
  return db
    .select()
    .from(bundleItemsTable)
    .where(eq(bundleItemsTable.bundleId, bundleId))
    .orderBy(asc(bundleItemsTable.id));
}

export async function getCartBundle(chatId: string): Promise<CartBundle | undefined> {
  const rows = await db
    .select()
    .from(cartBundlesTable)
    .where(eq(cartBundlesTable.chatId, chatId));
  return rows[0];
}

export async function clearCartBundle(chatId: string): Promise<void> {
  await db.delete(cartBundlesTable).where(eq(cartBundlesTable.chatId, chatId));
}

// After any per-item cart mutation (inc/dec/rm), verify that every item
// required by the attached bundle is still present in sufficient quantity.
// If any requirement is unmet, drop the bundle snapshot so the discount
// cannot survive into checkout without the qualifying items.
export async function revalidateCartBundle(chatId: string): Promise<void> {
  const bundleRow = (
    await db
      .select()
      .from(cartBundlesTable)
      .where(eq(cartBundlesTable.chatId, chatId))
      .limit(1)
  )[0];
  if (!bundleRow) return;

  const items = await db
    .select()
    .from(bundleItemsTable)
    .where(eq(bundleItemsTable.bundleId, bundleRow.bundleId));

  for (const it of items) {
    const variantRows = await db
      .select({ id: productVariantsTable.id })
      .from(productVariantsTable)
      .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
      .where(
        and(
          eq(productsTable.name, it.productName),
          eq(productVariantsTable.label, it.variantLabel),
        ),
      )
      .limit(1);
    const variantId = variantRows[0]?.id;
    if (!variantId) {
      await db.delete(cartBundlesTable).where(eq(cartBundlesTable.chatId, chatId));
      return;
    }
    const cartRows = await db
      .select({ quantity: cartItemsTable.quantity })
      .from(cartItemsTable)
      .where(and(eq(cartItemsTable.chatId, chatId), eq(cartItemsTable.variantId, variantId)))
      .limit(1);
    const qty = cartRows[0]?.quantity ?? 0;
    if (qty < it.quantity) {
      await db.delete(cartBundlesTable).where(eq(cartBundlesTable.chatId, chatId));
      return;
    }
  }
}

// Apply a bundle to a cart. Resolves every bundle item to a current active,
// in-stock variant inside a tx; aborts cleanly if anything's missing/sold
// out. Snapshots the discount on cart_bundles so a mid-cart admin edit to
// the bundle definition can't change the price the customer was shown.
// Replaces any existing bundle on the cart (one-bundle-per-cart limit).
export async function applyCartBundle(
  chatId: string,
  bundleId: number,
): Promise<{ ok: true; discountCents: number } | { ok: false; reason: string }> {
  return db.transaction(async (tx) => {
    const [b] = await tx
      .select()
      .from(bundlesTable)
      .where(and(eq(bundlesTable.id, bundleId), eq(bundlesTable.active, true)));
    if (!b) return { ok: false as const, reason: "Bundle no longer available." };
    const items = await tx
      .select()
      .from(bundleItemsTable)
      .where(eq(bundleItemsTable.bundleId, bundleId));
    if (items.length === 0) return { ok: false as const, reason: "Bundle is empty." };

    const resolved: { variantId: number; quantity: number; lineCents: number }[] = [];
    for (const it of items) {
      const rows = await tx
        .select({
          id: productVariantsTable.id,
          priceCents: productVariantsTable.priceCents,
          stock: productVariantsTable.stock,
        })
        .from(productVariantsTable)
        .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
        .where(
          and(
            eq(productsTable.name, it.productName),
            eq(productVariantsTable.label, it.variantLabel),
            eq(productsTable.available, true),
          ),
        )
        .limit(1);
      const v = rows[0];
      if (!v || v.stock === "sold_out") {
        return {
          ok: false as const,
          reason: `"${it.productName} ${it.variantLabel}" is unavailable right now.`,
        };
      }
      resolved.push({
        variantId: v.id,
        quantity: it.quantity,
        lineCents: v.priceCents * it.quantity,
      });
    }
    const sumCents = resolved.reduce((s, r) => s + r.lineCents, 0);
    const discountCents = Math.max(0, sumCents - b.priceCents);

    // Bundle-swap fix: if a different bundle is already attached to this
    // cart, remove the OLD bundle's items first so the customer doesn't end
    // up paying for both bundles' worth of items at full price (only the
    // new bundle's discount snapshot applies). Items added outside any
    // bundle stay — we only subtract what the prior bundle contributed.
    const prior = await tx
      .select()
      .from(cartBundlesTable)
      .where(eq(cartBundlesTable.chatId, chatId))
      .limit(1);
    if (prior[0] && prior[0].bundleId !== bundleId) {
      const priorItems = await tx
        .select()
        .from(bundleItemsTable)
        .where(eq(bundleItemsTable.bundleId, prior[0].bundleId));
      for (const pit of priorItems) {
        // Resolve the prior item to its current variantId (snapshot semantics).
        const rows = await tx
          .select({ id: productVariantsTable.id })
          .from(productVariantsTable)
          .innerJoin(productsTable, eq(productVariantsTable.productId, productsTable.id))
          .where(
            and(
              eq(productsTable.name, pit.productName),
              eq(productVariantsTable.label, pit.variantLabel),
            ),
          )
          .limit(1);
        const vid = rows[0]?.id;
        if (!vid) continue;
        // Decrement by the prior bundle's qty; if that takes the line to 0
        // or below, drop it. Anything the customer manually added on top
        // is preserved (they only lose the bundle's contribution).
        const existing = await tx
          .select({ quantity: cartItemsTable.quantity })
          .from(cartItemsTable)
          .where(and(eq(cartItemsTable.chatId, chatId), eq(cartItemsTable.variantId, vid)))
          .limit(1);
        const curQty = existing[0]?.quantity ?? 0;
        const newQty = curQty - pit.quantity;
        if (newQty <= 0) {
          await tx
            .delete(cartItemsTable)
            .where(and(eq(cartItemsTable.chatId, chatId), eq(cartItemsTable.variantId, vid)));
        } else {
          await tx
            .update(cartItemsTable)
            .set({ quantity: newQty })
            .where(and(eq(cartItemsTable.chatId, chatId), eq(cartItemsTable.variantId, vid)));
        }
      }
    }

    for (const r of resolved) {
      await tx
        .insert(cartItemsTable)
        .values({ chatId, variantId: r.variantId, quantity: r.quantity })
        .onConflictDoUpdate({
          target: [cartItemsTable.chatId, cartItemsTable.variantId],
          set: {
            quantity: sql`LEAST(${cartItemsTable.quantity} + ${r.quantity}, 99)`,
          },
        });
    }
    await tx
      .insert(cartBundlesTable)
      .values({ chatId, bundleId, label: b.label, discountCents })
      .onConflictDoUpdate({
        target: cartBundlesTable.chatId,
        set: { bundleId, label: b.label, discountCents, appliedAt: new Date() },
      });

    return { ok: true as const, discountCents };
  });
}

// ---- Newcomer cooldown ---------------------------------------------------
// Brand-new customer (joined < 1h ago) AND already has a pending order =>
// don't let them stack a second order. Caller (finalizeOrder) shows a
// friendly "we're processing your first one" message.
const NEWCOMER_COOLDOWN_MS = 60 * 60 * 1000;
export async function isNewcomerWithPending(chatId: string): Promise<boolean> {
  const sub = await getSubscriber(chatId);
  if (!sub) return false;
  const ageMs = Date.now() - sub.joinedAt.getTime();
  if (ageMs > NEWCOMER_COOLDOWN_MS) return false;
  const pending = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(and(eq(ordersTable.chatId, chatId), eq(ordersTable.status, "pending")))
    .limit(1);
  return pending.length > 0;
}

// ===========================================================================
// Flash Drops
// ---------------------------------------------------------------------------
// Limited-stock, time-boxed scarcity events. Admin broadcasts a drop; every
// "🟢 Grab one" tap atomically decrements qty_remaining. The atomic SQL
// UPDATE guarantees that two simultaneous taps on the last unit cannot both
// succeed — the second tap returns no row and shows "just sold out".
// ===========================================================================
export async function createDrop(params: {
  variantId: number;
  qtyTotal: number;
  copy: string;
  photoFileId: string | null;
  createdBy: string;
}): Promise<Drop> {
  if (!Number.isInteger(params.qtyTotal) || params.qtyTotal < 1 || params.qtyTotal > 9999) {
    throw new Error(`createDrop: invalid qtyTotal ${params.qtyTotal}`);
  }
  const [row] = await db
    .insert(dropsTable)
    .values({
      variantId: params.variantId,
      qtyTotal: params.qtyTotal,
      qtyRemaining: params.qtyTotal,
      copy: params.copy,
      photoFileId: params.photoFileId,
      createdBy: params.createdBy,
      status: "active",
    })
    .returning();
  return row;
}

export async function getDrop(id: number): Promise<Drop | undefined> {
  const rows = await db.select().from(dropsTable).where(eq(dropsTable.id, id));
  return rows[0];
}

export async function listActiveDrops(): Promise<Drop[]> {
  return db
    .select()
    .from(dropsTable)
    .where(eq(dropsTable.status, "active"))
    .orderBy(desc(dropsTable.id));
}

// Atomic single-unit claim. Returns the new remaining count on success, or
// null if the drop was sold out / cancelled (= the tap lost the race).
// Critical: this is the ONLY place qty_remaining decreases.
export async function tryClaimDropUnit(
  id: number,
): Promise<{ remaining: number; exhausted: boolean } | null> {
  const rows = await db
    .update(dropsTable)
    .set({
      qtyRemaining: sql`${dropsTable.qtyRemaining} - 1`,
      status: sql`CASE WHEN ${dropsTable.qtyRemaining} - 1 <= 0 THEN 'exhausted' ELSE 'active' END`,
      exhaustedAt: sql`CASE WHEN ${dropsTable.qtyRemaining} - 1 <= 0 THEN NOW() ELSE ${dropsTable.exhaustedAt} END`,
    })
    .where(
      and(
        eq(dropsTable.id, id),
        eq(dropsTable.status, "active"),
        gt(dropsTable.qtyRemaining, 0),
      ),
    )
    .returning({ qtyRemaining: dropsTable.qtyRemaining });
  if (rows.length === 0) return null;
  const remaining = rows[0].qtyRemaining;
  return { remaining, exhausted: remaining <= 0 };
}

export async function cancelDrop(id: number): Promise<boolean> {
  const rows = await db
    .update(dropsTable)
    .set({ status: "cancelled" })
    .where(and(eq(dropsTable.id, id), eq(dropsTable.status, "active")))
    .returning({ id: dropsTable.id });
  return rows.length > 0;
}
