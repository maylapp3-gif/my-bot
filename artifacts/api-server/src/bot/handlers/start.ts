import TelegramBot from "node-telegram-bot-api";
import { addSubscriber, needsVerification, isBlocked } from "../db.js";
import { logger } from "../../lib/logger.js";
import { tryAttachReferral } from "./referral.js";
import { sendVerifyGate } from "./verify.js";
import { sendCustomerWelcome } from "./welcome.js";

// Single message: welcome text + persistent reply keyboard, all in one shot.
// (Earlier behaviour split into two messages on some clients — fixed.)
export async function handleStart(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();

  // Blocklist choke point — a blocked account must never re-register via
  // /start (this is what closes the loop after purgeSubscriber deletes the
  // row). Silent drop. Fail open only on a DB error so a transient blip can't
  // lock out genuine new signups.
  try {
    if (await isBlocked(chatId)) {
      logger.info({ chatId }, "Ignoring /start from blocked chat");
      return;
    }
  } catch (err) {
    logger.error({ err, chatId }, "start blocklist check failed");
  }

  // The subscriber row MUST exist before we decide whether to gate — a brand-
  // new insert is what stamps verified=false. If the upsert fails we cannot
  // trust the gate state, so fail closed: show the neutral gate, never the
  // menu/welcome.
  try {
    await addSubscriber({
      chatId,
      username: msg.from?.username,
      firstName: msg.from?.first_name,
      lastName: msg.from?.last_name,
      active: true,
    });
  } catch (err) {
    logger.error({ err, chatId }, "Failed to add subscriber — failing closed to gate");
    // Fail closed, but only in a private customer DM — never drop a gate into
    // a group where /start might have been typed.
    if (msg.chat.type === "private") return await sendVerifyGate(bot, chatId);
    return;
  }

  // Deep-link referral: /start <code>. Must run AFTER addSubscriber so the
  // subscriber row exists. tryAttachReferral handles all the guards (brand-
  // new only, not self-referral, code must exist).
  const argMatch = (msg.text ?? "").match(/^\/start(?:@\w+)?\s+(\S+)/);
  if (argMatch) {
    try {
      await tryAttachReferral(chatId, argMatch[1]);
    } catch (err) {
      logger.error({ err }, "tryAttachReferral failed");
    }
  }

  // Verification gate for brand-new customers — private DMs only. Existing
  // customers read NULL and skip straight to the welcome; only an explicit
  // verified=false stops here and sees the one-tap gate instead.
  if (msg.chat.type === "private") {
    try {
      if (await needsVerification(chatId)) {
        return await sendVerifyGate(bot, chatId);
      }
    } catch (err) {
      // Fail-closed: if the gate check errors, show the gate rather than
      // exposing the menu to an unverified account.
      logger.error({ err, chatId }, "verification gate check failed — showing gate");
      return await sendVerifyGate(bot, chatId);
    }
  }

  return await sendCustomerWelcome(bot, chatId, msg.from?.first_name);
}
