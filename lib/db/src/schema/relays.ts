import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const relaysTable = pgTable("relays", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull().unique(),
  username: text("username"),
  label: text("label").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRelaySchema = createInsertSchema(relaysTable).omit({ id: true, createdAt: true });
export type InsertRelay = z.infer<typeof insertRelaySchema>;
export type Relay = typeof relaysTable.$inferSelect;
