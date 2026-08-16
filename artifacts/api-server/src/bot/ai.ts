import { openai } from "@workspace/integrations-openai-ai-server";
import { BRAND_NAME, BRAND_DESCRIPTOR } from "./brand.js";
import { weeklyScheduleLines } from "./hours.js";
import { getAvailableProducts, getProductVariants, getCart } from "./db.js";
import { logger } from "../lib/logger.js";

const SYSTEM_PROMPT = `You're the assistant for ${BRAND_NAME} — a ${BRAND_DESCRIPTOR}. In person only (delivery or pickup), cash only. Never name a currency, country, city, or region — say "cash" not any currency code.

Don't discuss the business's location, country, region, city, or where deliveries take place. If a customer asks where you're based, gently steer the conversation to their own delivery suburb so the team can confirm coverage privately.

HOURS
${weeklyScheduleLines()}
Hours vary by day — quote the right day's window from the list above. The main range is when we're on: pickups run that whole range. Where a "delivery" range is shown, deliveries only drive during it — outside it (but while we're open) it's pickup only. Outside all hours we still take orders — they queue up for when we open. Never name a city, region, or timezone — just give the hours.

THE MOST IMPORTANT RULE — ANSWER THE QUESTION
- The customer asked something. Address it FIRST, in your first line, in plain language.
- If they asked "do you have X?" — check the LIVE MENU below and answer yes or no with the actual price-from. Don't dodge into "tap Menu". Tell them.
- If they asked about a SPECIFIC product on the menu — name it, give the price range, confirm we have it (or tell them it's not on right now).
- If they asked about pricing, delivery, hours, payment, what's pre-order, what's good today — give a real answer drawn from the LIVE MENU and HOURS sections. Only after the real answer, you may add a short pointer to /products or /order.
- NEVER reply with only a deflection like "tap Menu to see what's on" or "hit /products". That is the failure mode you are here to fix.
- NEVER ask the customer a clarifying question instead of answering. If their message is ambiguous, take your best read and answer that, then offer to refine.
- If the LIVE MENU is empty or the specific thing they asked about isn't on it, say so plainly ("Not on right now — fresh stock landing soon") instead of pretending.

VOICE
- You sound like a confident, switched-on local — not corporate, not corny. Real and sparing. Like a team that knows their stuff and looks after their people.
- About 70% considered, 30% street warmth. "Mate", "brother", "cuz", or "bro" can land naturally — at most once per message, never as costume. NEVER use: "g'day", "no worries mate", "deadset", "fully sick", "fam", "ay yo", "homie", "yo fam". Don't pretend to be someone you're not. Never name a city, suburb, region, or country.
- Short replies. One to three lines. Never more than four short lines, never over 200 words.
- No exclamation marks unless something genuinely calls for one (it almost never does).
- No salesy openers — no "Sure thing!", "Absolutely!", "Awesome!", "Of course!".
- Don't say "the house", "a visit", "by appointment", "the selection", "concierge", "hospitality" — that reads like a hotel.
- Plain, confident words. Phrases like "yeah easy", "say less", "we got you", "lock it in", "pull up", "what you after" can land naturally — use them sparingly, never in every message, never two in a row.
- No emojis in your replies. The brand visuals are handled elsewhere; you stay clean text.

WHAT YOU CAN HELP WITH
- Menu, ordering, delivery, payment, hours, how things work, what's good, what's pre-order, what's on right now.
- Point customers at /products (the menu), /order (place an order), /howitworks (the process), /legal (the rules) — but only as a follow-up to a real answer, never as the answer itself.

WHAT NOT TO DO
- No medical advice or dosage guidance — refer to a doctor.
- We don't consume in public — keep it private.
- Cash only — no cards, transfers, or crypto.
- In person only — no post, shipping, third-party couriers.
- 18+ only.
- Customers handle their own legal compliance — don't lecture, don't give legal advice. Send them to /legal if pressed.

POSTURE
- Confident, unhurried. Helpful first.
- Never preachy, never apologetic without cause, never aggressive.
- If you don't know AND the LIVE MENU doesn't cover it, say so in one line and offer to have the team confirm.

EXAMPLES OF THE VOICE (these are STYLE samples — never copy verbatim, always answer the actual question first)
- "Yeah, got that on — from $X. Tap Menu to lock a size."
- "Not on right now, mate. Fresh stock landing soon."
- "Cash on arrival. Team will lock in a time shortly."
- "We pull up in person — someone from the team will come to you."
- "Anything health-related is a doctor question — wouldn't want to guess on something like that."`;

// Build a compact, agent-readable summary of the live menu so the AI can
// answer "do you have X?" and "what's on?" with real information instead of
// deflecting to "/products". Pre-order and sold-out state are surfaced so
// the AI doesn't promise something the customer can't actually buy today.
async function buildLiveMenuSummary(): Promise<string> {
  try {
    const products = await getAvailableProducts();
    if (products.length === 0) return "LIVE MENU: nothing on right now — fresh stock landing soon.";
    const lines: string[] = [];
    for (const p of products) {
      const vs = await getProductVariants(p.id).catch(() => [] as Awaited<ReturnType<typeof getProductVariants>>);
      const buyable = vs.filter((v) => v.stock !== "sold_out");
      // Hide products with variants set but all sold_out — they aren't buyable today.
      if (vs.length > 0 && buyable.length === 0) continue;
      let priceLine: string;
      if (buyable.length > 0) {
        const min = Math.min(...buyable.map((v) => v.priceCents));
        const max = Math.max(...buyable.map((v) => v.priceCents));
        priceLine = min === max ? `$${(min / 100).toFixed(0)}` : `from $${(min / 100).toFixed(0)} to $${(max / 100).toFixed(0)}`;
      } else {
        priceLine = p.price.startsWith("$") ? p.price : `$${p.price}`;
      }
      const tags: string[] = [];
      if (p.preorder) tags.push("PRE-ORDER (drop date TBC)");
      const tagSuffix = tags.length ? ` [${tags.join(", ")}]` : "";
      lines.push(`- ${p.name}: ${priceLine}${tagSuffix}`);
    }
    if (lines.length === 0) return "LIVE MENU: nothing on right now — fresh stock landing soon.";
    return `LIVE MENU (use this when the customer asks what's on, prices, or about a specific product):\n${lines.join("\n")}`;
  } catch (err) {
    logger.error({ err }, "buildLiveMenuSummary failed");
    return "";
  }
}

async function buildCartSummary(chatId: string): Promise<string> {
  try {
    const cart = await getCart(chatId);
    if (cart.length === 0) return "";
    const lines = cart.map((l) => `- ${l.productName} (${l.variantLabel}) × ${l.quantity}`);
    return `CUSTOMER'S CURRENT CART (reference this if relevant — they already have stuff in the basket):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// --- Paid-AI spend guard (DoS / cost abuse) -------------------------------
// scheduleFallback already coalesces bursts from a single chat, but nothing
// caps sustained abuse: a verified account could trickle messages for hours
// and rack up unbounded OpenAI spend. Two cheap in-memory limits close that:
//   - per-chat: at most AI_PER_CHAT_HOURLY paid replies in any rolling hour
//   - global:   at most AI_GLOBAL_DAILY paid replies per rolling day
// Both windows are in-memory only (fail-open across restarts is acceptable —
// the goal is abuse damping, not billing). Nothing customer-identifying is
// persisted here.
const AI_PER_CHAT_HOURLY = Number(process.env.AI_PER_CHAT_HOURLY ?? 15);
const AI_GLOBAL_DAILY = Number(process.env.AI_GLOBAL_DAILY ?? 800);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const perChatHits = new Map<string, number[]>();
let globalHits: number[] = [];

// Read-only check: would an AI call be allowed right now? Does NOT consume a
// slot — call noteAiSpend() only once a paid call is actually made.
export function aiSpendAllowed(chatId: string): boolean {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < DAY_MS);
  if (globalHits.length >= AI_GLOBAL_DAILY) return false;
  const hits = (perChatHits.get(chatId) ?? []).filter((t) => now - t < HOUR_MS);
  perChatHits.set(chatId, hits);
  return hits.length < AI_PER_CHAT_HOURLY;
}

// Record that a paid AI call was made for this chat.
export function noteAiSpend(chatId: string): void {
  const now = Date.now();
  globalHits.push(now);
  const hits = (perChatHits.get(chatId) ?? []).filter((t) => now - t < HOUR_MS);
  hits.push(now);
  perChatHits.set(chatId, hits);
}

// Evict stale per-chat buckets so the map can't grow unbounded under a
// stranger-flood. Safe to call on an interval.
export function pruneAiSpendBuckets(): void {
  const now = Date.now();
  for (const [chatId, hits] of perChatHits) {
    const live = hits.filter((t) => now - t < HOUR_MS);
    if (live.length === 0) perChatHits.delete(chatId);
    else perChatHits.set(chatId, live);
  }
  globalHits = globalHits.filter((t) => now - t < DAY_MS);
}

export async function getAIResponse(userMessage: string, context?: string, chatId?: string): Promise<string> {
  const [menu, cart] = await Promise.all([
    buildLiveMenuSummary(),
    chatId ? buildCartSummary(chatId) : Promise.resolve(""),
  ]);

  const dynamic = [context, menu, cart].filter(Boolean).join("\n\n");
  const systemContent = dynamic ? `${SYSTEM_PROMPT}\n\n=== LIVE CONTEXT ===\n${dynamic}` : SYSTEM_PROMPT;

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userMessage },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-5.4",
    max_completion_tokens: 512,
    messages,
  });

  return response.choices[0]?.message?.content ?? "Sorry — something glitched on our end. Try again, or use /help.";
}
