import TelegramBot from "node-telegram-bot-api";
import { getActiveSubscribers } from "../db.js";
import { isAdmin } from "./admin.js";
import { startBroadcastFlow } from "./broadcastFlow.js";
import { logger } from "../../lib/logger.js";

// ===========================================================================
// Recipient picker — admin-only.
//
// Lets an admin hand-pick exactly who receives a one-off message instead of
// blasting every subscriber. Renders the active subscriber list as a paginated
// checkbox keyboard (tap a name to toggle ▫️/☑️); "Send to N" then hands the
// chosen chat IDs straight into the existing compose-then-send broadcast flow
// (same preview, paced delivery, and auto-cleanup of dead chats).
//
// Selection is intentionally NOT persisted — each /send starts from a blank
// (nobody ticked) slate, per the operator's choice. State lives only in memory
// for the duration of the pick (30-min TTL).
//
// Stale-keyboard safety: every picker gets a random `token`, embedded in every
// callback. Re-running /send mints a new session+token, so taps on an OLDER
// (now-stale) picker message are rejected instead of silently mutating the new
// selection — which is what guarantees "exactly who you ticked" actually holds.
// Toggles address customers by their index in THIS session's snapshot, so an
// out-of-range / wrong-snapshot tap can never inject an unintended recipient.
// ===========================================================================

type PickerEntry = { chatId: string; label: string };
type PickerSession = {
  token: string;
  entries: PickerEntry[];
  selected: Set<string>;
  page: number;
  startedAt: number;
};

const SESSION_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 8;
const sessions = new Map<string, PickerSession>();

const CB_PREFIX = "sel:";
export function isRecipientPickerCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

export function hasRecipientPickerSession(chatId: string): boolean {
  const s = sessions.get(chatId);
  if (!s) return false;
  if (isExpired(s)) {
    sessions.delete(chatId);
    return false;
  }
  return true;
}

function isExpired(s: PickerSession): boolean {
  return Date.now() - s.startedAt > SESSION_TTL_MS;
}

function newToken(): string {
  return Math.random().toString(36).slice(2, 8);
}

// Human-friendly label for a customer button. Name + @username, falling back to
// the chat ID when Telegram gave us nothing else. Goes into inline-keyboard
// button text only, which Telegram renders literally (no Markdown parsing), so
// stray * _ ` characters in a customer's name can't break formatting.
function buildLabel(sub: {
  chatId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const name = [sub.firstName, sub.lastName].filter(Boolean).join(" ").trim();
  const handle = sub.username ? `@${sub.username}` : "";
  let label = name;
  if (handle) label = label ? `${label} ${handle}` : handle;
  if (!label) label = `id ${sub.chatId}`;
  // Keep it short so each row stays on one line on a phone.
  if (label.length > 32) label = `${label.slice(0, 31)}…`;
  return label;
}

function render(s: PickerSession): {
  text: string;
  keyboard: TelegramBot.InlineKeyboardMarkup;
} {
  const total = s.entries.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (s.page > totalPages - 1) s.page = totalPages - 1;
  if (s.page < 0) s.page = 0;
  const start = s.page * PAGE_SIZE;
  const slice = s.entries.slice(start, start + PAGE_SIZE);
  const t = s.token;

  // Toggle buttons carry the ABSOLUTE index into s.entries so the handler can
  // re-resolve the exact customer in this snapshot.
  const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((e, i) => {
    const idx = start + i;
    const checked = s.selected.has(e.chatId);
    return [
      {
        text: `${checked ? "☑️" : "▫️"} ${e.label}`,
        callback_data: `sel:t:${t}:${idx}`,
      },
    ];
  });

  if (totalPages > 1) {
    rows.push([
      { text: "◀️", callback_data: `sel:p:${t}:${s.page - 1}` },
      { text: `Page ${s.page + 1}/${totalPages}`, callback_data: "sel:noop" },
      { text: "▶️", callback_data: `sel:p:${t}:${s.page + 1}` },
    ]);
  }

  rows.push([
    { text: "✅ Select all", callback_data: `sel:all:${t}` },
    { text: "♻️ Clear", callback_data: `sel:none:${t}` },
  ]);

  const n = s.selected.size;
  rows.push([
    {
      text: n > 0 ? `📨 Send to ${n}` : "📨 Send (pick someone)",
      callback_data: `sel:send:${t}`,
    },
    { text: "❌ Cancel", callback_data: `sel:cancel:${t}` },
  ]);

  const text =
    `👥 *Pick who gets this message*\n\n` +
    `Tap a name to tick ☑️ or untick ▫️ it. When you're done, tap *Send* and I'll ask you for the message to send them.\n\n` +
    `*Selected: ${n}* of ${total}`;
  return { text, keyboard: { inline_keyboard: rows } };
}

// Entry point — /send command and the admin-panel "To selected customers"
// button both land here.
export async function startRecipientPicker(
  bot: TelegramBot,
  chatId: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await bot.sendMessage(chatId, "⛔ Admin access required.");
    return;
  }
  let subs;
  try {
    subs = await getActiveSubscribers();
  } catch (err) {
    logger.error({ err }, "recipient picker: failed to load subscribers");
    await bot.sendMessage(
      chatId,
      "Couldn't load your customer list right now. Try again in a moment.",
    );
    return;
  }
  if (subs.length === 0) {
    await bot.sendMessage(
      chatId,
      "_You have no active customers to message yet._",
      { parse_mode: "Markdown" },
    );
    return;
  }
  // Most recently joined first, so brand-new customers are easy to find up top.
  const entries: PickerEntry[] = subs
    .slice()
    .sort(
      (a, b) =>
        (b.joinedAt?.getTime?.() ?? 0) - (a.joinedAt?.getTime?.() ?? 0),
    )
    .map((sub) => ({ chatId: sub.chatId, label: buildLabel(sub) }));

  const session: PickerSession = {
    token: newToken(),
    entries,
    selected: new Set(),
    page: 0,
    startedAt: Date.now(),
  };
  sessions.set(chatId, session);
  const { text, keyboard } = render(session);
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

// Retire a stale/expired keyboard so it can't be tapped again. Never touches
// the in-memory session map (a newer, live picker may own it).
async function retireStaleKeyboard(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  messageId: number | undefined,
): Promise<void> {
  await bot.answerCallbackQuery(query.id, {
    text: "This list is out of date — tap /send to start fresh.",
    show_alert: false,
  });
  if (messageId) {
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: messageId },
      );
    } catch {
      /* best-effort */
    }
  }
}

export async function handleRecipientPickerCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data;
  const chatId = query.message?.chat.id?.toString();
  const actorId = query.from?.id?.toString();
  const messageId = query.message?.message_id;
  if (!data || !chatId || !actorId) {
    try {
      await bot.answerCallbackQuery(query.id);
    } catch {
      /* best-effort */
    }
    return;
  }
  // Authorize on the clicker, not the chat.
  if (!isAdmin(actorId)) {
    await bot.answerCallbackQuery(query.id, {
      text: "Admin only.",
      show_alert: false,
    });
    return;
  }

  const parts = data.split(":"); // ["sel", action, token?, arg?]
  const action = parts[1] ?? "";

  // Tokenless actions: opening a fresh picker and the inert page label.
  if (action === "open") {
    await bot.answerCallbackQuery(query.id);
    await startRecipientPicker(bot, chatId);
    return;
  }
  if (action === "noop") {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Everything below is bound to a specific picker session via its token.
  const token = parts[2] ?? "";
  const s = sessions.get(chatId);
  if (!s || isExpired(s) || s.token !== token) {
    // Only drop our own expired session; never clobber a live newer one.
    if (s && isExpired(s)) sessions.delete(chatId);
    await retireStaleKeyboard(bot, query, chatId, messageId);
    return;
  }

  if (action === "cancel") {
    sessions.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: "Cancelled." });
    if (messageId) {
      try {
        await bot.editMessageText("❌ Cancelled — no message sent.", {
          chat_id: chatId,
          message_id: messageId,
        });
      } catch {
        /* best-effort */
      }
    }
    return;
  }

  if (action === "send") {
    if (s.selected.size === 0) {
      await bot.answerCallbackQuery(query.id, {
        text: "Tick at least one person first.",
        show_alert: false,
      });
      return;
    }
    const recipients = [...s.selected];
    sessions.delete(chatId);
    await bot.answerCallbackQuery(query.id);
    if (messageId) {
      try {
        await bot.editMessageText(
          `✅ ${recipients.length} recipient(s) locked in.`,
          { chat_id: chatId, message_id: messageId },
        );
      } catch {
        /* best-effort */
      }
    }
    // Hand off to the existing compose-then-send flow with the explicit list.
    await startBroadcastFlow(bot, chatId, "selected", recipients);
    return;
  }

  // Mutating actions that re-render the keyboard in place.
  if (action === "t") {
    const idx = parseInt(parts[3] ?? "", 10);
    const entry = Number.isInteger(idx) ? s.entries[idx] : undefined;
    if (entry) {
      if (s.selected.has(entry.chatId)) s.selected.delete(entry.chatId);
      else s.selected.add(entry.chatId);
    }
  } else if (action === "p") {
    const p = parseInt(parts[3] ?? "", 10);
    if (!Number.isNaN(p)) s.page = p;
  } else if (action === "all") {
    for (const e of s.entries) s.selected.add(e.chatId);
  } else if (action === "none") {
    s.selected.clear();
  } else {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  s.startedAt = Date.now(); // refresh TTL on activity

  const { text, keyboard } = render(s);
  try {
    if (messageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    }
  } catch {
    // "message is not modified" (rapid identical taps) is benign.
  }
  try {
    await bot.answerCallbackQuery(query.id);
  } catch {
    /* best-effort */
  }
}
