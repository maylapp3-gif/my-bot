import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

// One row per moderator chat ID. `away=true` means they're driving / can't
// answer; the bot will instantly auto-respond to inbound customer messages
// when ALL configured moderators are away (instead of waiting 5 min for AI).
export const modStatusTable = pgTable("mod_status", {
  chatId: text("chat_id").primaryKey(),
  away: boolean("away").notNull().default(false),
  awayMessage: text("away_message"),
  awayUntil: timestamp("away_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ModStatus = typeof modStatusTable.$inferSelect;
