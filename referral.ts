import TelegramBot from "node-telegram-bot-api";
import { logger } from "../../lib/logger.js";
import {
  getSubscriber,
  setReferralCode,
  setReferredByIfBrandNew,
  findSubscriberByReferralCode,
  trackMessage,
} from "../db.js";

// $5 each — paid out on the referee's first confirmed order. Constant lives
// alongside the matching one in db.ts (REFERRAL_BONUS_CENTS).
const REFERRAL_BONUS_CENTS = 500;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L for clarity

function makeCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

async function ensureReferralCode(chatId: string): Promise<string> {
  const sub = await getSubscriber(chatId);
  if (sub?.referralCode) return sub.referralCode;
  // Up to 5 retries on collision (uniqueness is enforced in app code; the
  // DB column is non-unique to dodge a destructive backfill at migration time).
  for (let i = 0; i < 5; i++) {
    const code = makeCode();
    const taken = await findSubscriberByReferralCode(code);
    if (taken) continue;
    const ok = await setReferralCode(chatId, code);
    if (ok) return code;
  }
  // Last-resort timestamp-derived code — astronomically unlikely to collide.
  const fallback = "R" + Date.now().toString(36).toUpperCase().slice(-5);
  await setReferralCode(chatId, fallback);
  return fallback;
}

// /referral — show the customer's code + how it works.
export async function handleReferral(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  try {
    const code = await ensureReferralCode(chatId);
    const dollars = (REFERRAL_BONUS_CENTS / 100).toFixed(2);
    const text =
      `*Refer a mate*\n\n` +
      `Your code:  \`${code}\`\n\n` +
      `Share it. When a new customer joins with your code and confirms their first order, ` +
      `you both get *$${dollars}* credit toward your next order — auto-applied at checkout.\n\n` +
      `_To use a code: send_ \`/start ${code}\` _from a fresh bot DM._`;
    const sent = await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    await trackMessage(chatId, sent.message_id);
  } catch (err) {
    logger.error({ err, chatId }, "/referral handler error");
  }
}

// Called by handleStart when /start has a non-empty argument. Silently ignores
// invalid codes / repeat attempts — the welcome message still goes out.
export async function tryAttachReferral(chatId: string, codeRaw: string): Promise<void> {
  const code = (codeRaw ?? "").trim().toUpperCase();
  if (!code || code.length < 4 || code.length > 12) return;
  try {
    const owner = await findSubscriberByReferralCode(code);
    if (!owner || owner.chatId === chatId) return;
    await setReferredByIfBrandNew(chatId, code);
  } catch (err) {
    logger.warn({ err, chatId, code }, "tryAttachReferral failed (non-fatal)");
  }
}
