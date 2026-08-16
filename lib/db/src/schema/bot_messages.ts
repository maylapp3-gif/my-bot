import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botMessagesTable = pgTable("bot_messages", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  messageId: integer("message_id").notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});

export const insertBotMessageSchema = createInsertSchema(botMessagesTable).omit({ id: true, sentAt: true });
export type InsertBotMessage = z.infer<typeof insertBotMessageSchema>;
export type BotMessage = typeof botMessagesTable.$inferSelect;
