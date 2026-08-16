import TelegramBot from "node-telegram-bot-api";
import { Api } from "telegram";
import { logger } from "../../lib/logger.js";
import { isModerator } from "../moderation.js";
import { isAdmin } from "./admin.js";
import { blockAndWipe } from "../db.js";
import { getUserbot } from "../../userbot/registry.js";
import type { PeerSignals } from "../suspicion.js";

const PREFIX = "susblk:";

export function isSuspiciousCallback(data?: string): boolean {
  return !!data && data.startsWith(PREFIX);
}

// Build the private heads-up the bot sends to the moderator. Forensic
// minimization: peer id + display name + @username (if set) + signal lines only
// — never the customer's message text. The display name is the SAME name the mod
// already sees in their own Telegram inbox for this DM (it's how they recognise
// the person when no @username is set), and this heads-up goes only to that
// mod's own chat, so it discloses nothing the mod can't already see.
export function buildSuspiciousAlert(
  peerId: string,
  signals: PeerSignals,
  username: string | null,
  messageCount: number,
  displayName: string | null,
): { text: string; reply_markup: TelegramBot.InlineKeyboardMarkup } {
  const lines: string[] = [
    "⚠️ An unverified account just messaged your personal Telegram.",
    "",
    `• Name: ${displayName && displayName.length > 0 ? displayName : "(no name set)"}`,
    `• Username: ${username ? "@" + username : "none set"}`,
    `• Telegram ID: ${peerId}`,
  ];
  if (signals.likelyNewAccount === true) {
    lines.push("• Looks like a recent / newly-made account");
  }
  lines.push("• Not a verified customer or a regular");
  if (messageCount >= 3) {
    lines.push("");
    lines.push("They've now messaged 3+ times and still aren't verified.");
  }
  lines.push("");
  lines.push("If you know this person, just reply to them as normal — these alerts will stop.");
  lines.push(
    "If it's an unwanted stranger, tap below to block them on your phone AND on the bot and wipe the chat.",
  );
  return {
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [[{ text: "🚫 Block & delete", callback_data: `${PREFIX}${peerId}` }]],
    },
  };
}

// Delete the entire 1:1 history both sides. messages.deleteHistory returns an
// AffectedHistory with a non-zero `offset` while more remains; loop until
// drained (capped so a pathological case can't spin forever).
async function deleteWholeHistory(
  client: RegClient,
  peer: Api.TypeInputPeer,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = (await client.invoke(
      new Api.messages.DeleteHistory({ peer, revoke: true, maxId: 0, justClear: false }),
    )) as Api.messages.AffectedHistory;
    if (!res || typeof res.offset !== "number" || res.offset <= 0) break;
  }
}

type RegClient = ReturnType<typeof getUserbot> extends infer R
  ? R extends { client: infer C }
    ? C
    : never
  : never;

export async function handleSuspiciousCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? "";
  const peerId = data.slice(PREFIX.length).trim();

  // The acting moderator is the OWNER of the DM holding this button — derived
  // from the chat, never from callback data (which is forgeable). Authorize
  // server-side: only a moderator/admin can block.
  const modChatId = (query.message?.chat.id ?? query.from.id).toString();
  if (!isModerator(modChatId) && !isAdmin(modChatId)) {
    try { await bot.answerCallbackQuery(query.id, { text: "Not allowed." }); } catch {}
    return;
  }
  if (!/^\d+$/.test(peerId)) {
    try { await bot.answerCallbackQuery(query.id, { text: "Bad target." }); } catch {}
    return;
  }

  // 1) Bot side: block + wipe. blockAndWipe writes the blocklist row FIRST, so
  //    even a partial failure leaves the account blocked (fail-closed).
  let botOk = false;
  try {
    await blockAndWipe(peerId, "suspicious_unverified", modChatId);
    botOk = true;
  } catch (err) {
    logger.error({ err, modChatId, peerId }, "Suspicious block — bot side failed");
  }

  // 2) Personal-account side: block the peer + wipe the DM via the mod's own
  //    userbot session. Best-effort: if the InputPeer can't be resolved (e.g.
  //    after a restart cleared the in-memory cache) we report it so the mod can
  //    block manually on their phone.
  let phoneOk = false;
  const reg = getUserbot(modChatId);
  if (reg) {
    try {
      let ip = reg.inputPeers.get(peerId);
      if (!ip) {
        // Fallback when the in-memory InputPeer was evicted (e.g. after a
        // restart): resolve from gramjs's entity cache by numeric user id.
        // Telegram user ids fit comfortably in a JS number.
        ip = (await reg.client.getInputEntity(Number(peerId))) as Api.TypeInputPeer;
      }
      if (ip) {
        await reg.client.invoke(new Api.contacts.Block({ id: ip }));
        await deleteWholeHistory(reg.client, ip);
        reg.inputPeers.delete(peerId);
        phoneOk = true;
      }
    } catch (err) {
      logger.error({ err, modChatId, peerId }, "Suspicious block — userbot side failed");
    }
  } else {
    logger.warn({ modChatId, peerId }, "Suspicious block — no userbot registered for this mod");
  }

  const lines = [
    phoneOk
      ? "✅ Blocked on your phone + chat wiped."
      : "⚠️ Couldn't block on your phone automatically — block them manually there.",
    botOk
      ? "✅ Blocked on the bot + their data erased."
      : "⚠️ Couldn't block on the bot — try the button again.",
  ];
  try {
    await bot.answerCallbackQuery(query.id, {
      text: phoneOk && botOk ? "Blocked." : "Partly done — see message.",
    });
  } catch {}
  try {
    if (query.message) {
      await bot.editMessageText(lines.join("\n"), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    }
  } catch (err) {
    logger.warn({ err, modChatId, peerId }, "Suspicious block — alert edit failed");
  }
}
