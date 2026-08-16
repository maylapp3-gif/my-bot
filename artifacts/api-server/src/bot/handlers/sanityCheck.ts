import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";

// Pre-send AI sanity gate. Disabled unless AI_SANITY_CHECK_ENABLED=true so
// the operator can roll out cautiously. Fails OPEN — a model glitch must
// never block a legit order.

const SYSTEM = `You're a quick sanity check on a customer's order before it goes to the team. Reply with EXACTLY one short sentence describing any obvious red flag, or the literal word "OK" if nothing's off.

Red flags to surface:
- Notes contain another phone number, social handle, contact, or off-platform meeting place not for the meet itself.
- Notes contain explicit threats, hostile language, or requests to harm.
- Same item ordered in absurd quantity (e.g. 50× of one variant).
- Notes mention a country, region, or address that's clearly not local — we're a hyperlocal in-person service.
- Customer asks for shipping, post, courier, or off-platform payment (we're cash + in person only).

Output ONLY one short sentence (under 90 chars) describing the flag, or the literal "OK". Don't moralize, don't explain, don't list multiple flags — pick the most important one.`;

export async function aiSanityCheck(
  orderText: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const flag = process.env.AI_SANITY_CHECK_ENABLED;
  if (flag !== "true" && flag !== "1") return { ok: true };

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 80,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: orderText },
      ],
    });
    const text = (resp.choices[0]?.message?.content ?? "").trim();
    if (!text || /^OK\.?$/i.test(text)) return { ok: true };
    const cleaned = text.replace(/^["'`]+|["'`]+$/g, "").slice(0, 200);
    return { ok: false, reason: cleaned };
  } catch (err) {
    logger.warn({ err }, "AI sanity check threw — failing open");
    return { ok: true };
  }
}
