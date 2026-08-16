import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// One row per business day. The admin-set pickup window customers see for
// that day (e.g. "1pm–4pm"). dateKey is "YYYY-MM-DD" in the business
// timezone; start/end are minutes-from-midnight (13:00 → 780). Customer-facing
// text is ALWAYS rendered from these numbers — raw admin input is never
// echoed. Rows for past days are pruned by the daily cleanup (data
// minimization); unset simply means "time TBC", it never blocks pickup.
export const pickupWindowsTable = pgTable("pickup_windows", {
  dateKey: text("date_key").primaryKey(),
  startMinutes: integer("start_minutes").notNull(),
  endMinutes: integer("end_minutes").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PickupWindow = typeof pickupWindowsTable.$inferSelect;
