import TelegramBot from "node-telegram-bot-api";
import {
  USERNAME_RE,
  VERIFY_REJECTION_CAP,
  AUTO_CHECK_CAP,
  AUTO_CHECK_THROTTLE_MS,
  makeVerifyCode,
} from "../verifyCore.js";
import {
  addSubscriber,
  getVerifyState,
  beginVerification,
  setVerificationUsername,
  submitVerification,
  forceManualReview,
  claimVerifyAttempt,
  refundVerifyAttempt,
  autoApproveVerification,
  approveVerification,
  rejectVerification,
  listPendingVerifications,
  isHandleBanned,
  findVerifiedHandleConflict,
  bypassVerification,
  findSubscribers,
} from "../db.js";
import { isModerator } from "../moderation.js";
import { logger } from "../../lib/logger.js";
import { sendCustomerWelcome } from "./welcome.js";
import { isAdmin, getAdminIds } from "./admin.js";
import { verifyCodeOnProfile } from "./leafedout.js";
import { escapeMarkdown, cleanInput } from "../escape.js";
import { isCustomerMenuButton } from "./customerMenu.js";
import { BRAND_NAME } from "../brand.js";

// ===========================================================================
// New-customer verification: automated LeafedOut proof-of-ownership.
//
// Why: ordering is locked for brand-new customers until they prove they own a
// real LeafedOut account (reputation we can hold them to). The operator does
// NOT want anyone to need LeafedOut access, so the bot proves it itself: it
// fetches the customer's PUBLIC LeafedOut profile (server-rendered, no login)
// and confirms the one-time code is present, then self-approves. No human is
// in the loop on the happy path.
//
// Flow (customer): gate → tap Start → send LeafedOut username → bot issues a
// one-time code → customer puts the code on their LeafedOut profile (Additional
// Info / bio) → taps "I've added it — check now" → bot fetches the profile and,
// if the code is there, approves instantly (welcome). If the code isn't found
// after a few tries, the customer is routed to an ADMIN-only manual queue (the
// admin/owner is the only trust anchor with LeafedOut access). The manual
// queue stays admin-only; moderators have exactly ONE audited escape hatch —
// /bypass — for genuine exceptions (see handleModBypass at the bottom).
//
// `verified` (db) stays the single allow-flag the gate surfaces key off; this
// module only drives the process leading up to it.
// ===========================================================================

// --- Customer callback set (EXACT match — these ride the pre-gate fast path,
// so a prefix check would let a forged "vf:appr:<id>" self-approve). ---
const CB_OK = "vf:ok"; // legacy one-tap button → aliased to Start
const CB_START = "vf:start";
const CB_CONFIRM = "vf:confirm";
const CB_CHANGE = "vf:change";
const CB_RETRY = "vf:retry";
const CUSTOMER_CBS = new Set([CB_OK, CB_START, CB_CONFIRM, CB_CHANGE, CB_RETRY]);

// --- Admin callback prefixes (routed AFTER the gate; isAdmin re-checked). ---
const CB_APPROVE = "vf:appr:";
const CB_REJECT = "vf:rej:";

// The handle rules, rejection / auto-check caps, throttle, and proof-code
// generator are shared with the moderator companion userbot — single source of
// truth in verifyCore.ts so the two surfaces can never drift.

// In-memory guards (single process). inFlightChecks stops parallel fetches for
// one chat; lastCheckAt enforces the throttle.
const inFlightChecks = new Set<string>();
const lastCheckAt = new Map<string, number>();

const PROMPT_USERNAME =
  "Send me your *LeafedOut* username — just the username (no link, no spaces).";

const MANUAL_REVIEW_TEXT =
  "⏳ *We'll take a quick look*\n\n" +
  "Thanks — we couldn't auto-confirm the code on your LeafedOut profile, so the team is " +
  "checking it now. We'll message you here the moment you're cleared. Usually quick during open hours.";

function rejectedText(): string {
  return (
    "⛔ *Couldn't verify*\n\n" +
    "We weren't able to confirm that LeafedOut account.\n\n" +
    "Made a typo, or want to try a different account? Tap *🔁 Try again*."
  );
}

function codeNotFoundText(username: string): string {
  return (
    "🔎 *Couldn't find the code yet*\n\n" +
    `We checked the public LeafedOut profile for *${escapeMarkdown(username)}* but didn't see the code.\n\n` +
    "Double-check that:\n" +
    "• the code is saved on your profile (Additional Info / bio),\n" +
    "• your profile is public,\n" +
    "• the username is spelled exactly right (tap *✏️ Change username* to fix).\n\n" +
    "Then tap *✅ I've added it — check now* again."
  );
}

// --- Inline keyboards -------------------------------------------------------
const startKeyboard: TelegramBot.InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: "🔐 Start verification", callback_data: CB_START }]],
};
const collectingKeyboard: TelegramBot.InlineKeyboardMarkup = {
  inline_keyboard: [
    [{ text: "✅ I've added it — check now", callback_data: CB_CONFIRM }],
    [{ text: "✏️ Change username", callback_data: CB_CHANGE }],
  ],
};
const rejectedKeyboard: TelegramBot.InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: "🔁 Try again", callback_data: CB_RETRY }]],
};

function adminActionKeyboard(chatId: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `${CB_APPROVE}${chatId}` },
        { text: "⛔ Reject", callback_data: `${CB_REJECT}${chatId}` },
      ],
    ],
  };
}

// ===========================================================================
// Status-aware gate. Renders the right screen for wherever the customer is in
// the flow. Called from every gate surface (slash commands, message router,
// /start). Fails closed: on any read error, shows the plain Start screen.
// ===========================================================================
export async function sendVerifyGate(
  bot: TelegramBot,
  chatId: string,
): Promise<TelegramBot.Message> {
  let state;
  try {
    state = await getVerifyState(chatId);
  } catch (err) {
    logger.error({ err, chatId }, "verify gate state read failed — showing Start");
    state = undefined;
  }

  const status = state?.verifyStatus ?? null;

  if (status === "collecting" && state?.leafedoutUsername && state?.verifyCode) {
    return sendCollectingScreen(bot, chatId, state.leafedoutUsername, state.verifyCode);
  }
  if (status === "pending") {
    return bot.sendMessage(chatId, MANUAL_REVIEW_TEXT, { parse_mode: "Markdown" });
  }
  if (status === "rejected") {
    return bot.sendMessage(chatId, rejectedText(), {
      parse_mode: "Markdown",
      reply_markup: rejectedKeyboard,
    });
  }

  // Not started / awaiting_username (prompt lost) / unknown → actionable Start.
  return bot.sendMessage(
    chatId,
    `🔐 *${BRAND_NAME} — quick verification*\n\n` +
      "To keep the team safe, new customers verify a *LeafedOut* account before ordering.\n\n" +
      "It's quick: tap below, tell us your LeafedOut username, and drop a code on your profile. " +
      "The bot checks it automatically and lets you in — no one needs access to your account.",
    { parse_mode: "Markdown", reply_markup: startKeyboard },
  );
}

function sendCollectingScreen(
  bot: TelegramBot,
  chatId: string,
  username: string,
  code: string,
): Promise<TelegramBot.Message> {
  return bot.sendMessage(
    chatId,
    `Almost there. To prove *${escapeMarkdown(username)}* is yours:\n\n` +
      "1️⃣ Open LeafedOut and edit your profile.\n" +
      "2️⃣ Paste this code into your profile (your *Additional Info* / bio):\n\n" +
      `      \`${code}\`\n\n` +
      "3️⃣ Save it, make sure your profile is public, then tap *✅ I've added it — check now*.\n\n" +
      "_The bot reads your public profile automatically — no one needs access to your LeafedOut " +
      "account. Once you're verified you can remove the code._",
    { parse_mode: "Markdown", reply_markup: collectingKeyboard },
  );
}

// Best-effort: edit a tapped message to a settled state so its buttons can't
// be re-used. Plain text (msg.text has entities stripped already).
async function editAway(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  text: string,
): Promise<void> {
  if (!query.message) return;
  try {
    await bot.editMessageText(text, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  } catch {
    // gone / unchanged — ignore
  }
}

// Shared (re)start path for Start / Change-username / Retry / legacy OK taps.
// Fails safe against abuse on EVERY re-entry (not just Retry):
//   - already verified (stale button on an approved/grandfathered row) → no-op;
//   - already in the admin queue ('pending') → a stale Start/Change must NOT
//     drop them out of it or hand them a fresh check budget (anti admin-spam),
//     so we just re-show the manual-review status;
//   - lifetime rejection cap is enforced here too.
// Re-entry can never un-verify anyone — beginVerification is guarded on
// verified=false. On a state-read error we proceed (the gate still fails
// closed elsewhere, and the throttle bounds outbound fetches).
async function startOrRestartVerification(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  editText: string,
): Promise<void> {
  let state;
  try {
    state = await getVerifyState(chatId);
  } catch (err) {
    logger.error({ err, chatId }, "verify (re)start state read failed");
  }

  if (state?.verified === true) {
    await safeAnswer(bot, query, "You're already verified ✅");
    return;
  }
  if (state?.verifyStatus === "pending") {
    await safeAnswer(bot, query);
    await bot.sendMessage(chatId, MANUAL_REVIEW_TEXT, { parse_mode: "Markdown" });
    return;
  }
  if ((state?.verifyRejections ?? 0) >= VERIFY_REJECTION_CAP) {
    // Capped — but never point them at a moderator. Hand them to the admin-only
    // manual queue instead (idempotent: forceManualReview only moves a
    // not-yet-pending row, and repeat taps land on the 'pending' branch above,
    // so admins are notified at most once).
    await safeAnswer(bot, query, "We'll take a look.");
    let row;
    try {
      row = await forceManualReview(chatId);
    } catch (err) {
      logger.error({ err, chatId }, "forceManualReview (cap) failed");
    }
    await bot.sendMessage(chatId, MANUAL_REVIEW_TEXT, { parse_mode: "Markdown" });
    if (row) {
      try {
        await notifyAdminsOfVerification(
          bot,
          chatId,
          row.leafedoutUsername ?? "",
          row.verifyCode ?? "",
          query.from.first_name,
          query.from.last_name,
          query.from.username,
        );
      } catch (err) {
        logger.error({ err, chatId }, "notifyAdminsOfVerification (cap) failed");
      }
    }
    return;
  }

  try {
    await beginVerification(chatId);
  } catch (err) {
    logger.error({ err, chatId }, "beginVerification failed");
    await safeAnswer(bot, query, "Try again in a sec.");
    return;
  }
  await safeAnswer(bot, query);
  await editAway(bot, query, editText);
  await bot.sendMessage(chatId, PROMPT_USERNAME, { parse_mode: "Markdown" });
}

// ===========================================================================
// Customer callbacks (vf:start / vf:confirm / vf:change / vf:retry / vf:ok).
// These are the ONLY buttons an unverified customer can use, so the callback
// router lets this set through before the gate.
// ===========================================================================
export function isVerifyCustomerCallback(data: string | undefined): boolean {
  return !!data && CUSTOMER_CBS.has(data);
}

export async function handleVerifyCustomerCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const chatId = (query.message?.chat.id ?? query.from.id).toString();
  const data = query.data;

  // Ensure a subscriber row exists (a purged/returning customer can tap with
  // no row). addSubscriber recreates it as verified=false, leaving any
  // existing NULL/true untouched.
  try {
    await addSubscriber({
      chatId,
      username: query.from.username,
      firstName: query.from.first_name,
      lastName: query.from.last_name,
      active: true,
    });
  } catch (err) {
    logger.error({ err, chatId }, "verify callback addSubscriber failed");
  }

  if (data === CB_OK || data === CB_START || data === CB_CHANGE) {
    await startOrRestartVerification(
      bot,
      query,
      chatId,
      "🔐 Let's verify your LeafedOut account.",
    );
    return;
  }

  if (data === CB_RETRY) {
    await startOrRestartVerification(bot, query, chatId, "🔁 Let's try again.");
    return;
  }

  if (data === CB_CONFIRM) {
    await safeAnswer(bot, query, "Checking your profile…");
    await handleAutoCheck(bot, query);
    return;
  }

  await safeAnswer(bot, query);
}

// ===========================================================================
// The automated check. Triggered by the customer tapping "I've added it".
// Bounded by an in-memory in-flight lock + per-chat throttle, and by an
// atomic claim-before-fetch so looping taps can't spawn unbounded fetches.
// ===========================================================================
async function handleAutoCheck(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const chatId = (query.message?.chat.id ?? query.from.id).toString();

  // A second tap while the first is still working: ignore (already answered).
  if (inFlightChecks.has(chatId)) return;

  // Throttle rapid re-taps (and back-to-back outage retries).
  const now = Date.now();
  const last = lastCheckAt.get(chatId) ?? 0;
  if (now - last < AUTO_CHECK_THROTTLE_MS) {
    const wait = Math.ceil((AUTO_CHECK_THROTTLE_MS - (now - last)) / 1000);
    await bot.sendMessage(
      chatId,
      `⏱ Give it ~${wait}s, then tap *✅ I've added it — check now* again.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  inFlightChecks.add(chatId);
  lastCheckAt.set(chatId, now);
  try {
    // Atomically claim an attempt BEFORE the network call.
    const claim = await claimVerifyAttempt(chatId, AUTO_CHECK_CAP);
    if (!claim) {
      // Either no longer 'collecting', or the cap is already spent. Distinguish.
      let state;
      try {
        state = await getVerifyState(chatId);
      } catch (err) {
        logger.error({ err, chatId }, "auto-check state read failed");
      }
      if (state?.verifyStatus === "collecting") {
        await routeToManualReview(bot, chatId, query.from);
      } else {
        await sendVerifyGate(bot, chatId);
      }
      return;
    }

    const username = claim.leafedoutUsername ?? "";
    const code = claim.verifyCode ?? "";
    if (!username || !code) {
      await sendVerifyGate(bot, chatId);
      return;
    }

    const { found, reachable } = await verifyCodeOnProfile(username, code);

    if (found) {
      // TOCTOU-guarded on the exact username+code we just checked.
      const row = await autoApproveVerification(chatId, username, code);
      if (!row) {
        // Claim changed mid-fetch (username changed / already resolved).
        await sendVerifyGate(bot, chatId);
        return;
      }
      logger.info({ chatId }, "verification auto-approved via public LeafedOut profile");
      const offerLine = row.introOfferGranted
        ? "\n\n🎁 *Welcome gift:* 50% off your first order (orders up to $250). " +
          "It's applied automatically in your cart — no code needed."
        : "";
      await bot.sendMessage(
        chatId,
        "✅ *You're verified — welcome in!*\n\n" +
          "_You can remove the code from your LeafedOut profile now if you like._" +
          offerLine,
        { parse_mode: "Markdown" },
      );
      await sendCustomerWelcome(bot, chatId, undefined);
      return;
    }

    if (!reachable) {
      // LeafedOut unreachable — refund so an outage never burns the budget.
      await refundVerifyAttempt(chatId);
      await bot.sendMessage(
        chatId,
        "⚠️ Couldn't reach LeafedOut just now — that's on our side, not you. " +
          "Give it a minute, then tap *✅ I've added it — check now* again.",
        { parse_mode: "Markdown", reply_markup: collectingKeyboard },
      );
      return;
    }

    // Reachable, but the code isn't on the profile yet.
    if (claim.verifyCheckAttempts >= AUTO_CHECK_CAP) {
      await routeToManualReview(bot, chatId, query.from);
      return;
    }
    await bot.sendMessage(chatId, codeNotFoundText(username), {
      parse_mode: "Markdown",
      reply_markup: collectingKeyboard,
    });
  } catch (err) {
    logger.error({ err, chatId }, "auto-check failed");
    await bot.sendMessage(
      chatId,
      "Something glitched — tap *✅ I've added it — check now* to try again.",
      { parse_mode: "Markdown", reply_markup: collectingKeyboard },
    );
  } finally {
    inFlightChecks.delete(chatId);
  }
}

// Auto-check couldn't confirm — hand the customer to the admin-only manual
// queue (collecting → pending) and notify admins. verifyCode is kept so an
// admin can still eyeball the profile themselves.
async function routeToManualReview(
  bot: TelegramBot,
  chatId: string,
  from: TelegramBot.User,
): Promise<void> {
  let row;
  try {
    row = await submitVerification(chatId);
  } catch (err) {
    logger.error({ err, chatId }, "submitVerification (manual fallback) failed");
    await bot.sendMessage(chatId, "Try again in a sec.");
    return;
  }
  if (!row) {
    // No longer 'collecting' (race) — re-show wherever they are.
    await sendVerifyGate(bot, chatId);
    return;
  }
  await bot.sendMessage(chatId, MANUAL_REVIEW_TEXT, { parse_mode: "Markdown" });
  try {
    await notifyAdminsOfVerification(
      bot,
      chatId,
      row.leafedoutUsername ?? "",
      row.verifyCode ?? "",
      from.first_name,
      from.last_name,
      from.username,
    );
  } catch (err) {
    logger.error({ err, chatId }, "notifyAdminsOfVerification failed");
  }
}

// Free-text capture while a customer is in 'awaiting_username'. Invoked by the
// message router ONLY when getVerifyState reports that status, so this never
// runs for a customer who isn't mid-flow.
export async function handleVerifyUsernameText(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  const text = msg.text ?? "";

  // A stale reply-keyboard tap ("🛒 Cart", etc.) is NOT a username.
  if (isCustomerMenuButton(text)) {
    await bot.sendMessage(
      chatId,
      `That's a menu button — I need your *LeafedOut username* first.\n\n${PROMPT_USERNAME}`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  const handle = cleanInput(text).replace(/^@+/, "");
  if (!USERNAME_RE.test(handle)) {
    await bot.sendMessage(
      chatId,
      "Hmm, that doesn't look right. Send just your LeafedOut username — " +
        "3–30 characters, letters/numbers/._- only, no spaces.",
    );
    return;
  }

  const code = makeVerifyCode();
  let row;
  try {
    row = await setVerificationUsername(chatId, handle, code);
  } catch (err) {
    logger.error({ err, chatId }, "setVerificationUsername failed");
    await bot.sendMessage(chatId, "Something glitched — tap Start to try again.");
    return;
  }
  if (!row) {
    // No longer 'awaiting_username' (race) — re-show wherever they are.
    await sendVerifyGate(bot, chatId);
    return;
  }
  await sendCollectingScreen(bot, chatId, handle, code);
}

// ===========================================================================
// Admin manual-review fallback + approve/reject. Admin-only (the owner is the
// single trust anchor with LeafedOut access). Moderators never see this.
// ===========================================================================
function buildVerifyNotify(
  chatId: string,
  leafedoutUsername: string,
  code: string,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  username: string | null | undefined,
  banned: boolean,
  conflictChatId?: string,
): string {
  const name = escapeMarkdown(
    [firstName, lastName].filter(Boolean).join(" ") || "Customer",
  );
  const tg = username ? `@${escapeMarkdown(username)}` : "—";
  // If this LeafedOut profile is banned, lead with a loud warning. Approving
  // here is the one manual path that overrides a ban, so the admin must see it.
  const warn = banned
    ? "⛔ *This LeafedOut profile is BANNED.*\n" +
      "It was barred from verifying — either you banned it, or a previously " +
      "wiped/blocked account already proved this exact handle. Approving lets " +
      "it back in. Only do this if you are 100% sure it's safe.\n\n"
    : "";
  // If this LeafedOut handle is already verified (or mid-verification) on a
  // different Telegram account, the admin must know: it's usually someone
  // trying to double-dip the new-customer offer with a second account.
  const dupWarn = conflictChatId
    ? "⚠️ *This LeafedOut profile is already linked to another Telegram account* " +
      `(chat ID \`${conflictChatId}\`).\n` +
      "Approve will be refused while that account stays verified — this is " +
      "usually a second account trying to double-dip. If it's a legit account " +
      `switch, first run /reset\\_verify on \`${conflictChatId}\`, then approve here.\n\n`
    : "";
  // leafedoutUsername / code go inside backtick code spans (USERNAME_RE and the
  // code alphabet both forbid backticks), so they're literal and safe.
  return (
    warn +
    dupWarn +
    "🔐 *Verification needs a manual look*\n\n" +
    "The bot couldn't auto-confirm this customer's code on their public LeafedOut " +
    "profile after several tries.\n\n" +
    `Telegram: ${name} (${tg})\n` +
    `Chat ID: \`${chatId}\`\n` +
    `LeafedOut: \`${leafedoutUsername}\`\n` +
    `Proof code: \`${code}\`\n\n` +
    `To check yourself, open \`${leafedoutUsername}\` on LeafedOut and look for the ` +
    "code — then Approve or Reject below."
  );
}

export async function notifyAdminsOfVerification(
  bot: TelegramBot,
  chatId: string,
  leafedoutUsername: string,
  code: string,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  username: string | null | undefined,
): Promise<void> {
  const recipients = getAdminIds();
  if (recipients.length === 0) {
    logger.warn({ chatId }, "no admins configured for verification fallback");
    return;
  }
  const banned = leafedoutUsername ? await isHandleBanned(leafedoutUsername) : false;
  const conflictChatId = leafedoutUsername
    ? await findVerifiedHandleConflict(leafedoutUsername, chatId)
    : undefined;
  const text = buildVerifyNotify(
    chatId,
    leafedoutUsername,
    code,
    firstName,
    lastName,
    username,
    banned,
    conflictChatId,
  );
  const reply_markup = adminActionKeyboard(chatId);
  for (const a of recipients) {
    try {
      await bot.sendMessage(a, text, { parse_mode: "Markdown", reply_markup });
    } catch (err) {
      logger.warn({ err, admin: a }, "verification fallback fanout to admin failed");
    }
  }
}

export function isVerifyAdminCallback(data: string | undefined): boolean {
  return !!data && (data.startsWith(CB_APPROVE) || data.startsWith(CB_REJECT));
}

export async function handleVerifyAdminCallback(
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
  const approve = data.startsWith(CB_APPROVE);
  const chatId = data.slice((approve ? CB_APPROVE : CB_REJECT).length);
  if (!chatId) {
    await safeAnswer(bot, query);
    return;
  }

  if (approve) {
    let row;
    try {
      row = await approveVerification(chatId, actor);
    } catch (err) {
      logger.error({ err, chatId }, "approveVerification failed");
      await safeAnswer(bot, query, "Try again.");
      return;
    }
    if (!row) {
      // Refused. Either already handled, or the one-handle-one-account guard
      // fired because this LeafedOut profile got verified on another chat
      // while this card sat in the queue. Tell the admin which it was.
      let conflictChatId: string | undefined;
      try {
        const state = await getVerifyState(chatId);
        if (state?.verifyStatus === "pending" && state.leafedoutUsername) {
          conflictChatId = await findVerifiedHandleConflict(
            state.leafedoutUsername,
            chatId,
          );
        }
      } catch (err) {
        logger.error({ err, chatId }, "conflict lookup after refused approve failed");
      }
      if (conflictChatId) {
        await safeAnswer(bot, query, "Blocked: profile in use.");
        await editReviewFooter(
          bot,
          query,
          `⛔ Blocked — this LeafedOut profile is already verified on chat ${conflictChatId}. ` +
            `If it's a legit account switch, /reset_verify ${conflictChatId} first, then approve again.`,
        );
      } else {
        await safeAnswer(bot, query, "Already handled.");
        await editReviewFooter(bot, query, "— already handled");
      }
      return;
    }
    await safeAnswer(bot, query, "Approved ✅");
    await editReviewFooter(bot, query, `✅ Approved by ${actor}`);
    try {
      const offerLine = row.introOfferGranted
        ? "\n\n🎁 *Welcome gift:* 50% off your first order (orders up to $250). " +
          "It's applied automatically in your cart — no code needed."
        : "";
      await bot.sendMessage(chatId, "✅ *You're verified — welcome in!*" + offerLine, {
        parse_mode: "Markdown",
      });
      await sendCustomerWelcome(bot, chatId, undefined);
    } catch (err) {
      logger.error({ err, chatId }, "approve customer notify failed");
    }
    return;
  }

  // Reject
  let row;
  try {
    row = await rejectVerification(chatId, actor);
  } catch (err) {
    logger.error({ err, chatId }, "rejectVerification failed");
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
  try {
    await bot.sendMessage(chatId, rejectedText(), {
      parse_mode: "Markdown",
      reply_markup: rejectedKeyboard,
    });
  } catch (err) {
    logger.error({ err, chatId }, "reject customer notify failed");
  }
}

// Append an outcome footer to the admin's own copy and drop its buttons.
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

// /verify_queue — admins only. Re-lists everyone in the manual-review fallback
// so a missed fanout DM never strands a customer. Each item carries its own
// Approve/Reject buttons.
export async function handleVerifyQueue(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return; // silent for non-admins

  let rows;
  try {
    rows = await listPendingVerifications();
  } catch (err) {
    logger.error({ err }, "listPendingVerifications failed");
    await bot.sendMessage(chatId, "Couldn't load the queue — try again.");
    return;
  }
  if (rows.length === 0) {
    await bot.sendMessage(chatId, "✅ No pending verifications.");
    return;
  }
  await bot.sendMessage(chatId, `🔐 *Pending verifications: ${rows.length}*`, {
    parse_mode: "Markdown",
  });
  for (const r of rows) {
    const banned = r.leafedoutUsername ? await isHandleBanned(r.leafedoutUsername) : false;
    const conflictChatId = r.leafedoutUsername
      ? await findVerifiedHandleConflict(r.leafedoutUsername, r.chatId)
      : undefined;
    const text = buildVerifyNotify(
      r.chatId,
      r.leafedoutUsername ?? "",
      r.verifyCode ?? "",
      r.firstName,
      null,
      r.username,
      banned,
      conflictChatId,
    );
    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: adminActionKeyboard(r.chatId),
      });
    } catch (err) {
      logger.warn({ err }, "verify queue item send failed");
    }
  }
}

// ===========================================================================
// /bypass <@user or id> — moderator escape hatch. Lets a mod manually wave a
// still-gated account through verification for genuine exceptions (someone
// the team personally knows, LeafedOut down for days, etc). Guardrails:
//   - mods AND admins can use it (isModerator is the union);
//   - only works on a still-gated account — it can never touch a verified or
//     grandfathered one;
//   - refuses banned LeafedOut handles outright (only an admin can override
//     a ban, via the verify queue's Approve button);
//   - refuses handles already verified on another account (anti double-dip);
//   - never grants the 50%-off intro offer (that stays on the proper
//     approval paths);
//   - every use is logged AND fanned out to all admins for audit.
// ===========================================================================
export async function handleModBypass(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  targetRaw: string,
): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return; // silent for everyone else

  const target = cleanInput(targetRaw ?? "").trim();
  if (!target) {
    await bot.sendMessage(
      modId,
      "Usage: /bypass <@username or chat ID>\n\n" +
        "Manually lets a new customer skip LeafedOut verification. " +
        "Exceptions only — every use is reported to the admins.",
    );
    return;
  }

  let matches;
  try {
    matches = await findSubscribers(target);
  } catch (err) {
    logger.error({ err, target }, "/bypass lookup failed");
    await bot.sendMessage(modId, "Couldn't look that up — try again.");
    return;
  }
  if (matches.length === 0) {
    await bot.sendMessage(modId, `❓ ${target} — no match. They need to have messaged the bot first.`);
    return;
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.chatId).join(", ");
    await bot.sendMessage(
      modId,
      `⚠️ ${target} — ${matches.length} customers share this @. Re-run with the exact ID: ${ids}`,
    );
    return;
  }
  const sub = matches[0]!;
  const who = sub.username ? `@${sub.username}` : (sub.firstName ?? sub.chatId);

  // Fail closed: if we can't read their state, we don't bypass.
  let state;
  try {
    state = await getVerifyState(sub.chatId);
  } catch (err) {
    logger.error({ err, chatId: sub.chatId }, "/bypass state read failed");
    await bot.sendMessage(modId, "Couldn't check their status — try again.");
    return;
  }
  if (!state || state.verified !== false) {
    await bot.sendMessage(modId, `${who} can already order — nothing to bypass.`);
    return;
  }
  // A banned LeafedOut handle is an explicit keep-out decision. A mod bypass
  // must not quietly override it — that stays admin-only via the verify queue.
  if (state.leafedoutUsername) {
    let banned = false;
    try {
      banned = await isHandleBanned(state.leafedoutUsername);
    } catch (err) {
      logger.error({ err, chatId: sub.chatId }, "/bypass ban check failed — refusing");
      banned = true; // fail closed
    }
    if (banned) {
      await bot.sendMessage(
        modId,
        `⛔ Can't bypass ${who} — the LeafedOut profile on their account is banned. ` +
          "Only an admin can let a banned profile back in (via /verify_queue).",
      );
      return;
    }
  }

  let row;
  try {
    row = await bypassVerification(sub.chatId, modId);
  } catch (err) {
    logger.error({ err, chatId: sub.chatId }, "bypassVerification failed");
    await bot.sendMessage(modId, "Couldn't complete the bypass — try again.");
    return;
  }
  if (!row) {
    await bot.sendMessage(
      modId,
      `Couldn't bypass ${who} — either it was just handled, or their LeafedOut profile ` +
        "is already verified on another account (that block stays — it's usually a second " +
        "account trying to double-dip).",
    );
    return;
  }

  logger.info({ chatId: sub.chatId, by: modId }, "moderator /bypass — verification waived");

  // Audit fanout FIRST — the audit trail must never depend on the cosmetic
  // confirmation/welcome sends succeeding. Every admin (except the actor)
  // hears about every bypass.
  const name = escapeMarkdown([sub.firstName].filter(Boolean).join(" ") || "Customer");
  const tg = sub.username ? `@${escapeMarkdown(sub.username)}` : "—";
  const auditText =
    `🪪 *Verification bypassed by a moderator*\n\n` +
    `Moderator: \`${modId}\`\n` +
    `Customer: ${name} (${tg})\n` +
    `Chat ID: \`${sub.chatId}\`\n\n` +
    `No LeafedOut proof is on file for this account. If this shouldn't have happened, ` +
    `run /reset\\_verify \`${sub.chatId}\` to send them back through the gate.`;
  for (const a of getAdminIds()) {
    if (a === modId) continue;
    try {
      await bot.sendMessage(a, auditText, { parse_mode: "Markdown" });
    } catch (err) {
      logger.warn({ err, admin: a }, "bypass audit fanout to admin failed");
    }
  }

  // Mod confirmation — plain text on purpose: `who` is customer-controlled
  // (username/first name) and must not be fed through Markdown parsing.
  try {
    await bot.sendMessage(
      modId,
      `✅ ${who} is in — verification bypassed. The admins have been notified.\n\n` +
        `No welcome offer is granted on a bypass.`,
    );
  } catch (err) {
    logger.warn({ err, modId }, "bypass mod confirmation failed");
  }

  // Customer side: same welcome as any approval, minus the intro-offer line.
  try {
    await bot.sendMessage(sub.chatId, "✅ *You're verified — welcome in!*", {
      parse_mode: "Markdown",
    });
    await sendCustomerWelcome(bot, sub.chatId, undefined);
  } catch (err) {
    logger.error({ err, chatId: sub.chatId }, "bypass customer notify failed");
  }
}

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
