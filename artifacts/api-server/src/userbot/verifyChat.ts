import type TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { BRAND_NAME } from "../bot/brand.js";
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
} from "../bot/db.js";
import { verifyCodeOnProfile } from "../bot/handlers/leafedout.js";
import { notifyAdminsOfVerification } from "../bot/handlers/verify.js";
import {
  USERNAME_RE,
  VERIFY_REJECTION_CAP,
  AUTO_CHECK_CAP,
  AUTO_CHECK_THROTTLE_MS,
  makeVerifyCode,
  normalizeHandle,
} from "../bot/verifyCore.js";

// ===========================================================================
// In-chat LeafedOut verification for the moderator companion (userbot).
//
// When an UNVERIFIED customer DMs a moderator's personal/throwaway account, we
// run the SAME automated LeafedOut proof-of-ownership flow the bot runs — but
// right here in the chat, in plain text (a user account can't render inline
// buttons). The bot stays the single verification authority: this module is
// only a transport-agnostic UI layer over the exact same DB state machine
// (beginVerification → setVerificationUsername → claim/auto-approve / submit)
// and the same public-profile fetcher. Manual-review fallback still goes to
// ADMINS via the bot, where Approve/Reject buttons work.
//
// Transport-agnostic: customer-facing text goes out through the caller's
// `reply()`; the admin manual-review fanout goes through the bot. Forensic
// minimization: never log the customer's message text or the proof code.
// ===========================================================================

// Per-process throttle/in-flight guards for the auto-check (keyed by the
// customer's Telegram id, so they hold even if the same person DMs two mods).
const inFlight = new Set<string>();
const lastCheckAt = new Map<string, number>();

export interface UserbotVerifySender {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}

interface RunOpts {
  peerKey: string;
  incomingText: string;
  sender: UserbotVerifySender;
  reply: (text: string) => Promise<void>;
  bot: TelegramBot;
  modChatId: string;
}

const MANUAL_REVIEW_TEXT =
  "⏳ Thanks — I couldn't auto-confirm the code on your LeafedOut profile, so the " +
  "team's taking a quick look now. I'll message you here the moment you're cleared. " +
  "Usually quick during open hours.";

// --- Customer-facing copy (plain text — user accounts can't use Markdown). --
function welcomeText(): string {
  return (
    `👋 Welcome to ${BRAND_NAME}!\n\n` +
    "Before we chat, new customers do a quick one-time check of a LeafedOut " +
    "account — it's automatic and only takes a minute.\n\n" +
    "Send me your LeafedOut username to start (just the username — no link, no spaces)."
  );
}

function promptUsername(): string {
  return "Send me your LeafedOut username — just the username (no link, no spaces).";
}

function collectingText(username: string, code: string): string {
  return (
    `Almost there. To prove ${username} is yours:\n\n` +
    "1) Open LeafedOut and edit your profile.\n" +
    "2) Paste this code into your profile (your Additional Info / bio):\n\n" +
    `${code}\n\n` +
    '3) Save it, make sure your profile is public, then send the word "check".\n\n' +
    "I read your public profile automatically — no one needs access to your account, " +
    "and once you're verified you can remove the code. " +
    'Wrong username? Send "@yourname" or "change yourname".'
  );
}

function codeNotFoundText(username: string): string {
  return (
    `🔎 I checked the public LeafedOut profile for ${username} but didn't see the code yet.\n\n` +
    "Double-check that:\n" +
    "• the code is saved on your profile (Additional Info / bio),\n" +
    "• your profile is public,\n" +
    '• the username is spelled exactly right (send "@yourname" or "change yourname" to fix).\n\n' +
    'Then send "check" again.'
  );
}

// --- Intent parsing ---------------------------------------------------------

// "I've added the code, go look" triggers. Collapsed to letters/digits so
// punctuation/emoji don't matter. These run BEFORE the closer guard upstream,
// so it's fine that some ("ok", "yes", "done") are also conversation closers.
function isCheckTrigger(raw: string): boolean {
  const stripped = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!stripped) return false;
  const EXACT = new Set([
    "check", "checknow", "recheck", "checkit",
    "done", "doneit", "added", "addedit", "posted", "postedit", "saved",
    "ready", "go", "ok", "okay", "yes", "yep", "yeah", "yup",
    "verify", "verifyme", "itsthere", "ivaddedit", "iveaddedit",
  ]);
  if (EXACT.has(stripped)) return true;
  return stripped.startsWith("check") || stripped.startsWith("done") || stripped.startsWith("added");
}

// Explicit username (re)submission while 'collecting'. Deliberately strict —
// USERNAME_RE alone matches any short word ("hello", "lol"), which would let
// ordinary chatter silently reset the code and refresh the auto-check budget.
// Only "@handle" or "change <handle>" counts. Returns a valid handle or null.
function parseUsernameChange(raw: string): string | null {
  const t = raw.trim();
  if (t.startsWith("@")) {
    const h = normalizeHandle(t);
    return USERNAME_RE.test(h) ? h : null;
  }
  const m = t.match(/^change\b[:\s]+(.+)$/i);
  if (m) {
    const h = normalizeHandle(m[1]);
    return USERNAME_RE.test(h) ? h : null;
  }
  return null;
}

// ===========================================================================
// Entry point. Drives ONE step of the verification conversation for `peerKey`
// based on its current DB state. The caller (userbot/index.ts) guarantees:
//   - this peer needs verification (DB-authoritative needsVerification),
//   - calls are serialized per peer (no concurrent steps),
//   - a per-peer prompt budget bounds how often we speak (flood guard).
// ===========================================================================
export async function runUserbotVerification(opts: RunOpts): Promise<void> {
  const { peerKey, incomingText, sender, reply, bot, modChatId } = opts;

  // Ensure a gated row exists so the state machine has somewhere to live.
  // Forensic minimization: create the row with ONLY the chat id — no name /
  // username, unlike the bot's /start path. The accountability link (the
  // LeafedOut handle) is stored later, when the customer actually provides it.
  // Only create when missing so we never overwrite an existing row.
  let state = await getVerifyState(peerKey);
  if (!state) {
    try {
      await addSubscriber({ chatId: peerKey });
    } catch (err) {
      logger.error({ err, modChatId, peerKey }, "userbot verify addSubscriber failed");
    }
    state = await getVerifyState(peerKey);
  }

  // Defensive: only gated (verified=false) rows are driven here. NULL
  // (grandfathered) / true (approved) should never reach us — the caller's
  // needsVerification() gate filters them — but fail safe if one slips through.
  if (!state || state.verified !== false) return;

  const status = state.verifyStatus ?? null;

  // Already in the admin manual queue — don't re-trigger anything.
  if (status === "pending") {
    await reply(
      "⏳ Thanks — the team's taking a quick look at your verification. " +
        "I'll message you here the moment you're cleared.",
    );
    return;
  }

  // Previously rejected: offer a fresh attempt, or hand to admins if capped.
  if (status === "rejected") {
    if ((state.verifyRejections ?? 0) >= VERIFY_REJECTION_CAP) {
      await forceManual(peerKey, sender, reply, bot, modChatId);
      return;
    }
    try {
      await beginVerification(peerKey);
    } catch (err) {
      logger.error({ err, modChatId, peerKey }, "userbot beginVerification (retry) failed");
    }
    await reply(promptUsername());
    return;
  }

  // Mid-flow: code issued, waiting for the customer to confirm.
  if (status === "collecting") {
    if (isCheckTrigger(incomingText)) {
      await runAutoCheck(peerKey, sender, reply, bot, modChatId);
      return;
    }
    const changed = parseUsernameChange(incomingText);
    if (changed) {
      await issueCode(peerKey, changed, reply, modChatId, true);
      return;
    }
    // Anything else: reshow the instructions (bounded by the caller's budget).
    if (state.leafedoutUsername && state.verifyCode) {
      await reply(collectingText(state.leafedoutUsername, state.verifyCode));
    } else {
      try {
        await beginVerification(peerKey);
      } catch (err) {
        logger.error({ err, modChatId, peerKey }, "userbot beginVerification (repair) failed");
      }
      await reply(promptUsername());
    }
    return;
  }

  // Waiting for the username — treat this message as it.
  if (status === "awaiting_username") {
    const handle = normalizeHandle(incomingText);
    if (!USERNAME_RE.test(handle)) {
      await reply(
        "Hmm, that doesn't look like a username. Send just your LeafedOut " +
          "username — 3–30 characters, letters/numbers/._- only, no spaces.",
      );
      return;
    }
    await issueCode(peerKey, handle, reply, modChatId, false);
    return;
  }

  // status === null → brand-new first contact. Welcome + ask for the username.
  try {
    await beginVerification(peerKey);
  } catch (err) {
    logger.error({ err, modChatId, peerKey }, "userbot beginVerification (start) failed");
  }
  await reply(welcomeText());
}

// Issue a fresh proof code for `handle`. When `restart` (a username change from
// 'collecting'), first move back to awaiting_username so setVerificationUsername
// fires cleanly.
async function issueCode(
  peerKey: string,
  handle: string,
  reply: (t: string) => Promise<void>,
  modChatId: string,
  restart: boolean,
): Promise<void> {
  if (restart) {
    try {
      await beginVerification(peerKey);
    } catch (err) {
      logger.error({ err, modChatId, peerKey }, "userbot beginVerification (change) failed");
    }
  }
  const code = makeVerifyCode();
  let row;
  try {
    row = await setVerificationUsername(peerKey, handle, code);
  } catch (err) {
    logger.error({ err, modChatId, peerKey }, "userbot setVerificationUsername failed");
    await reply("Something glitched on my end — send your LeafedOut username again.");
    return;
  }
  if (!row) {
    // Not in awaiting_username (race) — re-show the current state.
    await reshow(peerKey, reply);
    return;
  }
  await reply(collectingText(handle, code));
}

// The automated public-profile check. Mirrors the bot's handleAutoCheck:
// in-flight lock + per-chat throttle + atomic claim-before-fetch, refund on
// outage, manual-review handoff once the cap is spent.
async function runAutoCheck(
  peerKey: string,
  sender: UserbotVerifySender,
  reply: (t: string) => Promise<void>,
  bot: TelegramBot,
  modChatId: string,
): Promise<void> {
  if (inFlight.has(peerKey)) return;

  const now = Date.now();
  const last = lastCheckAt.get(peerKey) ?? 0;
  if (now - last < AUTO_CHECK_THROTTLE_MS) {
    const wait = Math.ceil((AUTO_CHECK_THROTTLE_MS - (now - last)) / 1000);
    await reply(`⏱ Give it ~${wait}s, then send "check" again.`);
    return;
  }

  inFlight.add(peerKey);
  lastCheckAt.set(peerKey, now);
  try {
    // Atomically claim an attempt BEFORE the network call.
    const claim = await claimVerifyAttempt(peerKey, AUTO_CHECK_CAP);
    if (!claim) {
      // Either the cap is spent (still 'collecting') or state moved on.
      let st;
      try {
        st = await getVerifyState(peerKey);
      } catch (err) {
        logger.error({ err, modChatId, peerKey }, "userbot auto-check state read failed");
      }
      if (st?.verifyStatus === "collecting") {
        await routeToManualReview(peerKey, sender, reply, bot, modChatId);
      } else {
        await reshow(peerKey, reply);
      }
      return;
    }

    const username = claim.leafedoutUsername ?? "";
    const code = claim.verifyCode ?? "";
    if (!username || !code) {
      await reshow(peerKey, reply);
      return;
    }

    const { found, reachable } = await verifyCodeOnProfile(username, code);

    if (found) {
      // TOCTOU-guarded on the exact username+code we just checked.
      const row = await autoApproveVerification(peerKey, username, code);
      if (!row) {
        await reshow(peerKey, reply);
        return;
      }
      logger.info({ modChatId, peerKey }, "userbot verification auto-approved via public LeafedOut profile");
      await reply(
        "✅ You're verified — welcome in! You can remove the code from your " +
          "LeafedOut profile now. What can I get sorted for you?",
      );
      return;
    }

    if (!reachable) {
      // LeafedOut unreachable — refund so an outage never burns the budget.
      await refundVerifyAttempt(peerKey);
      await reply(
        "⚠️ Couldn't reach LeafedOut just now — that's on my side, not you. " +
          'Give it a minute, then send "check" again.',
      );
      return;
    }

    // Reachable, but the code isn't on the profile yet.
    if (claim.verifyCheckAttempts >= AUTO_CHECK_CAP) {
      await routeToManualReview(peerKey, sender, reply, bot, modChatId);
      return;
    }
    await reply(codeNotFoundText(username));
  } catch (err) {
    logger.error({ err, modChatId, peerKey }, "userbot auto-check failed");
    await reply('Something glitched — send "check" again to retry.');
  } finally {
    inFlight.delete(peerKey);
  }
}

// Re-render whatever state the customer is actually in (used after a race where
// the state moved out from under us mid-step).
async function reshow(peerKey: string, reply: (t: string) => Promise<void>): Promise<void> {
  let st;
  try {
    st = await getVerifyState(peerKey);
  } catch {
    /* fall through to welcome */
  }
  if (!st) {
    await reply(welcomeText());
    return;
  }
  if (st.verified === true) {
    await reply("✅ You're already verified — what can I get sorted for you?");
    return;
  }
  const status = st.verifyStatus ?? null;
  if (status === "collecting" && st.leafedoutUsername && st.verifyCode) {
    await reply(collectingText(st.leafedoutUsername, st.verifyCode));
  } else if (status === "pending") {
    await reply("⏳ The team's taking a quick look — I'll message you when you're cleared.");
  } else if (status === "awaiting_username") {
    await reply(promptUsername());
  } else {
    await reply(welcomeText());
  }
}

// Auto-check exhausted while 'collecting' → admin manual queue (collecting →
// pending) + notify admins via the bot.
async function routeToManualReview(
  peerKey: string,
  sender: UserbotVerifySender,
  reply: (t: string) => Promise<void>,
  bot: TelegramBot,
  modChatId: string,
): Promise<void> {
  let row;
  try {
    row = await submitVerification(peerKey);
  } catch (err) {
    logger.error({ err, modChatId, peerKey }, "userbot submitVerification failed");
    await reply("Give it a sec and try again.");
    return;
  }
  if (!row) {
    // No longer 'collecting' (race) — re-show wherever they are.
    await reshow(peerKey, reply);
    return;
  }
  await notifyManual(peerKey, row, sender, reply, bot, modChatId);
}

// Rejection cap hit → force into the admin manual queue regardless of current
// state (forceManualReview is idempotent for already-pending rows).
async function forceManual(
  peerKey: string,
  sender: UserbotVerifySender,
  reply: (t: string) => Promise<void>,
  bot: TelegramBot,
  modChatId: string,
): Promise<void> {
  let row;
  try {
    row = await forceManualReview(peerKey);
  } catch (err) {
    logger.error({ err, modChatId, peerKey }, "userbot forceManualReview failed");
  }
  await notifyManual(peerKey, row ?? null, sender, reply, bot, modChatId);
}

async function notifyManual(
  peerKey: string,
  row: { leafedoutUsername: string | null; verifyCode: string | null } | null,
  sender: UserbotVerifySender,
  reply: (t: string) => Promise<void>,
  bot: TelegramBot,
  modChatId: string,
): Promise<void> {
  await reply(MANUAL_REVIEW_TEXT);
  if (!row) return;
  try {
    await notifyAdminsOfVerification(
      bot,
      peerKey,
      row.leafedoutUsername ?? "",
      row.verifyCode ?? "",
      sender.firstName,
      sender.lastName,
      sender.username,
    );
  } catch (err) {
    logger.error({ err, modChatId, peerKey }, "userbot notifyAdminsOfVerification failed");
  }
}
