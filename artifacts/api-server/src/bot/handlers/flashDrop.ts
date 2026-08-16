import TelegramBot from "node-telegram-bot-api";
import {
  createDrop,
  getDrop,
  tryClaimDropUnit,
  cancelDrop,
  listActiveDrops,
  getVariant,
  getActiveSubscribers,
  addSubscriber,
  addToCart,
  formatPriceCents,
  setVariantStock,
} from "../db.js";
import { productsTable, productVariantsTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isAdmin } from "./admin.js";
import { getModeratorIds } from "../moderation.js";
import { startCheckout } from "./cart.js";
import { escapeMarkdown } from "../escape.js";
import { notifyTeamStockChange } from "../stockCheck.js";
import { logger } from "../../lib/logger.js";

const CB_PREFIX = "fd:";

export function isFlashDropCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

// In-memory map: dropId -> [{chatId, messageId}] of broadcast messages, so
// we can edit the "N left" counter on remaining recipients after each tap
// (best effort — out-of-process restarts wipe this; the button still works,
// just shows a stale count until tapped).
type BroadcastRef = { chatId: string; messageId: number };
const dropBroadcasts = new Map<number, BroadcastRef[]>();

// ---------------------------------------------------------------------------
// /drop — admin command, two flavors:
//   /drop <variantId> <qty> [copy...]              (no photo)
//   /drop <variantId> <qty> [copy...]  + replied-to photo  (photo attached)
// Where variantId is the numeric ID shown in /stock_report.
// ---------------------------------------------------------------------------
export async function handleDropCommand(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  rawArgs: string,
): Promise<void> {
  const actorChatId = msg.chat.id.toString();
  if (!isAdmin(actorChatId)) {
    await bot.sendMessage(actorChatId, "⛔ Admin only.");
    return;
  }

  const parts = rawArgs.trim().split(/\s+/);
  const variantId = parseInt(parts[0] ?? "", 10);
  const qty = parseInt(parts[1] ?? "", 10);
  const copy = parts.slice(2).join(" ").trim();

  if (!Number.isInteger(variantId) || !Number.isInteger(qty) || qty < 1 || qty > 9999) {
    await bot.sendMessage(
      actorChatId,
      "Usage: `/drop <variantId> <qty> [copy...]`\n\n" +
        "Reply to a photo with the command to attach it to the broadcast.\n" +
        "Look up variantId in /stock\\_report.\n\n" +
        "Example: `/drop 42 5 fresh GMO just landed, FCFS`",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const variant = await getVariant(variantId);
  if (!variant) {
    await bot.sendMessage(actorChatId, `❌ No variant with ID ${variantId}.`);
    return;
  }
  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, variant.productId));
  if (!product) {
    await bot.sendMessage(actorChatId, `❌ Variant ${variantId} has no product.`);
    return;
  }

  // Photo: if the admin replied to a photo message, grab the highest-res
  // file_id from that. Otherwise the drop goes out as a text-only blast.
  const repliedPhoto = msg.reply_to_message?.photo;
  const photoFileId = repliedPhoto && repliedPhoto.length > 0
    ? repliedPhoto[repliedPhoto.length - 1].file_id
    : null;

  const drop = await createDrop({
    variantId,
    qtyTotal: qty,
    copy,
    photoFileId,
    createdBy: actorChatId,
  });

  // Build the broadcast payload.
  const headline = `🔥 *FLASH DROP* — ${escapeMarkdown(product.name)} (${escapeMarkdown(variant.label)})`;
  const priceLine = `Price: *${formatPriceCents(variant.priceCents)}*`;
  const stockLine = copy ? `\n\n${escapeMarkdown(copy)}` : "";

  const buildText = (remaining: number) =>
    `${headline}\n${priceLine}${stockLine}\n\n_${remaining} left · first come first served_`;
  const buildKb = (remaining: number): TelegramBot.InlineKeyboardMarkup => ({
    inline_keyboard: [[
      { text: `🟢 Grab one (${remaining} left)`, callback_data: `fd:g:${drop.id}` },
    ]],
  });

  // Telegram caps bot sends at ~30/sec globally. Pace at ~28/sec to leave
  // headroom for other concurrent traffic (mod pings, customer DMs).
  // Without this, a >100-sub drop trips 429 Too Many Requests mid-blast.
  const BROADCAST_DELAY_MS = 36;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const subs = await getActiveSubscribers();
  const refs: BroadcastRef[] = [];
  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    try {
      const opts = {
        parse_mode: "Markdown" as const,
        reply_markup: buildKb(qty),
      };
      const sentMsg = photoFileId
        ? await bot.sendPhoto(sub.chatId, photoFileId, {
            caption: buildText(qty),
            ...opts,
          })
        : await bot.sendMessage(sub.chatId, buildText(qty), opts);
      refs.push({ chatId: sub.chatId, messageId: sentMsg.message_id });
      sent++;
    } catch (err) {
      failed++;
      logger.warn({ err, sub: sub.chatId, dropId: drop.id }, "flash drop send failed");
    }
    await sleep(BROADCAST_DELAY_MS);
  }
  dropBroadcasts.set(drop.id, refs);

  // Confirm to admin.
  await bot.sendMessage(
    actorChatId,
    `🚀 Drop #${drop.id} live — *${escapeMarkdown(product.name)} ${escapeMarkdown(variant.label)}* x${qty}\n` +
      `Delivered to *${sent}* subs${failed ? `, ${failed} failed` : ""}.\n\n` +
      `Cancel with: \`/drop_cancel ${drop.id}\``,
    { parse_mode: "Markdown" },
  );

  // Fan the FULL drop preview to every moderator (not just a one-line
  // announcement) so the team sees exactly what customers are seeing.
  // Mods aren't in subscribersTable, so they'd otherwise miss it entirely.
  // No Grab button on the mod copy — they're not the audience for the
  // claim, and the atomic decrement should be customer-driven only.
  // Dedupe against subs that already received the broadcast.
  const subChatIds = new Set(refs.map((r) => r.chatId));
  const modPreviewHeader =
    `🚀 *MOD PREVIEW — Flash Drop #${drop.id}*\n` +
    `${escapeMarkdown(product.name)} ${escapeMarkdown(variant.label)} · ${qty} units · ${formatPriceCents(variant.priceCents)} each\n` +
    `Broadcast to *${sent}* subs${failed ? ` · ${failed} failed` : ""}\n` +
    `━━━━━━━━━━━━━━━━━━`;
  const modPreviewBody = `\n${buildText(qty)}`;
  let modSent = 0;
  let modFailed = 0;
  for (const id of getModeratorIds()) {
    if (id === actorChatId) continue;
    if (subChatIds.has(id)) continue;
    try {
      await bot.sendMessage(id, modPreviewHeader, { parse_mode: "Markdown" });
      if (photoFileId) {
        await bot.sendPhoto(id, photoFileId, {
          caption: buildText(qty),
          parse_mode: "Markdown",
        });
      } else {
        await bot.sendMessage(id, modPreviewBody, { parse_mode: "Markdown" });
      }
      modSent++;
    } catch (err) {
      modFailed++;
      logger.error({ err, modId: id, dropId: drop.id }, "flash drop mod preview failed");
    }
    await sleep(BROADCAST_DELAY_MS);
  }
  if (modFailed > 0 || modSent === 0) {
    // Tell the admin so they're not flying blind if mod delivery is broken
    // (wrong env var, mod blocked the bot, etc.).
    await bot.sendMessage(
      actorChatId,
      `ℹ️ Mod preview delivery: *${modSent}* sent` +
        (modFailed ? `, *${modFailed}* failed (check logs)` : `` ) +
        (modSent === 0 && modFailed === 0 ? ` — no moderators configured outside the admin sender.` : ``),
      { parse_mode: "Markdown" },
    );
  }
}

// ---------------------------------------------------------------------------
// /drop_cancel <id> — admin pulls a drop early. Won't refund existing claims
// (those already became cart items the customers are mid-checkout on); just
// freezes any further grabs.
// ---------------------------------------------------------------------------
export async function handleDropCancel(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  dropIdStr: string,
): Promise<void> {
  const actorChatId = msg.chat.id.toString();
  if (!isAdmin(actorChatId)) {
    await bot.sendMessage(actorChatId, "⛔ Admin only.");
    return;
  }
  const dropId = parseInt(dropIdStr, 10);
  if (!Number.isInteger(dropId)) {
    await bot.sendMessage(actorChatId, "Usage: `/drop_cancel <id>`", { parse_mode: "Markdown" });
    return;
  }
  const ok = await cancelDrop(dropId);
  if (!ok) {
    await bot.sendMessage(actorChatId, `❌ Drop #${dropId} isn't active.`);
    return;
  }
  // Strip the Grab buttons on all broadcast messages.
  const refs = dropBroadcasts.get(dropId) ?? [];
  for (const ref of refs) {
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ref.chatId, message_id: ref.messageId });
    } catch {
      // best effort
    }
  }
  dropBroadcasts.delete(dropId);
  await bot.sendMessage(actorChatId, `🛑 Drop #${dropId} cancelled. Buttons stripped from broadcasts.`);
}

// ---------------------------------------------------------------------------
// /drops — admin list of currently-active drops.
// ---------------------------------------------------------------------------
export async function handleDropsList(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const actorChatId = msg.chat.id.toString();
  if (!isAdmin(actorChatId)) return;
  const active = await listActiveDrops();
  if (active.length === 0) {
    await bot.sendMessage(actorChatId, "No active drops.");
    return;
  }
  const lines: string[] = ["*Active drops:*"];
  for (const d of active) {
    const v = await getVariant(d.variantId);
    const [p] = v
      ? await db.select().from(productsTable).where(eq(productsTable.id, v.productId))
      : [undefined];
    const label = p && v ? `${escapeMarkdown(p.name)} ${escapeMarkdown(v.label)}` : `variant #${d.variantId}`;
    lines.push(`#${d.id} · ${label} · ${d.qtyRemaining}/${d.qtyTotal} left`);
  }
  await bot.sendMessage(actorChatId, lines.join("\n"), { parse_mode: "Markdown" });
}

// ---------------------------------------------------------------------------
// Callback: fd:g:<dropId>  — customer taps "Grab one"
// ---------------------------------------------------------------------------
export async function handleFlashDropCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const chatId = query.from.id.toString();
  const data = query.data ?? "";
  const parts = data.split(":");
  const op = parts[1];
  const dropId = parseInt(parts[2] ?? "", 10);

  if (op !== "g" || !Number.isInteger(dropId)) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  const msgChatId = query.message?.chat.id;
  const messageId = query.message?.message_id;

  // Try the atomic claim. This either decrements qty_remaining by 1 or
  // returns null (sold out / cancelled / drop gone).
  const result = await tryClaimDropUnit(dropId).catch((err) => {
    logger.error({ err, dropId, chatId }, "tryClaimDropUnit threw");
    return null;
  });

  if (!result) {
    await bot.answerCallbackQuery(query.id, {
      text: "💨 Just sold out — try the Menu for similar.",
      show_alert: true,
    });
    if (msgChatId && messageId) {
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msgChatId, message_id: messageId });
      } catch {
        // best effort
      }
    }
    return;
  }

  const drop = await getDrop(dropId);
  if (!drop) {
    await bot.answerCallbackQuery(query.id, { text: "Drop gone.", show_alert: false });
    return;
  }
  const variant = await getVariant(drop.variantId);
  if (!variant) {
    await bot.answerCallbackQuery(query.id, { text: "Item gone.", show_alert: false });
    return;
  }
  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, variant.productId));

  // Make sure tapper is registered as a subscriber. A forwarded broadcast
  // can land in front of someone who isn't subbed yet — let them grab,
  // then opt them into future drops. Idempotent upsert.
  try {
    await addSubscriber({
      chatId,
      username: query.from.username ?? null,
      firstName: query.from.first_name ?? null,
      lastName: query.from.last_name ?? null,
    });
  } catch (err) {
    logger.warn({ err, chatId }, "flash drop addSubscriber failed (continuing)");
  }

  // Add to cart + jump straight to checkout step 1.
  try {
    await addToCart(chatId, variant.id, 1);
  } catch (err) {
    logger.error({ err, chatId, variantId: variant.id }, "flash drop addToCart failed");
    await bot.answerCallbackQuery(query.id, {
      text: "Couldn't add to cart — try the Menu.",
      show_alert: true,
    });
    return;
  }

  await bot.answerCallbackQuery(query.id, { text: "✅ Locked in — checkout below." });

  // Strip the button from the tapper's broadcast so they can't double-grab
  // through the same message.
  if (msgChatId && messageId) {
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msgChatId, message_id: messageId });
    } catch {
      // best effort
    }
  }

  await startCheckout(bot, chatId);

  // Mod fanout: who grabbed, how many left. Quiet plain-text — no Markdown
  // so a screen name with stray * never bounces the ping.
  const handle = query.from.username ? `@${query.from.username}` : `id ${chatId}`;
  const label = product && variant ? `${product.name} ${variant.label}` : `variant #${variant.id}`;
  const note = result.exhausted
    ? `🟢 ${handle} grabbed the last ${label} — drop #${dropId} SOLD OUT 💥`
    : `🟢 ${handle} grabbed 1× ${label} — ${result.remaining} left (drop #${dropId})`;
  for (const id of getModeratorIds()) {
    try {
      await bot.sendMessage(id, note);
    } catch (err) {
      logger.error({ err, modId: id, dropId }, "flash drop grab mod ping failed");
    }
  }

  // ---------------------------------------------------------------------
  // Stock-system integration: when a drop hits zero, that variant is gone
  // for now — flip it to sold_out in the canonical stock state so the
  // Menu hides it for future browsers, and fire the same notifyTeamStockChange
  // broadcast that every other stock mutation uses. One pipeline, one
  // source of truth, mods get the same "📦 Stock update 🔴" card they
  // always do.
  // ---------------------------------------------------------------------
  if (result.exhausted && product && variant) {
    try {
      const updated = await setVariantStock(variant.id, "sold_out");
      if (updated) {
        await notifyTeamStockChange(bot, {
          productName: product.name,
          productEmoji: product.emoji ?? "🌿",
          variantLabel: variant.label,
          variantId: variant.id,
          targetState: "sold_out",
          actor: `drop #${dropId} sell-through`,
          source: "flash_drop",
        });
      }
    } catch (err) {
      logger.error({ err, dropId, variantId: variant.id }, "flash drop stock-flip failed");
    }
  }

  // Best-effort: update the "N left" counter on every still-listed broadcast.
  // Skip the tapper (already stripped) and skip if the drop is exhausted
  // (we'll strip them all instead).
  const refs = dropBroadcasts.get(dropId);
  if (refs) {
    if (result.exhausted) {
      for (const ref of refs) {
        if (ref.chatId === chatId && ref.messageId === messageId) continue;
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ref.chatId, message_id: ref.messageId });
        } catch {
          // best effort
        }
      }
      dropBroadcasts.delete(dropId);
    } else {
      const newKb: TelegramBot.InlineKeyboardMarkup = {
        inline_keyboard: [[
          { text: `🟢 Grab one (${result.remaining} left)`, callback_data: `fd:g:${dropId}` },
        ]],
      };
      for (const ref of refs) {
        if (ref.chatId === chatId && ref.messageId === messageId) continue;
        try {
          await bot.editMessageReplyMarkup(newKb, { chat_id: ref.chatId, message_id: ref.messageId });
        } catch {
          // best effort — message may have been deleted by customer
        }
      }
    }
  }
}
