import { pgTable, text, timestamp, integer, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const orderStatusEnum = pgEnum("order_status", ["pending", "confirmed", "in_progress", "completed", "cancelled"]);

// `id` is assigned by the application as a random 4-digit number (1000-9999).
// We deliberately do NOT use a serial/sequence — the application picks the
// value with collision-retry on insert. See `generateRandomOrderId` in
// artifacts/api-server/src/bot/db.ts.
export const ordersTable = pgTable("orders", {
  id: integer("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  customerName: text("customer_name").notNull(),
  customerUsername: text("customer_username"),
  // `items` is a human-readable summary line ("3.5g Blue Dream × 1 · 1g OG × 2").
  // The structured snapshot lives in `order_items` (joined by orderId).
  items: text("items").notNull(),
  deliveryArea: text("delivery_area"),
  preferredTime: text("preferred_time"),
  notes: text("notes"),
  // Money — nullable so legacy orders (pre-cart) survive the migration.
  subtotalCents: integer("subtotal_cents"),
  discountCents: integer("discount_cents"),
  // Delivery fee snapshot at order time. NULL = "unknown" (geocode failed —
  // mod will confirm at the meet). 0 = pickup or in-zone free delivery.
  deliveryFeeCents: integer("delivery_fee_cents"),
  // $10-off snapshot for regular customers at order time. NULL on legacy
  // orders, 0 for non-regulars, positive for regulars (capped at subtotal).
  regularDiscountCents: integer("regular_discount_cents"),
  // One-time new-customer 50%-off snapshot at order time. NULL/0 for orders
  // without it. >0 marks THE order that consumed the customer's intro offer —
  // the cancel/undo paths use this to refund/re-consume the flag.
  introDiscountCents: integer("intro_discount_cents"),
  totalCents: integer("total_cents"),
  promoCode: text("promo_code"),
  status: orderStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Customer-facing "fell-through" follow-up marker. Set when this order has
  // already received its single automatic "still open?" nudge — guarantees at
  // most one follow-up per order and survives a restart (unlike in-memory
  // dedupe). Nullable; lives and is purged with the order (≤24h), so it adds
  // no new long-lived customer-traceable data. See followUpReminder.ts.
  followUpSentAt: timestamp("follow_up_sent_at"),
  // Neighbour-grouping opt-in (delivery only). TRUE = customer consented to
  // having their drop batched with another nearby order so the team can waive
  // the delivery fee on a grouped run. Fail-closed default false. Purged with
  // the order (<=24h) — adds no new long-lived customer data. INVARIANT: the
  // customer is NEVER told whether a pairing actually happened; that signal,
  // correlated with their typed area, would leak another nearby customer's
  // existence/location. Outcome is verbal at the meet only.
  groupOptin: boolean("group_optin").notNull().default(false),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
