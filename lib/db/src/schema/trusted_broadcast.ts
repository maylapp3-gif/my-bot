import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A separate, hand-curated "trusted" list used ONLY for private broadcasts.
// This is intentionally distinct from `regular_customers` (the pricing tier):
// a customer can be on one list, the other, both, or neither. The operator
// adds/removes members by hand — there is no automatic onboarding. The
// trusted broadcast pushes an operator-typed message to exactly these chat
// IDs and no one else.
export const trustedBroadcastTable = pgTable("trusted_broadcast", {
  chatId: text("chat_id").primaryKey(),
  notes: text("notes"),
  addedBy: text("added_by"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export const insertTrustedBroadcastSchema = createInsertSchema(trustedBroadcastTable).omit({ addedAt: true });
export type InsertTrustedBroadcast = z.infer<typeof insertTrustedBroadcastSchema>;
export type TrustedBroadcastMember = typeof trustedBroadcastTable.$inferSelect;
