import TelegramBot from "node-telegram-bot-api";
import { openProductBrowser } from "./customerMenu.js";

// /products command — same Manybot-style card stream as the Menu button.
// Single source of truth lives in customerMenu.openProductBrowser so /products
// and the persistent Menu button can never drift apart.
export async function handleProducts(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  await openProductBrowser(bot, chatId);
}
