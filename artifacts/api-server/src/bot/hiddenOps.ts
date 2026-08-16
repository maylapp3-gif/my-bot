// Hidden operator surface.
//
// The "decoy" model: nothing in the visible bot UI ever mentions a contact
// list, broadcasts, backups, regulars, or panic-wipe. The /admin panel only
// shows ordering / products / relays / mods stuff — looks like a generic
// food-ordering bot.
//
// Sensitive commands (anything that touches the customer list or destroys
// data) are accessed ONLY by typing a private passphrase the operator chose,
// followed by a sub-command. Without the passphrase, those handlers don't
// exist as far as Telegram or any inspector can tell — there's no slash
// command to autocomplete, nothing in /help, nothing in /admin.
//
// The passphrase lives in `OPS_PASSPHRASE` (Replit secret). Only the operator
// knows it. If it's unset, the hidden surface is disabled entirely — log a
// boot warning and refuse to dispatch anything. This is intentional: better
// to fail closed than to ship with a default that someone could guess.

import TelegramBot from "node-telegram-bot-api";
import { isAdmin } from "./handlers/admin.js";
import { handleSubscribers, handleBroadcast } from "./handlers/admin.js";
import {
  handlePanicWipe,
  handleBackupNow,
  handleListBackups,
  handleRestoreSubscribers,
} from "./handlers/security.js";
import { handlePromoBroadcastCommand } from "./promoBroadcaster.js";
import {
  handleAddRegular,
  handleRemoveRegular,
  handleListRegulars,
} from "./handlers/regulars.js";
import {
  handleAddTrusted,
  handleRemoveTrusted,
  handleListTrusted,
  handleTrustedBroadcast,
} from "./handlers/trusted.js";
import { logger } from "../lib/logger.js";

// Read at every call so the operator can rotate the passphrase via Replit
// Secrets without redeploying.
function getPassphrase(): string | null {
  const raw = (process.env.OPS_PASSPHRASE ?? "").trim();
  // Refuse to operate on suspiciously short passphrases — that's a footgun,
  // not a feature.
  if (raw.length < 6) return null;
  return raw;
}

let warned = false;
export function warnIfPassphraseMissing() {
  if (!getPassphrase() && !warned) {
    warned = true;
    logger.warn(
      "OPS_PASSPHRASE is unset or too short (<6 chars). Hidden operator commands " +
        "(contact list, broadcasts, backups, regulars, panic-wipe) are DISABLED. " +
        "Set OPS_PASSPHRASE in Secrets to enable.",
    );
  }
}

const HELP_TEXT =
  "🔒 _Hidden ops_\n\n" +
  "`<phrase> contacts`            — dump contact list\n" +
  "`<phrase> blast <message>`     — push to every contact\n" +
  "`<phrase> autoblast [arg]`     — daily auto-promo (status|on|off|now|preview)\n" +
  "`<phrase> snapshot`            — snapshot contact list to cold storage\n" +
  "`<phrase> snapshots`           — list cold-storage snapshots\n" +
  "`<phrase> restore [YYYY-MM-DD]` — restore contacts from snapshot\n" +
  "`<phrase> regulars`            — list regulars\n" +
  "`<phrase> regular+ <id> [notes]` — flag as regular\n" +
  "`<phrase> regular- <id>`       — un-flag\n" +
  "`<phrase> vip`                 — list trusted broadcast members\n" +
  "`<phrase> vip+ <id> [notes]`   — add to trusted broadcast list\n" +
  "`<phrase> vip- <id>`           — remove from trusted broadcast list\n" +
  "`<phrase> vipblast <message>`  — push to trusted members only\n" +
  "`<phrase> wipe CONFIRM_NUKE`   — ☠️ panic wipe everything\n\n" +
  "_Don't paste these where anyone can see — your passphrase is what gates them._";

// Returns true if the message was consumed by the hidden surface (so the
// caller can short-circuit any further routing). Returns false otherwise —
// fall through to the normal bot.onText handlers.
export async function maybeHandleHiddenOp(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<boolean> {
  const text = msg.text;
  if (!text) return false;
  const phrase = getPassphrase();
  if (!phrase) return false;
  const adminId = msg.chat.id.toString();
  // Admin-only. Non-admins typing the phrase by accident get nothing — and
  // critically no error message either, so there's no oracle for guessing.
  if (!isAdmin(adminId)) return false;

  // Match `<phrase>` exactly OR `<phrase> <rest>`. Word-boundary on the
  // phrase end so `kazoowalnut2` isn't accidentally accepted when phrase is
  // `kazoowalnut`.
  if (!text.startsWith(phrase)) return false;
  const after = text.slice(phrase.length);
  if (after.length > 0 && after[0] !== " " && after[0] !== "\n") return false;
  const rest = after.trim();

  if (rest === "" || rest === "help" || rest === "?") {
    await bot.sendMessage(adminId, HELP_TEXT, { parse_mode: "Markdown" });
    return true;
  }

  // Split first word as sub-command, keep the remainder as arg.
  const spaceIdx = rest.search(/\s/);
  const sub = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
  const arg = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();

  try {
    switch (sub) {
      case "contacts":
        await handleSubscribers(bot, msg);
        return true;
      case "blast":
        if (!arg) {
          await bot.sendMessage(adminId, "Usage: `<phrase> blast <message>`", { parse_mode: "Markdown" });
          return true;
        }
        await handleBroadcast(bot, msg, arg);
        return true;
      case "autoblast":
        await handlePromoBroadcastCommand(bot, msg, arg);
        return true;
      case "snapshot":
        await handleBackupNow(bot, msg);
        return true;
      case "snapshots":
        await handleListBackups(bot, msg);
        return true;
      case "restore":
        await handleRestoreSubscribers(bot, msg, arg || undefined);
        return true;
      case "regulars":
        await handleListRegulars(bot, msg);
        return true;
      case "regular+":
        await handleAddRegular(bot, msg, arg);
        return true;
      case "regular-":
        await handleRemoveRegular(bot, msg, arg);
        return true;
      case "vip":
        await handleListTrusted(bot, msg);
        return true;
      case "vip+":
        await handleAddTrusted(bot, msg, arg);
        return true;
      case "vip-":
        await handleRemoveTrusted(bot, msg, arg);
        return true;
      case "vipblast":
        if (!arg) {
          await bot.sendMessage(adminId, "Usage: `<phrase> vipblast <message>`", { parse_mode: "Markdown" });
          return true;
        }
        await handleTrustedBroadcast(bot, msg, arg);
        return true;
      case "wipe":
        await handlePanicWipe(bot, msg, arg || undefined);
        return true;
      default:
        await bot.sendMessage(
          adminId,
          `Unknown op: \`${sub}\`. Send the passphrase alone for the menu.`,
          { parse_mode: "Markdown" },
        );
        return true;
    }
  } catch (err) {
    logger.error({ err, sub }, "Hidden ops dispatch error");
    try {
      await bot.sendMessage(adminId, "Couldn't run that op — check logs.");
    } catch {}
    return true;
  }
}
