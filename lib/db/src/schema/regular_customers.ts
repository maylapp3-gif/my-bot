import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Customers granted a "regular" pricing tier by an admin via /add_regular.
// Regulars get an enlarged free-delivery zone (15km vs the default 12km)
// and $10 off every cart at checkout. State lives forever — admin removes
// via /remove_regular.
export const regularCustomersTable = pgTable("regular_customers", {
  chatId: text("chat_id").primaryKey(),
  notes: text("notes"),
  addedBy: text("added_by"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export const insertRegularCustomerSchema = createInsertSchema(regularCustomersTable).omit({ addedAt: true });
export type InsertRegularCustomer = z.infer<typeof insertRegularCustomerSchema>;
export type RegularCustomer = typeof regularCustomersTable.$inferSelect;
