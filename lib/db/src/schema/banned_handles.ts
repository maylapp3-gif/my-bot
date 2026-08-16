import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// LeafedOut handles that are barred from verifying ANY Telegram account.
//
// Why this exists: the blocklist (`blocked_customers`) is keyed on the Telegram
// chat_id, which a banned person trivially escapes by making a new Telegram
// account. The one durable identity the bot actually PROVES is the LeafedOut
// profile (the customer posts a one-time code on it). Binding bans to that
// profile means a blocked person can't return on a fresh Telegram account while
// re-using the same LeafedOut profile.
//
// Forensic minimization: we store a one-way SHA-256 HASH of the canonical
// (lowercased, normalized) handle — never the plaintext handle. It can be
// matched against a re-verification attempt but can't be read back into a
// customer identity. `reason` is a short enum code, never free text or message
// content. No chat ids, names, or message bodies live here.
export const bannedHandlesTable = pgTable("banned_handles", {
  handleHash: text("handle_hash").primaryKey(),
  reason: text("reason"),
  bannedBy: text("banned_by"),
  bannedAt: timestamp("banned_at").defaultNow().notNull(),
});

export const insertBannedHandleSchema = createInsertSchema(bannedHandlesTable).omit({ bannedAt: true });
export type InsertBannedHandle = z.infer<typeof insertBannedHandleSchema>;
export type BannedHandle = typeof bannedHandlesTable.$inferSelect;
