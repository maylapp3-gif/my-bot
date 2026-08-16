import TelegramBot from "node-telegram-bot-api";
import { addTrusted, removeTrusted, listTrusted } from "../db.js";
import { isAdmin } from "./admin.js";
import { escapeMarkdown } from "../escape.js";
import { logger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Private "trusted broadcast" list.
//
// A separate, hand-curated audience that only the operator can edit. The
// trusted broadcast pushes an operator-typed message to exactly these chat
// IDs — never to the wider subscriber base. Reached only through the hidden
// passphrase surface (see hiddenOps.ts); nothing about it appears in the
// visible /admin panel, /help, or command autocomplete.
// ---------------------------------------------------------------------------

// Add a trusted member: `vip+ <chatId> [notes]`. Idempotent.
export async function handleAddTrusted(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  argsRaw: string,
): Promise<void> {
  const adminId = msg.chat.id.toString();
  if (!isAdmin(adminId)) return;
  const args = argsRaw.trim();
  if (!args) {
    await bot.sendMessage(
      adminId,
      "Usage: `<phrase> vip+ <chatId> [notes]`\n\nThe customer's chat ID is the long number you see on their order alerts.",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const [targetChatId, ...rest] = args.split(/\s+/);
  if (!/^-?\d+$/.test(targetChatId)) {
    await bot.sendMessage(adminId, "Chat ID must be a number. Try `<phrase> vip+ 123456789 OG mate`.", {
      parse_mode: "Markdown",
    });
    return;
  }
  const notes = rest.length > 0 ? rest.join(" ") : null;
  try {
    const { created } = await addTrusted(targetChatId, notes, adminId);
    await bot.sendMessage(
      adminId,
      created
        ? `✅ Added \`${targetChatId}\` to the *trusted broadcast* list.${notes ? `\n\n_Notes:_ ${escapeMarkdown(notes)}` : ""}`
        : `🔄 Already trusted — refreshed notes for \`${targetChatId}\`.${notes ? `\n\n_Notes:_ ${escapeMarkdown(notes)}` : ""}`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err, targetChatId }, "addTrusted failed");
    await bot.sendMessage(adminId, "Couldn't save that. Check the logs.");
  }
}

// Remove a trusted member: `vip- <chatId>`.
export async function handleRemoveTrusted(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  argsRaw: string,
): Promise<void> {
  const adminId = msg.chat.id.toString();
  if (!isAdmin(adminId)) return;
  const targetChatId = argsRaw.trim();
  if (!/^-?\d+$/.test(targetChatId)) {
    await bot.sendMessage(adminId, "Usage: `<phrase> vip- <chatId>`", { parse_mode: "Markdown" });
    return;
  }
  try {
    const removed = await removeTrusted(targetChatId);
    await bot.sendMessage(
      adminId,
      removed
        ? `🗑 Removed \`${targetChatId}\` from the trusted broadcast list.`
        : `_No trusted member found for \`${targetChatId}\`. Nothing to remove._`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err, targetChatId }, "removeTrusted failed");
    await bot.sendMessage(adminId, "Couldn't remove that. Check the logs.");
  }
}

// List the trusted broadcast roster: `vip`.
export async function handleListTrusted(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const adminId = msg.chat.id.toString();
  if (!isAdmin(adminId)) return;
  try {
    const rows = await listTrusted();
    if (rows.length === 0) {
      await bot.sendMessage(adminId, "_No trusted members yet. Use_ `<phrase> vip+ <chatId> [notes]` _to add one._", {
        parse_mode: "Markdown",
      });
      return;
    }
    // Telegram caps messages at 4096 chars; chunk to 50 entries per message.
    const lines = rows.map((r) => {
      const notes = r.notes ? ` — _${escapeMarkdown(r.notes)}_` : "";
      const added = r.addedAt.toISOString().slice(0, 10);
      return `• \`${r.chatId}\`${notes}  (added ${added})`;
    });
    const PAGE = 50;
    const totalPages = Math.ceil(lines.length / PAGE);
    for (let p = 0; p < totalPages; p++) {
      const slice = lines.slice(p * PAGE, (p + 1) * PAGE);
      const header =
        totalPages === 1
          ? `🔐 *Trusted broadcast list (${rows.length})*`
          : `🔐 *Trusted broadcast list (${rows.length})* — page ${p + 1}/${totalPages}`;
      await bot.sendMessage(adminId, `${header}\n\n${slice.join("\n")}`, { parse_mode: "Markdown" });
    }
  } catch (err) {
    logger.error({ err }, "listTrusted failed");
    await bot.sendMessage(adminId, "Couldn't list the trusted broadcast list. Check the logs.");
  }
}

// Telegram caps sends to different chats at ~30/sec. Pace at ~28/sec.
const BROADCAST_DELAY_MS = 36;

// Send an operator-typed message to every trusted member: `vipblast <message>`.
// Unlike the all-contacts blast, a permanent delivery failure here does NOT
// auto-remove the member — the list is hand-curated, so we report failures and
// let the operator prune by hand with `vip- <id>`.
export async function handleTrustedBroadcast(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  text: string,
): Promise<void> {
  const adminId = msg.chat.id.toString();
  if (!isAdmin(adminId)) return;
  const body = text.trim();
  if (!body) {
    await bot.sendMessage(adminId, "Usage: `<phrase> vipblast <message>`", { parse_mode: "Markdown" });
    return;
  }

  const rows = await listTrusted();
  if (rows.length === 0) {
    await bot.sendMessage(adminId, "_No trusted members to send to. Add one with_ `<phrase> vip+ <chatId>`.", {
      parse_mode: "Markdown",
    });
    return;
  }

  await bot.sendMessage(adminId, `🔐 Sending to ${rows.length} trusted member(s)… (paced ~28/sec)`);

  let sent = 0;
  const failedIds: string[] = [];
  // Plain text (no parse_mode) so operator input can't break Telegram parsing.
  for (const r of rows) {
    try {
      await bot.sendMessage(r.chatId, body);
      sent++;
    } catch (err) {
      failedIds.push(r.chatId);
      logger.error({ err, targetChatId: r.chatId }, "trusted broadcast: send failed");
    }
    await new Promise((resolve) => setTimeout(resolve, BROADCAST_DELAY_MS));
  }

  const failLines =
    failedIds.length > 0
      ? `\n• Failed: ${failedIds.length}\n` +
        failedIds.map((id) => `   ◦ \`${id}\``).join("\n") +
        `\n\n_Failures are kept on the list. Remove any dead ones with_ \`<phrase> vip- <id>\`.`
      : "";
  await bot.sendMessage(adminId, `🔐 Trusted broadcast done.\n• Delivered: ${sent}/${rows.length}${failLines}`, {
    parse_mode: "Markdown",
  });
}
