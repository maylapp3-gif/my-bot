import { pgTable, text, serial, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// A single customer's entry into a raffle. This IS customer-traceable data, so
// it is EPHEMERAL: purged (a) the instant a raffle is drawn, (b) when a raffle
// is deleted, and (c) by the hourly 24h retention sweep — same contract as
// orders/carts. The unique (raffle_code, chat_id) index makes re-entry a no-op
// (onConflictDoNothing), so a customer can spam the code without stacking odds.
//
// Entries start PENDING: an admin manually Approves (or Rejects) each one via
// inline buttons before it counts. Only approved entries make the draw —
// fail-closed: a pending entry that never gets looked at is never drawn.
// Rejected entries are KEPT (status flip, not delete) so the unique index
// still dedupes — a rejected customer re-sending the code can't re-ping the
// team. Rejected rows die with everything else: on draw, on delete, and on
// the 24h sweep — never later.
//
// No FK to raffles: deletion is handled explicitly in a transaction (see
// deleteRaffle / drawRaffle in bot/db.ts), matching the house style of
// cross-table purges. raffle_code is a plain string join key.
export const raffleEntriesTable = pgTable(
  "raffle_entries",
  {
    id: serial("id").primaryKey(),
    raffleCode: text("raffle_code").notNull(),
    chatId: text("chat_id").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    raffleChatUniq: uniqueIndex("raffle_entries_code_chat_uniq").on(t.raffleCode, t.chatId),
  }),
);

export type RaffleEntry = typeof raffleEntriesTable.$inferSelect;
