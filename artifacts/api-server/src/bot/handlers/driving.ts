import TelegramBot from "node-telegram-bot-api";
import { setModStatus, getModStatus } from "../db.js";
import { isModerator } from "../moderation.js";
import { logger } from "../../lib/logger.js";
import { escapeMarkdown } from "../escape.js";
import { isOpenNow, closedPhase, openHourHumanToday, nextOpenHuman } from "../hours.js";

// Two pools of default replies the USERBOT sends from a moderator's personal
// account when a customer DMs them and the mod hasn't replied within the
// grace window. The userbot is ALWAYS armed — there's no on/off toggle.
//
// IMPORTANT: this account runs in a low-profile / privacy-locked posture.
// Replies MUST NOT name, link, or hint at the public bot account or any
// other team handle. Every line below is intentionally generic — just
// "I'm tied up, back shortly, leave the message". The mod handles any
// cross-surface turnaround manually so the two accounts stay unlinked.
//
// Lines are varied so the same customer doesn't see identical canned text
// twice and clock it as an auto-reply. Brand voice: short, lower-case-
// leaning, polite, no exclamation marks, no emojis, no @-mentions.
//
// Three pools, picked at fire-time based on opening hours:
//   • OPEN       → "tied up right now, back shortly today"
//   • PRE_OPEN   → "not on yet, back at <open> today" (closed but opening later today)
//   • POST_CLOSE → "off for the night, back at <open> tomorrow"
//
// The PRE_OPEN split is critical: customers messaging an hour before open
// were previously being told "off for the night, see you tomorrow at 2pm"
// even though we open in 60 minutes. That kills the sale.
export const DEFAULT_AWAY_MESSAGES_OPEN: readonly string[] = [
  `Hands full right now — back to you in a bit. Leave the message and I'll come straight back to it.`,
  `On the move, can't reply properly. Drop the message here and I'll come back as soon as I'm free.`,
  `Caught up at the moment. Leave whatever you need and I'll get back to you shortly.`,
  `Bit tied up — give me a sec. Drop the message and I'll come back the moment I'm free.`,
  `Mid something right now. Leave the message here and I'll get to you shortly.`,
  `Can't get to my phone properly right now. Leave the message and I'll handle it as soon as I'm back.`,
  `On a job, back shortly. Drop whatever you need here and I'll see it when I'm free.`,
  `One sec, mid something. Leave the message and I'll come straight back to you.`,
  `Out of pocket for a few. Leave the message and I'll come back the moment I can.`,
  `Driving, can't type properly. Leave the message and I'll get to it the moment I'm parked.`,
  `Phone's away from me right now. Leave the message and I'll come back to you shortly.`,
  `Sorting something out, back shortly. Drop the message and I'll see it when I'm free.`,
  `If you've already placed an order, forward me the confirmation when you have a sec and I'll lock it in as soon as I'm back.`,
];

// Hours vary by weekday, so the pre-open / post-close pools are built at
// fire time with the right opening hour ("openHuman"). Pre-open uses TODAY's
// open; post-close uses the NEXT day's open (they can differ — e.g. a Sat
// night DM must say "back at 12pm" because Sunday opens at 12pm).
export function preOpenAwayMessages(openHuman: string): readonly string[] {
  return [
    `Not on yet — back at ${openHuman} today. Leave the message and I'll get straight onto it.`,
    `Won't be on 'til ${openHuman}. Drop whatever you need and I'll come back to it the moment I'm on.`,
    `Few hours off still — on at ${openHuman} today. Leave the message and I'll handle it as soon as I'm back.`,
    `Off the clock 'til ${openHuman}. Drop the message here and I'll see it the second I'm on.`,
    `Not on shift yet — back at ${openHuman}. Leave the message and I'll come straight back to it.`,
    `On in a bit (${openHuman}). Drop the message and I'll get to it the moment I'm free.`,
    `Phone's away 'til ${openHuman}. Leave whatever you need and I'll come straight back.`,
    `Not on the clock yet — back at ${openHuman} today. Drop the message and I'll handle it first thing.`,
    `Quiet until ${openHuman}. Leave the message here and I'll come back the moment I'm on.`,
    `Few hours off — back on at ${openHuman}. Drop the message and I'll get straight back to it.`,
    `If you've already placed an order, forward me the confirmation and I'll lock it in the moment I'm on at ${openHuman} today.`,
  ];
}

export function postCloseAwayMessages(openHuman: string): readonly string[] {
  return [
    `Off for the night — back on at ${openHuman}. Leave the message and I'll handle it first thing.`,
    `Phone's down 'til the morning. Drop the message here and I'll come back to it at ${openHuman}.`,
    `Day's done on this end. Leave whatever you need and I'll get to it first thing at ${openHuman}.`,
    `Off the clock for the night. Drop the message and I'll come back to it when I'm on at ${openHuman}.`,
    `Closed for the night. Leave the message here and I'll see it when I'm back at ${openHuman}.`,
    `Off shift. Drop the message and I'll handle it as soon as I'm on tomorrow at ${openHuman}.`,
    `Down for the night — back at ${openHuman}. Leave the message and I'll get straight onto it.`,
    `Wrapped for the day. Drop whatever you need here and I'll come back to it at ${openHuman}.`,
    `Knocked off for the night. Leave the message and I'll come back to it at ${openHuman} open.`,
    `End of shift. Drop the message and I'll come back to it the moment I'm on at ${openHuman}.`,
    `If you've already placed an order, forward me the confirmation and I'll lock it in first thing at ${openHuman}.`,
  ];
}

// Pick a random default reply from the right pool depending on opening hours.
// Used by the userbot at fire-time so the same customer doesn't get the exact
// same wording across multiple DMs, and so an after-hours DM gets converted
// into a queued sale instead of a "we're closed" dead-end.
export function pickDefaultAwayMessage(): string {
  const pool = isOpenNow()
    ? DEFAULT_AWAY_MESSAGES_OPEN
    : (closedPhase() === "pre_open"
        ? preOpenAwayMessages(openHourHumanToday())
        : postCloseAwayMessages(nextOpenHuman()));
  const i = Math.floor(Math.random() * pool.length);
  return pool[i] ?? pool[0]!;
}

// /driving                — show your current custom auto-reply (or default)
// /driving <text>         — set your custom auto-reply text
// /driving reset          — revert to default
//
// The userbot auto-reply is ALWAYS on — this command only changes the wording.
export async function handleDriving(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  rawArgs: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isModerator(chatId)) return;

  const args = rawArgs.trim();

  // No args → show this mod's current auto-reply text
  if (!args) {
    try {
      const s = await getModStatus(chatId);
      const customText = s?.awayMessage?.trim();
      const isCustom = !!customText;
      const todayOpen = openHourHumanToday();
      const nextOpen = nextOpenHuman();
      const openPool = DEFAULT_AWAY_MESSAGES_OPEN.map((m, i) => `${i + 1}. ${escapeMarkdown(m)}`).join("\n\n");
      const preOpenPool = preOpenAwayMessages(todayOpen).map((m, i) => `${i + 1}. ${escapeMarkdown(m)}`).join("\n\n");
      const postClosePool = postCloseAwayMessages(nextOpen).map((m, i) => `${i + 1}. ${escapeMarkdown(m)}`).join("\n\n");
      const nowState = isOpenNow()
        ? "OPEN pool"
        : (closedPhase() === "pre_open" ? "PRE-OPEN pool (opens later today)" : "POST-CLOSE pool (closed for the night)");
      const body = isCustom
        ? `*Your auto-reply* (custom — same text every time, day or night)\n\n${escapeMarkdown(customText!)}`
        : `*Your auto-reply* (default — rotates randomly so it doesn't read like a bot)\n\n` +
          `Right now we're in: *${nowState}*\n\n` +
          `*OPEN pool* (used during open hours — "tied up, back shortly"):\n\n${openPool}\n\n` +
          `*PRE-OPEN pool* (used when we're closed but opening later today — "back at ${todayOpen} today"; the hour tracks each day's schedule):\n\n${preOpenPool}\n\n` +
          `*POST-CLOSE pool* (used after close for the night — "back at ${nextOpen}"; the hour tracks the next day's schedule):\n\n${postClosePool}`;
      await bot.sendMessage(
        chatId,
        `${body}\n\n` +
          "ℹ️ The userbot auto-replies on your behalf if any customer DMs your personal Telegram account and you don't respond within 5 minutes (max one per customer per hour).\n\n" +
          "Change it:\n`/driving <your message>` — set one fixed line\n`/driving reset` — back to the rotating default pool",
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      logger.error({ err }, "/driving status error");
    }
    return;
  }

  // /driving reset → clear custom message
  if (args.toLowerCase() === "reset") {
    await setModStatus(chatId, true, null, null);
    await bot.sendMessage(chatId, "✅ Auto-reply reverted to the default.");
    return;
  }

  // Anything else → set as custom message. Hard privacy filter: the
  // userbot account runs in a low-profile posture and must NOT name or
  // link any other Telegram surface (the public bot, the team handle,
  // any t.me URL). Reject the save if the mod tries to put one in.
  // Same regex as aiAutoReply.ts looksUsable() so AI and custom paths
  // share one definition of "leaks the account separation".
  const FORBIDDEN = /@[a-z0-9_]{3,}|t\.me\/|telegram\.me\//i;
  if (FORBIDDEN.test(args)) {
    await bot.sendMessage(
      chatId,
      "❌ Can't save that — the auto-reply must not contain any Telegram @handle or t.me link. The userbot account stays unlinked from the bot account on purpose; cross-surface turnaround is manual. Try again without the @-mention or link.",
    );
    return;
  }
  await setModStatus(chatId, true, args, null);
  await bot.sendMessage(
    chatId,
    "✅ Custom auto-reply saved. The userbot will use this if you don't reply to a customer within 5 minutes.",
  );
}
