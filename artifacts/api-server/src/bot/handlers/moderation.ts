import TelegramBot from "node-telegram-bot-api";
import {
  claimChat,
  releaseChat,
  forceReleaseChat,
  getClaimer,
  getActiveClaims,
  getModeratorIds,
  isModerator,
  cancelFallback,
} from "../moderation.js";
import { escapeMarkdown } from "../escape.js";
import { logger } from "../../lib/logger.js";
import { trackMessage, isRegular, getConfirmedOrderCount } from "../db.js";
import { templateKeyboard } from "./quickReply.js";

// Mods-first model: when a customer sends free text, mods see it immediately
// (with one-tap action buttons) and AI only steps in after this delay if
// nobody on the team has claimed the chat.
export const AI_FALLBACK_DELAY_MS = 4 * 60 * 1000; // 4 minutes

// =============================================================================
// One-tap moderator action keyboard.
// Attached to every customer-DM relay and every AI-reply relay so a mod can
// Take / Reply / Quick-reply / Release without typing /commands or chatIds.
// =============================================================================
const MOD_CB_PREFIX = "mod:";

export function isModInlineCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(MOD_CB_PREFIX);
}

function modActionKeyboard(
  customerChatId: string,
  claimerId: string | undefined,
  viewerModId: string,
): TelegramBot.InlineKeyboardMarkup {
  const isMine = claimerId === viewerModId;
  const isOthers = !!claimerId && !isMine;
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  // Row 1: Reply + Quick (always available; Reply auto-takes if unclaimed).
  rows.push([
    { text: "💬 Reply", callback_data: `mod:rp:${customerChatId}` },
    { text: "⚡ Quick", callback_data: `mod:qr:${customerChatId}` },
  ]);

  // Row 2: Take (when unclaimed) OR Let-AI / Release (when mine) OR coordinate (when other's).
  if (!claimerId) {
    rows.push([
      { text: "🤙 Take chat", callback_data: `mod:tk:${customerChatId}` },
    ]);
  } else if (isMine) {
    rows.push([
      { text: "🤖 Let AI handle", callback_data: `mod:rl:${customerChatId}` },
    ]);
  } else if (isOthers) {
    // Read-only badge — non-functional, just for awareness.
    rows.push([
      { text: `🔒 Held by ${claimerId}`, callback_data: `mod:noop` },
    ]);
  }

  return { inline_keyboard: rows };
}

// =============================================================================
// Force-reply "type your message" prompt + parser.
// Mod taps 💬 Reply → bot sends a force-reply prompt → mod just types and
// hits send. We extract the chatId from the prompt the bot itself sent
// (server-controlled text, never user input) and route to handleReply.
// =============================================================================
const REPLY_PROMPT_MARKER = "↪︎"; // unique sentinel so we can recognise our prompts
const CHATID_RE = /\(#(-?\d+)\)/;

async function sendReplyPrompt(
  bot: TelegramBot,
  modId: string,
  customerChatId: string,
  customerName: string,
): Promise<void> {
  const text =
    `${REPLY_PROMPT_MARKER} *Reply to ${escapeMarkdown(customerName)}* (#${customerChatId})\n\n` +
    `_Type your message and hit send, or tap a quick reply below._`;
  await bot.sendMessage(modId, text, {
    parse_mode: "Markdown",
    reply_markup: { force_reply: true, selective: true },
  });
  // Telegram won't let a single message be both a force-reply and carry an
  // inline keyboard, so we send the quick-reply templates as a follow-up.
  // Mod can either type into the reply box or tap a preset.
  try {
    await bot.sendMessage(modId, `_Or tap a preset:_`, {
      parse_mode: "Markdown",
      reply_markup: templateKeyboard(customerChatId),
    });
  } catch (err) {
    logger.error({ err, customerChatId }, "reply preset keyboard failed");
  }
}

/**
 * If `msg` is a moderator's reply to one of our force-reply prompts, route
 * the text to handleReply and return true. Otherwise return false so the
 * caller can continue normal message routing.
 */
export async function tryConsumeForceReply(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<boolean> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return false;
  const reply = msg.reply_to_message;
  if (!reply || !reply.from?.is_bot) return false;
  const replyText = reply.text ?? "";
  if (!replyText.startsWith(REPLY_PROMPT_MARKER)) return false;
  const m = CHATID_RE.exec(replyText);
  if (!m) return false;
  const customerChatId = m[1];
  const body = (msg.text ?? "").trim();
  if (!body) return true; // consumed but empty — silently drop

  await handleReply(bot, msg, customerChatId, body);
  return true;
}

// =============================================================================
// Inline callback dispatcher for `mod:*` buttons.
// =============================================================================
export async function handleModInlineCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const modId = query.from.id.toString();
  if (!isModerator(modId)) {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  const data = query.data ?? "";
  const parts = data.split(":");
  const action = parts[1];
  const customerChatId = parts[2];

  if (action === "noop") {
    await bot.answerCallbackQuery(query.id, { text: "Held by another mod." });
    return;
  }
  if (!customerChatId) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (action === "rp") {
    // Reply: auto-take if unclaimed (so the AI fallback is paused while the
    // mod composes), then send the force-reply prompt.
    const claimer = getClaimer(customerChatId);
    if (claimer && claimer !== modId) {
      await bot.answerCallbackQuery(query.id, {
        text: `Held by ${claimer} — coordinate first.`,
        show_alert: true,
      });
      return;
    }
    if (!claimer) {
      claimChat(customerChatId, modId);
      cancelFallback(customerChatId);
    }
    const customerName = "customer"; // we don't have name in callback context; prompt is enough
    try {
      await sendReplyPrompt(bot, modId, customerChatId, customerName);
      await bot.answerCallbackQuery(query.id, { text: "Type your reply." });
    } catch (err) {
      logger.error({ err, customerChatId }, "mod:rp prompt failed");
      await bot.answerCallbackQuery(query.id, { text: "Couldn't open reply box.", show_alert: true });
    }
    return;
  }

  if (action === "qr") {
    const claimer = getClaimer(customerChatId);
    if (claimer && claimer !== modId) {
      await bot.answerCallbackQuery(query.id, {
        text: `Held by ${claimer} — coordinate first.`,
        show_alert: true,
      });
      return;
    }
    if (!claimer) {
      claimChat(customerChatId, modId);
      cancelFallback(customerChatId);
    }
    try {
      await bot.sendMessage(modId, `*Quick reply* → \`${customerChatId}\``, {
        parse_mode: "Markdown",
        reply_markup: templateKeyboard(customerChatId),
      });
      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      logger.error({ err }, "mod:qr send failed");
      await bot.answerCallbackQuery(query.id);
    }
    return;
  }

  if (action === "tk") {
    const ok = claimChat(customerChatId, modId);
    if (!ok) {
      const otherMod = getClaimer(customerChatId);
      await bot.answerCallbackQuery(query.id, {
        text: `Already held by ${otherMod}.`,
        show_alert: true,
      });
      return;
    }
    cancelFallback(customerChatId);
    await bot.answerCallbackQuery(query.id, { text: "Chat is yours." });
    await fanoutToModerators(
      bot,
      `🛎️ Chat \`${customerChatId}\` claimed by \`${modId}\`.`,
      { excludeId: modId, parse_mode: "Markdown" },
    );
    return;
  }

  if (action === "rl") {
    const claimer = getClaimer(customerChatId);
    if (!claimer) {
      await bot.answerCallbackQuery(query.id, { text: "Not currently claimed." });
      return;
    }
    if (claimer !== modId) {
      await bot.answerCallbackQuery(query.id, {
        text: `Held by ${claimer}.`,
        show_alert: true,
      });
      return;
    }
    releaseChat(customerChatId, modId);
    await bot.answerCallbackQuery(query.id, { text: "Released. AI is on." });
    await fanoutToModerators(
      bot,
      `🛎️ Chat \`${customerChatId}\` released by \`${modId}\`. AI is back on.`,
      { excludeId: modId, parse_mode: "Markdown" },
    );
    return;
  }

  await bot.answerCallbackQuery(query.id);
}

// Send a message to all moderators except `excludeId` (e.g. the moderator who triggered the action).
async function fanoutToModerators(
  bot: TelegramBot,
  text: string,
  opts?: {
    excludeId?: string;
    parse_mode?: "Markdown" | "HTML";
    reply_markup?: TelegramBot.InlineKeyboardMarkup;
  }
) {
  const ids = getModeratorIds();
  for (const id of ids) {
    if (opts?.excludeId && id === opts.excludeId) continue;
    try {
      const sendOpts: TelegramBot.SendMessageOptions = {};
      if (opts?.parse_mode) sendOpts.parse_mode = opts.parse_mode;
      if (opts?.reply_markup) sendOpts.reply_markup = opts.reply_markup;
      await bot.sendMessage(id, text, sendOpts);
    } catch (err) {
      logger.error({ err, modId: id }, "Failed to fan out moderator message");
    }
  }
}

/**
 * Called whenever a non-command customer message arrives.
 * Mirrors the message to moderators with one-tap action buttons. Returns
 * true if a moderator has claimed this chat (caller should then NOT trigger AI).
 */
export async function relayCustomerMessage(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<{ claimed: boolean; claimer?: string }> {
  const customerChatId = msg.chat.id.toString();
  const claimer = getClaimer(customerChatId);
  const claimed = !!claimer;

  const customerName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Customer";
  const username = msg.from?.username ? ` (@${escapeMarkdown(msg.from.username)})` : "";
  const body = (msg.text ?? "").slice(0, 800);

  // VIP context: show mods instantly whether this is a regular and how many
  // confirmed orders they've placed, so a $200 customer message doesn't sit
  // in the same visual lane as a brand-new tire-kicker. Both lookups are
  // best-effort — a slow DB shouldn't block the relay.
  let badge = "";
  try {
    const [regular, orderCount] = await Promise.all([
      isRegular(customerChatId).catch(() => false),
      getConfirmedOrderCount(customerChatId).catch(() => 0),
    ]);
    const parts: string[] = [];
    if (regular) parts.push("🌟 Regular");
    if (orderCount > 0) parts.push(`${orderCount} order${orderCount === 1 ? "" : "s"}`);
    if (parts.length > 0) badge = `\n_${parts.join(" · ")}_`;
  } catch (err) {
    logger.warn({ err, customerChatId }, "relay header badge lookup failed");
  }

  const header = claimed
    ? `💬 *${escapeMarkdown(customerName)}*${username} _(claimed)_${badge}`
    : `💬 *Inbound — ${escapeMarkdown(customerName)}*${username}${badge}`;
  const text = `${header}\n\n> ${escapeMarkdown(body)}`;

  if (claimed && claimer) {
    // Only the claiming moderator gets this stream.
    try {
      await bot.sendMessage(claimer, text, {
        parse_mode: "Markdown",
        reply_markup: modActionKeyboard(customerChatId, claimer, claimer),
      });
    } catch (err) {
      logger.error({ err, claimer }, "Failed to deliver to claiming moderator");
    }
  } else {
    // Per-mod fan-out so each mod's keyboard reflects their own POV.
    for (const id of getModeratorIds()) {
      try {
        await bot.sendMessage(id, text, {
          parse_mode: "Markdown",
          reply_markup: modActionKeyboard(customerChatId, undefined, id),
        });
      } catch (err) {
        logger.error({ err, modId: id }, "Failed to fan out customer relay");
      }
    }
  }

  return { claimed, claimer };
}

/**
 * Mirror an outbound AI/automated reply to moderators so they have full context.
 * Skipped if the chat is claimed (the moderator is replying themselves).
 */
export async function relayAIResponse(
  bot: TelegramBot,
  customerChatId: string,
  customerName: string,
  aiText: string,
) {
  if (getClaimer(customerChatId)) return;
  const trimmed = aiText.slice(0, 800);
  const text =
    `🤖 *AI replied to ${escapeMarkdown(customerName)}* (#${customerChatId})\n\n` +
    `> ${escapeMarkdown(trimmed)}`;
  for (const id of getModeratorIds()) {
    try {
      await bot.sendMessage(id, text, {
        parse_mode: "Markdown",
        reply_markup: modActionKeyboard(customerChatId, undefined, id),
      });
    } catch (err) {
      logger.error({ err, modId: id }, "Failed to fan out AI relay");
    }
  }
}

// =============================================================================
// Legacy /command handlers (kept for power-users and parity).
// =============================================================================

// /take <customerChatId>
export async function handleTake(bot: TelegramBot, msg: TelegramBot.Message, customerChatId: string): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return;

  const ok = claimChat(customerChatId, modId);
  if (!ok) {
    const otherMod = getClaimer(customerChatId);
    await bot.sendMessage(
      modId,
      `Already claimed by another moderator (\`${otherMod}\`). Ask them to /release ${customerChatId} first, or coordinate.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  cancelFallback(customerChatId);

  await bot.sendMessage(
    modId,
    `🤙 You've taken chat \`${customerChatId}\`. AI is paused.\n` +
      `_Tap *💬 Reply* on any inbound message — no commands needed._`,
    { parse_mode: "Markdown" }
  );

  await fanoutToModerators(
    bot,
    `🛎️ Chat \`${customerChatId}\` claimed by moderator \`${modId}\`.`,
    { excludeId: modId, parse_mode: "Markdown" }
  );
}

// /release <customerChatId>
export async function handleRelease(bot: TelegramBot, msg: TelegramBot.Message, customerChatId: string): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return;

  const claimer = getClaimer(customerChatId);
  if (!claimer) {
    await bot.sendMessage(modId, `Chat \`${customerChatId}\` isn't currently claimed.`, { parse_mode: "Markdown" });
    return;
  }

  const ok = releaseChat(customerChatId, modId);
  if (!ok) {
    await bot.sendMessage(
      modId,
      `That chat is held by another moderator (\`${claimer}\`). Ask them to /release ${customerChatId}, or use /forcerelease ${customerChatId} to override.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await bot.sendMessage(modId, `Released chat \`${customerChatId}\`. AI is active again.`, { parse_mode: "Markdown" });

  await fanoutToModerators(
    bot,
    `🛎️ Chat \`${customerChatId}\` released. Now unclaimed.`,
    { excludeId: modId, parse_mode: "Markdown" }
  );
}

// /forcerelease <customerChatId> — override another moderator's claim (rare; logged & broadcast)
export async function handleForceRelease(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  customerChatId: string
): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return;

  const claimer = getClaimer(customerChatId);
  if (!claimer) {
    await bot.sendMessage(modId, `Chat \`${customerChatId}\` isn't currently claimed.`, { parse_mode: "Markdown" });
    return;
  }

  forceReleaseChat(customerChatId);
  await bot.sendMessage(modId, `⚠️ Force-released chat \`${customerChatId}\` (was held by \`${claimer}\`). AI now active.`, { parse_mode: "Markdown" });

  await fanoutToModerators(
    bot,
    `⚠️ Chat \`${customerChatId}\` was *force-released* by \`${modId}\` (was held by \`${claimer}\`). Now unclaimed.`,
    { excludeId: modId, parse_mode: "Markdown" }
  );
}

// /reply <customerChatId> <message>
export async function handleReply(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  customerChatId: string,
  replyText: string
): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return;

  const text = replyText.trim();
  if (!text) {
    await bot.sendMessage(modId, `Tap *💬 Reply* on any customer message and just type — no command needed.`, { parse_mode: "Markdown" });
    return;
  }

  const claimer = getClaimer(customerChatId);
  if (claimer && claimer !== modId) {
    await bot.sendMessage(
      modId,
      `That chat is currently claimed by another moderator (\`${claimer}\`). Coordinate or ask them to /release first.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  let sentToCustomer: TelegramBot.Message;
  try {
    sentToCustomer = await bot.sendMessage(customerChatId, text);
  } catch (err) {
    logger.error({ err, customerChatId }, "Failed to send moderator reply to customer");
    await bot.sendMessage(modId, `❌ Couldn't deliver to \`${customerChatId}\` — they may have blocked the bot.`, { parse_mode: "Markdown" });
    return;
  }

  try {
    await trackMessage(customerChatId, sentToCustomer.message_id);
  } catch (err) {
    logger.error({ err }, "Failed to track moderator reply for self-destruct");
  }

  cancelFallback(customerChatId);

  await bot.sendMessage(modId, `✅ Sent.`, { parse_mode: "Markdown" });

  await fanoutToModerators(
    bot,
    `📤 *Sent to* \`${customerChatId}\` *by* \`${modId}\`\n\n> ${escapeMarkdown(text)}`,
    { excludeId: modId, parse_mode: "Markdown" }
  );
}

// /active — list all currently claimed conversations
export async function handleActive(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return;

  const active = getActiveClaims();
  if (active.length === 0) {
    await bot.sendMessage(modId, "No active conversations claimed right now.");
    return;
  }

  const lines = active.map((a) => {
    const ageMin = Math.round((Date.now() - a.claimedAt) / 60_000);
    const owner = a.moderatorId === modId ? "you" : `\`${a.moderatorId}\``;
    return `• \`${a.customerChatId}\` — held by ${owner} (${ageMin}m ago)`;
  });

  await bot.sendMessage(
    modId,
    `📋 *Active Conversations* (${active.length})\n\n${lines.join("\n")}`,
    { parse_mode: "Markdown" }
  );
}

// /mods — show who the configured moderators are
export async function handleMods(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const modId = msg.chat.id.toString();
  if (!isModerator(modId)) return;
  const ids = getModeratorIds();
  await bot.sendMessage(
    modId,
    `👥 *Configured Moderators* (${ids.length})\n\n${ids.map((id) => `• \`${id}\``).join("\n")}`,
    { parse_mode: "Markdown" }
  );
}
