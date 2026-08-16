import TelegramBot from "node-telegram-bot-api";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  getAllProductsOrdered,
  getProduct,
  addProduct,
  updateProductFields,
  deleteProduct,
  swapProductPositions,
  getProductVariants,
  addProductVariant,
  updateVariantFields,
  deleteVariant,
  getVariant,
  setVariantStock,
  setAllVariantsStock,
  getAllProductsWithVariantStock,
  formatPriceCents,
  type ProductVariant,
} from "../db.js";
import { logger } from "../../lib/logger.js";
import { notifyTeamStockChange } from "../stockCheck.js";
import { isAdmin } from "./admin.js";
import { escapeMarkdown } from "../escape.js";
import { emojiFor, fallbackEmojiFor, sanitizeEmoji } from "../emoji.js";
import { aiPickEmojiForName } from "../aiEmoji.js";
import { broadcastProductNow } from "../promoBroadcaster.js";

// ---------------------------------------------------------------------------
// AI-powered freeform product parser
// ---------------------------------------------------------------------------
// Admins write product details however they want — any layout, any order,
// pipes, dashes, line breaks, emojis, whatever. AI extracts the three fields.
interface ParsedVariant {
  label: string;
  priceCents: number;
}
interface ParsedProduct {
  name: string;
  price: string;
  description: string;
  emoji: string;
  variants: ParsedVariant[];
}

const PARSE_SYSTEM_PROMPT = `You extract product fields from a freeform message an admin sent to add a cannabis product to a menu.

Return ONLY a JSON object with exactly these five keys: "name", "price", "description", "emoji", "variants".

Rules:
- "name": the product name (e.g. "Blue Dream", "OG Kush Pre-Roll", "1g Live Resin"). Strip leading bullets, numbers, emojis, and labels like "Name:". Strip any size info from the name itself (do NOT include "1g" or "3.5g" in the name — those go in variants).
- "price": A SHORT human-readable price summary used as a fallback when no variants are present (e.g. "$40", "from $40"). If variants are present, use "from $<lowest>". If nothing is present at all, empty string.
- "description": everything else — the strain notes, effects, vibe. Preserve tone and line breaks. Strip labels like "Description:" or "Notes:". Strip the size/price list from this field — those go in variants.
- "emoji": pick ONE single emoji that fits this strain or product, biased toward the NAME (the strain/flavour cue lives there). Examples — lemon/citrus: 🍋, grape/berry: 🍇, fire/loud: 🔥, sleepy/heavy: 🌙, energetic/sativa: ⚡, tropical: 🥭, diesel: ⛽, cake/dessert: 🍰, mint/cool: 🌬, crystal/resinous: 💎, spacey: 🌌, classic kush: 🟢, pre-roll: 🚬, edible: 🍬, concentrate: 💧. Never use 🌿 or 🍃 (the leaf — overused). Single emoji character only. Default to 💎.
- "variants": ARRAY of objects with "label" (string) and "priceCents" (integer). Extract every size/price pair the admin listed. Example: "1g $40, 3.5g $130, 7g $250, 14g $480" → [{"label":"1g","priceCents":4000},{"label":"3.5g","priceCents":13000},{"label":"7g","priceCents":25000},{"label":"14g","priceCents":48000}]. Convert dollars to cents (multiply by 100, integer). Keep the label exactly as the admin wrote it (lowercase units like "1g", "3.5g", or labels like "Pre-roll", "Each"). If only ONE price is mentioned with no size context, return [{"label":"Each","priceCents":<cents>}]. If no prices at all, return [].

If a field genuinely isn't in the message, return an empty string (or [] for variants). Don't invent product details.

Output ONLY the JSON object. No prose, no code fences, no commentary.`;

function sanitizeParsedVariants(raw: unknown): ParsedVariant[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedVariant[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const rec = v as Record<string, unknown>;
    const label = typeof rec.label === "string" ? rec.label.trim().slice(0, 32) : "";
    const cents =
      typeof rec.priceCents === "number"
        ? Math.round(rec.priceCents)
        : typeof rec.priceCents === "string"
          ? Math.round(parseFloat(rec.priceCents) || 0)
          : 0;
    if (!label || !isFinite(cents) || cents <= 0) continue;
    out.push({ label, priceCents: cents });
  }
  return out.slice(0, 8); // cap at 8 sizes per product
}

export async function parseProductFreeform(rawText: string): Promise<ParsedProduct> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 600,
    messages: [
      { role: "system", content: PARSE_SYSTEM_PROMPT },
      { role: "user", content: rawText },
    ],
    response_format: { type: "json_object" },
  });
  const content = response.choices[0]?.message?.content ?? "{}";
  let parsed: Partial<ParsedProduct> & { variants?: unknown } = {};
  try {
    parsed = JSON.parse(content) as Partial<ParsedProduct> & { variants?: unknown };
  } catch (err) {
    logger.error({ err, content }, "parseProductFreeform: JSON parse failed");
  }
  return {
    name: (parsed.name ?? "").trim(),
    price: (parsed.price ?? "").trim(),
    description: (parsed.description ?? "").trim(),
    emoji: sanitizeEmoji(parsed.emoji),
    variants: sanitizeParsedVariants(parsed.variants),
  };
}

// Replace the message attached to a callback with new text + keyboard.
// If the originating message is a PHOTO (admin tapped a button on a photo
// detail card), Telegram won't let us editMessageText on it — we delete and
// send a fresh text message instead. For plain-text origins we edit in place.
async function replaceWithText(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  text: string,
  replyMarkup: TelegramBot.InlineKeyboardMarkup,
): Promise<void> {
  const chatId = query.message?.chat.id?.toString();
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;
  const previousIsPhoto = !!query.message?.photo && query.message.photo.length > 0;
  if (previousIsPhoto) {
    try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore — older than 48h, etc. */ }
    await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
    return;
  }
  await safeEditMessageText(bot, text, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

// Telegram throws 400 "message is not modified" when editMessageText is called
// with content byte-identical to the current message (e.g. tapping a no-op
// button). Swallow that specific error; surface anything else.
async function safeEditMessageText(
  bot: TelegramBot,
  text: string,
  options: TelegramBot.EditMessageTextOptions
): Promise<void> {
  try {
    await bot.editMessageText(text, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("message is not modified")) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
// One active "edit" or "add" session per admin chat. The next plain-text
// message they send is captured and applied to the field they're editing.
//
// kind:
//   add            → next msg (photo+caption OR text) becomes a whole new product
//   edit-name      → next msg replaces existing product's name
//   edit-desc      → next msg replaces description
//   edit-price     → next msg replaces price
//   edit-image     → next msg replaces image (photo upload, https URL, or "-" to clear)
//   edit-video     → next msg replaces video (video upload, https URL, or "-" to clear)
type SessionKind =
  | "add"
  | "edit-name"
  | "edit-desc"
  | "edit-price"
  | "edit-image"
  | "edit-video"
  | "edit-emoji"
  | "var-add"
  | "var-edit";

interface ProductSession {
  kind: SessionKind;
  productId?: number;
  variantId?: number;
}

const sessions = new Map<string, ProductSession>();

export function hasProductAdminSession(chatId: string): boolean {
  return sessions.has(chatId);
}

function clearSession(chatId: string) {
  sessions.delete(chatId);
}

// ---------------------------------------------------------------------------
// Callback data format
// ---------------------------------------------------------------------------
// All callback_data strings start with "pa:" to namespace this feature.
//   pa:menu                  → main product menu
//   pa:list                  → list view (buttons for each product)
//   pa:view:<id>             → product detail view
//   pa:edit:<field>:<id>     → start an edit session for one field
//                              field ∈ name | desc | price | image
//   pa:toggle:<id>           → flip available
//   pa:up:<id>               → move up
//   pa:down:<id>             → move down
//   pa:del:<id>              → ask for delete confirmation
//   pa:delok:<id>            → confirmed delete
//   pa:add                   → start "add product" wizard
//   pa:cancel                → cancel current session and return to menu
//   pa:close                 → remove the menu
const CB_PREFIX = "pa:";

export function isProductAdminCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

// ---------------------------------------------------------------------------
// UI builders
// ---------------------------------------------------------------------------
function priceLabel(price: string): string {
  return price.startsWith("$") ? price : `$${price}`;
}

function buildMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "📋 My products", callback_data: "pa:list" }],
      [{ text: "➕ Add product", callback_data: "pa:add" }],
      [{ text: "✖ Close", callback_data: "pa:close" }],
    ],
  };
}

async function buildListKeyboard(): Promise<TelegramBot.InlineKeyboardMarkup> {
  const items = await getAllProductsWithVariantStock();
  const rows: TelegramBot.InlineKeyboardButton[][] = items.map(({ product: p, total, buyable }) => {
    // Reflect what customers ACTUALLY see, not just the on/off switch:
    //   ⚪ hidden by switch · 🔴 switch on but every size sold out · 🟢 live on menu
    const dot = !p.available ? "⚪" : total > 0 && buyable === 0 ? "🔴" : "🟢";
    return [
      {
        text: `${dot} ${p.name} — ${priceLabel(p.price)}`,
        callback_data: `pa:view:${p.id}`,
      },
    ];
  });
  rows.push([{ text: "➕ Add product", callback_data: "pa:add" }]);
  rows.push([{ text: "🔙 Back", callback_data: "pa:menu" }]);
  return { inline_keyboard: rows };
}

function buildDetailKeyboard(
  productId: number,
  available: boolean,
  preorder: boolean,
  stockState: "in" | "out" | "none",
): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [
    [
      { text: "✏️ Name", callback_data: `pa:edit:name:${productId}` },
      { text: "✏️ Description", callback_data: `pa:edit:desc:${productId}` },
    ],
    [
      { text: "🧱 Sizes & prices", callback_data: `pa:vars:${productId}` },
      { text: "🪄 Emoji", callback_data: `pa:edit:emoji:${productId}` },
    ],
    [
      { text: "💰 Legacy price", callback_data: `pa:edit:price:${productId}` },
    ],
    [
      { text: "🖼 Photo", callback_data: `pa:edit:image:${productId}` },
      { text: "🎥 Video", callback_data: `pa:edit:video:${productId}` },
    ],
  ];
  // Real stock control — flips every size at once. This is what decides whether
  // customers can see/buy the item; it is NOT the pre-order flag below. Hidden
  // when the product has no sizes yet (nothing to flip).
  if (stockState === "out") {
    rows.push([{ text: "🟢 Put back in stock (all sizes)", callback_data: `pa:stock:in:${productId}` }]);
  } else if (stockState === "in") {
    rows.push([{ text: "🔴 Mark sold out (all sizes)", callback_data: `pa:stock:out:${productId}` }]);
  }
  rows.push([
    { text: available ? "👁 Hide from menu" : "👁 Show on menu", callback_data: `pa:toggle:${productId}` },
    { text: preorder ? "📦 Clear pre-order" : "🕒 Mark pre-order", callback_data: `pa:preorder:${productId}` },
  ]);
  // Broadcast this product to every subscriber. Only offered when it's
  // actually purchasable (shown on menu + at least one in-stock size) — no
  // point blasting customers a product they can't see or buy.
  if (available && stockState === "in") {
    rows.push([{ text: "📣 Broadcast to all subscribers", callback_data: `pa:bcast:${productId}` }]);
  }
  rows.push([
    { text: "⬆️ Move up", callback_data: `pa:up:${productId}` },
    { text: "⬇️ Move down", callback_data: `pa:down:${productId}` },
  ]);
  rows.push([{ text: "🗑 Delete", callback_data: `pa:del:${productId}` }]);
  rows.push([{ text: "🔙 Back to list", callback_data: "pa:list" }]);
  return { inline_keyboard: rows };
}

function buildVariantsKeyboard(productId: number, variants: ProductVariant[]): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (const v of variants) {
    const soldOut = v.stock === "sold_out";
    rows.push([
      { text: `✏️ ${v.label} · ${formatPriceCents(v.priceCents)}`, callback_data: `pa:varedit:${v.id}` },
      soldOut
        ? { text: "🟢 In", callback_data: `pa:vstock:in:${v.id}` }
        : { text: "🔴 Out", callback_data: `pa:vstock:out:${v.id}` },
      { text: "🗑", callback_data: `pa:vardel:${v.id}` },
    ]);
  }
  rows.push([{ text: "➕ Add size", callback_data: `pa:varadd:${productId}` }]);
  rows.push([{ text: "🔙 Back to product", callback_data: `pa:view:${productId}` }]);
  return { inline_keyboard: rows };
}

function variantsHeaderText(productName: string, variants: ProductVariant[]): string {
  if (variants.length === 0) {
    return (
      `🧱 Sizes — ${productName}\n\n` +
      `No sizes set yet. Customers can't add this to their cart until you add at least one.\n\n` +
      `Tap “Add size” and send something like:\n  3.5g 130\n  7g $250\n  Each $40`
    );
  }
  const stockBadge = (s: string) =>
    s === "sold_out" ? "🔴 sold out" : s === "low" ? "🟡 low" : "🟢 in stock";
  const lines = variants.map(
    (v, i) => `${i + 1}.  ${v.label}  —  ${formatPriceCents(v.priceCents)}  ·  ${stockBadge(v.stock)}`,
  );
  return (
    `🧱 Sizes — ${productName}\n\n` +
    `${lines.join("\n")}\n\n` +
    `Tap a row to edit its label/price, 🟢/🔴 to flip that size's stock, 🗑 to delete, or “Add size” for a new one.`
  );
}

// Parse "<label> <price>" or "<label> $<price>" into a normalized variant
// pair. Returns null if the input doesn't match — caller asks again.
function parseVariantInput(text: string): { label: string; priceCents: number } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Match: <label-without-final-number> <price>
  // Label can have spaces ("Pre-roll 1g"), price is the trailing $? + number.
  const m = trimmed.match(/^(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s*$/);
  if (!m) return null;
  const label = m[1].trim().slice(0, 32);
  const dollars = parseFloat(m[2]);
  if (!isFinite(dollars) || dollars <= 0) return null;
  if (!label) return null;
  // Cap at $99,999 so a fat-fingered admin can't create an order with totals
  // that overflow the int4 columns or look obviously wrong to a customer.
  if (dollars > 99999) return null;
  return { label, priceCents: Math.round(dollars * 100) };
}

function buildDeleteConfirmKeyboard(productId: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Yes, delete", callback_data: `pa:delok:${productId}` },
        { text: "🔙 Cancel", callback_data: `pa:view:${productId}` },
      ],
    ],
  };
}

function buildCancelKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: "✖ Cancel", callback_data: "pa:cancel" }]] };
}

function buildBroadcastConfirmKeyboard(productId: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Yes, send to everyone", callback_data: `pa:bcastok:${productId}` },
        { text: "🔙 Cancel", callback_data: `pa:view:${productId}` },
      ],
    ],
  };
}

function detailText(
  p: { id: number; name: string; description: string; price: string; available: boolean; preorder: boolean; imageUrl: string | null; videoUrl: string | null; emoji: string | null; position: number },
  stock: { hasVariants: boolean; allSoldOut: boolean; anyLow: boolean },
): string {
  // Plain text — no parse_mode — to dodge any Markdown landmines from product content.
  // Customers only see a product when the on/off switch is ON *and* at least one
  // size is in stock. Spell that out so a non-technical operator never has to
  // guess why an item isn't on the menu.
  const customerVisible = p.available && (!stock.hasVariants || !stock.allSoldOut);
  const stockLine = !stock.hasVariants
    ? "📦 Stock: no sizes set"
    : stock.allSoldOut
      ? "📦 Stock: all sizes sold out"
      : stock.anyLow
        ? "📦 Stock: low"
        : "📦 Stock: in stock";
  const lines = [
    `${emojiFor(p)} ${p.name}`,
    "",
    p.description,
    "",
    `💰 ${priceLabel(p.price)}`,
    `📊 Position: ${p.position + 1}`,
    `${p.available ? "👁 Your switch: shown on menu" : "👁 Your switch: hidden"}`,
    stockLine,
  ];
  if (p.preorder) lines.push("🕒 Pre-order (drop date TBC)");
  lines.push(customerVisible ? "✅ Customers can see this now" : "🚫 Customers can't see this right now");
  if (!customerVisible) {
    if (!p.available) lines.push("   → tap “Show on menu” to fix");
    else if (stock.hasVariants && stock.allSoldOut) lines.push("   → tap “Put back in stock” to fix");
  }
  lines.push("");
  if (p.imageUrl) {
    const isUrl = p.imageUrl.startsWith("http://") || p.imageUrl.startsWith("https://");
    lines.push(isUrl ? `🖼 ${p.imageUrl}` : "🖼 Photo attached");
  } else {
    lines.push("🖼 No photo");
  }
  if (p.videoUrl) {
    const isUrl = p.videoUrl.startsWith("http://") || p.videoUrl.startsWith("https://");
    lines.push(isUrl ? `🎥 ${p.videoUrl}` : "🎥 Video attached");
  } else {
    lines.push("🎥 No video");
  }
  lines.push(p.emoji ? `🪄 ${p.emoji}` : `🪄 ${fallbackEmojiFor(p.name)} (auto)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------
export async function openProductMenu(bot: TelegramBot, chatId: string) {
  if (!isAdmin(chatId)) {
    await bot.sendMessage(chatId, "⛔ Admin access required.");
    return;
  }
  await bot.sendMessage(
    chatId,
    "🛍 Product Manager\n\nManage what customers see when they tap /products.",
    { reply_markup: buildMenuKeyboard() }
  );
}

// Called by the global bot.on("message") router whenever an admin sends a
// non-command text message AND has an active product session. Returns true if
// the message was consumed (caller should stop further routing).
export async function handleProductAdminText(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
  const chatId = msg.chat.id.toString();
  const session = sessions.get(chatId);
  if (!session) return false;

  // Photo? Take the largest variant's file_id. Caption is the text payload.
  const photoArr = msg.photo;
  const largestPhoto = photoArr && photoArr.length > 0 ? photoArr[photoArr.length - 1] : null;
  const photoFileId = largestPhoto?.file_id ?? null;
  const text = (msg.caption ?? msg.text ?? "").trim();

  try {
    switch (session.kind) {
      case "add": {
        // One-shot create: write it however you want — AI extracts the fields.
        // Photo (if attached) becomes the product image.
        if (!text) {
          await bot.sendMessage(
            chatId,
            "Send the product details — write it however you want.\n\n" +
            "Include a name, price, and a quick description. Attach a photo if you've got one.",
            { reply_markup: buildCancelKeyboard() }
          );
          return true;
        }

        // Tell admin we're working on it — AI parsing can take a couple seconds.
        const thinkingMsg = await bot.sendMessage(chatId, "🤔 Reading that…").catch(() => null);

        let parsed: ParsedProduct;
        try {
          parsed = await parseProductFreeform(text);
        } catch (err) {
          logger.error({ err }, "parseProductFreeform error");
          if (thinkingMsg) await bot.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});
          await bot.sendMessage(
            chatId,
            "Couldn't read that just now — try again, or tap Cancel.",
            { reply_markup: buildCancelKeyboard() }
          );
          return true;
        }
        if (thinkingMsg) await bot.deleteMessage(chatId, thinkingMsg.message_id).catch(() => {});

        const problems: string[] = [];
        if (parsed.name.length < 2) problems.push("• Name");
        if (!parsed.price) problems.push("• Price");
        if (parsed.description.length < 2) problems.push("• Description");
        if (problems.length > 0) {
          await bot.sendMessage(
            chatId,
            "Couldn't pick this out of your message:\n\n" + problems.join("\n") +
            "\n\nResend with the missing bit added — any layout works.",
            { reply_markup: buildCancelKeyboard() }
          );
          return true;
        }

        clearSession(chatId);
        // Prefer AI-picked emoji from the parser; if blank, ask the AI emoji
        // helper directly (biased to the NAME). Last fallback is deterministic.
        let finalEmoji = parsed.emoji;
        if (!finalEmoji) {
          finalEmoji = await aiPickEmojiForName(parsed.name, parsed.description);
        }
        const insertedRows = await addProduct({
          name: parsed.name,
          description: parsed.description,
          price: parsed.price,
          available: true,
          imageUrl: photoFileId,
          emoji: finalEmoji,
        });
        // addProduct returns the inserted row(s). Capture the id so we can
        // also insert any AI-extracted variants atomically with the create.
        const created = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
        let variantNote = "";
        if (created && parsed.variants.length > 0) {
          for (const v of parsed.variants) {
            try {
              await addProductVariant({
                productId: created.id,
                label: v.label,
                priceCents: v.priceCents,
                position: 0,
              });
            } catch (err) {
              logger.error({ err, productId: created.id, variant: v }, "Failed to add parsed variant");
            }
          }
          variantNote =
            `\n\nSizes detected: ` +
            parsed.variants.map((v) => `${v.label} ${formatPriceCents(v.priceCents)}`).join(", ");
        } else if (created) {
          variantNote =
            `\n\nNo sizes detected — open this product and tap *🧱 Sizes & prices* to add them, otherwise customers can't add it to their cart.`;
        }
        await bot.sendMessage(
          chatId,
          `✅ Added ${finalEmoji} "${escapeMarkdown(parsed.name)}" — ${escapeMarkdown(parsed.price || "(no legacy price)")}${photoFileId ? " (with photo)" : ""}.${variantNote}`,
          { parse_mode: "Markdown" },
        );
        await openProductMenu(bot, chatId);
        return true;
      }
      case "var-add": {
        if (!session.productId) {
          clearSession(chatId);
          await bot.sendMessage(chatId, "Lost track of which product. Reopened the menu.");
          await openProductMenu(bot, chatId);
          return true;
        }
        const parsedVar = parseVariantInput(text);
        if (!parsedVar) {
          await bot.sendMessage(
            chatId,
            "Send it as `<label> <price>` — e.g. `3.5g 130`, `7g $250`, or `Each 40`. Tap Cancel to bail.",
            { parse_mode: "Markdown", reply_markup: buildCancelKeyboard() },
          );
          return true;
        }
        await addProductVariant({
          productId: session.productId,
          label: parsedVar.label,
          priceCents: parsedVar.priceCents,
          position: 0,
        });
        const productId = session.productId;
        clearSession(chatId);
        await bot.sendMessage(
          chatId,
          `✅ Added ${parsedVar.label} — ${formatPriceCents(parsedVar.priceCents)}.`,
        );
        await sendVariantsView(bot, chatId, productId);
        return true;
      }
      case "var-edit": {
        if (!session.variantId) {
          clearSession(chatId);
          await bot.sendMessage(chatId, "Lost track of which size. Reopened the menu.");
          await openProductMenu(bot, chatId);
          return true;
        }
        const parsedVar = parseVariantInput(text);
        if (!parsedVar) {
          await bot.sendMessage(
            chatId,
            "Send the new value as `<label> <price>` — e.g. `3.5g 130`. Tap Cancel to bail.",
            { parse_mode: "Markdown", reply_markup: buildCancelKeyboard() },
          );
          return true;
        }
        const existing = await getVariant(session.variantId);
        if (!existing) {
          clearSession(chatId);
          await bot.sendMessage(chatId, "That size is gone now. Reopened the menu.");
          await openProductMenu(bot, chatId);
          return true;
        }
        await updateVariantFields(session.variantId, {
          label: parsedVar.label,
          priceCents: parsedVar.priceCents,
        });
        const productId = existing.productId;
        clearSession(chatId);
        await bot.sendMessage(
          chatId,
          `✅ Updated ${parsedVar.label} — ${formatPriceCents(parsedVar.priceCents)}.`,
        );
        await sendVariantsView(bot, chatId, productId);
        return true;
      }
      case "edit-name":
      case "edit-desc":
      case "edit-price": {
        if (!text) {
          await bot.sendMessage(chatId, "Empty — send the new value, or tap Cancel.", { reply_markup: buildCancelKeyboard() });
          return true;
        }
        if (!session.productId) {
          clearSession(chatId);
          await bot.sendMessage(chatId, "Lost track of which product. Reopened the menu.");
          await openProductMenu(bot, chatId);
          return true;
        }
        const fields: Partial<{ name: string; description: string; price: string }> = {};
        if (session.kind === "edit-name") fields.name = text;
        if (session.kind === "edit-desc") fields.description = text;
        if (session.kind === "edit-price") fields.price = text;
        await updateProductFields(session.productId, fields);
        const productId = session.productId;
        clearSession(chatId);
        await bot.sendMessage(chatId, "✅ Saved.");
        await sendProductDetail(bot, chatId, productId);
        return true;
      }
      case "edit-image": {
        if (!session.productId) {
          clearSession(chatId);
          await bot.sendMessage(chatId, "Lost track of which product. Reopened the menu.");
          await openProductMenu(bot, chatId);
          return true;
        }
        let imageUrl: string | null;
        if (photoFileId) {
          imageUrl = photoFileId;
        } else if (text === "-" || text.toLowerCase() === "none") {
          imageUrl = null;
        } else if (text.startsWith("http://") || text.startsWith("https://")) {
          imageUrl = text;
        } else {
          await bot.sendMessage(
            chatId,
            "Send a PHOTO to attach, paste an https URL, or send \"-\" to remove the image.",
            { reply_markup: buildCancelKeyboard() }
          );
          return true;
        }
        await updateProductFields(session.productId, { imageUrl });
        const productId = session.productId;
        clearSession(chatId);
        await bot.sendMessage(chatId, imageUrl ? "✅ Photo saved." : "✅ Photo removed.");
        await sendProductDetail(bot, chatId, productId);
        return true;
      }
      case "edit-emoji": {
        if (!session.productId) {
          clearSession(chatId);
          await bot.sendMessage(chatId, "Lost track of which product. Reopened the menu.");
          await openProductMenu(bot, chatId);
          return true;
        }
        let emoji: string | null;
        if (text === "-" || text.toLowerCase() === "auto" || text.toLowerCase() === "none") {
          emoji = null; // fall back to the deterministic auto-pick
        } else {
          const cleaned = sanitizeEmoji(text);
          if (!cleaned) {
            await bot.sendMessage(
              chatId,
              "Send a single emoji to pin to this product (e.g. 🔥, 🍇, 💎). Send \"-\" to auto-pick.",
              { reply_markup: buildCancelKeyboard() }
            );
            return true;
          }
          emoji = cleaned;
        }
        await updateProductFields(session.productId, { emoji });
        const productId = session.productId;
        clearSession(chatId);
        await bot.sendMessage(chatId, emoji ? `✅ Emoji set to ${emoji}.` : "✅ Emoji set to auto-pick.");
        await sendProductDetail(bot, chatId, productId);
        return true;
      }
      case "edit-video": {
        if (!session.productId) {
          clearSession(chatId);
          await bot.sendMessage(chatId, "Lost track of which product. Reopened the menu.");
          await openProductMenu(bot, chatId);
          return true;
        }
        // Telegram delivers uploaded videos as msg.video (single object, not array).
        const videoFileId = msg.video?.file_id ?? null;
        let videoUrl: string | null;
        if (videoFileId) {
          videoUrl = videoFileId;
        } else if (text === "-" || text.toLowerCase() === "none") {
          videoUrl = null;
        } else if (text.startsWith("http://") || text.startsWith("https://")) {
          videoUrl = text;
        } else {
          await bot.sendMessage(
            chatId,
            "Send a VIDEO to attach, paste an https URL, or send \"-\" to remove the video.",
            { reply_markup: buildCancelKeyboard() }
          );
          return true;
        }
        await updateProductFields(session.productId, { videoUrl });
        const productId = session.productId;
        clearSession(chatId);
        await bot.sendMessage(chatId, videoUrl ? "✅ Video saved." : "✅ Video removed.");
        await sendProductDetail(bot, chatId, productId);
        return true;
      }
    }
  } catch (err) {
    logger.error({ err }, "handleProductAdminText error");
    clearSession(chatId);
    await bot.sendMessage(chatId, "Something went wrong saving that. Reopened the menu.");
    await openProductMenu(bot, chatId);
    return true;
  }
  return false;
}

async function sendVariantsView(bot: TelegramBot, chatId: string, productId: number) {
  const p = await getProduct(productId);
  if (!p) {
    await bot.sendMessage(chatId, "Product not found.");
    await openProductMenu(bot, chatId);
    return;
  }
  const variants = await getProductVariants(productId);
  await bot.sendMessage(chatId, variantsHeaderText(p.name, variants), {
    reply_markup: buildVariantsKeyboard(productId, variants),
  });
}

async function sendProductDetail(bot: TelegramBot, chatId: string, productId: number) {
  const p = await getProduct(productId);
  if (!p) {
    await bot.sendMessage(chatId, "Product not found.");
    await openProductMenu(bot, chatId);
    return;
  }
  const variants = await getProductVariants(productId);
  const total = variants.length;
  const buyable = variants.filter((v) => v.stock !== "sold_out").length;
  const stockSummary = {
    hasVariants: total > 0,
    allSoldOut: total > 0 && buyable === 0,
    anyLow: variants.some((v) => v.stock === "low"),
  };
  const stockState: "in" | "out" | "none" = total === 0 ? "none" : buyable === 0 ? "out" : "in";
  const text = detailText(p, stockSummary);
  const keyboard = buildDetailKeyboard(p.id, p.available, p.preorder, stockState);
  // Show the actual photo (Manybot-style) when one is attached so admins
  // can see what customers will see, instead of just a "Photo attached" line.
  if (p.imageUrl) {
    try {
      // Captions are capped at 1024 chars; truncate if needed.
      const caption = text.length > 1024 ? text.slice(0, 1023) + "…" : text;
      await bot.sendPhoto(chatId, p.imageUrl, {
        caption,
        reply_markup: keyboard,
      });
      return;
    } catch (err) {
      logger.error({ err, productId }, "sendProductDetail: sendPhoto failed, falling back to text");
    }
  }
  await bot.sendMessage(chatId, text, { reply_markup: keyboard });
}

// ---------------------------------------------------------------------------
// Callback query router
// ---------------------------------------------------------------------------
export async function handleProductAdminCallback(bot: TelegramBot, query: TelegramBot.CallbackQuery): Promise<void> {
  const data = query.data ?? "";
  if (!data.startsWith(CB_PREFIX)) return;
  const chatId = query.message?.chat.id?.toString();
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;

  if (!isAdmin(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: "Admin only.", show_alert: true });
    return;
  }

  const parts = data.slice(CB_PREFIX.length).split(":");
  const action = parts[0];

  try {
    switch (action) {
      case "menu": {
        await replaceWithText(
          bot,
          query,
          "🛍 Product Manager\n\nManage what customers see when they tap /products.",
          buildMenuKeyboard(),
        );
        break;
      }
      case "list": {
        const products = await getAllProductsOrdered();
        const header = products.length === 0
          ? "📋 No products yet — tap Add product to create your first one."
          : `📋 Products (${products.length})\n\n🟢 = live on menu · 🔴 = sold out (hidden) · ⚪ = hidden by switch\nTap a product to edit, restock, hide, reorder or delete.`;
        await replaceWithText(bot, query, header, await buildListKeyboard());
        break;
      }
      case "view": {
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        // Always send a fresh message — sendProductDetail handles photo vs.
        // text and lets admins see the actual image. Delete the list message
        // we came from so the chat stays tidy.
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        await sendProductDetail(bot, chatId, p.id);
        break;
      }
      case "edit": {
        const field = parts[1];
        const id = parseInt(parts[2] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        const kind: SessionKind | null =
          field === "name" ? "edit-name"
          : field === "desc" ? "edit-desc"
          : field === "price" ? "edit-price"
          : field === "image" ? "edit-image"
          : field === "video" ? "edit-video"
          : field === "emoji" ? "edit-emoji"
          : null;
        if (!kind) break;
        sessions.set(chatId, { kind, productId: id });
        const prompt =
          field === "name" ? `Send the new NAME for "${p.name}":`
          : field === "desc" ? `Send the new DESCRIPTION for "${p.name}":`
          : field === "price" ? `Send the new PRICE for "${p.name}" (e.g. 40 or $40):`
          : field === "image" ? `Send a PHOTO for "${p.name}" (or paste an https URL). Send "-" to remove the current photo.`
          : field === "video" ? `Send a VIDEO for "${p.name}" (or paste an https URL). Send "-" to remove the current video.`
          : `Send a single EMOJI for "${p.name}" (e.g. 🔥, 🍇, 💎). Send "-" to auto-pick from the name.`;
        await bot.sendMessage(chatId, prompt, { reply_markup: buildCancelKeyboard() });
        break;
      }
      case "toggle": {
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        await updateProductFields(id, { available: !p.available });
        // Re-render the detail card so admin sees the new state. Uses
        // sendProductDetail so photo products keep their photo and we don't
        // try to editMessageText on a photo message.
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        await sendProductDetail(bot, chatId, id);
        await bot.answerCallbackQuery(query.id, { text: !p.available ? "Now visible on menu" : "Hidden from menu" });
        return;
      }
      case "preorder": {
        // Flip the pre-order flag. Customers see a 🕒 PRE-ORDER badge on
        // the menu card and a banner on the order receipt; mods see a
        // "confirm drop date" line in the fanout for any pre-order items.
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        await updateProductFields(id, { preorder: !p.preorder });
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        await sendProductDetail(bot, chatId, id);
        await bot.answerCallbackQuery(query.id, { text: !p.preorder ? "Marked pre-order" : "Pre-order cleared" });
        return;
      }
      case "stock": {
        // Real stock control — flips EVERY size of a product at once. This is
        // what decides whether customers can see/buy the item (distinct from
        // the pre-order flag). Admin-gated by the isAdmin check at the top.
        const dir = parts[1];
        const id = parseInt(parts[2] ?? "", 10);
        const p = await getProduct(id);
        if (!p || (dir !== "in" && dir !== "out")) {
          await bot.answerCallbackQuery(query.id, { text: "Couldn't update stock.", show_alert: true });
          break;
        }
        const targetState = dir === "in" ? "in_stock" : "sold_out";
        let count = 0;
        try {
          count = await setAllVariantsStock(id, targetState);
        } catch (err) {
          logger.error({ err, productId: id, targetState }, "pa:stock setAllVariantsStock failed");
          await bot.answerCallbackQuery(query.id, { text: "Couldn't update stock.", show_alert: true });
          break;
        }
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        await sendProductDetail(bot, chatId, id);
        await bot.answerCallbackQuery(query.id, { text: dir === "in" ? "Back in stock" : "Marked sold out" });
        // Same team notifier every other stock path uses — no silent changes.
        const variants = await getProductVariants(id).catch(() => []);
        await notifyTeamStockChange(bot, {
          productName: p.name,
          productEmoji: p.emoji ?? "🌿",
          targetState,
          actor: query.from.username ? `@${query.from.username}` : query.from.first_name ?? chatId,
          actorChatId: chatId,
          countSuffix: variants.length > 0 ? ` · ${count}/${variants.length} sizes` : "",
          source: "product_admin",
        });
        return;
      }
      case "vstock": {
        // Per-size stock flip from the Sizes view. Mirrors the product-level
        // control above but targets a single variant.
        const dir = parts[1];
        const vid = parseInt(parts[2] ?? "", 10);
        if ((dir !== "in" && dir !== "out") || Number.isNaN(vid)) {
          await bot.answerCallbackQuery(query.id, { text: "Couldn't update stock.", show_alert: true });
          break;
        }
        const targetState = dir === "in" ? "in_stock" : "sold_out";
        let ok = false;
        try {
          ok = await setVariantStock(vid, targetState);
        } catch (err) {
          logger.error({ err, variantId: vid, targetState }, "pa:vstock setVariantStock failed");
        }
        if (!ok) {
          await bot.answerCallbackQuery(query.id, { text: "That size is gone.", show_alert: true });
          break;
        }
        const v = await getVariant(vid);
        const product = v ? await getProduct(v.productId) : undefined;
        if (v) {
          try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
          await sendVariantsView(bot, chatId, v.productId);
        }
        await bot.answerCallbackQuery(query.id, { text: dir === "in" ? "Back in stock" : "Marked sold out" });
        if (v && product) {
          await notifyTeamStockChange(bot, {
            productName: product.name,
            productEmoji: product.emoji ?? "🌿",
            variantLabel: v.label,
            variantId: v.id,
            targetState,
            actor: query.from.username ? `@${query.from.username}` : query.from.first_name ?? chatId,
            actorChatId: chatId,
            source: "product_admin",
          });
        }
        return;
      }
      case "up":
      case "down": {
        const id = parseInt(parts[1] ?? "", 10);
        const products = await getAllProductsOrdered();
        const idx = products.findIndex((p) => p.id === id);
        if (idx < 0) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        const targetIdx = action === "up" ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= products.length) {
          await bot.answerCallbackQuery(query.id, { text: action === "up" ? "Already at top" : "Already at bottom" });
          return;
        }
        await swapProductPositions(products[idx].id, products[targetIdx].id);
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        await sendProductDetail(bot, chatId, id);
        await bot.answerCallbackQuery(query.id, { text: action === "up" ? "Moved up" : "Moved down" });
        return;
      }
      case "bcast": {
        // Step 1: confirm. Blasting every subscriber is a big, irreversible
        // send, so gate it behind a Yes/Cancel like Delete does.
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        await replaceWithText(
          bot,
          query,
          `📣 Broadcast "${p.name}" to ALL subscribers now?\n\n` +
            `Everyone on the list gets a one-off promo (the product photo + an AI-written blurb + today's prices & hours). This can't be unsent.\n\n` +
            `Heads up: this also counts as today's daily promo, so the automatic blast won't fire again today.`,
          buildBroadcastConfirmKeyboard(id),
        );
        break;
      }
      case "bcastok": {
        // Step 2: fire. Delegates to the promo broadcaster's full pipeline.
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        await replaceWithText(bot, query, `📣 Sending "${p.name}" to all subscribers…`, { inline_keyboard: [] });
        await bot.answerCallbackQuery(query.id, { text: "Broadcasting…" });
        const result = await broadcastProductNow(bot, id);
        if (result.ok) {
          // Plain text — the report embeds raw AI copy that can carry
          // unbalanced Markdown; parse_mode would bounce the whole message.
          await bot.sendMessage(chatId, result.report);
        } else {
          await bot.sendMessage(chatId, `⏭ Didn't send: ${result.reason}`);
        }
        await sendProductDetail(bot, chatId, id);
        return;
      }
      case "del": {
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        await replaceWithText(
          bot,
          query,
          `🗑 Delete "${p.name}"?\n\nThis can't be undone.`,
          buildDeleteConfirmKeyboard(id),
        );
        break;
      }
      case "delok": {
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Already gone." });
        } else {
          await deleteProduct(id);
        }
        await replaceWithText(
          bot,
          query,
          `📋 Products\n\nDeleted${p ? ` "${p.name}"` : ""}.`,
          await buildListKeyboard(),
        );
        await bot.answerCallbackQuery(query.id, { text: "Deleted" });
        return;
      }
      case "add": {
        sessions.set(chatId, { kind: "add" });
        await bot.sendMessage(
          chatId,
          "➕ Add a product — one message, your layout.\n\n" +
          "Just include a name, price, and a quick description. Attach a photo if you want one.\n\n" +
          "Examples that all work:\n\n" +
          "• Blue Dream — $40. Smooth hybrid, easy smoke.\n" +
          "• Name: OG Kush\nPrice: $50\nNotes: heavy indica, sleepy\n" +
          "• Pre-roll, 1g, $25, fire kush\n\n" +
          "AI reads it and pulls the bits out.",
          { reply_markup: buildCancelKeyboard() }
        );
        break;
      }
      case "vars": {
        const id = parseInt(parts[1] ?? "", 10);
        if (Number.isNaN(id)) break;
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        await sendVariantsView(bot, chatId, id);
        break;
      }
      case "varadd": {
        const id = parseInt(parts[1] ?? "", 10);
        const p = await getProduct(id);
        if (!p) {
          await bot.answerCallbackQuery(query.id, { text: "Product not found.", show_alert: true });
          break;
        }
        sessions.set(chatId, { kind: "var-add", productId: id });
        await bot.sendMessage(
          chatId,
          `➕ Add a size for "${p.name}".\n\nSend it as \`<label> <price>\` — e.g.\n  \`1g 40\`\n  \`3.5g $130\`\n  \`Each 40\``,
          { parse_mode: "Markdown", reply_markup: buildCancelKeyboard() },
        );
        break;
      }
      case "varedit": {
        const variantId = parseInt(parts[1] ?? "", 10);
        const v = await getVariant(variantId);
        if (!v) {
          await bot.answerCallbackQuery(query.id, { text: "Size not found.", show_alert: true });
          break;
        }
        sessions.set(chatId, { kind: "var-edit", variantId });
        await bot.sendMessage(
          chatId,
          `✏️ Editing *${v.label}* — current price ${formatPriceCents(v.priceCents)}.\n\nSend the new value as \`<label> <price>\`. Examples:\n  \`3.5g 130\`\n  \`7g $250\``,
          { parse_mode: "Markdown", reply_markup: buildCancelKeyboard() },
        );
        break;
      }
      case "vardel": {
        const variantId = parseInt(parts[1] ?? "", 10);
        const v = await getVariant(variantId);
        if (!v) {
          await bot.answerCallbackQuery(query.id, { text: "Already gone." });
          break;
        }
        await deleteVariant(variantId);
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        await sendVariantsView(bot, chatId, v.productId);
        await bot.answerCallbackQuery(query.id, { text: "Deleted." });
        return;
      }
      case "cancel": {
        clearSession(chatId);
        await replaceWithText(bot, query, "Cancelled.", { inline_keyboard: [] });
        await openProductMenu(bot, chatId);
        break;
      }
      case "close": {
        clearSession(chatId);
        await replaceWithText(bot, query, "✖ Closed.", { inline_keyboard: [] });
        break;
      }
      default:
        break;
    }
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    logger.error({ err, data }, "handleProductAdminCallback error");
    try {
      await bot.answerCallbackQuery(query.id, { text: "Something went wrong.", show_alert: true });
    } catch {}
  }
}
