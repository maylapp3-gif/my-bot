import { pgTable, text, serial, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  price: text("price").notNull(),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  emoji: text("emoji"),
  available: boolean("available").notNull().default(true),
  // Pre-order flag. When true, the menu card shows a 🕒 PRE-ORDER badge,
  // the mod fanout calls out a "confirm drop date" line, and the
  // customer's order receipt notes the drop date is TBC. The product is
  // still added to the cart and the order is placed immediately — the
  // mod confirms a date via the existing DM flow.
  preorder: boolean("preorder").notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProductSchema = createInsertSchema(productsTable).omit({ id: true, createdAt: true });
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;
