import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productsTable } from "./products";

export const productVariantsTable = pgTable("product_variants", {
  id: serial("id").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  priceCents: integer("price_cents").notNull(),
  position: integer("position").notNull().default(0),
  // 'in_stock' (default), 'low' (badge shown to customer), or 'sold_out'
  // (hidden from add buttons; surfaced as "sold out" badge).
  stock: text("stock").notNull().default("in_stock"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProductVariantSchema = createInsertSchema(productVariantsTable).omit({ id: true, createdAt: true });
export type InsertProductVariant = z.infer<typeof insertProductVariantSchema>;
export type ProductVariant = typeof productVariantsTable.$inferSelect;
