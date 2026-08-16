import type TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";

// In-memory handover state. Maps customer chatId -> moderator chatId who has claimed it.
// On restart, all claims are released (handlers will fall back to AI). Keep in DB later if needed.
const claims = new Map<string, { moderatorId: string; claimedAt: number }>();

// Hard cap on how long a single mod can sit on a claim before the janitor
// auto-releases it. Stops the "sticky claim" pattern where a mod /take's a
// chat, then goes silent and the customer hangs forever — because the AI
// fallback path is suppressed while a claim is held.
const CLAIM_TTL_MS = 10 * 60 * 1000;

// Pending AI fallback timers (mods-first model). Maps customer chatId -> active setTimeout.
// When the timer fires, AI auto-answers the last unread customer message.
const pendingFallbacks = new Map<string, NodeJS.Timeout>();

// Pending escalation-warning timers — fired ~1 min before the AI fallback so
// moderators get a "last chance" ping in their DMs.
const pendingWarnings = new Map<string, NodeJS.Timeout>();

export function scheduleFallback(customerChatId: string, fn: () => void | Promise<void>, delayMs: number): void {
  const existing = pendingFallbacks.get(customerChatId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingFallbacks.delete(customerChatId);
    Promise.resolve(fn()).catch(() => undefined);
  }, delayMs);
  pendingFallbacks.set(customerChatId, t);
}

export function cancelFallback(customerChatId: string): boolean {
  // Cancel BOTH the AI fallback and any pending escalation-warning ping.
  const w = pendingWarnings.get(customerChatId);
  if (w) {
    clearTimeout(w);
    pendingWarnings.delete(customerChatId);
  }
  const existing = pendingFallbacks.get(customerChatId);
  if (!existing) return false;
  clearTimeout(existing);
  pendingFallbacks.delete(customerChatId);
  return true;
}

export function hasPendingFallback(customerChatId: string): boolean {
  return pendingFallbacks.has(customerChatId);
}

export function scheduleWarning(customerChatId: string, fn: () => void | Promise<void>, delayMs: number): void {
  const existing = pendingWarnings.get(customerChatId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingWarnings.delete(customerChatId);
    Promise.resolve(fn()).catch(() => undefined);
  }, delayMs);
  pendingWarnings.set(customerChatId, t);
}

export function claimChat(customerChatId: string, moderatorId: string): boolean {
  const existing = claims.get(customerChatId);
  if (existing && existing.moderatorId !== moderatorId) return false;
  claims.set(customerChatId, { moderatorId, claimedAt: Date.now() });
  return true;
}

export function releaseChat(customerChatId: string, moderatorId: string): boolean {
  const existing = claims.get(customerChatId);
  if (!existing) return true;
  if (existing.moderatorId !== moderatorId) return false;
  claims.delete(customerChatId);
  return true;
}

export function forceReleaseChat(customerChatId: string): void {
  claims.delete(customerChatId);
}

export function getClaimer(customerChatId: string): string | undefined {
  return claims.get(customerChatId)?.moderatorId;
}

export function isClaimed(customerChatId: string): boolean {
  return claims.has(customerChatId);
}

export function isClaimedBy(customerChatId: string, moderatorId: string): boolean {
  return claims.get(customerChatId)?.moderatorId === moderatorId;
}

export function getActiveClaims(): { customerChatId: string; moderatorId: string; claimedAt: number }[] {
  return Array.from(claims.entries()).map(([customerChatId, v]) => ({
    customerChatId,
    moderatorId: v.moderatorId,
    claimedAt: v.claimedAt,
  }));
}

// Janitor: scans claims every minute, auto-releases any held longer than
// CLAIM_TTL_MS, and DMs the claiming mod so they know to re-/take if they
// are still working it. Without this, a silent mod blocks the AI fallback
// path and the customer hangs indefinitely.
export function startClaimsJanitor(bot: TelegramBot): NodeJS.Timeout {
  const tick = async () => {
    const now = Date.now();
    const expired: { customerChatId: string; moderatorId: string; ageMs: number }[] = [];
    for (const [customerChatId, v] of claims.entries()) {
      if (now - v.claimedAt >= CLAIM_TTL_MS) {
        expired.push({ customerChatId, moderatorId: v.moderatorId, ageMs: now - v.claimedAt });
      }
    }
    for (const e of expired) {
      claims.delete(e.customerChatId);
      try {
        const mins = Math.round(e.ageMs / 60000);
        await bot.sendMessage(
          e.moderatorId,
          `🔁 Auto-released chat \`${e.customerChatId}\` — held for ${mins} min with no /reply or /qr.\n` +
            `If you're still on it (your own DM is fine), no action needed. If you want the bot to suppress the AI again, /take ${e.customerChatId}.`,
          { parse_mode: "Markdown" },
        );
      } catch (err) {
        logger.warn({ err, moderatorId: e.moderatorId }, "claims janitor: notify mod failed");
      }
    }
    if (expired.length > 0) {
      logger.info({ count: expired.length }, "claims janitor: released stale claims");
    }
  };
  const interval = setInterval(() => { void tick(); }, 60 * 1000);
  logger.info({ ttlMs: CLAIM_TTL_MS }, "Claims janitor started (auto-release after 10 min)");
  return interval;
}

// Moderator IDs are the union of ADMIN_CHAT_IDS (admins are always moderators)
// and MODERATOR_CHAT_IDS (moderator-only role: handover commands, no admin powers).
function parseIdList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getModeratorIds(): string[] {
  const admins = parseIdList(process.env.ADMIN_CHAT_IDS);
  const mods = parseIdList(process.env.MODERATOR_CHAT_IDS);
  return Array.from(new Set([...admins, ...mods]));
}

export function isModerator(chatId: string): boolean {
  return getModeratorIds().includes(chatId);
}
