import { randomInt, createHash } from "crypto";
import { cleanInput } from "./escape.js";

// ===========================================================================
// Shared, surface-agnostic primitives for the LeafedOut verification flow.
// Pure (no Telegram / DB deps) so BOTH surfaces reuse one source of truth:
//   - the customer bot           → bot/handlers/verify.ts
//   - the moderator companion    → userbot/verifyChat.ts
// Keeping the handle rules, caps, throttle, and proof-code generator here means
// the bot and the userbot can never drift on what a valid handle is, how many
// auto-checks a customer gets, or how the one-time code looks.
// ===========================================================================

// LeafedOut handles: letters/numbers/._- only. Forbidding spaces/backticks
// also keeps the value safe inside a Markdown code span in the admin message.
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;

// Cap lifetime rejections so a stuck/abusive user can't loop forever.
export const VERIFY_REJECTION_CAP = 3;

// Auto-check attempts per 'collecting' cycle before we hand off to the admin
// manual queue. Reset whenever a new username is submitted. Combined with the
// throttle below, this bounds outbound LeafedOut fetches.
export const AUTO_CHECK_CAP = 5;

// Min gap between two auto-checks for the same chat. Anti-hammer; also covers
// the unreachable path, which deliberately refunds its attempt.
export const AUTO_CHECK_THROTTLE_MS = 30_000;

// Unambiguous alphabet (no I/L/O/0/1) for an easy-to-copy proof code.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeVerifyCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

// Normalize a user-typed LeafedOut handle: strip control chars / whitespace and
// a leading @ (people paste "@handle"). Does NOT validate — callers test the
// result against USERNAME_RE. Original case is preserved here because it is what
// gets stored and used to build the public-profile URL (LeafedOut paths may be
// case-sensitive).
export function normalizeHandle(text: string): string {
  return cleanInput(text).replace(/^@+/, "");
}

// Canonical form used ONLY for identity comparison (ban list, one-account-per-
// handle). Lowercased so "Alice" and "alice" can't be used to dodge a ban or
// the uniqueness rule. NOT used for storage or the profile fetch.
export function canonicalHandle(text: string): string {
  return normalizeHandle(text).toLowerCase();
}

// One-way hash of the canonical handle, used as the primary key of the
// banned-handle list. Storing the hash (not the plaintext) keeps the ban list
// forensically minimal: it supports an exact-match lookup on re-verification
// but can't be reversed back into a customer's LeafedOut identity.
export function hashHandle(text: string): string {
  return createHash("sha256").update(canonicalHandle(text)).digest("hex");
}
