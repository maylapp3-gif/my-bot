import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const cartPromosTable = pgTable("cart_promos", {
  chatId: text("chat_id").primaryKey(),
  code: text("code").notNull(),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
});

export type CartPromo = typeof cartPromosTable.$inferSelect;
