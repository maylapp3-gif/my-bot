import cron from "node-cron";
import { db } from "@workspace/db";
import {
  ordersTable,
  cartItemsTable,
  cartPromosTable,
  conversations,
  raffleEntriesTable,
} from "@workspace/db/schema";
import { lt } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { clearStaleVerifyCodes } from "./db.js";

// Hard data-retention rule for the bot:
//   ── Nothing customer-traceable lives in the DB longer than 24 hours. ──
// The only intentional exception is the contact list (subscribers) and
// admin-managed config (products/variants/promos/relays/mod_status/
// regular_customers). Everything else — order history, in-flight carts,
// AI conversation logs — is wiped on the hour.
//
// Why hourly (not daily): the promise to the customer is "self-destructs
// every 24h". An hourly sweep keeps the worst-case overshoot to 1 hour
// instead of nearly 24. Cheap query, indexed on created_at.
//
// Cascade behaviour (relied on, do NOT touch the schema without re-checking):
//   orders        → order_items   (FK onDelete: cascade)
//   conversations → messages      (FK onDelete: cascade)
//
// This runs alongside selfDestruct.ts (which deletes the actual Telegram
// messages via the bot API). selfDestruct handles what users SEE in chat.
// dataRetention handles what survives in OUR database. Two layers, same
// 24h promise.
const RETENTION_MS = 24 * 60 * 60 * 1000;

async function purgeOldData() {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  try {
    const [orders, carts, promos, convos, raffleEntries, staleCodes] = await Promise.all([
      db.delete(ordersTable).where(lt(ordersTable.createdAt, cutoff)).returning({ id: ordersTable.id }),
      db.delete(cartItemsTable).where(lt(cartItemsTable.addedAt, cutoff)).returning({ id: cartItemsTable.id }),
      db.delete(cartPromosTable).where(lt(cartPromosTable.appliedAt, cutoff)).returning({ chatId: cartPromosTable.chatId }),
      db.delete(conversations).where(lt(conversations.createdAt, cutoff)).returning({ id: conversations.id }),
      // Raffle entries are customer-traceable (chatId ↔ code). They are normally
      // wiped the instant a raffle is drawn/deleted; this is the safety net for
      // raffles the operator never draws — same 24h contract as everything else.
      db.delete(raffleEntriesTable).where(lt(raffleEntriesTable.createdAt, cutoff)).returning({ id: raffleEntriesTable.id }),
      // Not a delete: wipes the one-time proof code from abandoned 'collecting'
      // verification sessions older than the cutoff (forensic minimization).
      clearStaleVerifyCodes(cutoff),
    ]);
    const total =
      orders.length + carts.length + promos.length + convos.length + raffleEntries.length + staleCodes;
    if (total > 0) {
      logger.info(
        {
          orders: orders.length,
          carts: carts.length,
          promos: promos.length,
          convos: convos.length,
          raffleEntries: raffleEntries.length,
          staleVerifyCodes: staleCodes,
        },
        "Data-retention purge complete (>24h customer data wiped)",
      );
    }
  } catch (err) {
    logger.error({ err }, "Data-retention purge error");
  }
}

export function startDataRetentionScheduler() {
  // Hourly. The contact list (subscribers) is intentionally excluded —
  // see top-of-file comment for the full retention contract.
  cron.schedule("0 * * * *", () => {
    void purgeOldData();
  });
  // Also run once at boot so a long-stopped instance doesn't carry over
  // a backlog of >24h data when it comes back up.
  void purgeOldData();
  logger.info("Data-retention scheduler started (hourly; cutoff = 24h; subscribers exempt)");
}
