// Telegram does NOT expose an account's creation date (or phone number) to
// bots or userbots. The only age-ish signal available is the numeric user id,
// which grows roughly monotonically as new accounts are created over time.
//
// So this is deliberately CRUDE: a single configurable threshold. Ids at or
// above it are annotated "likely a recent account". It is used ONLY to enrich
// a moderator alert — it never gates, blocks, or auto-acts on anything, and we
// never claim a precise age. When we can't parse the id we return null (no
// claim either way).
//
// The frontier drifts upward over time, so the threshold is tunable via the
// NEW_ACCOUNT_ID_THRESHOLD env var. Bump it periodically (or when the
// annotation starts feeling noisy) — it has no effect on who gets flagged,
// only on whether the "recent account" line shows.

const DEFAULT_NEW_ACCOUNT_ID_THRESHOLD = 7_500_000_000n;

function threshold(): bigint {
  const raw = process.env.NEW_ACCOUNT_ID_THRESHOLD;
  if (raw) {
    try {
      const v = BigInt(raw.trim());
      if (v > 0n) return v;
    } catch {
      /* malformed — fall through to default */
    }
  }
  return DEFAULT_NEW_ACCOUNT_ID_THRESHOLD;
}

// true  → id parses and sits at/above the threshold (looks recent)
// false → id parses and is below the threshold (looks established)
// null  → can't tell (unparseable / non-positive)
export function isLikelyNewAccount(userId: string): boolean | null {
  let id: bigint;
  try {
    id = BigInt(userId.trim());
  } catch {
    return null;
  }
  if (id <= 0n) return null;
  return id >= threshold();
}
