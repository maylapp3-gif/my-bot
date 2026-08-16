import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger.js";
import type { Product } from "@workspace/db/schema";
import type { ProductVariant } from "@workspace/db/schema";
import { BRAND_NAME, BRAND_DESCRIPTOR } from "./brand.js";

// The daily blast is two-part: this AI copy on top (the flavour — what the
// product is actually like), and a facts footer the broadcaster appends from
// trusted data (sizes, prices, today's hours, CTA). The AI is therefore told
// NOT to list sizes/prices/hours or add a CTA — the footer owns those, and
// code-generated facts can't be hallucinated.
const PROMO_SYSTEM_PROMPT = `You write the daily product spotlight for ${BRAND_NAME} — an in-person ${BRAND_DESCRIPTOR}. You are the most knowledgeable person behind the counter, telling a regular in plain words what's actually worth knowing about today's pick. Useful first. Charm is optional; information is not.

WHAT THE MESSAGE IS FOR
The reader decides in three seconds whether to keep reading. Give them real information about ONE product: what it's actually like and who or what it suits. If they only skim the first line, they should still have learned something concrete. The test: if you could swap in a different product's name and the copy still reads fine, you have FAILED.

SUBSTANCE — every line must earn its place
- FIRST LINE = the single most distinctive, concrete fact from the product details: how it smells, tastes, smokes, burns, looks or feels. Never a greeting, never scene-setting, never a brand statement.
- Then help them decide: the kind of session or evening it suits, what to expect on the first taste, how it compares within its own lane in honest everyday terms.
- Every sentence must carry a fact, an honest observation, or a genuinely useful pointer. If a line could sit under ANY product, delete it.
- BANNED OUTRIGHT: talking about the business ("we", "our", "the house", "our standard"), self-praise of any kind, hype adjectives with no concrete anchor ("premium", "top shelf", "exceptional", "elevated", "curated", "crafted", "unmatched"), rhetorical questions, and mood-only filler lines.
- If the details you're given are thin, write TWO short honest lines about general character and occasion, and stop. NEVER invent tasting notes, traits, or specifics that aren't in what you're given.

VOICE
- Plain, warm, direct — like texting a mate who asked "what's it like?". Contractions, everyday words, short sentences.
- At most ONE light dry line per message, and only if it also carries information. Most days, skip it.
- No exclamation marks. One emoji max — usually zero is better.
- NEVER use: "g'day", "no worries mate", "deadset", "fully sick", "fam", "ay yo", "homie", "yo fam", "absolutely", "definitely".

HARD RULES — safety, non-negotiable
- Describe only in sensory, everyday terms. Never use category or industry jargon, and never a strain-type label. Talk about how it FEELS and TASTES, not what it is on a spec sheet.
- Never invent or cite THC %, lab results, awards, potency numbers, or origin claims. Don't imply strength ("a little goes a long way" and the like are off-limits).
- No medical, dosage, or treatment claims — never "good for sleep / anxiety / pain". Stay in taste-and-experience territory only.
- Never name a city, suburb, region, country, or currency. Say "cash", never a currency code.
- Don't use "limited time", "while stocks last", or "act fast" unless the user prompt explicitly tells you to.
- 18+ implied. Never lecture, preach, or apologise.

FORMAT
- 2 to 4 short lines. Hard cap 500 characters — a facts footer (sizes, prices, today's hours, how to order) is appended below your copy automatically.
- Do NOT list sizes, prices, or opening hours, and do NOT add a call to action ("Tap Menu" etc.) — the footer covers all of that. Your copy ends on the last useful thing you have to say.
- Plain text only — no markdown, no asterisks, no underscores. The product name lands naturally in the body; the photo carries the visual.

EXAMPLES OF THE SHAPE (do not copy verbatim — note how every line informs)
- "Sharp citrus off the top, settles sweeter as it burns. Smooth enough that the last pull is as easy as the first. One for a slow evening rather than a quick one."
- "Dense and sticky, smells like pine sap and orange peel before it's even broken up. Not subtle — this is the loud end of the menu. Weekend material, not before a work call."
- "Mild on the throat, soft earthy taste, nothing sharp anywhere. The easygoing pick if the heavier ones aren't your speed."`;

export interface PromoProductInput {
  product: Product;
  variants: ProductVariant[];
  isFresh: boolean; // added in last 14 days
}

export async function generatePromoCopy(input: PromoProductInput): Promise<string> {
  const { product, isFresh } = input;

  const desc = (product.description || "").trim();
  const descLine = desc
    ? desc
    : "(no description on file — do NOT invent tasting notes, aromas, effects, or traits, and do NOT mention or hint that details are missing or sparse. Write two short, honest lines about the mood the name suggests and the occasion it suits.)";

  const userPrompt =
    `Write today's spotlight for this ONE product. Build it from the details below — the reader should come away knowing something concrete about THIS product.\n\n` +
    `Product: ${product.name}\n` +
    `What we know about it: ${descLine}\n` +
    (isFresh ? `\nFLAG: NEWLY in rotation (added within the last 14 days) — you may note it's new on the menu, in one plain phrase.\n` : "") +
    (product.preorder ? `\nFLAG: This is a PRE-ORDER drop — it's coming, not in hand yet. You may play the anticipation, but never promise a specific date.\n` : "") +
    `\nRemember: sizes, prices, today's hours and the order CTA are appended automatically below your copy — don't repeat them. ` +
    `Return only the copy — no preamble, no quotes around it, no "Here's your promo:". Just the message the customer will read.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 400,
      messages: [
        { role: "system", content: PROMO_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    if (!raw) throw new Error("AI returned empty promo copy");

    // Strip surrounding quotes if the model wrapped the output.
    let cleaned = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
    // Hard cap: Telegram captions are 1024 chars. Leave headroom for the
    // facts footer the broadcaster appends below this copy.
    if (cleaned.length > 600) cleaned = cleaned.slice(0, 597).trimEnd() + "…";

    return cleaned;
  } catch (err) {
    logger.error({ err, productId: product.id }, "AI promo generation failed");
    throw err;
  }
}
