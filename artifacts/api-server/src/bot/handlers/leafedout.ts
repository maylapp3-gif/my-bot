import { logger } from "../../lib/logger.js";

// ===========================================================================
// Automated LeafedOut proof-of-ownership check.
//
// The customer places a one-time code on their PUBLIC LeafedOut profile; this
// module fetches that profile server-side and confirms the code is present.
// LeafedOut profiles are public + server-rendered, so a plain fetch sees the
// bio text — no login, no API, no human with LeafedOut access required.
//
// Security posture (this is the only place the bot reaches an external,
// user-named URL, so it is hardened as a unit):
//   - Username is re-validated against a strict allowlist and URL-encoded
//     before it touches the path (SSRF / path-injection guard). The host is a
//     fixed constant — the username can only ever be a path segment.
//   - Redirects are followed, but the FINAL response host must still be
//     LeafedOut, else we treat the attempt as unreachable (fail closed).
//   - The body is read through a streamed byte cap so a hostile/huge response
//     can't exhaust memory.
//   - A short timeout bounds each fetch.
//
// Return contract:
//   found     — the code string appears on the profile page.
//   reachable — at least one profile URL was actually fetched from LeafedOut.
//               false only when every attempt threw / timed out / redirected
//               off-host, so the caller can say "couldn't reach LeafedOut"
//               instead of wrongly telling the customer their code is missing.
// ===========================================================================

const LEAFEDOUT_HOST = "leafedout.com";
// A real user resolves under both slugs; the other LeafedOut types 404. We try
// consumer first (the overwhelming common case for an ordering customer).
const PROFILE_TYPES = ["cannabis-consumer", "cannabis-vendor"] as const;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024; // profiles are ~15–25 KB; this is generous.
// Independent re-validation (defense in depth — the caller already validates).
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type ProfileCheck = { found: boolean; reachable: boolean };

function isLeafedOutHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host === LEAFEDOUT_HOST || host.endsWith(`.${LEAFEDOUT_HOST}`);
  } catch {
    return false;
  }
}

// Read up to MAX_BYTES of the body as text, then stop. Returns null on error.
async function readCapped(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body) {
    // No stream (shouldn't happen for these pages) — fall back, still capped.
    try {
      const t = await res.text();
      return t.slice(0, MAX_BYTES);
    } catch {
      return null;
    }
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= MAX_BYTES) break;
    }
    out += decoder.decode();
    return out;
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

// Case-insensitive search for the EXACT issued code (hyphenated form only).
// We deliberately do NOT tolerate a dropped separator: the bare 6-char form
// risks false-positive collisions against script hashes / base64 / asset
// fingerprints elsewhere on the page, which would let an attacker "prove" a
// code they never placed. The collecting screen always shows the code WITH the
// hyphen, so a real customer pastes it verbatim.
function htmlContainsCode(html: string, code: string): boolean {
  return html.toLowerCase().includes(code.toLowerCase());
}

async function fetchProfile(
  type: string,
  username: string,
): Promise<{ reachable: boolean; html: string | null }> {
  const url = `https://${LEAFEDOUT_HOST}/${type}/${encodeURIComponent(username)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html" },
    });
    // Fail closed if a redirect carried us off LeafedOut.
    if (!isLeafedOutHost(res.url || url)) {
      logger.warn({ finalUrl: res.url }, "leafedout check: off-host redirect");
      return { reachable: false, html: null };
    }
    const html = await readCapped(res);
    return { reachable: html !== null, html };
  } catch (err) {
    // Network error / timeout / abort — unreachable for this attempt.
    logger.warn({ err, type }, "leafedout profile fetch failed");
    return { reachable: false, html: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyCodeOnProfile(
  username: string,
  code: string,
): Promise<ProfileCheck> {
  if (!USERNAME_RE.test(username) || !code) {
    // Invalid input never produces a network call; treat as a clean miss.
    return { found: false, reachable: true };
  }
  let anyReachable = false;
  for (const type of PROFILE_TYPES) {
    const { reachable, html } = await fetchProfile(type, username);
    if (reachable) anyReachable = true;
    if (html && htmlContainsCode(html, code)) {
      return { found: true, reachable: true };
    }
  }
  return { found: false, reachable: anyReachable };
}
