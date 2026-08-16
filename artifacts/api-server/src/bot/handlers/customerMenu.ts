import TelegramBot from "node-telegram-bot-api";
import {
  getAvailableProducts,
  getProduct,
  getProductVariants,
  formatPriceCents,
  type Product,
  type ProductVariant,
} from "../db.js";
import { logger } from "../../lib/logger.js";
import {
  weeklyScheduleLine,
  weeklyScheduleBullets,
  todayHoursBullets,
  openStatusLine,
} from "../hours.js";
import { BRAND_NAME } from "../brand.js";
import { handleMyOrders } from "./order.js";
import { handleContact, handleLegal, handleHowItWorks } from "./contact.js";
import { escapeMarkdown } from "../escape.js";
import { emojiFor } from "../emoji.js";
import { openCart, addVariantToCart, getCartCount } from "./cart.js";
import { handlePick } from "./matchmaker.js";
import { handleReferral } from "./referral.js";
import { listBundlesActive, formatPriceCents as fmtCents } from "../db.js";

// ---------------------------------------------------------------------------
// Persistent reply keyboard — always at the bottom of the chat.
// IMPORTANT: each label here MUST stay in ALL_REPLY_BUTTONS below or the
// catch-all message handler will route the press to the AI instead.
// ---------------------------------------------------------------------------
const BTN_HOURS = "🕑 Today's Hours";
const BTN_PRODUCTS = "Menu";
const BTN_CART = "🛒 Cart";
const BTN_MY_ORDERS = "My Orders";
const BTN_CONTACT = "Contact";
const BTN_HOW = "How it works";
const BTN_LEGAL = "Rules";
const BTN_ASK = "Ask us";
const BTN_PICK = "🤖 Help me pick";
const BTN_REFER = "🎁 Refer a mate";

const ALL_REPLY_BUTTONS = new Set<string>([
  BTN_HOURS,
  BTN_PRODUCTS,
  BTN_CART,
  BTN_MY_ORDERS,
  BTN_CONTACT,
  BTN_HOW,
  BTN_LEGAL,
  BTN_ASK,
  BTN_PICK,
  BTN_REFER,
]);

export function customerReplyKeyboard(): TelegramBot.SendMessageOptions["reply_markup"] {
  return {
    keyboard: [
      [{ text: BTN_HOURS }],
      [{ text: BTN_PRODUCTS }, { text: BTN_CART }],
      [{ text: BTN_MY_ORDERS }, { text: BTN_CONTACT }],
      [{ text: BTN_PICK }, { text: BTN_REFER }],
      [{ text: BTN_HOW }, { text: BTN_LEGAL }],
      [{ text: BTN_ASK }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function isCustomerMenuButton(text: string | undefined): boolean {
  return !!text && ALL_REPLY_BUTTONS.has(text.trim());
}

export async function handleCustomerMenuButton(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
  const text = (msg.text ?? "").trim();
  const chatId = msg.chat.id.toString();
  switch (text) {
    case BTN_HOURS:
      await sendTodaysHours(bot, chatId);
      return true;
    case BTN_PRODUCTS:
      await openProductBrowser(bot, chatId);
      return true;
    case BTN_CART:
      await openCart(bot, chatId);
      return true;
    case BTN_MY_ORDERS:
      await handleMyOrders(bot, msg);
      return true;
    case BTN_CONTACT:
      await handleContact(bot, msg);
      return true;
    case BTN_HOW:
      await handleHowItWorks(bot, msg);
      return true;
    case BTN_LEGAL:
      await handleLegal(bot, msg);
      return true;
    case BTN_PICK:
      await handlePick(bot, msg);
      return true;
    case BTN_REFER:
      await handleReferral(bot, msg);
      return true;
    case BTN_ASK:
      await bot.sendMessage(
        msg.chat.id,
        `*Ask us anything*\n\n` +
          `Type a question — menu, an order, payment, hours, whatever.\n\n` +
          `Team will reply. If we're slow, our AI jumps in so you're not left hanging.`,
        { parse_mode: "Markdown", reply_markup: customerReplyKeyboard() },
      );
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Today's Hours page — one tap, zero guesswork about availability. Shows a
// live open/closed status line, today's bullet block, and the full week.
// ---------------------------------------------------------------------------
export async function sendTodaysHours(bot: TelegramBot, chatId: string): Promise<void> {
  const text =
    `🕑 *Today's Hours*\n\n` +
    `${openStatusLine()}\n\n` +
    `*Today*\n` +
    `${todayHoursBullets()}\n\n` +
    `*This week*\n` +
    `${weeklyScheduleBullets()}\n\n` +
    `_Orders can be sent any time — we confirm and lock in details during open hours._`;
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: customerReplyKeyboard(),
  });
}

// ---------------------------------------------------------------------------
// Customer-facing /menu — main hub
// ---------------------------------------------------------------------------
export async function openCustomerMenu(
  bot: TelegramBot,
  chatId: string,
  firstName?: string,
): Promise<TelegramBot.Message> {
  const greeting = firstName ? `What's good, ${escapeMarkdown(firstName)}.` : `What's good.`;
  const text =
    `*${BRAND_NAME}*\n\n` +
    `${greeting}\n\n` +
    `*Menu*  —  what we got on (tap a size to add to cart)\n` +
    `*🛒 Cart*  —  view what's in, send the order\n` +
    `*My Orders*  —  past + current\n` +
    `*Contact*  —  pull up the team\n` +
    `*How it works*  —  the move, top to bottom\n` +
    `*Rules*  —  the basics\n` +
    `*Ask us*  —  type a question\n\n` +
    `_cash · in person · 18+_\n` +
    `🕑 ${weeklyScheduleLine()}\n\n` +
    `🔒 _wipes every 24h._`;
  return bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: customerReplyKeyboard(),
  });
}

// ---------------------------------------------------------------------------
// Product card builders — Manybot-style: photo + info + size buttons.
// Each size button adds 1 to the cart on tap.
// ---------------------------------------------------------------------------
const CAPTION_MAX = 1024;

function buildProductCardCaption(
  p: { name: string; description: string; price: string; emoji: string | null; preorder?: boolean },
  variants: ProductVariant[],
): string {
  // Customers never see stock language. Sold-out variants are hidden from
  // the buy buttons; products with zero buyable variants are filtered out
  // of the menu upstream in openProductBrowser. The "from $X" line uses
  // only buyable variants so the anchor price is always one the customer
  // can actually tap.
  const buyable = variants.filter((v) => v.stock !== "sold_out");
  let priceLine: string;
  if (buyable.length > 0) {
    const min = buyable.reduce((m, v) => Math.min(m, v.priceCents), Infinity);
    priceLine = `from ${formatPriceCents(min)}`;
  } else {
    // Legacy product with no variants set yet — show the old free-text price.
    priceLine = p.price.startsWith("$") ? p.price : `$${p.price}`;
  }
  // Pre-order badge sits right under the price line so customers see it
  // before they tap a size. Drop date is TBC — the mod confirms via DM.
  const preorderBadge = p.preorder ? `\n🕒 _PRE-ORDER — drop date confirmed by your contact_` : "";
  let caption =
    `${emojiFor(p)} *${escapeMarkdown(p.name)}*\n` +
    `_${escapeMarkdown(priceLine)}_${preorderBadge}\n\n` +
    `${escapeMarkdown(p.description)}`;
  if (caption.length > CAPTION_MAX) {
    caption = caption.slice(0, CAPTION_MAX - 1) + "…";
  }
  return caption;
}

function buildProductCardKeyboard(
  p: { id: number; videoUrl: string | null },
  variants: ProductVariant[],
): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [];

  // Hide sold-out variants from the buy buttons. Customers see no stock
  // language at all — low and in_stock variants render identically.
  const buyable = variants.filter((v) => v.stock !== "sold_out");
  const labelFor = (v: ProductVariant) => `${v.label} · ${formatPriceCents(v.priceCents)}`;
  if (buyable.length === 0) {
    // Either no variants set or every variant is sold out — surface the cart
    // anyway so the customer isn't stuck on a dead-end card.
    buttons.push([{ text: "🛒 View Cart", callback_data: "ca:open" }]);
  } else {
    for (let i = 0; i < buyable.length; i += 2) {
      const row: TelegramBot.InlineKeyboardButton[] = [];
      const a = buyable[i];
      row.push({ text: labelFor(a), callback_data: `cm:add:${a.id}` });
      const b = buyable[i + 1];
      if (b) row.push({ text: labelFor(b), callback_data: `cm:add:${b.id}` });
      buttons.push(row);
    }
    buttons.push([{ text: "🛒 View Cart", callback_data: "ca:open" }]);
  }

  if (p.videoUrl) {
    buttons.push([{ text: "🎥 See the video", callback_data: `cm:vid:${p.id}` }]);
  }
  return { inline_keyboard: buttons };
}

export async function openProductBrowser(bot: TelegramBot, chatId: string) {
  try {
    const allAvailable = await getAvailableProducts();
    // Pre-fetch variants for every product so we can (a) hide products whose
    // every variant is sold_out and (b) reuse the lookup in the render loop
    // below. Customers must never see a sold-out item — not even a card.
    const variantsByProduct = new Map<number, ProductVariant[]>();
    for (const p of allAvailable) {
      const vs = await getProductVariants(p.id).catch(() => [] as ProductVariant[]);
      variantsByProduct.set(p.id, vs);
    }
    const products = allAvailable.filter((p) => {
      const vs = variantsByProduct.get(p.id) ?? [];
      // Legacy product with zero variants set still shows (uses free-text price).
      if (vs.length === 0) return true;
      // Hide if every variant is sold_out.
      return vs.some((v) => v.stock !== "sold_out");
    });
    if (products.length === 0) {
      await bot.sendMessage(
        chatId,
        `*Menu*\n\nNothing on right now — fresh stock landing soon.`,
        { parse_mode: "Markdown", reply_markup: customerReplyKeyboard() },
      );
      return;
    }

    const cartCount = await getCartCount(chatId);
    const headerSuffix = cartCount > 0 ? `  ·  🛒 ${cartCount} in cart` : "";
    await bot.sendMessage(
      chatId,
      `*Menu* — _what we got on today._${headerSuffix}\n\n_Tap a size to add it to your cart._`,
      { parse_mode: "Markdown" },
    );

    // Bundles section — only render when there's at least one active.
    try {
      const bundles = await listBundlesActive();
      if (bundles.length > 0) {
        const lines = bundles
          .map((b) => `• *${escapeMarkdown(b.label)}* — ${fmtCents(b.priceCents)}`)
          .join("\n");
        const buttons: TelegramBot.InlineKeyboardButton[][] = bundles.map((b) => [
          { text: `🎁 ${b.label} · ${fmtCents(b.priceCents)}`, callback_data: `bn:add:${b.id}` },
        ]);
        await bot.sendMessage(
          chatId,
          `*🎁 Bundles* — pre-set combos at a sharper price\n\n${lines}\n\n_Tap one to add to your cart._`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } },
        );
      }
    } catch (err) {
      logger.error({ err }, "openProductBrowser bundles section failed");
    }

    for (const p of products) {
      const variants = variantsByProduct.get(p.id) ?? [];
      const caption = buildProductCardCaption(p, variants);
      const keyboard = buildProductCardKeyboard(p, variants);

      if (p.imageUrl) {
        try {
          await bot.sendPhoto(chatId, p.imageUrl, {
            caption,
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
          continue;
        } catch (err) {
          logger.error({ err, productId: p.id }, "sendPhoto failed in openProductBrowser, falling back to text");
        }
      }
      await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: keyboard });
    }

    await bot.sendMessage(
      chatId,
      `_Done browsing? Tap 🛒 Cart to review your order and send it through._`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🛒 View Cart", callback_data: "ca:open" }]] },
      },
    );
  } catch (err) {
    logger.error({ err }, "openProductBrowser error");
    await bot.sendMessage(chatId, "Couldn't load the menu just now. Give it a sec and try again.", {
      reply_markup: customerReplyKeyboard(),
    });
  }
}

// ---------------------------------------------------------------------------
// Callback router for cm:* (customer menu) inline-button taps
// ---------------------------------------------------------------------------
const CB_PREFIX = "cm:";

export function isCustomerMenuCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

export async function handleCustomerMenuCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? "";
  if (!data.startsWith(CB_PREFIX)) return;
  const chatId = query.message?.chat.id?.toString();
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;

  const parts = data.slice(CB_PREFIX.length).split(":");
  const action = parts[0];

  try {
    switch (action) {
      case "p":
      case "browse": {
        await bot.answerCallbackQuery(query.id);
        await openProductBrowser(bot, chatId);
        return;
      }
      case "vid": {
        const id = parseInt(parts[1] ?? "", 10);
        if (Number.isNaN(id)) {
          await bot.answerCallbackQuery(query.id);
          return;
        }
        const p = await getProduct(id);
        if (!p || !p.available) {
          await bot.answerCallbackQuery(query.id, { text: "No longer on the menu.", show_alert: true });
          return;
        }
        if (!p.videoUrl) {
          await bot.answerCallbackQuery(query.id, { text: "No video for this one.", show_alert: true });
          return;
        }
        try {
          await bot.sendVideo(chatId, p.videoUrl, {
            caption: `🎥 *${escapeMarkdown(p.name)}*`,
            parse_mode: "Markdown",
          });
          await bot.answerCallbackQuery(query.id);
        } catch (err) {
          logger.error({ err, productId: p.id }, "sendVideo failed");
          await bot.answerCallbackQuery(query.id, {
            text: "Couldn't send the video right now.",
            show_alert: true,
          });
        }
        return;
      }
      case "add": {
        const variantId = parseInt(parts[1] ?? "", 10);
        if (Number.isNaN(variantId)) {
          await bot.answerCallbackQuery(query.id);
          return;
        }
        await addVariantToCart(bot, query, variantId);
        return;
      }
      // Legacy "buy" callback from old menu cards — redirect to opening the cart
      // so old, still-visible photos don't 404 the customer.
      case "buy": {
        await bot.answerCallbackQuery(query.id, {
          text: "Menu refreshed — open it again to add sizes.",
        });
        await openProductBrowser(bot, chatId);
        return;
      }
      case "order": {
        await bot.answerCallbackQuery(query.id);
        await openCart(bot, chatId);
        return;
      }
      default:
        await bot.answerCallbackQuery(query.id);
        return;
    }
  } catch (err) {
    logger.error({ err, data }, "handleCustomerMenuCallback error");
    try {
      await bot.answerCallbackQuery(query.id, { text: "Something glitched — give it a sec.", show_alert: true });
    } catch {}
  }
}

// Re-export Product type for callers
export type { Product };
