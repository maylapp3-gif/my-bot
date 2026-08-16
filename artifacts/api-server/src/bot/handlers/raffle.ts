import TelegramBot from "node-telegram-bot-api";
import {
  listRafflesWithCounts,
  createRaffle,
  deleteRaffle,
  findRaffleByCode,
  addRaffleEntry,
  approveRaffleEntry,
  rejectRaffleEntry,
  listPendingRaffleEntries,
  drawRaffle,
  getSubscriber,
  isBlocked,
  trackMessage,
} from "../db.js";
import { isAdmin, getAdminIds } from "./admin.js";
import { escapeMarkdown } from "../escape.js";
import { logger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Raffle — admin-managed, entry-by-code, MANUALLY APPROVED entries.
// See bot/db.ts for the data contract.
//
// Entry flow: customer sends /raffle CODE → entry lands as PENDING → every
// admin gets an Approve/Reject prompt → only an approved entry can be drawn.
// Fail-closed: an entry nobody reviews never makes the draw.
//
// Privacy rules baked in here:
//  - Customers NEVER see entrant counts, other entrants, or the outcome of a
//    raffle they're in beyond their own win. A neutral reply for a bad code.
//  - The admin-authored prize is free text (may contain forbidden words); it is
//    shown to ADMINS ONLY and is never interpolated into any customer message.
//  - Winner + approval/rejection DMs are strictly generic and tracked for the
//    24h self-destruct.
// ---------------------------------------------------------------------------

const MAX_DRAW_WINNERS = 50;

// Track a bot-sent customer message so the 24h chat sweep deletes it. Retention
// is non-negotiable: if tracking fails, delete the message now rather than leave
// an untracked customer-facing message lingering past 24h (fail-closed). Mirrors
// the track-or-delete rule used by followUpReminder / selfDestruct.
async function trackOrDelete(
  bot: TelegramBot,
  chatId: string,
  messageId: number,
  context: string,
): Promise<void> {
  try {
    await trackMessage(chatId, messageId);
  } catch (trackErr) {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (delErr) {
      logger.error({ err: delErr, context }, "raffle: cleanup delete failed (untracked message may survive)");
    }
    logger.error({ err: trackErr, context }, "raffle: trackMessage failed — message deleted to honour 24h purge");
  }
}

function humanTimeLeft(createdAt: Date): string {
  const msLeft = createdAt.getTime() + 24 * 60 * 60 * 1000 - Date.now();
  if (msLeft <= 0) return "closed";
  const h = Math.floor(msLeft / (60 * 60 * 1000));
  const m = Math.floor((msLeft % (60 * 60 * 1000)) / (60 * 1000));
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

// /raffles — list every raffle with live entry counts + time remaining, then
// re-issue Approve/Reject buttons for any still-pending entries (mirrors
// /verify_queue: a missed fanout DM never strands an entry).
export async function handleRaffles(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  try {
    const all = await listRafflesWithCounts();
    const help =
      "Commands:\n" +
      "`/add_raffle CODE <prize>`  (e.g. `/add_raffle JULY a little something`)\n" +
      "`/draw_raffle CODE [how many]`  (default 1 winner)\n" +
      "`/del_raffle CODE`\n\n" +
      "_A raffle runs for 24h from when you create it — hand out the code and draw the same day._\n" +
      "_Each entry needs your ✅ before it counts — you'll get a prompt when someone enters._";
    if (all.length === 0) {
      await bot.sendMessage(chatId, `*Raffles*\n\n_None yet._\n\n${help}`, { parse_mode: "Markdown" });
      return;
    }
    const lines = all.map((r) => {
      const status = r.live ? "🟢" : "⚪";
      const when = r.live ? humanTimeLeft(r.createdAt) : "closed";
      const waiting = r.pendingCount > 0 ? ` · ⏳ ${r.pendingCount} waiting on you` : "";
      return (
        `${status} \`${escapeMarkdown(r.code)}\` — ${escapeMarkdown(r.prize)}\n` +
        `   ${r.approvedCount} in${waiting} · ${when}`
      );
    });
    await bot.sendMessage(chatId, `*Raffles* (${all.length})\n\n${lines.join("\n")}\n\n${help}`, {
      parse_mode: "Markdown",
    });

    // Re-list pending entries with fresh buttons so nothing gets stranded.
    let pending;
    try {
      pending = await listPendingRaffleEntries();
    } catch (err) {
      logger.error({ err }, "/raffles pending re-list failed");
      await bot.sendMessage(chatId, "⚠️ Couldn't load the pending-entries queue just now.");
      return;
    }
    for (const entry of pending) {
      try {
        await bot.sendMessage(chatId, await buildEntryReviewText(entry.chatId, entry.raffleCode), {
          parse_mode: "Markdown",
          reply_markup: entryReviewKeyboard(entry.id),
        });
      } catch (err) {
        logger.warn({ err, entryId: entry.id }, "/raffles pending item send failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "/raffles error");
    await bot.sendMessage(chatId, "Couldn't load raffles right now.");
  }
}

// /add_raffle CODE <prize free text>
export async function handleAddRaffle(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  args: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    await bot.sendMessage(
      chatId,
      "Usage:\n`/add_raffle CODE <prize>`\nExample: `/add_raffle JULY a little something on us`",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const rawCode = trimmed.slice(0, firstSpace);
  const prize = trimmed.slice(firstSpace + 1).trim();
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!code || code.length < 2) {
    await bot.sendMessage(chatId, "Code must be at least 2 letters/digits (A-Z, 0-9, _ or -).");
    return;
  }
  if (!prize) {
    await bot.sendMessage(chatId, "Add a prize after the code, e.g. `/add_raffle JULY a little something`.", {
      parse_mode: "Markdown",
    });
    return;
  }
  const existing = await findRaffleByCode(code);
  if (existing) {
    await bot.sendMessage(
      chatId,
      `Raffle \`${escapeMarkdown(code)}\` already exists. Delete it first with \`/del_raffle ${escapeMarkdown(code)}\`.`,
      { parse_mode: "Markdown" },
    );
    return;
  }
  try {
    const created = await createRaffle(code, prize);
    await bot.sendMessage(
      chatId,
      `✅ Raffle \`${escapeMarkdown(created.code)}\` is live for 24h.\n` +
        `Prize: ${escapeMarkdown(created.prize)}\n\n` +
        `Tell customers to enter by sending:\n\`/raffle ${escapeMarkdown(created.code)}\`\n\n` +
        `Each entry lands here with ✅ Approve / ⛔ Reject buttons — only entries ` +
        `you approve make the draw.\n\n` +
        `Draw it today with \`/draw_raffle ${escapeMarkdown(created.code)}\`.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "/add_raffle error");
    await bot.sendMessage(chatId, "Couldn't create that raffle. Try again.");
  }
}

// /del_raffle CODE — removes the raffle and wipes its entries.
export async function handleDelRaffle(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  rawCode: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const code = rawCode.trim().toUpperCase();
  try {
    const existed = await deleteRaffle(code);
    if (!existed) {
      await bot.sendMessage(chatId, `No raffle \`${escapeMarkdown(code)}\` to delete.`, {
        parse_mode: "Markdown",
      });
      return;
    }
    await bot.sendMessage(chatId, `🗑 Deleted \`${escapeMarkdown(code)}\` and cleared its entries.`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    logger.error({ err }, "/del_raffle error");
    await bot.sendMessage(chatId, "Couldn't delete that raffle. Try again.");
  }
}

// /draw_raffle CODE [count] — pick winner(s), DM them a generic congrats, and
// show the admin who won so they can follow up with the prize specifics.
export async function handleDrawRaffle(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  args: string,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const parts = args.trim().split(/\s+/);
  const code = (parts[0] ?? "").toUpperCase();
  if (!code) {
    await bot.sendMessage(chatId, "Usage: `/draw_raffle CODE [how many]`", { parse_mode: "Markdown" });
    return;
  }
  let count = 1;
  if (parts[1] != null) {
    const n = parseInt(parts[1], 10);
    if (Number.isNaN(n) || n < 1) {
      await bot.sendMessage(chatId, "How many winners must be a positive whole number.");
      return;
    }
    count = Math.min(n, MAX_DRAW_WINNERS);
  }

  let result;
  try {
    result = await drawRaffle(code, count);
  } catch (err) {
    logger.error({ err }, "/draw_raffle error");
    await bot.sendMessage(chatId, "Couldn't run that draw. Try again.");
    return;
  }

  if (!result.ok) {
    const reasonMsg =
      result.reason === "noraffle"
        ? `No raffle \`${escapeMarkdown(code)}\`.`
        : result.reason === "expired"
          ? `Raffle \`${escapeMarkdown(code)}\` is past its 24h window — its entries have been cleared. Start a fresh one and draw it the same day.`
          : `Raffle \`${escapeMarkdown(code)}\` had no entries. It's now closed.`;
    await bot.sendMessage(chatId, reasonMsg, { parse_mode: "Markdown" });
    return;
  }

  // Notify winners with a STRICTLY generic message (no prize text / no forbidden
  // words), tracked so it self-destructs on the 24h sweep like everything else.
  let notifyFailed = 0;
  const winnerLines: string[] = [];
  for (const winnerId of result.winners) {
    let label = `\`${winnerId}\``;
    try {
      const sub = await getSubscriber(winnerId);
      if (sub?.username) label = `@${escapeMarkdown(sub.username)} (\`${winnerId}\`)`;
      else if (sub?.firstName) label = `${escapeMarkdown(sub.firstName)} (\`${winnerId}\`)`;
    } catch {
      /* fall back to raw id */
    }
    winnerLines.push(`• ${label}`);
    try {
      const sent = await bot.sendMessage(
        winnerId,
        `🎉 *You won!*\n\n` +
          `You've been drawn as a winner in our raffle — nice one. The team will message you shortly to sort out the details.\n\n` +
          `🔒 _this message wipes in 24h._`,
        { parse_mode: "Markdown" },
      );
      await trackOrDelete(bot, winnerId, sent.message_id, "draw winner DM");
    } catch (err) {
      notifyFailed++;
      logger.error({ err, winnerId }, "/draw_raffle: failed to DM winner");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const foot =
    `\n\n_Winners were DM'd a generic heads-up. Reach out with the prize using_ \`/reply <id> <message>\`_._` +
    (notifyFailed > 0 ? `\n⚠️ ${notifyFailed} winner(s) couldn't be DM'd (they may have blocked the bot).` : "");
  await bot.sendMessage(
    chatId,
    `🎟 *Draw — \`${escapeMarkdown(code)}\`*\n` +
      `Prize: ${escapeMarkdown(result.prize)}\n` +
      `Winners (${result.winners.length} of ${result.totalEntries} ${result.totalEntries === 1 ? "entry" : "entries"}):\n` +
      `${winnerLines.join("\n")}` +
      foot,
    { parse_mode: "Markdown" },
  );
}

// Customer: /raffle <code> — enter a raffle. Gated (verification) at the call
// site; we ALSO fail closed on the blocklist here (blocked chats must never
// reach a business action). All replies are neutral and reveal nothing about
// other entrants. The entry lands PENDING — admins get an Approve/Reject
// prompt, and only approved entries count for the draw.
export async function handleRaffleEntry(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  code: string | undefined,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  try {
    if (await isBlocked(chatId)) return;
  } catch (err) {
    // Fail closed: if we can't confirm they're not blocked, do nothing.
    logger.error({ err, chatId }, "/raffle blocklist check failed — failing closed");
    return;
  }

  if (!code) {
    const sent = await bot.sendMessage(
      chatId,
      "🎟 To enter a raffle, send the code like this:\n`/raffle YOURCODE`",
      { parse_mode: "Markdown" },
    );
    await trackOrDelete(bot, chatId, sent.message_id, "raffle entry reply");
    return;
  }

  try {
    const result = await addRaffleEntry(code, chatId);
    const reply =
      result.status === "pending"
        ? "🎟 Got it — your entry is in. The team gives each one a quick once-over, and you're in the draw once that's done. We'll message you if you win.\n\n🔒 _this wipes in 24h._"
        : result.status === "already"
          ? "🎟 You're already in this one — good luck!"
          : "That code isn't active. Double-check it and try again.";
    const sent = await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    await trackOrDelete(bot, chatId, sent.message_id, "raffle entry reply");
    if (result.status === "pending") {
      // Fan out AFTER the customer reply so a fanout hiccup can't block it.
      // If every admin DM fails the entry just stays pending — /raffles
      // re-lists it with fresh buttons, and an unreviewed entry is never drawn.
      await notifyAdminsOfRaffleEntry(bot, result.entryId, result.raffleCode, chatId);
    }
  } catch (err) {
    logger.error({ err, chatId }, "/raffle entry error");
    const sent = await bot.sendMessage(chatId, "Couldn't enter you just now. Try again in a moment.");
    await trackOrDelete(bot, chatId, sent.message_id, "raffle entry reply");
  }
}

// ---------------------------------------------------------------------------
// Manual approval — admin-side.
// ---------------------------------------------------------------------------
// Callback data carries only the entry's DB row id (no customer data). The
// buttons are one-shot: approve flips pending→approved, reject flips
// pending→rejected (row kept so re-sending the code can't re-ping admins);
// whichever lands first wins and later taps read "already handled" (same
// contract as the verification queue).
const CB_ENTRY_APPROVE = "rfe:ok:";
const CB_ENTRY_REJECT = "rfe:no:";

function entryReviewKeyboard(entryId: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `${CB_ENTRY_APPROVE}${entryId}` },
        { text: "⛔ Reject", callback_data: `${CB_ENTRY_REJECT}${entryId}` },
      ],
    ],
  };
}

// Admin-facing review card. Pulls the display name from the subscribers table
// (customer-supplied → escaped). Shown to admins only.
async function buildEntryReviewText(chatId: string, raffleCode: string): Promise<string> {
  let who = `\`${chatId}\``;
  try {
    const sub = await getSubscriber(chatId);
    if (sub?.username) who = `@${escapeMarkdown(sub.username)} (\`${chatId}\`)`;
    else if (sub?.firstName) who = `${escapeMarkdown(sub.firstName)} (\`${chatId}\`)`;
  } catch {
    /* fall back to raw id */
  }
  return (
    `🎟 *Raffle entry — needs your OK*\n\n` +
    `Raffle: \`${escapeMarkdown(raffleCode)}\`\n` +
    `Customer: ${who}\n\n` +
    `Approve to put them in the draw, or Reject to drop the entry.`
  );
}

async function notifyAdminsOfRaffleEntry(
  bot: TelegramBot,
  entryId: number,
  raffleCode: string,
  chatId: string,
): Promise<void> {
  const recipients = getAdminIds();
  if (recipients.length === 0) {
    logger.warn({ entryId }, "raffle entry pending but no admins configured");
    return;
  }
  const text = await buildEntryReviewText(chatId, raffleCode);
  const reply_markup = entryReviewKeyboard(entryId);
  for (const a of recipients) {
    try {
      await bot.sendMessage(a, text, { parse_mode: "Markdown", reply_markup });
    } catch (err) {
      logger.warn({ err, admin: a, entryId }, "raffle entry fanout to admin failed");
    }
  }
}

export function isRaffleEntryCallback(data: string | undefined): boolean {
  return !!data && (data.startsWith(CB_ENTRY_APPROVE) || data.startsWith(CB_ENTRY_REJECT));
}

export async function handleRaffleEntryCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  // Authoritative authorization check: the actor (not the chat) must be admin.
  const actor = query.from.id.toString();
  if (!isAdmin(actor)) {
    await safeAnswer(bot, query, "Not allowed.");
    return;
  }

  const data = query.data ?? "";
  const approve = data.startsWith(CB_ENTRY_APPROVE);
  const raw = data.slice((approve ? CB_ENTRY_APPROVE : CB_ENTRY_REJECT).length);
  const entryId = parseInt(raw, 10);
  if (Number.isNaN(entryId)) {
    await safeAnswer(bot, query);
    return;
  }

  if (approve) {
    let row;
    try {
      row = await approveRaffleEntry(entryId);
    } catch (err) {
      logger.error({ err, entryId }, "approveRaffleEntry failed");
      await safeAnswer(bot, query, "Try again.");
      return;
    }
    if (!row) {
      await safeAnswer(bot, query, "Already handled.");
      await editReviewFooter(bot, query, "— already handled");
      return;
    }
    await safeAnswer(bot, query, "Approved ✅");
    await editReviewFooter(bot, query, `✅ Approved by ${actor}`);
    // Generic confirmation only — no prize text, no forbidden words, tracked.
    try {
      const sent = await bot.sendMessage(
        row.chatId,
        "🎟 You're in the draw — good luck! We'll message you if you win.\n\n🔒 _this wipes in 24h._",
        { parse_mode: "Markdown" },
      );
      await trackOrDelete(bot, row.chatId, sent.message_id, "raffle approve DM");
    } catch (err) {
      logger.error({ err, entryId }, "raffle approve customer notify failed");
    }
    return;
  }

  // Reject — flip the row to rejected (kept for dedupe; swept within 24h like
  // every other entry, so retention is unchanged).
  let row;
  try {
    row = await rejectRaffleEntry(entryId);
  } catch (err) {
    logger.error({ err, entryId }, "rejectRaffleEntry failed");
    await safeAnswer(bot, query, "Try again.");
    return;
  }
  if (!row) {
    await safeAnswer(bot, query, "Already handled.");
    await editReviewFooter(bot, query, "— already handled");
    return;
  }
  await safeAnswer(bot, query, "Rejected");
  await editReviewFooter(bot, query, `⛔ Rejected by ${actor}`);
  // Neutral customer DM — no reason given, nothing about the raffle's state.
  try {
    const sent = await bot.sendMessage(
      row.chatId,
      "🎟 That entry didn't go through this time.",
    );
    await trackOrDelete(bot, row.chatId, sent.message_id, "raffle reject DM");
  } catch (err) {
    logger.error({ err, entryId }, "raffle reject customer notify failed");
  }
}

// Small local helpers — same shape as the verification queue's (kept local so
// each handler file stays self-contained).
async function safeAnswer(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  text?: string,
): Promise<void> {
  try {
    await bot.answerCallbackQuery(query.id, text ? { text } : undefined);
  } catch {
    // ignore
  }
}

async function editReviewFooter(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  footer: string,
): Promise<void> {
  const m = query.message;
  if (!m) return;
  const base = m.text ?? "";
  try {
    await bot.editMessageText(`${base}\n\n${footer}`, {
      chat_id: m.chat.id,
      message_id: m.message_id,
    });
  } catch {
    // gone / unchanged — ignore
  }
}
