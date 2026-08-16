import TelegramBot from "node-telegram-bot-api";
import { weeklyScheduleLine } from "../hours.js";
import { pickupWindowLineForToday } from "./pickup.js";

export async function handleContact(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  const pickupLine = await pickupWindowLineForToday();

  return bot.sendMessage(
    chatId,
    `*Contact*\n\n` +
    `Direct line. Write here and someone from the team will hit you back — usually within minutes during open hours.\n\n` +
    `If we're slow, our AI jumps in so you're not left hanging.\n\n` +
    `*Build an order* — tap Menu, then sizes, then 🛒 Cart\n` +
    `*Menu* — /products\n` +
    `*Cart* — /cart\n` +
    `*How it works* — /howitworks\n` +
    `*Rules* — /legal\n\n` +
    `_cash · in person · 18+_\n` +
    `🕑 ${weeklyScheduleLine()}` +
    (pickupLine ? `\n🤝 _Extra pickup times today: ${pickupLine}_` : ""),
    { parse_mode: "Markdown" }
  );
}

export async function handleLegal(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();

  return bot.sendMessage(
    chatId,
    `*The Rules*\n_The basics — quick read._\n\n` +
    `*1.* 18+. By ordering you confirm you meet this.\n\n` +
    `*2.* Not for those who are pregnant or breastfeeding.\n\n` +
    `*3.* You're responsible for your own legal compliance — by using this service you confirm doing so is lawful for you in your jurisdiction.\n\n` +
    `*4.* Private use only. Not for public consumption.\n\n` +
    `*5.* Not to be re-sold, redistributed, or carried across borders.\n\n` +
    `*6.* We don't give medical advice — see a doctor for anything health-related.\n\n` +
    `*Pay* — cash on arrival.\n` +
    `*Meet* — in person only. No post, shipping, or third-party couriers.\n` +
    `🔒 *Privacy* — every message in this chat wipes after 24h. Your details stay with us.\n\n` +
    `_We can decline an order at our discretion._\n\n` +
    `_By using this service you accept the above._`,
    { parse_mode: "Markdown" }
  );
}

export async function handleHowItWorks(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();

  return bot.sendMessage(
    chatId,
    `*How it works*\n\n` +
    `*1. Browse* — tap Menu, see what's on.\n` +
    `*2. Build cart* — tap a size on any item to drop it in. Repeat for as many as you want.\n` +
    `*3. Send order* — open 🛒 Cart, apply a promo code if you've got one, hit Send Order.\n` +
    `   4 quick taps: delivery or pickup, where, when, any notes.\n` +
    `*4. Confirm* — team pulls up to confirm the meet.\n` +
    `*5. Meet* — we come to you, or you swing by us. Face to face either way.\n` +
    `*6. Pay* — cash on arrival.\n\n` +
    `_cash only_  —  no cards, no transfers, no crypto.\n` +
    `_in person_  —  no post, no shipping, no third party.\n` +
    `🔒 _every message wipes after 24h._\n\n` +
    `🕑 ${weeklyScheduleLine()}\n\n` +
    `_Anything else, just ask._`,
    { parse_mode: "Markdown" }
  );
}
