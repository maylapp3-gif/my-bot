// Per-product emoji helpers. Each product carries its own emoji (chosen by the
// AI parser when an admin adds a product, or edited later). Legacy products
// without one fall back to a deterministic pick from a curated set so the
// product still feels distinct on the menu without showing a leaf.

const FALLBACK_EMOJIS = [
  "💎", "🔥", "🌬", "🍋", "🍇", "🟣", "🌸", "🍫", "🥭", "🍊",
  "🌶", "💧", "✨", "⭐", "🌌", "🪐", "🌷", "🟢", "🫧", "🌠",
];

// Cheap stable hash → pick from FALLBACK_EMOJIS. Same name always picks the
// same emoji so customers see consistent branding across menu loads.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function fallbackEmojiFor(name: string): string {
  return FALLBACK_EMOJIS[hash(name) % FALLBACK_EMOJIS.length] ?? "💎";
}

// Anything containing at least one Extended_Pictographic codepoint counts as
// "looks like an emoji". This covers all the strain-relevant glyphs we care
// about (🔥 🍇 💎 🌬 etc.) plus ZWJ sequences (👨‍🔬 etc.) without false-
// matching plain text/punctuation.
const HAS_EMOJI = /\p{Extended_Pictographic}/u;

function looksLikeEmoji(s: string): boolean {
  return HAS_EMOJI.test(s);
}

// The single emoji to render for a product. Prefers the admin/AI-chosen emoji
// IF it actually contains an emoji codepoint, else a deterministic fallback
// derived from the product name. The looksLikeEmoji guard means a stale bad
// value (legacy row, model hiccup, manual DB edit) can never leak garbage
// into a customer caption.
export function emojiFor(p: { emoji?: string | null; name: string }): string {
  const stored = (p.emoji ?? "").trim();
  if (stored && looksLikeEmoji(stored)) return stored;
  return fallbackEmojiFor(p.name);
}

// Sanity check on AI/admin input — only accept input that contains at least
// one actual emoji codepoint, then cap to the first whitespace-separated chunk
// at a small codepoint budget so ZWJ sequences (skin tones, family glyphs)
// survive but stray sentences ("🔥 fire kush gas") get trimmed to "🔥".
// Returns "" for plain-text noise, punctuation-only, or empty input — the
// caller is expected to fall back to fallbackEmojiFor(name) in that case.
export function sanitizeEmoji(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const firstWord = trimmed.split(/\s+/)[0] ?? "";
  const codepoints = Array.from(firstWord);
  const candidate = codepoints.slice(0, 8).join("");
  return looksLikeEmoji(candidate) ? candidate : "";
}
