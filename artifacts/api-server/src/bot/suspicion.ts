import { isRegular, getApprovalState } from "./db.js";
import { isLikelyNewAccount } from "./accountAge.js";

// Signals about a peer that has DMed a moderator's PERSONAL account. None of
// these auto-act; they only decide whether to surface a private heads-up to
// the moderator (the actual block is always a human one-tap).
export interface PeerSignals {
  // "OK / leave alone" — an approved customer on the bot OR a marked regular.
  // (Telegram user ids are global, so the userbot peer id is the same id the
  // bot stores as chat_id for the same person.)
  isOk: boolean;
  // Annotations shown in the alert. Approximate / best-effort.
  likelyNewAccount: boolean | null; // crude id-based heuristic, may be null
  noUsername: boolean;
  unverified: boolean; // not an approved customer and not a regular
}

// All DB lookups fail SAFE toward "not ok" so a transient blip still surfaces a
// heads-up rather than silently swallowing a real stranger. This is safe
// because (a) the userbot only calls this for peers the mod has never replied
// to, and (b) the alert is non-destructive — nothing is blocked without a
// human tap.
export async function assessPeer(opts: {
  chatId: string;
  username?: string | null;
}): Promise<PeerSignals> {
  const username = (opts.username ?? "").trim();
  const [regular, approval] = await Promise.all([
    isRegular(opts.chatId).catch(() => false),
    getApprovalState(opts.chatId).catch(() => "missing" as const),
  ]);
  const isOk = regular || approval === "approved";
  return {
    isOk,
    likelyNewAccount: isLikelyNewAccount(opts.chatId),
    noUsername: username.length === 0,
    unverified: !isOk,
  };
}
