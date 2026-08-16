import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger.js";
import { sanitizeEmoji, fallbackEmojiFor } from "./emoji.js";
import { VERTICAL_NOUN } from "./brand.js";

// AI-pick an emoji for a product, biased toward the NAME (the strain/flavour
// cue lives there). Description is used only as a tiebreaker. Returns a
// validated single emoji or — on AI failure / unparseable output — a
// deterministic fallback so callers never see "".
export async function aiPickEmojiForName(name: string, description?: string): Promise<string> {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 40,
      messages: [
        {
          role: "system",
          content:
            `You pick ONE emoji for a ${VERTICAL_NOUN} product. Read the product NAME first — strain/flavour cues live there. Description is a tiebreaker.

Output ONLY the emoji character. No words, no quotes, no commentary.

Cue → emoji guide (apply the BEST single match, not multiple):
- citrus / lemon / sour / zest → 🍋
- grape / berry / purple / blueberry → 🍇
- mango / pineapple / tropical → 🥭
- watermelon / melon → 🍉
- apple / sour apple → 🍏
- strawberry / cherry → 🍓
- cake / cookie / cream / dessert / cheesecake / wedding → 🍰
- "Cookies" (the strain family) → 🍪
- chocolate / mocha / brownie → 🍫
- mint / ice / cool / frost / chill → 🌬
- fire / loud / strong / nuclear → 🔥
- gas / diesel / fuel → ⛽
- kush / OG / classic indica → 🟢
- haze / sativa / energy / wake / day → ⚡
- indica / sleep / night / moon / nighttime → 🌙
- skywalker / galaxy / space / cosmic / stardust → 🌌
- alien / UFO → 👽
- crystal / diamond / glass / rosin / live resin / concentrate → 💎
- water / wet / hash → 💧
- pre-roll / joint / blunt → 🚬
- edible / gummy / candy → 🍬
- runtz / candy → 🍭
- flower / bouquet → 🌸
- sunset / orange / tangerine → 🌅
- jungle / forest → 🌴

Never output 🌿 or 🍃 (the leaf — overused). If absolutely nothing matches, output 💎.`,
        },
        { role: "user", content: description ? `${name}\n${description}` : name },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? "";
    const cleaned = sanitizeEmoji(raw);
    return cleaned || fallbackEmojiFor(name);
  } catch (err) {
    logger.error({ err, name }, "aiPickEmojiForName failed — using deterministic fallback");
    return fallbackEmojiFor(name);
  }
}
