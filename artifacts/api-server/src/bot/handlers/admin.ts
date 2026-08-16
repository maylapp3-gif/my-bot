import TelegramBot from "node-telegram-bot-api";
import {
  getAvailableProducts,
  toggleProduct,
  getOrders,
  transitionPendingOrder,
  getActiveSubscribers,
  removeSubscriber,
  addRelay,
  removeRelay,
  getRelays,
} from "../db.js";
import { logger } from "../../lib/logger.js";
import { escapeMarkdown } from "../escape.js";
import { sendMarkdownSafe } from "../sendUtil.js";
import { sendEodSummary } from "../eod.js";
import { isModerator } from "../moderation.js";
import { applyOrderTransition } from "./orderActions.js";

// Read at every call so env changes (Replit Secrets edits) are picked up without redeploy.
export function getAdminIds(): string[] {
  return (process.env.ADMIN_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdmin(chatId: string): boolean {
  return getAdminIds().includes(chatId);
}

export async function handleAdmin(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) {
    // Hook the suspicious-attempt tracker — /admin is the highest-signal
    // probe a would-be attacker could try, so we count rejections here.
    const { recordSuspiciousAdminAttempt } = await import("../security.js");
    recordSuspiciousAdminAttempt(bot, chatId, "/admin");
    return bot.sendMessage(chatId, "⛔ Admin access required.");
  }

  // Sent as plain text — command names contain underscores which Telegram
  // Markdown V1 interprets as italic markers and breaks parsing.
  // ⚠️ Decoy admin panel — intentionally sparse. Nothing here references
  // contacts, broadcasts, backups, regulars, or panic-wipe. Those live
  // behind the hidden ops surface (see `bot/hiddenOps.ts`) and are only
  // accessible by typing the operator's private passphrase.
  await bot.sendMessage(
    chatId,
    `🔧 Admin Panel\n\n` +
    `Orders:\n` +
    `/pending_orders — View pending orders\n` +
    `/confirmall — Confirm every pending order in one shot (notifies each customer)\n` +
    `/all_orders — View all orders\n` +
    `/eod — End-of-day sales summary (auto-sent at close)\n` +
    `/pickup — Extra pickup times today, on top of open hours (e.g. /pickup 10am-1pm, /pickup off)\n\n` +
    `Products (button-driven manager):\n` +
    `/menu — Open the product manager (add, edit, hide, reorder, delete)\n` +
    `/add_product — Shortcut into the product manager\n` +
    `/list_products — Quick list (text-only)\n\n` +
    `Broadcasts (tap a button below, or type the command):\n` +
    `/broadcast — Send to every active subscriber (text or photo+caption)\n` +
    `/send — Pick exactly who gets a message (tick a checklist)\n` +
    `/announce — Send to the moderator team only (text or photo+caption)\n\n` +
    `Raffles (24h giveaways — announce and draw the same day):\n` +
    `/raffles — List raffles + live entry counts\n` +
    `/add_raffle CODE <prize> — Start one (customers enter with /raffle CODE)\n` +
    `/draw_raffle CODE [how many] — Pick winner(s) now; they get a generic DM\n` +
    `/del_raffle CODE — Delete a raffle and clear its entries\n\n` +
    `Subscribers:\n` +
    `/remove_sub <@user or id> — Permanently wipe a suspicious customer (accepts several at once)\n` +
    `/reset_verify <@user or id> — Send a customer back through new-customer verification\n\n` +
    `Safety — block by LeafedOut profile (sticks across new Telegram accounts):\n` +
    `/ban_handle <LeafedOut handle> — Bar a profile from verifying ANY account\n` +
    `/unban_handle <LeafedOut handle> — Lift a profile ban\n\n` +
    `Relays:\n` +
    `/add_relay <label> — Add this chat as an order relay\n` +
    `/remove_relay — Remove this chat from relays\n` +
    `/list_relays — List relay channels\n\n` +
    `Userbot auto-reply (always on — fires after 5min of no reply):\n` +
    `/driving — see your current auto-reply text\n` +
    `/driving <message> — set a custom auto-reply\n` +
    `/driving reset — revert to the default auto-reply\n\n` +
    `Manual handover (rarely needed — customers DM the mod directly after ordering):\n` +
    `/take <chatId> — Claim a customer chat (silences AI for that chat)\n` +
    `/bypass <@user or id> — Let a new customer skip verification (exceptions only; admins get notified)\n` +
    `/reply <chatId> <message> — Reply through the bot\n` +
    `/release <chatId> — Drop your claim\n` +
    `/forcerelease <chatId> — Override another mod's claim\n` +
    `/active — Show currently claimed chats\n` +
    `/mods — Show configured moderator IDs`
  );
  // One-tap entry points into the compose-then-send broadcast flow. Sent
  // as a follow-up message because the admin-panel summary above is plain
  // text and Telegram only attaches one inline keyboard per message.
  const { broadcastPanelKeyboard } = await import("./broadcastFlow.js");
  return bot.sendMessage(
    chatId,
    "📢 *Start a broadcast*\n_Tap to compose — supports photos with captions._",
    { parse_mode: "Markdown", reply_markup: broadcastPanelKeyboard() },
  );
}

export async function handleListProducts(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const products = await getAvailableProducts();
  if (products.length === 0) return bot.sendMessage(chatId, "No products yet.");
  let text = "📦 *Products*\n\n";
  for (const p of products) {
    text += `#${p.id} *${escapeMarkdown(p.name)}* — ${escapeMarkdown(p.price)}\n${escapeMarkdown(p.description)}\n\n`;
  }
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

export async function handlePendingOrders(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const orders = await getOrders("pending");
  if (orders.length === 0) return bot.sendMessage(chatId, "No pending orders! 🎉");
  let text = "⏳ *Pending Orders*\n\n";
  for (const o of orders) {
    text += `*#${o.id}* — ${escapeMarkdown(o.customerName)}${o.customerUsername ? ` (@${escapeMarkdown(o.customerUsername)})` : ""}\n📦 ${escapeMarkdown(o.items)}\n${o.deliveryArea ? `📍 ${escapeMarkdown(o.deliveryArea)}\n` : ""}${o.preferredTime ? `🕐 ${escapeMarkdown(o.preferredTime)}\n` : ""}${o.notes ? `📝 ${escapeMarkdown(o.notes)}\n` : ""}${o.groupOptin ? `🤝 _group-ok — pair with a nearby order, waive delivery_\n` : ""}\n`;
  }
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

export async function handleAllOrders(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const orders = await getOrders();
  if (orders.length === 0) return bot.sendMessage(chatId, "No orders yet.");
  let text = "📋 *All Orders*\n\n";
  for (const o of orders.slice(-10)) {
    text += `*#${o.id}* [${o.status.toUpperCase()}] — ${escapeMarkdown(o.customerName)}\n📦 ${escapeMarkdown(o.items)}\n\n`;
  }
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

export async function handleOrderStatusUpdate(bot: TelegramBot, msg: TelegramBot.Message, command: string) {
  const chatId = msg.chat.id.toString();
  // Mods (not just admins) handle order confirmations — they get the alerts.
  if (!isAdmin(chatId) && !isModerator(chatId)) return;
  const [cmd, idStr] = command.split("_");
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return bot.sendMessage(chatId, "Invalid order ID.");

  const status: "confirmed" | "cancelled" = cmd === "confirm" ? "confirmed" : "cancelled";
  const result = await applyOrderTransition(bot, id, status, chatId);
  if (!result.ok) {
    return bot.sendMessage(
      chatId,
      `Order #${id} is already processed (or doesn't exist). No change made.`,
    );
  }
  return bot.sendMessage(chatId, `Order #${id} marked as ${status}.`);
}

// Bulk-confirm every pending order in one shot. Useful when a batch comes in
// during a busy window and the mod just wants to clear the queue. Races with
// single-order /confirm_<id> are safe because each order goes through the
// same atomic transitionPendingOrder — the second mover sees "already
// processed" and silently skips.
export async function handleConfirmAll(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  // Mods (not just admins) can confirm — they're the ones receiving alerts.
  if (!isAdmin(chatId) && !isModerator(chatId)) return;

  const pending = await getOrders("pending");
  if (pending.length === 0) {
    return bot.sendMessage(chatId, "No pending orders to confirm. 🎉");
  }

  let confirmed = 0;
  let alreadyProcessed = 0;
  let notifyFailed = 0;
  const confirmedIds: number[] = [];

  for (const o of pending) {
    const row = await transitionPendingOrder(o.id, "confirmed");
    if (!row) {
      // Another mod confirmed/cancelled it between our list and our flip.
      alreadyProcessed++;
      continue;
    }
    confirmed++;
    confirmedIds.push(row.id);
    try {
      await bot.sendMessage(
        row.chatId,
        `🔥 Your Order #${row.id} is *confirmed* — we're on the way. 🛵`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      notifyFailed++;
      logger.error({ err, orderId: row.id }, "/confirmall: failed to notify customer");
    }
    // Light pacing to stay well under Telegram's per-second cap when there
    // are a lot of orders in the queue.
    await new Promise((r) => setTimeout(r, 50));
  }

  // Forensic minimization: report counts only — never echo the list of order
  // IDs back into chat history (a seized device would otherwise show a tidy
  // map of "who ordered how much, when").
  const noteLines = [
    `*Confirmed:* ${confirmed}`,
    alreadyProcessed > 0 ? `*Already processed (race):* ${alreadyProcessed}` : null,
    notifyFailed > 0 ? `*Customer notify failed:* ${notifyFailed} (logged)` : null,
  ].filter(Boolean).join("\n");
  void confirmedIds; // intentionally unused — see comment above

  return bot.sendMessage(
    chatId,
    `✅ */confirmall complete*\n\n${noteLines}`,
    { parse_mode: "Markdown" },
  );
}

export async function handleSubscribers(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  const subs = await getActiveSubscribers();
  // Large subscriber lists blow past Telegram's 4096-char cap; sendMarkdownSafe
  // chunks on line boundaries and degrades to plain text if markdown slips past.
  const body = `👥 *Active Subscribers: ${subs.length}*\n\n` + subs.map((s) => `• ${escapeMarkdown(s.firstName ?? "")} ${escapeMarkdown(s.lastName ?? "")} ${s.username ? `(@${escapeMarkdown(s.username)})` : ""} — ID: \`${s.chatId}\``).join("\n");
  await sendMarkdownSafe(bot, chatId, body);
}

// Telegram bots are limited to ~30 messages/sec to different chats. We pace
// broadcasts at ~28/sec to stay under the cap and avoid 429s. For large
// subscriber lists this matters; for small ones the delay is negligible.
const BROADCAST_DELAY_MS = 36;

// Detect "user has blocked the bot / chat is gone / account deleted" — these
// permanent failures are returned by Telegram's HTTP API as 403 (forbidden) or
// 400 with specific descriptions. We auto-deactivate those subscribers so
// future broadcasts don't keep retrying dead chats.
function isPermanentDeliveryFailure(err: unknown): boolean {
  const e = err as { response?: { body?: { error_code?: number; description?: string } }; code?: number };
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

export async function handleBroadcast(bot: TelegramBot, msg: TelegramBot.Message, text: string) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  if (!text.trim()) return bot.sendMessage(chatId, "Usage: /broadcast <your message>");

  const subs = await getActiveSubscribers();
  await bot.sendMessage(chatId, `📢 Sending to ${subs.length} subscribers… (paced ~28/sec)`);

  let sent = 0;
  let cleaned = 0;
  // Send broadcast as plain text (no parse_mode) to avoid Markdown injection from admin input.
  const body = `📢 Announcement\n\n${text}`;
  for (const sub of subs) {
    try {
      await bot.sendMessage(sub.chatId, body);
      sent++;
    } catch (err) {
      if (isPermanentDeliveryFailure(err)) {
        // Mark this subscriber inactive so we don't keep hitting them on every
        // future broadcast. They can /start again to re-subscribe.
        try {
          await removeSubscriber(sub.chatId);
          cleaned++;
        } catch (deactErr) {
          logger.error({ err: deactErr, subChatId: sub.chatId }, "Failed to deactivate dead subscriber");
        }
        logger.info({ subChatId: sub.chatId }, "Auto-deactivated subscriber after permanent delivery failure");
      } else {
        logger.error({ err, subChatId: sub.chatId }, "Broadcast failed for subscriber (transient)");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, BROADCAST_DELAY_MS));
  }
  return bot.sendMessage(
    chatId,
    `📢 Broadcast done.\n` +
    `• Delivered: ${sent}/${subs.length}\n` +
    (cleaned > 0 ? `• Auto-removed (blocked / deleted bot): ${cleaned}\n` : "") +
    (sent < subs.length - cleaned ? `• Transient failures: ${subs.length - sent - cleaned}` : "")
  );
}

export async function handleAddRelay(bot: TelegramBot, msg: TelegramBot.Message, label: string) {
  // Auth check uses the sender's user id (msg.from), NOT msg.chat.id —
  // because /add_relay is meant to be run from inside a group, and the
  // group's chat id is the *relay target*, never an admin allowlist entry.
  const senderId = msg.from?.id?.toString();
  const chatId = msg.chat.id.toString();
  if (!senderId || !isAdmin(senderId)) return;
  if (!label.trim()) return bot.sendMessage(chatId, "Usage: /add_relay <label>\nExample: /add_relay Kitchen Team");
  await addRelay({ chatId, username: msg.chat.type === "private" ? msg.from?.username : (msg.chat as { username?: string }).username, label: label.trim(), active: true });
  return bot.sendMessage(chatId, `🤙 This chat added as relay: "${label}"`);
}

export async function handleRemoveRelay(bot: TelegramBot, msg: TelegramBot.Message) {
  const senderId = msg.from?.id?.toString();
  const chatId = msg.chat.id.toString();
  if (!senderId || !isAdmin(senderId)) return;
  await removeRelay(chatId);
  return bot.sendMessage(chatId, "🤙 This chat removed from order relays.");
}

export async function handleEod(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  try {
    await sendEodSummary(bot, chatId);
  } catch (err) {
    logger.error({ err }, "handleEod error");
    await bot.sendMessage(chatId, "Couldn't build the EOD summary right now. Please try again shortly.");
  }
}

export async function handleListRelays(bot: TelegramBot, msg: TelegramBot.Message) {
  const senderId = msg.from?.id?.toString();
  const chatId = msg.chat.id.toString();
  if (!senderId || !isAdmin(senderId)) return;
  const relays = await getRelays();
  if (relays.length === 0) return bot.sendMessage(chatId, "No relays configured yet.\nUse /add_relay <label> to add one.");
  return bot.sendMessage(chatId, `📡 *Active Relays*\n\n` + relays.map((r) => `• ${escapeMarkdown(r.label)} — \`${r.chatId}\`${r.username ? ` (@${escapeMarkdown(r.username)})` : ""}`).join("\n"), { parse_mode: "Markdown" });
}
