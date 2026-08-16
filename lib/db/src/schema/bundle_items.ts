import { pgTable, text, serial, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bundlesTable } from "./bundles";

// Snapshot semantics like order_items — store productName + variantLabel
// (not IDs) so renames/deletes don't silently change a bundle. The customer
// add-bundle flow resolves these labels to current active variants at tap-time.
export const bundleItemsTable = pgTable("bundle_items", {
  id: serial("id").primaryKey(),
  bundleId: integer("bundle_id")
    .notNull()
    .references(() => bundlesTable.id, { onDelete: "cascade" }),
  productName: text("product_name").notNull(),
  variantLabel: text("variant_label").notNull(),
  quantity: integer("quantity").notNull().default(1),
});

export const insertBundleItemSchema = createInsertSchema(bundleItemsTable).omit({ id: true });
export type InsertBundleItem = z.infer<typeof insertBundleItemSchema>;
export type BundleItem = typeof bundleItemsTable.$inferSelect;
