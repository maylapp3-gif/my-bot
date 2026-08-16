import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Accounts a moderator/admin has blocked via the suspicious-account flag.
// This table survives purgeSubscriber (which deletes the subscriber row), so a
// blocked person can't simply /start again and re-register.
//
// Forensic minimization: store the bare minimum. `reason` is an enum CODE
// (e.g. "suspicious_unverified"), never free-text or customer message content.
// No names, no usernames, no message bodies live here.
export const blockedCustomersTable = pgTable("blocked_customers", {
  chatId: text("chat_id").primaryKey(),
  reason: text("reason"),
  blockedBy: text("blocked_by"),
  blockedAt: timestamp("blocked_at").defaultNow().notNull(),
});

export const insertBlockedCustomerSchema = createInsertSchema(blockedCustomersTable).omit({ blockedAt: true });
export type InsertBlockedCustomer = z.infer<typeof insertBlockedCustomerSchema>;
export type BlockedCustomer = typeof blockedCustomersTable.$inferSelect;
