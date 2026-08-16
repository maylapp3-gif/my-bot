import TelegramBot from "node-telegram-bot-api";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import { getAvailableProducts, getProductVariants, trackMessage, formatPriceCents } from "../db.js";
import { escapeMarkdown } from "../escape.js";
import { emojiFor } from "../emoji.js";
import { AI_FORBIDDEN_WORDS } from "../brand.js";

const CB_PREFIX = "pk:";

const MOODS: { key: string; label: string; brief: string }[] = [
  { key: "chill", label: "🌿 Chill", brief: "relaxing, mellow, evening unwind" },
  { key: "energy", label: "⚡ Energy", brief: "uplifting, daytime focus" },
  { key: "sleep", label: "🌙 Sleep", brief: "heavy, late-night, sleep aid" },
  { key: "social", label: "👯 Social", brief: "social, conversational, weekend" },
  { key: "creative", label: "🎨 Creative", brief: "cerebral, expansive, idea-friendly" },
];

export function isMatchmakerCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

export async function handlePick(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < MOODS.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [
      { text: MOODS[i].label, callback_data: `${CB_PREFIX}${MOODS[i].key}` },
    ];
    if (MOODS[i + 1]) {
      row.push({ text: MOODS[i + 1].label, callback_data: `${CB_PREFIX}${MOODS[i + 1].key}` });
    }
    buttons.push(row);
  }
  try {
    const sent = await bot.sendMessage(
      chatId,
      "*Help me pick*\n\n_What's the vibe? Tap one and I'll suggest something off the menu._",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } },
    );
    await trackMessage(chatId, sent.message_id);
  } catch (err) {
    logger.error({ err, chatId }, "/pick handler error");
  }
}

export async function handleMatchmakerCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? "";
  const moodKey = data.slice(CB_PREFIX.length);
  const mood = MOODS.find((m) => m.key === moodKey);
  const chatId = query.message?.chat.id.toString();
  if (!chatId || !mood) {
    try { await bot.answerCallbackQuery(query.id); } catch {}
    return;
  }
  try { await bot.answerCallbackQuery(query.id, { text: "Thinking…" }); } catch {}

  try {
    const products = await getAvailableProducts();
    if (products.length === 0) {
      await bot.sendMessage(chatId, "_Nothing on right now — try again soon._", { parse_mode: "Markdown" });
      return;
    }
    // Compact catalog for the AI. Names and trimmed descriptions only — no IDs.
    const catalog = products
      .map((p) => `- ${p.name}: ${p.description.slice(0, 200)}`)
      .join("\n");

    const userPrompt =
      `Customer's after: ${mood.brief}.\n\nMenu:\n${catalog}\n\n` +
      `Pick the ONE best match from the menu. Reply EXACTLY in this format on two lines:\n` +
      `NAME: <exact product name from the menu>\n` +
      `WHY: <one short sentence, max 100 chars. Vibe + use-case only. NO emojis. NO city/region/country/timezone names. NO product-category vocabulary (no genus, strain, format, or chemistry terms — describe the experience, not the thing). Adjectives + use-case only.>\n\n` +
      `Don't suggest anything not on the menu. Don't include any other text.`;

    const resp = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 120,
      messages: [
        {
          role: "system",
          content:
            "You match products to customer moods from a provided menu. Be brief. Pick from the list only. NEVER name a city, region, country, or timezone. NEVER use product-category vocabulary (no genus, strain, format, or chemistry terms — describe the experience, not the thing). Describe vibe + use-case in adjectives only.",
        },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = (resp.choices[0]?.message?.content ?? "").trim();
    const nameMatch = raw.match(/^NAME:\s*(.+)$/im);
    const whyMatch = raw.match(/^WHY:\s*(.+)$/im);
    const pickedName = nameMatch?.[1]?.trim();
    let why = (whyMatch?.[1]?.trim() ?? "").slice(0, 140);
    // Defense-in-depth post-filter: if the model still slips a category
    // word past the prompt (LLM nondeterminism), drop the WHY line entirely
    // rather than echo the leak back to the customer.
    const FORBIDDEN = AI_FORBIDDEN_WORDS
      ? new RegExp(`\\b(${AI_FORBIDDEN_WORDS}|@[a-z0-9_]{3,}|t\\.me\\/)\\b`, "i")
      : /(@[a-z0-9_]{3,}|t\.me\/)/i;
    if (why && FORBIDDEN.test(why)) {
      logger.warn({ why }, "matchmaker: model WHY tripped forbidden filter — suppressing");
      why = "";
    }
    const product = products.find(
      (p) => pickedName && p.name.toLowerCase() === pickedName.toLowerCase(),
    );
    if (!product) {
      await bot.sendMessage(
        chatId,
        "_Couldn't lock one in — open the menu and have a flick through._",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const variants = await getProductVariants(product.id).catch(
      () => [] as Awaited<ReturnType<typeof getProductVariants>>,
    );
    const inStockVariants = variants.filter((v) => v.stock !== "sold_out");
    const e = emojiFor({ emoji: product.emoji, name: product.name });
    let body =
      `${e} *${escapeMarkdown(product.name)}*\n` +
      (why ? `_${escapeMarkdown(why)}_\n\n` : "\n") +
      escapeMarkdown(product.description.slice(0, 400));
    const buttons: TelegramBot.InlineKeyboardButton[][] = [];
    for (let i = 0; i < inStockVariants.length; i += 2) {
      const row: TelegramBot.InlineKeyboardButton[] = [];
      const a = inStockVariants[i];
      row.push({ text: `${a.label} · ${formatPriceCents(a.priceCents)}`, callback_data: `cm:add:${a.id}` });
      const b = inStockVariants[i + 1];
      if (b) row.push({ text: `${b.label} · ${formatPriceCents(b.priceCents)}`, callback_data: `cm:add:${b.id}` });
      buttons.push(row);
    }
    buttons.push([{ text: "📋 Open full menu", callback_data: "cm:browse" }]);
    if (inStockVariants.length === 0) {
      body += "\n\n_Sold out right now — tap the menu for what's on._";
    }
    const sent = await bot.sendMessage(chatId, body, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    });
    await trackMessage(chatId, sent.message_id);
  } catch (err) {
    logger.error({ err, chatId, moodKey }, "matchmaker callback error");
    try {
      await bot.sendMessage(chatId, "_Couldn't pick one just now — try the full menu._", {
        parse_mode: "Markdown",
      });
    } catch {}
  }
}
