import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { productVariantsTable } from "./product_variants";

export const dropsTable = pgTable("drops", {
  id: serial("id").primaryKey(),
  variantId: integer("variant_id")
    .notNull()
    .references(() => productVariantsTable.id, { onDelete: "cascade" }),
  qtyTotal: integer("qty_total").notNull(),
  qtyRemaining: integer("qty_remaining").notNull(),
  copy: text("copy").notNull().default(""),
  photoFileId: text("photo_file_id"),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  exhaustedAt: timestamp("exhausted_at"),
});

export const insertDropSchema = createInsertSchema(dropsTable).omit({ id: true, createdAt: true });
export type InsertDrop = z.infer<typeof insertDropSchema>;
export type Drop = typeof dropsTable.$inferSelect;
