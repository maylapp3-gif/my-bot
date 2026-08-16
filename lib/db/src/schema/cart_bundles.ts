import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// One bundle per cart (chatId is PK). Snapshots `label` and `discountCents`
// at apply-time so a mid-checkout admin edit to the bundle doesn't change
// the price the customer confirmed. Cleared atomically with cart_items in
// createOrderFromCart's tx.
export const cartBundlesTable = pgTable("cart_bundles", {
  chatId: text("chat_id").primaryKey(),
  bundleId: integer("bundle_id").notNull(),
  label: text("label").notNull(),
  discountCents: integer("discount_cents").notNull(),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
});

export type CartBundle = typeof cartBundlesTable.$inferSelect;
