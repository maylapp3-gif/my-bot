import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A raffle is admin-managed config (like promo_codes) — NOT customer-traceable
// data, so it may persist. Customers join by sending the `code`; the admin sets
// the free-text `prize` (varies per raffle) and triggers the draw manually.
//
// A raffle is a HARD 24h event: it is only joinable/drawable within 24h of
// `createdAt`. This is deliberate — entrant rows (raffle_entries) can never
// outlive the 24h retention window, so the raffle itself is scoped to match.
// "Everyone who entered is in the draw" stays literally true, and it needs no
// scheduler (expiry is computed from createdAt). Announce and draw same day.
export const rafflesTable = pgTable("raffles", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  // Free-form, admin-authored. NEVER auto-echoed to customers (may contain
  // product/vertical words on the forbidden list). Shown to admins only.
  prize: text("prize").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRaffleSchema = createInsertSchema(rafflesTable).omit({ id: true, createdAt: true });
export type InsertRaffle = z.infer<typeof insertRaffleSchema>;
export type Raffle = typeof rafflesTable.$inferSelect;
