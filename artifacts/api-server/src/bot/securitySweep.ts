import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { db } from "@workspace/db";
import {
  ordersTable,
  subscribersTable,
  promoCodesTable,
  productsTable,
  productVariantsTable,
  cartItemsTable,
  cartPromosTable,
  conversations,
  raffleEntriesTable,
} from "@workspace/db/schema";
import { and, lt, gte, isNotNull, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { escapeMarkdown } from "./escape.js";
import { sendMarkdownSafe } from "./sendUtil.js";
import { getAdminIds } from "./handlers/admin.js";
import { getModeratorIds } from "./moderation.js";
import { AI_FORBIDDEN_WORDS, TIMEZONE, BRAND_NAME, LOCALE_HOUR } from "./brand.js";
import { listSubscriberBackups } from "./backup.js";
import { businessDateKey } from "./hours.js";

// ---------------------------------------------------------------------------
// Weekly automated in-bot security sweep.
//
// A set of independent "agencies", each of which audits one slice of the live
// system and returns findings. Nothing here changes state — the sweep only
// reads and reports. It runs weekly on a cron and can be fired on demand by an
// admin with /sweep. The result is DM'd to ADMIN_CHAT_IDS only.
//
// Reporting discipline (hard rules for this project):
//   - Forensic minimization: the report carries COUNTS, not customer data.
//     The only per-record identifier ever included is a Telegram chat ID, and
//     only where the admin needs it to act (e.g. an order that slipped past
//     the verification gate) — the same chat IDs already shown on the EOD and
//     order cards. Never usernames, names, notes, areas, or LeafedOut handles.
//   - No forbidden words: the content-hygiene agency reports WHICH admin copy
//     tripped the filter (the admin must fix it), but the sweep report itself
//     never echoes a forbidden term — it names products/sizes by numeric id and
//     reports promo hits as a bare count (a promo code can itself be the leak).
//   - Fail-closed: an agency that throws is reported as an explicit ⚠️ error
//     line, never silently dropped, so a broken check can't read as "clear".
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = DAY_MS; // must match dataRetention.ts 24h contract
// The purge runs hourly (dataRetention.ts, `0 * * * *`), so a row can sit up to
// ~1h past the 24h line before the next tick clears it. The audit adds a grace
// margin on top so it only alarms once the purge is genuinely stuck, never on
// the normal timing overlap between the two schedulers.
const RETENTION_AUDIT_GRACE_MS = 2 * 60 * 60 * 1000;
const BACKUP_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.BACKUP_RETENTION_DAYS ?? 14),
);

export type SweepStatus = "ok" | "info" | "warn" | "critical";

export interface SweepFinding {
  status: SweepStatus;
  // One plain-language line. Safe to show a non-technical operator.
  detail: string;
}

export interface AgencyResult {
  name: string;
  findings: SweepFinding[];
}

interface Agency {
  name: string;
  run: () => Promise<SweepFinding[]>;
}

function ok(detail: string): SweepFinding {
  return { status: "ok", detail };
}

// A Telegram chat ID is an integer (users positive, groups negative). Anything
// else in an allowlist is a config typo that silently disables that entry.
function isNumericId(s: string): boolean {
  return /^-?\d+$/.test(s);
}

// ---------------------------------------------------------------------------
// Agency: config hygiene — required secrets/config present and well-formed.
// Pure env inspection, no DB. Never prints a secret value, only presence.
// ---------------------------------------------------------------------------
const configHygiene: Agency = {
  name: "Settings & keys",
  async run() {
    const out: SweepFinding[] = [];

    if (!process.env.TELEGRAM_BOT_TOKEN) {
      out.push({ status: "critical", detail: "Bot token is missing — the bot cannot run without it." });
    }

    // Delivery origin is deliberately optional: unset just means fees are
    // quoted at the meet. So absence is info, not a problem — but a malformed
    // value silently does the same thing while looking configured.
    const origin = process.env.DELIVERY_ORIGIN?.trim();
    if (!origin) {
      out.push({ status: "info", detail: "Delivery origin not set — delivery fees will be quoted at the meet (by design)." });
    } else {
      const parts = origin.split(",").map((p) => Number(p.trim()));
      const valid =
        parts.length === 2 && parts.every((n) => Number.isFinite(n)) &&
        Math.abs(parts[0]) <= 90 && Math.abs(parts[1]) <= 180;
      if (!valid) {
        out.push({ status: "warn", detail: "Delivery origin is set but not a valid \"lat,lng\" — fees will silently fall back to quote-at-meet." });
      }
    }

    // Companion listener needs the Telegram API pair; absence just disables it.
    const hasApiId = !!process.env.TELEGRAM_API_ID;
    const hasApiHash = !!process.env.TELEGRAM_API_HASH;
    if (hasApiId !== hasApiHash) {
      out.push({ status: "warn", detail: "Only one of the Telegram API ID / hash pair is set — the companion listener needs both or neither." });
    }

    if (out.length === 0) out.push(ok("Core settings and keys look right."));
    return out;
  },
};

// ---------------------------------------------------------------------------
// Agency: access control — who can run privileged commands.
// ---------------------------------------------------------------------------
const accessControl: Agency = {
  name: "Team access",
  async run() {
    const out: SweepFinding[] = [];
    const admins = getAdminIds();
    const mods = getModeratorIds();

    if (admins.length === 0) {
      out.push({ status: "critical", detail: "No admins configured — nobody can run admin commands. Set ADMIN_CHAT_IDS." });
    }

    const rawAdmin = (process.env.ADMIN_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const rawMod = (process.env.MODERATOR_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const badAdmin = rawAdmin.filter((s) => !isNumericId(s));
    const badMod = rawMod.filter((s) => !isNumericId(s));
    if (badAdmin.length > 0) {
      out.push({ status: "warn", detail: `${badAdmin.length} admin entr${badAdmin.length === 1 ? "y is" : "ies are"} not a numeric chat ID — those entries do nothing.` });
    }
    if (badMod.length > 0) {
      out.push({ status: "warn", detail: `${badMod.length} moderator entr${badMod.length === 1 ? "y is" : "ies are"} not a numeric chat ID — those entries do nothing.` });
    }

    if (out.length === 0) {
      out.push(ok(`${admins.length} admin${admins.length === 1 ? "" : "s"}, ${mods.length} on the team total.`));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Agency: data-retention audit — the 24h promise is actually being kept.
// Counts customer-traceable rows that should already have been purged, plus
// cold-storage snapshots that overran their window. Counts only — no IDs.
// ---------------------------------------------------------------------------
const dataRetention: Agency = {
  name: "Auto-delete (24h)",
  async run() {
    const out: SweepFinding[] = [];
    const cutoff = new Date(Date.now() - RETENTION_MS - RETENTION_AUDIT_GRACE_MS);

    const [orders, carts, promos, convos, raffles, staleCodes] = await Promise.all([
      db.$count(ordersTable, lt(ordersTable.createdAt, cutoff)),
      db.$count(cartItemsTable, lt(cartItemsTable.addedAt, cutoff)),
      db.$count(cartPromosTable, lt(cartPromosTable.appliedAt, cutoff)),
      db.$count(conversations, lt(conversations.createdAt, cutoff)),
      db.$count(raffleEntriesTable, lt(raffleEntriesTable.createdAt, cutoff)),
      db.$count(
        subscribersTable,
        and(isNotNull(subscribersTable.verifyCode), lt(subscribersTable.verifyCodeIssuedAt, cutoff)),
      ),
    ]);
    const overdue = orders + carts + promos + convos + raffles + staleCodes;
    if (overdue > 0) {
      out.push({
        status: "critical",
        detail: `${overdue} record${overdue === 1 ? "" : "s"} older than 24h are still here (orders ${orders}, carts ${carts}, promos ${promos}, chats ${convos}, raffle entries ${raffles}, verify codes ${staleCodes}). The hourly auto-delete may be stuck — check the server is running.`,
      });
    } else {
      out.push(ok("Nothing customer-related is older than 24h."));
    }

    // Cold-storage snapshots (subscriber roster mirror) should age out too.
    try {
      const backups = await listSubscriberBackups();
      // +1 day grace: the prune only runs when a fresh snapshot is written, so
      // the newest overdue blob can legitimately linger up to a day.
      const cutoffDay = new Date(Date.now() - (BACKUP_RETENTION_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
      const stale = backups.filter((b) => b.date < cutoffDay).length;
      if (stale > 0) {
        out.push({ status: "warn", detail: `${stale} contact-list backup${stale === 1 ? "" : "s"} older than ${BACKUP_RETENTION_DAYS} days are still in cold storage — they should have been pruned.` });
      }
    } catch (err) {
      logger.warn({ err }, "sweep: backup retention check failed");
      out.push({ status: "info", detail: "Couldn't check cold-storage backups (storage unreachable)." });
    }

    return out;
  },
};

// ---------------------------------------------------------------------------
// Agency: verification-gate integrity — no unverified customer holds an order,
// and no LeafedOut handle is bound to more than one Telegram account.
// ---------------------------------------------------------------------------
const verificationGate: Agency = {
  name: "New-customer gate",
  async run() {
    const out: SweepFinding[] = [];

    // Orders whose owner is explicitly NOT allowed to order (verified = false).
    // Grandfathered (NULL) and approved (true) are fine. Any hit means an order
    // slipped past the gate — the admin needs the chat IDs to investigate.
    const leaked = await db
      .select({ chatId: ordersTable.chatId })
      .from(ordersTable)
      .innerJoin(subscribersTable, eq(subscribersTable.chatId, ordersTable.chatId))
      .where(eq(subscribersTable.verified, false));
    const leakedIds = Array.from(new Set(leaked.map((r) => r.chatId)));
    if (leakedIds.length > 0) {
      out.push({
        status: "critical",
        detail: `${leakedIds.length} unverified customer(s) have live orders — the gate may be leaking. Chat IDs: ${leakedIds.join(", ")}`,
      });
    }

    // One LeafedOut handle → at most one Telegram account. Count handles held
    // by more than one row (case-insensitive). Report the count + chat IDs; the
    // handle text itself is never echoed.
    const dupHandles = await db
      .select({ handle: sql<string>`lower(${subscribersTable.leafedoutUsername})` })
      .from(subscribersTable)
      .where(isNotNull(subscribersTable.leafedoutUsername))
      .groupBy(sql`lower(${subscribersTable.leafedoutUsername})`)
      .having(sql`count(*) > 1`);
    if (dupHandles.length > 0) {
      out.push({
        status: "warn",
        detail: `${dupHandles.length} LeafedOut handle(s) are linked to more than one Telegram account — review with /verify_queue.`,
      });
    }

    if (out.length === 0) out.push(ok("Every order belongs to a verified or long-standing customer."));
    return out;
  },
};

// ---------------------------------------------------------------------------
// Agency: order & money integrity — server-side money math and one-time-offer
// invariants hold. Live orders only (older ones are already purged).
// ---------------------------------------------------------------------------
const moneyIntegrity: Agency = {
  name: "Orders & money",
  async run() {
    const out: SweepFinding[] = [];
    const since = new Date(Date.now() - RETENTION_MS);

    const negativeTotals = await db.$count(
      ordersTable,
      and(gte(ordersTable.createdAt, since), lt(ordersTable.totalCents, 0)),
    );
    if (negativeTotals > 0) {
      out.push({ status: "critical", detail: `${negativeTotals} recent order(s) have a negative total — a discount is over-applying.` });
    }

    // Intro-offer invariant: a customer can't have the offer "available" AND
    // already "used" at the same time. That contradictory state means the
    // atomic consume/refund cycle broke.
    const brokenIntro = await db.$count(
      subscribersTable,
      and(eq(subscribersTable.introOfferAvailable, true), isNotNull(subscribersTable.introOfferUsedAt)),
    );
    if (brokenIntro > 0) {
      out.push({ status: "warn", detail: `${brokenIntro} customer(s) show the first-order 50% offer as both available and already used — the offer state is inconsistent.` });
    }

    // Promo codes used past their own cap.
    const overusedPromos = await db
      .select({ code: promoCodesTable.code })
      .from(promoCodesTable)
      .where(and(isNotNull(promoCodesTable.maxUses), sql`${promoCodesTable.usedCount} > ${promoCodesTable.maxUses}`));
    if (overusedPromos.length > 0) {
      out.push({ status: "warn", detail: `${overusedPromos.length} promo code(s) have been used past their limit: ${overusedPromos.map((p) => p.code).join(", ")}` });
    }

    // A variant priced at or below zero would give product away for free.
    const freeVariants = await db.$count(productVariantsTable, lt(productVariantsTable.priceCents, 1));
    if (freeVariants > 0) {
      out.push({ status: "warn", detail: `${freeVariants} product size(s) are priced at $0 — check the product manager.` });
    }

    if (out.length === 0) out.push(ok("Order totals, offers and promos all add up."));
    return out;
  },
};

// ---------------------------------------------------------------------------
// Agency: content hygiene — admin-authored, customer-facing copy contains no
// forbidden category/region words. Names the offending item by numeric id only
// — never the matched word, and never the promo code (either could itself be
// the leak), so the report never re-introduces a forbidden term into the
// admin's persistent chat history.
// ---------------------------------------------------------------------------
const contentHygiene: Agency = {
  name: "Wording check",
  async run() {
    const out: SweepFinding[] = [];
    if (!AI_FORBIDDEN_WORDS) {
      out.push(ok("Word filter is turned off (no list configured)."));
      return out;
    }
    const re = new RegExp(`\\b(${AI_FORBIDDEN_WORDS})\\b`, "i");
    const firstHit = (s: string | null | undefined): string | null => {
      if (!s) return null;
      const m = s.match(re);
      return m ? m[1].toLowerCase() : null;
    };

    const [products, variants, promos] = await Promise.all([
      db.select({ id: productsTable.id, name: productsTable.name, description: productsTable.description }).from(productsTable),
      db.select({ id: productVariantsTable.id, label: productVariantsTable.label }).from(productVariantsTable),
      db.select({ code: promoCodesTable.code }).from(promoCodesTable),
    ]);

    // Report the item's stable id only — never the matched word, and never the
    // promo code itself (a code can BE the forbidden word). Promos collapse to a
    // bare count so nothing off-limits ever lands in the report.
    const itemHits: string[] = [];
    let promoHits = 0;
    for (const p of products) {
      if (firstHit(p.name) ?? firstHit(p.description)) itemHits.push(`product #${p.id}`);
    }
    for (const v of variants) {
      if (firstHit(v.label)) itemHits.push(`size #${v.id}`);
    }
    for (const p of promos) {
      if (firstHit(p.code)) promoHits++;
    }

    const total = itemHits.length + promoHits;
    if (total > 0) {
      const parts = [...itemHits];
      if (promoHits > 0) parts.push(`${promoHits} promo code${promoHits === 1 ? "" : "s"}`);
      out.push({
        status: "warn",
        detail: `${total} item(s) use a word customers shouldn't see: ${parts.join(", ")}. Fix them in the product manager (open /promos to check codes).`,
      });
    } else {
      out.push(ok("No off-limits words in the menu or promo copy."));
    }
    return out;
  },
};

const AGENCIES: Agency[] = [
  configHygiene,
  accessControl,
  dataRetention,
  verificationGate,
  moneyIntegrity,
  contentHygiene,
];

export async function runSecuritySweep(): Promise<AgencyResult[]> {
  const results: AgencyResult[] = [];
  for (const agency of AGENCIES) {
    try {
      const findings = await agency.run();
      results.push({ name: agency.name, findings });
    } catch (err) {
      // Fail-closed: a check that crashed is surfaced, never dropped.
      logger.error({ err, agency: agency.name }, "security sweep agency failed");
      results.push({
        name: agency.name,
        findings: [{ status: "warn", detail: "This check couldn't run — look into it manually." }],
      });
    }
  }
  return results;
}

const STATUS_EMOJI: Record<SweepStatus, string> = {
  ok: "✅",
  info: "ℹ️",
  warn: "⚠️",
  critical: "🚨",
};

const STATUS_RANK: Record<SweepStatus, number> = { ok: 0, info: 1, warn: 2, critical: 3 };

export function buildSweepReport(results: AgencyResult[], now: Date = new Date()): string {
  const dateLabel = new Intl.DateTimeFormat(LOCALE_HOUR, {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(now);

  let worst: SweepStatus = "ok";
  for (const r of results) {
    for (const f of r.findings) {
      if (STATUS_RANK[f.status] > STATUS_RANK[worst]) worst = f.status;
    }
  }
  const actionable = results
    .flatMap((r) => r.findings)
    .filter((f) => f.status === "warn" || f.status === "critical").length;

  const headline =
    worst === "critical"
      ? `🚨 *${escapeMarkdown(actionable === 1 ? "1 urgent thing" : `${actionable} things`)} need attention*`
      : worst === "warn"
        ? `⚠️ *${escapeMarkdown(actionable === 1 ? "1 thing to look at" : `${actionable} things to look at`)}*`
        : `✅ *All clear*`;

  let text = `🛡️ *${escapeMarkdown(BRAND_NAME)} weekly security check — ${escapeMarkdown(dateLabel)}*\n\n${headline}\n`;

  for (const r of results) {
    // Section header carries the worst status within the section.
    let sectionWorst: SweepStatus = "ok";
    for (const f of r.findings) {
      if (STATUS_RANK[f.status] > STATUS_RANK[sectionWorst]) sectionWorst = f.status;
    }
    text += `\n${STATUS_EMOJI[sectionWorst]} *${escapeMarkdown(r.name)}*\n`;
    for (const f of r.findings) {
      // Skip the "ok" filler line when a section has real findings — the
      // section header already shows green otherwise.
      if (f.status === "ok" && r.findings.length > 1) continue;
      text += `  ${STATUS_EMOJI[f.status]} ${escapeMarkdown(f.detail)}\n`;
    }
  }

  text += `\n_Automatic weekly check. Nothing here is shared with customers._`;
  return text;
}

export async function sendSecuritySweep(bot: TelegramBot, requestedBy?: string): Promise<void> {
  const admins = getAdminIds();
  const results = await runSecuritySweep();
  const report = buildSweepReport(results);

  // On-demand /sweep: reply to just the caller if they're an admin. Scheduled
  // run: DM every admin.
  const targets = requestedBy ? [requestedBy] : admins;
  if (targets.length === 0) {
    logger.warn("security sweep produced a report but no admin to send it to");
    return;
  }
  for (const adminId of targets) {
    try {
      await sendMarkdownSafe(bot, adminId, report);
    } catch (err) {
      logger.error({ err, adminId }, "security sweep: failed to deliver report");
    }
  }
  logger.info({ delivered: targets.length, onDemand: !!requestedBy }, "security sweep report delivered");
}

// Weekly: Monday 09:00 in the business timezone. An in-memory week marker
// dedupes within a process (matches the EOD/digest pattern); the cron only
// fires once a week anyway, so this is just belt-and-braces against a
// restart-straddle.
let lastSweepWeek = "";

function isoWeekKey(now: Date = new Date()): string {
  // Cheap "which business day" bucket reused as a coarse week guard.
  return businessDateKey(now);
}

export function startSecuritySweepScheduler(bot: TelegramBot): void {
  cron.schedule(
    "0 9 * * 1",
    () => {
      const wk = isoWeekKey();
      if (lastSweepWeek === wk) return;
      lastSweepWeek = wk;
      void sendSecuritySweep(bot);
    },
    { timezone: TIMEZONE },
  );
  logger.info({ timezone: TIMEZONE }, "Security sweep scheduler started (weekly, Mon 09:00)");
}
