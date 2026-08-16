import { pgTable, text, serial, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Pre-set combos. Bundle has a fixed price (priceCents) and a list of items
// (bundle_items). When a customer taps "Add bundle", every item is added to
// the cart at its current variant price, but the cart shows a separate
// "Bundle: <label> -$X" discount line so the customer pays the bundle price.
export const bundlesTable = pgTable("bundles", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  priceCents: integer("price_cents").notNull(),
  active: boolean("active").notNull().default(true),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBundleSchema = createInsertSchema(bundlesTable).omit({ id: true, createdAt: true });
export type InsertBundle = z.infer<typeof insertBundleSchema>;
export type Bundle = typeof bundlesTable.$inferSelect;
