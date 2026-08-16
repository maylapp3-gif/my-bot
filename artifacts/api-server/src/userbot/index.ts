import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { logger } from "../lib/logger.js";
import { getModStatus, trackMessage, needsVerification } from "../bot/db.js";
import { pickDefaultAwayMessage } from "../bot/handlers/driving.js";
import { generateAutoReply } from "../bot/aiAutoReply.js";
import { isOpenNow, closedPhase } from "../bot/hours.js";
import type TelegramBot from "node-telegram-bot-api";
import { assessPeer } from "../bot/suspicion.js";
import { buildSuspiciousAlert } from "../bot/handlers/suspicious.js";
import { registerUserbot } from "./registry.js";
import { runUserbotVerification } from "./verifyChat.js";

// How long to wait after a customer DM before the userbot speaks up. If the
// moderator replies inside this window (we see an outgoing message to that
// peer), we cancel the auto-reply — the human got there first.
// 5-minute grace window. Briefly tried 90s and operator feedback was that
// it fired too aggressively, stepping on top of conversations the mod was
// already mid-replying to. Back to 5min.
const REPLY_DELAY_MS = 5 * 60 * 1000;

// Per-customer cooldown: don't auto-reply to the same person more than once
// per hour. They got the message; spamming them defeats the point.
const COOLDOWN_MS = 60 * 60 * 1000;

// In-chat verification flood guard. Unlike the away-reply (which waits 5 min),
// the verification flow answers conversationally, so a hostile peer could try
// to make THIS personal account spam (FLOOD_WAIT / ban risk). Cap it per peer:
// ignore rapid-fire bursts (debounce) and stop entirely past an hourly ceiling
// — by then the mod has already been flagged, so going silent is correct.
const VERIFY_BUDGET_DEBOUNCE_MS = 5 * 1000;
const VERIFY_BUDGET_MAX = 12;

// Conversation-closer detection. If the customer's incoming message is just
// a sign-off ("ok", "thanks", "👍", etc.) we should NOT auto-reply — the
// conversation is done. The userbot was firing on these and customers were
// (rightly) saying "why's it talking to me again, we were finished".
//
// Heuristic: strip punctuation/emoji/whitespace, lowercase, and check if
// what's left is empty (= emoji-only) OR matches a known closer word. We
// only treat it as a closer when the WHOLE message is a closer — "ok cool
// what about runtz" is not a closer because there's a real question after.
const CLOSER_TOKENS = new Set([
  "ok", "okay", "okey", "k", "kk", "kkk", "okk", "oki", "okie",
  "thanks", "thank", "thankyou", "thx", "thnx", "ty", "tysm", "tyvm",
  "cheers", "ta", "appreciate", "appreciated", "appreciateit",
  "cool", "sweet", "nice", "sick", "wicked", "perfect", "great", "good",
  "allgood", "noworries", "np", "nw", "alright", "aight", "righto",
  "bye", "goodbye", "cya", "cyalater", "cyaround", "seeya", "seeyou",
  "later", "laters", "ttyl", "ttys", "gn", "gnight", "goodnight", "night",
  "done", "sorted", "sortd", "yep", "yup", "yeah", "yea", "yass", "ya",
  "got", "gotcha", "gotit", "understood", "noted", "copy", "copythat",
  "👍", "👌", "🙏", "👋", "🤝", "🙌", "💯", "🫡", "✅",
]);

function isConversationCloser(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true; // empty / non-text = nothing to respond to
  if (t.length > 30) return false; // long message can't be a closer
  // Strip punctuation, emoji, whitespace — keep ASCII letters + digits only.
  const stripped = t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!stripped) return true; // emoji-only / punctuation-only
  if (CLOSER_TOKENS.has(stripped)) return true;
  // Allow a small combo like "okthanks", "okcool", "thankscheers" — collapse
  // to no-space and check if the whole thing is composed of closer tokens.
  // Simple greedy peel-off.
  let rest = stripped;
  while (rest.length > 0) {
    let matched = false;
    for (const tok of CLOSER_TOKENS) {
      if (rest.startsWith(tok)) {
        rest = rest.slice(tok.length);
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

interface UserbotInstance {
  modChatId: string;
  client: TelegramClient;
  debounce: Map<string, number>;
  pending: Map<string, NodeJS.Timeout>;
}

// Boot every userbot listener for which we have a session string in env.
// Sessions live in env vars named USERBOT_SESSION_<chatId> (one per mod) —
// generated via the `pnpm --filter @workspace/api-server run userbot:login`
// CLI. If TELEGRAM_API_ID/HASH are missing or no sessions are configured,
// this is a no-op (with a warning) — the bot still works without userbots.
export async function startAllUserbots(bot: TelegramBot): Promise<UserbotInstance[]> {
  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiIdRaw || !apiHash) {
    logger.warn(
      "TELEGRAM_API_ID / TELEGRAM_API_HASH not set — userbot listeners disabled. " +
        "Customers DMing moderators directly will get no auto-reply at all. " +
        "Get the keys from https://my.telegram.org and set them as secrets to enable.",
    );
    return [];
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isFinite(apiId)) {
    logger.error({ apiIdRaw }, "TELEGRAM_API_ID is not a valid number — userbots disabled");
    return [];
  }

  const sessions: { chatId: string; session: string }[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^USERBOT_SESSION_(\d+)$/);
    if (m && v && v.length > 0) sessions.push({ chatId: m[1], session: v });
  }
  if (sessions.length === 0) {
    logger.warn(
      "No USERBOT_SESSION_<chatId> env vars set — userbot listeners disabled. " +
        "Run `pnpm --filter @workspace/api-server run userbot:login` per moderator " +
        "to generate a session string, then add it as a secret.",
    );
    return [];
  }

  const instances: UserbotInstance[] = [];
  for (const { chatId, session } of sessions) {
    try {
      const inst = await startUserbotListener(apiId, apiHash, chatId, session, bot);
      instances.push(inst);
    } catch (err) {
      const e = err as { message?: string; stack?: string; name?: string; code?: unknown; errorMessage?: string };
      logger.error(
        {
          modChatId: chatId,
          errName: e?.name,
          errMessage: e?.message,
          errCode: e?.code,
          errTelegramMessage: e?.errorMessage,
          errStack: e?.stack,
        },
        "Failed to start userbot listener",
      );
    }
  }
  logger.info({ count: instances.length }, "Userbot listeners online");
  return instances;
}

async function startUserbotListener(
  apiId: number,
  apiHash: string,
  modChatId: string,
  sessionString: string,
  bot: TelegramBot,
): Promise<UserbotInstance> {
  const stringSession = new StringSession(sessionString);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  // gramjs is chatty by default; only show errors so the prod logs stay clean.
  try {
    // setLogLevel exists at runtime even though the type may not export it
    (client as unknown as { setLogLevel?: (lvl: string) => void }).setLogLevel?.("error");
  } catch {
    /* not critical */
  }

  await client.connect();
  let meId = "<unknown>";
  try {
    const me = (await client.getMe()) as { id?: { toString?: () => string } };
    meId = me?.id?.toString?.() ?? "<unknown>";
  } catch (err) {
    logger.error({ err, modChatId }, "Userbot connected but getMe failed");
  }
  // Identity guard — the env-var chatId MUST match the logged-in account, or
  // this userbot would auto-reply *as the wrong moderator's account*. That's
  // a serious privacy failure (impersonation), so refuse to start.
  if (meId !== "<unknown>" && meId !== modChatId) {
    await client.disconnect().catch(() => {});
    throw new Error(
      `USERBOT_SESSION_${modChatId} is logged into account ${meId} — chatId mismatch. ` +
        `Re-run userbot:login for the correct moderator and update the secret.`,
    );
  }
  logger.info({ modChatId, meId }, "Userbot connected");
  // Ship marker: lets ops confirm from deployment logs that the live build runs
  // the DB-authoritative verification gate (independent of any mod outgoing
  // message / Telegram Business auto-reply). If this line is absent, an old
  // build is still serving.
  logger.info({ modChatId }, "Userbot verification gate: DB-authoritative (auto-reply-independent) ACTIVE");

  const debounce = new Map<string, number>();
  const pending = new Map<string, NodeJS.Timeout>();
  // `verified` = peers the moderator has personally engaged, making them
  // eligible for the userbot's delayed AI auto-reply (gated at the away
  // machinery below). It is set by any outgoing message from the mod's
  // account. IMPORTANT: this is ONLY an auto-reply-eligibility signal — it is
  // deliberately NOT consulted by the LeafedOut verification gate. The mod's
  // Telegram Business auto-reply (away/greeting) fires an outgoing message to
  // EVERYONE who DMs, which would otherwise mark every brand-new customer
  // "engaged" and suppress verification for all of them. Verification is
  // DB-authoritative instead. In-memory only; lost on restart, which at worst
  // re-arms the auto-reply a beat later for an already-known customer.
  const verified = new Set<string>();
  // Latest customer message text per peer, captured on every incoming DM
  // during the wait window. Used at fire time to feed the AI auto-reply so
  // the response actually addresses what the customer asked. We use the
  // LATEST message (not the first) because customers often refine — first
  // "hey", then the actual question 30s later. Cleared on cancel and after
  // fire to keep the map bounded.
  const latestText = new Map<string, string>();
  // Async-arming guard — two simultaneous incoming DMs from the same peer
  // could both pass the `pending.has()` check and arm two timers, only one
  // of which is in `pending` (the second overwrites). Mod's reply would
  // only cancel the one in the map — the orphan would still fire. The
  // arming Set closes that race.
  const arming = new Set<string>();

  // Suspicious-stranger flagging state. Per-peer message counter (alert on
  // first contact, escalate at the 3rd) and the InputPeer stashed at detection
  // time so a later "Block & delete" has a usable handle even for a peer we've
  // never resolved before. Both are in-memory only — persisting stranger
  // metadata would violate forensic minimization — and are evicted alongside
  // the debounce map below. The registry lets the bot's callback handler reach
  // THIS mod's client to perform the personal-account half of the block.
  const suspicion = new Map<string, { count: number; last: number }>();
  const inputPeers = new Map<string, Api.TypeInputPeer>();
  registerUserbot({ modChatId, client, inputPeers });

  // In-chat verification state (all in-memory, per mod process):
  //  - verifiedOk: peers confirmed NOT to need verification (approved /
  //    grandfathered). Caches the needsVerification() DB read so a verified
  //    customer doesn't hit the DB on every message. Only ever set when the DB
  //    says false. Normal flow never flips a peer back to needing verification,
  //    so the cache is safe — the ONE exception is the admin /reset_verify
  //    command (verified true/NULL → false), which won't re-gate an
  //    already-cached peer on THIS mod's DM surface until the process restarts.
  //    Acceptable: the bot surface re-gates immediately (DB-backed), and an
  //    admin reset is rare + paired with a redeploy/restart.
  //  - verifying: per-peer step lock so two quick DMs don't run the state
  //    machine concurrently, and so the message.out handler can tell our OWN
  //    automated sends apart from a genuine mod reply.
  //  - selfSent: ids of messages WE auto-sent, so the echoed outgoing event
  //    isn't mistaken for the mod replying (backstop for `verifying`).
  //  - verifyBudget: per-peer flood guard (debounce + hourly ceiling).
  const verifiedOk = new Set<string>();
  const verifying = new Set<string>();
  const selfSent = new Map<number, number>();
  const verifyBudget = new Map<string, { count: number; windowStart: number; last: number }>();

  // Periodic eviction so the debounce Map can't grow unbounded as new
  // customers DM the moderator over time. Anything older than the cooldown
  // window can no longer affect behaviour, so it's safe to drop.
  const evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, last] of debounce.entries()) {
      if (now - last >= COOLDOWN_MS) debounce.delete(k);
    }
    for (const [k, v] of suspicion.entries()) {
      if (now - v.last >= COOLDOWN_MS) {
        suspicion.delete(k);
        inputPeers.delete(k);
      }
    }
    for (const [k, v] of verifyBudget.entries()) {
      if (now - v.windowStart >= COOLDOWN_MS) verifyBudget.delete(k);
    }
    for (const [id, ts] of selfSent.entries()) {
      if (now - ts >= 5 * 60 * 1000) selfSent.delete(id);
    }
  }, COOLDOWN_MS);
  evictTimer.unref?.();

  // Walk an unverified peer through the in-chat LeafedOut verification flow.
  // Serialized per peer (`verifying`) and rate-limited per peer (`verifyBudget`)
  // so a hostile DM flood can't make this personal account spam. Every send we
  // make is recorded in `selfSent` so its echoed outgoing event isn't mistaken
  // for the mod replying. Forensic: never logs the customer's text or the code.
  async function driveVerification(
    peerKey: string,
    incomingText: string,
    message: Api.Message,
    peer: Api.TypePeer,
  ): Promise<void> {
    if (verifying.has(peerKey)) return; // a step is already running for this peer

    // Per-peer flood guard: short debounce + hourly ceiling. Once over the
    // ceiling, go silent — the mod was already flagged below.
    const now = Date.now();
    let b = verifyBudget.get(peerKey);
    if (!b || now - b.windowStart >= COOLDOWN_MS) {
      b = { count: 0, windowStart: now, last: 0 };
    }
    if (b.count >= VERIFY_BUDGET_MAX || now - b.last < VERIFY_BUDGET_DEBOUNCE_MS) {
      verifyBudget.set(peerKey, b);
      return;
    }
    b.count += 1;
    b.last = now;
    verifyBudget.set(peerKey, b);

    verifying.add(peerKey);
    try {
      // Resolve an InputPeer (with access_hash) while the message is fresh —
      // needed to send AND for a later "Block & delete". Stash it.
      let ip: Api.TypeInputPeer | undefined = inputPeers.get(peerKey);
      if (!ip) {
        try {
          ip = await (
            message as unknown as {
              getInputSender: () => Promise<Api.TypeInputPeer | undefined>;
            }
          ).getInputSender();
          if (ip) inputPeers.set(peerKey, ip);
        } catch {
          /* fall back to the raw peer for the send */
        }
      }
      const target = ip ?? peer;

      // Sender identity — ONLY for the admin manual-review fanout. Never logged.
      let sender = {
        firstName: null as string | null,
        lastName: null as string | null,
        username: null as string | null,
      };
      try {
        const s = (await (
          message as unknown as {
            getSender: () => Promise<
              { firstName?: string; lastName?: string; username?: string; bot?: boolean } | null
            >;
          }
        ).getSender()) as
          | { firstName?: string; lastName?: string; username?: string; bot?: boolean }
          | null;
        // Never run verification against a bot account the mod happens to chat
        // with (e.g. @BotFather, service bots). Bots are not customers. The
        // per-peer verifyBudget already bounds how often we re-enter here.
        if (s?.bot === true) return;
        sender = {
          firstName: s?.firstName ?? null,
          lastName: s?.lastName ?? null,
          username: s?.username && s.username.length > 0 ? s.username : null,
        };
      } catch {
        /* sender unresolved — leave nulls */
      }

      // Customer-facing replies go out as the mod's account. Record each id so
      // the message.out handler doesn't read our own send as a mod reply.
      const reply = async (text: string): Promise<void> => {
        const sent = await client.sendMessage(target, { message: text });
        const id = (sent as { id?: number })?.id;
        if (typeof id === "number") selfSent.set(id, Date.now());
      };

      await runUserbotVerification({ peerKey, incomingText, sender, reply, bot, modChatId });

      // Existing safety net: a private heads-up to the mod on first contact and
      // the 3rd message, with a one-tap Block & delete. Forensic: peer id +
      // display name + @username + signal lines only — never the message text.
      // The display name is the same one the mod already sees in their inbox for
      // this DM (mods recognise people by name, not chat id).
      try {
        const seen = suspicion.get(peerKey);
        const count = (seen?.count ?? 0) + 1;
        suspicion.set(peerKey, { count, last: Date.now() });
        if (count === 1 || count === 3) {
          const signals = await assessPeer({ chatId: peerKey, username: sender.username });
          if (!signals.isOk) {
            const displayName = [sender.firstName, sender.lastName]
              .filter((p): p is string => !!p && p.length > 0)
              .join(" ");
            const alert = buildSuspiciousAlert(
              peerKey,
              signals,
              sender.username,
              count,
              displayName.length > 0 ? displayName : null,
            );
            try {
              const sentAlert = await bot.sendMessage(modChatId, alert.text, {
                reply_markup: alert.reply_markup,
              });
              try {
                await trackMessage(modChatId, sentAlert.message_id);
              } catch {
                /* tracking is best-effort */
              }
              logger.info({ modChatId, peerKey, count }, "Userbot flagged unverified stranger to mod");
            } catch (err) {
              logger.warn({ err, modChatId, peerKey }, "Userbot suspicious alert send failed");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, modChatId, peerKey }, "Userbot suspicious detection error");
      }
    } catch (err) {
      logger.warn({ err, modChatId, peerKey }, "Userbot in-chat verification error");
    } finally {
      verifying.delete(peerKey);
    }
  }

  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const message = event.message;
      if (!message) return;
      // Only react to 1:1 private DMs — never to groups, channels, or
      // bot chats. peerId is a PeerUser only for direct DMs.
      const peer = message.peerId;
      if (!(peer instanceof Api.PeerUser)) return;
      const peerKey = peer.userId.toString();

      // Skip self-chat (Saved Messages) — the userbot would otherwise risk
      // auto-replying to the moderator's own notes to themselves.
      if (peerKey === modChatId || peerKey === meId) return;

      // Outgoing → the moderator just replied themselves. Mark the peer as
      // verified (the human has touched the conversation, future silences
      // can now trigger the auto-reply) AND cancel any pending auto-reply.
      if (message.out) {
        // Ignore the userbot's OWN automated verification sends — only a
        // GENUINE human reply from the mod should mark this peer mod-engaged.
        // `verifying` holds the peer across every send the driver makes; the id
        // set is a backstop for the echo that may arrive after the driver
        // releases the lock (gramjs dispatches it via the async update loop).
        const outId = (message as { id?: number }).id;
        if (verifying.has(peerKey) || (typeof outId === "number" && selfSent.delete(outId))) {
          return;
        }
        if (!verified.has(peerKey)) {
          verified.add(peerKey);
          logger.info({ modChatId, peerKey }, "Userbot peer verified by mod outgoing message");
        }
        // The mod engaged this peer → no longer a flag-worthy stranger.
        suspicion.delete(peerKey);
        inputPeers.delete(peerKey);
        const t = pending.get(peerKey);
        if (t) {
          clearTimeout(t);
          pending.delete(peerKey);
          latestText.delete(peerKey);
          logger.debug({ modChatId, peerKey }, "Userbot pending auto-reply cancelled by mod reply");
        }
        return;
      }

      // Stash the latest customer text for this peer. Even if a timer is
      // already armed (we don't double-arm), we still want the freshest
      // message text for the AI prompt at fire time.
      const incomingText = (message.message ?? "").trim();

      // === In-chat LeafedOut verification gate (DB-authoritative) ==========
      // The DB is the SINGLE source of truth for whether a peer must verify.
      // We deliberately ignore whether any outgoing message exists: the mod's
      // Telegram Business auto-reply (away/greeting) fires for EVERYONE who
      // DMs, so "an outgoing message exists" no longer implies "the mod vetted
      // this peer" — keying the gate on that (via the `verified` Set) would
      // skip verification for every new customer. Only an approved or
      // grandfathered DB row lets a peer past. Runs BEFORE the closer guard
      // because "done"/"ok"/"yes" are valid verification check-triggers that
      // are ALSO conversation closers.
      if (!verifiedOk.has(peerKey)) {
        let needs = true;
        try {
          needs = await needsVerification(peerKey);
        } catch (err) {
          logger.warn({ err, modChatId, peerKey }, "Verification DB read failed — gating (fail-closed)");
          needs = true;
        }
        if (!needs) {
          // Approved / grandfathered customer in the DB. Not a verification
          // case; cache the all-clear and let the away-reply machinery decide.
          verifiedOk.add(peerKey);
        } else {
          // Brand-new or mid-flow customer: run the LeafedOut verification
          // right here in this chat and stop. driveVerification re-reads and
          // advances the DB state itself, is serialized + rate-limited per
          // peer, and skips bot senders. It does NOT depend on the mod-engaged
          // `verified` Set, so the mod's Telegram auto-reply can't suppress it.
          await driveVerification(peerKey, incomingText, message, peer);
          return;
        }
      }

      if (incomingText) latestText.set(peerKey, incomingText);

      // Conversation-closer guard. If the customer just sent "ok thanks"
      // or "👍" or "cheers", they're signing off. Don't arm a timer (and
      // cancel any in-flight one) — the conversation is done. This stops
      // the userbot from speaking up after the chat naturally ended.
      if (isConversationCloser(incomingText)) {
        const t = pending.get(peerKey);
        if (t) {
          clearTimeout(t);
          pending.delete(peerKey);
          latestText.delete(peerKey);
          logger.debug({ modChatId, peerKey, sample: incomingText.slice(0, 30) }, "Userbot pending auto-reply cancelled — customer sent closer");
        }
        return;
      }

      // Incoming customer DM. If we already have an auto-reply timer armed
      // for this peer, the new message just extends the same conversation —
      // don't double-arm. The arming Set closes the race where a second
      // simultaneous DM passes pending.has() before the first finishes its
      // async setup and writes to the map.
      if (pending.has(peerKey) || arming.has(peerKey)) return;
      arming.add(peerKey);
      try {
        // Per-customer cooldown — skip arming if we've already replied to
        // this customer within the last hour.
        const now = Date.now();
        const last = debounce.get(peerKey) ?? 0;
        if (now - last < COOLDOWN_MS) return;

        // Reached for a peer that is NOT mod-engaged (`verified`) yet survived
        // both guards above — i.e. an approved / grandfathered customer
        // (needsVerification was false) the mod simply hasn't personally
        // replied to, e.g. someone who ordered in the bot and is now DMing to
        // lock in the meet. Stay silent until the mod replies; only THEN does
        // the away-reply machinery arm. (Unverified peers were handled by the
        // verification gate above and returned; established contacts were
        // marked verified by the first-touch history guard and skip this.)
        if (!verified.has(peerKey)) {
          logger.info(
            { modChatId, peerKey },
            "Userbot skipped auto-reply — peer not yet engaged by the mod",
          );
          return;
        }

        // Re-check pending in case another event resolved while we awaited.
        if (pending.has(peerKey)) return;

        // Resolve the InputPeer (with access_hash) NOW while the message is
        // fresh. Passing the raw PeerUser to client.sendMessage 5 min later
        // can fail with PEER_ID_INVALID for first-time customers because
        // gramjs may not have cached an entity for them yet. The message
        // itself always carries enough context to derive an InputPeer.
        let inputPeer: Api.TypeInputPeer | undefined;
        try {
          inputPeer = await message.getInputSender();
        } catch (err) {
          logger.warn({ err, modChatId, peerKey }, "Userbot getInputSender failed — falling back to raw peer");
        }
        const sendTarget: Api.TypePeer | Api.TypeInputPeer = inputPeer ?? peer;

        // Arm the 5-minute timer. The userbot is always armed — there's no
        // /driving on/off toggle. If the mod replies before the timer fires
        // we cancel above. If they don't, we send the canned reply.
        const timer = setTimeout(async () => {
          pending.delete(peerKey);
          try {
            const s = await getModStatus(modChatId);
            const n = Date.now();
            const l = debounce.get(peerKey) ?? 0;
            if (n - l < COOLDOWN_MS) {
              latestText.delete(peerKey);
              return;
            }
            debounce.set(peerKey, n);
            // Reply selection priority:
            //   1. Mod's custom /driving message (single fixed line, day & night).
            //   2. AI-generated reply addressing the customer's actual message
            //      AND pushing them to send the order via the bot. This is
            //      what makes the auto-reply feel like a real person instead
            //      of canned spam.
            //   3. Fixed pool fallback (pickDefaultAwayMessage) — used when
            //      AI fails / sanity check rejects the output / no customer
            //      text was captured (photo/voice/sticker only).
            const customMsg = s?.awayMessage?.trim();
            const customerText = latestText.get(peerKey) ?? "";
            let replyText: string;
            if (customMsg) {
              replyText = customMsg;
            } else {
              const nowAt = new Date();
              const aiReply = customerText
                ? await generateAutoReply(customerText, isOpenNow(nowAt), closedPhase(nowAt))
                : null;
              replyText = aiReply ?? pickDefaultAwayMessage();
              if (aiReply) {
                logger.info({ modChatId, peerKey }, "Userbot using AI-generated auto-reply");
              }
            }
            // Clean up the captured text — we're either about to send or fail.
            latestText.delete(peerKey);
            try {
              await client.sendMessage(sendTarget, { message: replyText });
              logger.info(
                { modChatId, peerKey },
                "Userbot auto-reply sent (5min after no mod reply)",
              );
            } catch (err) {
              // Roll back the debounce so a transient network blip doesn't
              // lock the customer out of the auto-reply for the next hour.
              debounce.delete(peerKey);
              const e = err as { message?: string; name?: string; code?: unknown; errorMessage?: string };
              logger.error(
                {
                  modChatId,
                  peerKey,
                  errName: e?.name,
                  errMessage: e?.message,
                  errCode: e?.code,
                  errTelegramMessage: e?.errorMessage,
                },
                "Userbot auto-reply failed",
              );
            }
          } catch (err) {
            logger.error({ err, modChatId, peerKey }, "Userbot fire-time check failed");
          }
        }, REPLY_DELAY_MS);
        timer.unref?.();
        pending.set(peerKey, timer);
      } finally {
        arming.delete(peerKey);
      }
    } catch (err) {
      logger.error({ err, modChatId }, "Userbot event handler error");
    }
  }, new NewMessage({}));

  return { modChatId, client, debounce, pending };
}
