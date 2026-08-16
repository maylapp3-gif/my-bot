import { getRelays } from "./db.js";
import { getModeratorIds } from "./moderation.js";

/**
 * Recipients for order-related fan-out (new orders, sanity-check blocks,
 * confirm/decline mirrors, etc).
 *
 * Policy: orders go to relay channels ONLY when at least one is configured.
 * This keeps the mods' personal DM with the bot focused on customer chat
 * (the new mod-relay surface). When no relay is configured yet, fall back
 * to the moderator DMs so orders are never silently dropped during setup.
 */
export async function getOrderRecipients(): Promise<string[]> {
  const relays = await getRelays().catch(() => [] as Awaited<ReturnType<typeof getRelays>>);
  if (relays.length > 0) {
    const set = new Set<string>(relays.map((r) => r.chatId));
    return Array.from(set);
  }
  return getModeratorIds();
}
