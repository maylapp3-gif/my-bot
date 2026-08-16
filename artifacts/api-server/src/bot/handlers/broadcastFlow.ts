import TelegramBot from "node-telegram-bot-api";
import { getActiveSubscribers, removeSubscriber } from "../db.js";
import { getModeratorIds } from "../moderation.js";
import { isAdmin } from "./admin.js";
import { weeklyScheduleLines } from "../hours.js";
import { logger } from "../../lib/logger.js";

// ===========================================================================
// Interactive broadcast flow — admin-only.
//
// Why this exists: typing `/broadcast <message>` on a single line is fine for
// short text but awkward for anything more than a sentence, and it doesn't
// accept photos. This flow is the "compose-then-send" UX every other bot has:
//
//   1. Admin taps a button (or runs /broadcast with no args) → flow starts
//   2. Bot asks for the message (text, or a photo with optional caption)
//   3. Admin sends that as a normal Telegram message
//   4. Bot shows a preview + "Send to N" / "Cancel" buttons
//   5. Tap Send → fan-out with the same paced 28/sec delivery + auto-cleanup
//      of dead subscribers as the legacy text command
//
// Audience is locked in at step (1) — "mods" or "subscribers" — so the
// admin can't accidentally blast a draft mod-note to every customer.
// ===========================================================================

export type BroadcastAudience = "mods" | "subscribers" | "selected";
export type BroadcastPayload = {
  // Exactly one of these will be set. Text-only uses `text`; photo uses
  // `photoFileId` + optional `caption`. file_id is reusable — we never
  // re-upload the image to fan it out.
  text?: string;
  photoFileId?: string;
  caption?: string;
};
type Step = "awaiting_message" | "awaiting_confirm";
type Session = {
  audience: BroadcastAudience;
  step: Step;
  payload?: BroadcastPayload;
  // Only set when audience === "selected": the hand-picked chat IDs from the
  // recipient picker. Snapshotted at pick time so the send hits exactly who
  // was ticked.
  recipients?: string[];
  startedAt: number;
};

// 30-min TTL matches checkout/promo sessions. Long enough to compose a
// thoughtful note, short enough that a forgotten draft can't accidentally
// fire days later.
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, Session>();

// Telegram bots are limited to ~30 messages/sec to different chats. We pace
// at ~28/sec to stay under the cap. Identical to the legacy /broadcast.
const BROADCAST_DELAY_MS = 36;

// Prepared announcement for the neighbour-grouping feature. Fired via the
// one-tap admin-panel button (bc:start:partner) through the SAME confirm→send
// gate as a hand-typed broadcast — nothing goes out without an explicit tap.
// Sent as PLAIN text (deliverBroadcast uses no parse_mode), so no markdown.
// Deliberately: no fee amounts, no place names, and no promise of an outcome —
// a customer is never told whether we actually paired them. (Raffles are NOT
// announced here by design — the operator hands codes out directly.)
const PARTNER_ANNOUNCEMENT =
  "🤝 New: share a delivery run, skip the fee\n\n" +
  "Want free delivery? Now you can team up.\n\n" +
  'When you check out for delivery you\'ll see a new option: "group my drop." ' +
  "Tap it and we'll try to pair your order with another one heading out near you " +
  "around the same time — and when we can group the run, delivery's on us.\n\n" +
  "Know a mate or neighbour nearby who also orders? Time your orders together and " +
  "both tap it. Going solo is fine too — we'll match you with another nearby drop " +
  "if one lines up.\n\n" +
  "Nothing to share with anyone, and pickup + normal delivery stay exactly the " +
  'same. Just look for "group my drop" at checkout. 💚';

// Prepared "updated hours" announcement (bc:start:hours). Built AT TAP TIME —
// never cached — so it always renders the schedule currently in force
// (brand.ts WEEKLY_HOURS / env overrides), matching the hours.ts rule that
// schedule strings are derived at call time. Same confirm→send gate as every
// other broadcast. Plain text (deliverBroadcast uses no parse_mode); generic
// copy only — no location, no product talk, no forbidden words.
function hoursAnnouncementText(): string {
  const schedule = weeklyScheduleLines();
  // Only explain the pickup/delivery split when the schedule actually shows
  // one (legacy forks with delivery = full window get the simple version).
  const splitNote = schedule.includes("delivery")
    ? "Pickups run any time we're on. Deliveries head out during the " +
      "delivery window shown for each day.\n\n"
    : "";
  return (
    "🕑 Updated hours\n\n" +
    "Heads up — our hours have changed. Here's the new schedule:\n\n" +
    schedule +
    "\n\n" +
    splitNote +
    "You can send an order any time; we confirm and sort everything out " +
    "during open hours. 💚"
  );
}

// Prepared "delivery windows this week" template for the hand-picked (/send)
// flow. The operator groups customers by neighbourhood THEMSELVES (nothing is
// stored server-side — see recipientPicker.ts) and taps a number; the copy
// fills in how many windows. Deliberately generic: "your neighbourhood" names
// no place, reveals no distance/fee/pairing info, and contains no forbidden
// words. Plain text (deliverBroadcast uses no parse_mode).
function windowsTemplateText(n: number): string {
  const windows = n === 1 ? "1 delivery window" : `${n} delivery windows`;
  return (
    "🗓 This week's runs\n\n" +
    `Good news — we've got ${windows} to your neighbourhood this week. ` +
    "Get your order in early and pop your preferred day in the notes, " +
    "and we'll lock you into one.\n\n" +
    "Windows fill first-come, first-served — once they're gone, that's the week. 💚"
  );
}

function isExpired(s: Session): boolean {
  return Date.now() - s.startedAt > SESSION_TTL_MS;
}

export function hasBroadcastSession(chatId: string): boolean {
  const s = sessions.get(chatId);
  if (!s) return false;
  if (isExpired(s)) {
    sessions.delete(chatId);
    return false;
  }
  return true;
}

export function clearBroadcastSession(chatId: string): void {
  sessions.delete(chatId);
}

// Detect "user blocked bot / chat gone / account deleted" so we can prune
// dead subscribers on the fly. Copy of admin.ts's helper — kept local so
// this flow is self-contained.
function isPermanentDeliveryFailure(err: unknown): boolean {
  const e = err as {
    response?: { body?: { error_code?: number; description?: string } };
    code?: number;
  };
  const code = e?.response?.body?.error_code ?? e?.code;
  const desc = (e?.response?.body?.description ?? "").toLowerCase();
  if (code === 403) return true;
  if (
    desc.includes("bot was blocked") ||
    desc.includes("user is deactivated") ||
    desc.includes("chat not found") ||
    desc.includes("user not found") ||
    desc.includes("group chat was deactivated")
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Step 1: start the flow. Called from the admin-panel buttons (bc:start:*)
// and from the no-arg forms of /announce and /broadcast.
// ---------------------------------------------------------------------------
export async function startBroadcastFlow(
  bot: TelegramBot,
  chatId: string,
  audience: BroadcastAudience,
  recipients?: string[],
): Promise<void> {
  if (!isAdmin(chatId)) return;
  sessions.set(chatId, {
    audience,
    step: "awaiting_message",
    recipients: audience === "selected" ? (recipients ?? []) : undefined,
    startedAt: Date.now(),
  });
  const audienceLabel =
    audience === "mods"
      ? "the moderator team"
      : audience === "selected"
        ? `${recipients?.length ?? 0} selected customer(s)`
        : "every active subscriber";

  // Hand-picked sends get a shortcut row: one tap fills in the prepared
  // "delivery windows to your neighbourhood this week" message (the number
  // = how many windows). Typing a custom message still works as always.
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  let shortcutHint = "";
  if (audience === "selected") {
    keyboard.push(
      [1, 2, 3, 4, 5].map((n) => ({
        text: `🗓 ${n}`,
        callback_data: `bc:tmpl:w:${n}`,
      })),
    );
    shortcutHint =
      `\n\n🗓 *Shortcut:* tap a number to use the ready-made ` +
      `"delivery windows to your neighbourhood this week" message — ` +
      `the number is how many windows. You'll still preview it before it sends.`;
  }
  keyboard.push([{ text: "❌ Cancel", callback_data: "bc:cancel" }]);

  await bot.sendMessage(
    chatId,
    `📝 *Compose broadcast → ${audienceLabel}*\n\n` +
      `Send your message in the next reply. You can use:\n` +
      `• Plain text\n` +
      `• A photo (with an optional caption)` +
      shortcutHint +
      `\n\n_Or tap Cancel to abort._`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    },
  );
}

// ---------------------------------------------------------------------------
// Step 2: consume the admin's next message (text or photo). Returns true if
// the message was claimed by this flow so the caller can short-circuit.
// ---------------------------------------------------------------------------
export async function handleBroadcastMessage(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<boolean> {
  const chatId = msg.chat.id.toString();
  const s = sessions.get(chatId);
  if (!s || s.step !== "awaiting_message") return false;
  if (isExpired(s)) {
    sessions.delete(chatId);
    await bot.sendMessage(chatId, "⌛ Broadcast draft expired. Tap /broadcast to start over.");
    return true;
  }

  // Let the admin abort with a plain "/cancel" so they don't have to scroll
  // back up to find the Cancel button.
  if (msg.text?.trim() === "/cancel") {
    sessions.delete(chatId);
    await bot.sendMessage(chatId, "❌ Broadcast cancelled.");
    return true;
  }

  // Highest-resolution photo is the last entry in msg.photo. file_id is
  // reusable across sendPhoto calls — no re-upload required.
  const hasPhoto = !!msg.photo && msg.photo.length > 0;
  let payload: BroadcastPayload;
  if (hasPhoto) {
    const photo = msg.photo![msg.photo!.length - 1];
    const caption = (msg.caption ?? "").trim();
    payload = {
      photoFileId: photo.file_id,
      caption: caption.length > 0 ? caption : undefined,
    };
  } else if (msg.text && msg.text.trim().length > 0) {
    payload = { text: msg.text.trim() };
  } else {
    // Sticker, voice, video, document, etc. We deliberately don't broadcast
    // these — the legacy delivery code only knows text/photo and silently
    // dropping a video would surprise the admin.
    await bot.sendMessage(
      chatId,
      "⚠️ Only text or photo broadcasts are supported. Send a text message or a photo (with optional caption).",
    );
    return true;
  }

  s.payload = payload;
  s.step = "awaiting_confirm";
  s.startedAt = Date.now(); // refresh TTL on activity

  await sendBroadcastConfirmPreview(bot, chatId, s);
  return true;
}

// Shared "Ready to send" preview + confirm keyboard. Used by the interactive
// compose flow (after the admin sends their message) AND by the one-tap
// prepared broadcasts (bc:start:partner) that seed the payload directly. Either
// way the operator still has to tap Send — this only renders the gate.
async function sendBroadcastConfirmPreview(
  bot: TelegramBot,
  chatId: string,
  s: Session,
): Promise<void> {
  const payload = s.payload!;
  // Audience size preview — counts at compose time so the admin sees how
  // big the blast will be before they confirm.
  const recipientCount =
    s.audience === "mods"
      ? getModeratorIds().length
      : s.audience === "selected"
        ? (s.recipients?.length ?? 0)
        : (await getActiveSubscribers().catch(() => [])).length;
  const audienceLabel =
    s.audience === "mods"
      ? "moderator(s)"
      : s.audience === "selected"
        ? "selected customer(s)"
        : "active subscriber(s)";

  const summary = payload.photoFileId
    ? `📸 *Photo${payload.caption ? " + caption" : ""}*${payload.caption ? `\n\n_${payload.caption.length} char caption_` : ""}`
    : `💬 *Text* — ${payload.text!.length} chars`;

  await bot.sendMessage(
    chatId,
    `🔎 *Ready to send*\n\n${summary}\n\n→ *${recipientCount}* ${audienceLabel}\n\nTap *Send* to fan it out, or *Cancel* to drop it.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: `📢 Send to ${recipientCount}`, callback_data: "bc:send" },
            { text: "❌ Cancel", callback_data: "bc:cancel" },
          ],
        ],
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Callback router for the broadcast flow (bc:*). Handles:
//   bc:start:mods       — admin-panel button
//   bc:start:subs       — admin-panel button
//   bc:start:partner    — admin-panel button (prepared neighbour-deal blast)
//   bc:start:hours      — admin-panel button (prepared updated-hours blast)
//   bc:send             — confirm and fan out
//   bc:cancel           — drop the draft
// ---------------------------------------------------------------------------
const CB_PREFIX = "bc:";
export function isBroadcastCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

export async function handleBroadcastCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data;
  const chatId = query.message?.chat.id?.toString();
  const actorId = query.from?.id?.toString();
  if (!data || !chatId || !actorId) {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  // Authorize on the *clicker*, not the chat — guards against an admin
  // having accidentally forwarded the prompt to a non-admin chat.
  if (!isAdmin(actorId)) {
    await bot.answerCallbackQuery(query.id, {
      text: "Admin only.",
      show_alert: false,
    });
    return;
  }

  if (data === "bc:start:mods" || data === "bc:start:subs") {
    const audience: BroadcastAudience =
      data === "bc:start:mods" ? "mods" : "subscribers";
    await bot.answerCallbackQuery(query.id);
    await startBroadcastFlow(bot, chatId, audience);
    return;
  }

  if (data === "bc:start:partner" || data === "bc:start:hours") {
    // One-tap prepared announcements. Seed the payload straight at the
    // confirm step (audience = subscribers) and show the SAME preview +
    // Send/Cancel gate as a hand-typed broadcast. The operator still
    // confirms before anything fans out — nothing auto-sends.
    const text =
      data === "bc:start:hours" ? hoursAnnouncementText() : PARTNER_ANNOUNCEMENT;
    const s: Session = {
      audience: "subscribers",
      step: "awaiting_confirm",
      payload: { text },
      startedAt: Date.now(),
    };
    sessions.set(chatId, s);
    await bot.answerCallbackQuery(query.id);
    // Unlike the hand-typed flow (where the admin just wrote the message
    // themselves), the operator hasn't seen the prepared copy — echo it
    // exactly as customers will receive it (banner + plain text, no
    // parse_mode) before the Send/Cancel gate.
    await bot.sendMessage(chatId, `📢 Announcement\n\n${text}`);
    await sendBroadcastConfirmPreview(bot, chatId, s);
    return;
  }

  if (data.startsWith("bc:tmpl:w:")) {
    // One-tap "delivery windows this week" template — only valid while a
    // hand-picked (/send) draft is waiting for its message. The prepared text
    // is echoed exactly as customers will receive it, then goes through the
    // SAME preview + Send/Cancel gate as a hand-typed message.
    const s = sessions.get(chatId);
    if (
      !s ||
      s.step !== "awaiting_message" ||
      s.audience !== "selected" ||
      isExpired(s)
    ) {
      if (s && isExpired(s)) sessions.delete(chatId);
      await bot.answerCallbackQuery(query.id, {
        text: "That draft is gone — start over with /send.",
        show_alert: false,
      });
      return;
    }
    const n = parseInt(data.slice("bc:tmpl:w:".length), 10);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      await bot.answerCallbackQuery(query.id);
      return;
    }
    s.payload = { text: windowsTemplateText(n) };
    s.step = "awaiting_confirm";
    s.startedAt = Date.now();
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, `📢 Announcement\n\n${s.payload.text}`);
    await sendBroadcastConfirmPreview(bot, chatId, s);
    return;
  }

  if (data === "bc:cancel") {
    sessions.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: "Cancelled." });
    // Strip the inline keyboard so the preview can't be re-tapped.
    try {
      if (query.message?.message_id) {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id },
        );
      }
    } catch {
      /* best-effort */
    }
    return;
  }

  if (data === "bc:send") {
    const s = sessions.get(chatId);
    if (!s || s.step !== "awaiting_confirm" || !s.payload) {
      await bot.answerCallbackQuery(query.id, {
        text: "Nothing to send — start over with /broadcast.",
        show_alert: false,
      });
      return;
    }
    if (isExpired(s)) {
      sessions.delete(chatId);
      await bot.answerCallbackQuery(query.id, {
        text: "Draft expired. Start over.",
        show_alert: false,
      });
      return;
    }
    // Clear the session BEFORE delivery so a double-tap can't double-send.
    sessions.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: "Sending…" });
    try {
      if (query.message?.message_id) {
        await bot
          .editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id },
          )
          .catch(() => undefined);
      }
    } catch {
      /* best-effort */
    }

    const result = await deliverBroadcast(bot, s.audience, s.payload, s.recipients);
    await bot.sendMessage(
      chatId,
      `📢 *Broadcast complete*\n\n` +
        `• Delivered: *${result.sent}/${result.total}*\n` +
        (result.cleaned > 0 ? `• Auto-removed (blocked / deleted bot): ${result.cleaned}\n` : "") +
        (result.transientFailed > 0 ? `• Transient failures: ${result.transientFailed}` : ""),
      { parse_mode: "Markdown" },
    );
    return;
  }

  await bot.answerCallbackQuery(query.id);
}

// ---------------------------------------------------------------------------
// Core delivery. Reusable from the interactive flow above AND from the
// legacy text-only /announce / /broadcast handlers (which pass a plain
// `{ text }` payload).
// ---------------------------------------------------------------------------
export async function deliverBroadcast(
  bot: TelegramBot,
  audience: BroadcastAudience,
  payload: BroadcastPayload,
  recipients?: string[],
): Promise<{
  total: number;
  sent: number;
  cleaned: number;
  transientFailed: number;
}> {
  let recipientIds: string[];
  if (audience === "mods") {
    recipientIds = getModeratorIds();
  } else if (audience === "selected") {
    // Final guard: only message people who are STILL active subscribers at send
    // time, so a customer removed/blocked between picking and sending can't slip
    // through. Mirrors the fail-closed `.catch(() => [])` the all-subs path uses
    // — if we can't confirm the active list, we deliver to nobody rather than to
    // an unvalidated set.
    const activeIds = new Set(
      (await getActiveSubscribers().catch(() => [])).map((s) => s.chatId),
    );
    recipientIds = (recipients ?? []).filter((id) => activeIds.has(id));
  } else {
    recipientIds = (await getActiveSubscribers().catch(() => [])).map(
      (s) => s.chatId,
    );
  }

  // Both customer-facing blasts (everyone, or a hand-picked subset) get paced
  // delivery and dead-chat pruning; the tiny mod list needs neither.
  const isCustomerBlast = audience === "subscribers" || audience === "selected";

  let sent = 0;
  let cleaned = 0;
  let transientFailed = 0;

  for (const id of recipientIds) {
    try {
      await sendBroadcastPayload(bot, id, audience, payload);
      sent++;
    } catch (err) {
      if (isCustomerBlast && isPermanentDeliveryFailure(err)) {
        try {
          await removeSubscriber(id);
          cleaned++;
        } catch (deactErr) {
          logger.error(
            { err: deactErr, subChatId: id },
            "Failed to deactivate dead subscriber after broadcast",
          );
        }
        logger.info(
          { subChatId: id },
          "Auto-deactivated subscriber after permanent delivery failure",
        );
      } else {
        transientFailed++;
        logger.error(
          { err, recipientId: id, audience },
          "Broadcast delivery failed",
        );
      }
    }
    // Pace the customer blasts — the mod list is tiny (≤5) and the 36ms gap
    // adds nothing useful there.
    if (isCustomerBlast) {
      await new Promise((resolve) => setTimeout(resolve, BROADCAST_DELAY_MS));
    }
  }

  return { total: recipientIds.length, sent, cleaned, transientFailed };
}

// Send a single message in the broadcast. Prepends the audience-appropriate
// banner so customers see "📢 Announcement" and mods see "📣 Update for the
// team" — same wording the legacy commands used so this is a drop-in.
async function sendBroadcastPayload(
  bot: TelegramBot,
  toChatId: string,
  audience: BroadcastAudience,
  payload: BroadcastPayload,
): Promise<void> {
  const bannerLine =
    audience === "mods" ? "📣 Update for the team" : "📢 Announcement";
  if (payload.photoFileId) {
    const caption = payload.caption
      ? `${bannerLine}\n\n${payload.caption}`
      : bannerLine;
    // No parse_mode — operator-typed caption may contain stray *, _, `.
    await bot.sendPhoto(toChatId, payload.photoFileId, { caption });
  } else {
    const text = `${bannerLine}\n\n${payload.text ?? ""}`;
    await bot.sendMessage(toChatId, text);
  }
}

// Keyboard helper for the admin panel. Two big buttons, one per audience.
export function broadcastPanelKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "📣 To moderators", callback_data: "bc:start:mods" }],
      [{ text: "📢 To all subscribers", callback_data: "bc:start:subs" }],
      [{ text: "🎯 To selected customers", callback_data: "sel:open" }],
      [{ text: "🤝 Announce neighbour deal", callback_data: "bc:start:partner" }],
      [{ text: "🕑 Announce updated hours", callback_data: "bc:start:hours" }],
    ],
  };
}
