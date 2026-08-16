import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getAvailableProducts, getProductVariants, getProduct, setVariantStock } from "./db.js";
import { getModeratorIds } from "./moderation.js";
import { getAdminIds } from "./handlers/admin.js";
import { escapeMarkdown } from "./escape.js";
import { businessDateKey, businessHourNow, todayHours } from "./hours.js";
import { TIMEZONE } from "./brand.js";

// Mod-only recipients = everyone in the moderator list MINUS anyone who's
// also an admin. The stock check is a moderator chore; admins receive a
// rollup of mod answers instead of having to tap buttons themselves.
function getModOnlyIds(): string[] {
  const admins = new Set(getAdminIds());
  return getModeratorIds().filter((id) => !admins.has(id));
}

// =============================================================================
// Stock check ping — fires twice daily (at each day's open hour + 22:30
// business timezone; opens vary by weekday, see brand.ts WEEKLY_HOURS).
// Each moderator gets one message per active product with 3 buttons:
//   🟢 Healthy → flips every variant of that product to `in_stock`
//   🟡 Low      → flips every variant to `low`
//   🔴 Out      → flips every variant to `sold_out`
// Per-weight granularity stays available via the existing /stock command;
// this ping is the quick "shape of the menu" sweep.
// =============================================================================

const CB_PREFIX = "stk:";

type StockChoice = "ok" | "low" | "out";

const CHOICE_LABEL: Record<StockChoice, string> = {
  ok: "🟢 Healthy",
  low: "🟡 Low",
  out: "🔴 Out",
};

const CHOICE_TO_VARIANT_STATE: Record<StockChoice, "in_stock" | "low" | "sold_out"> = {
  ok: "in_stock",
  low: "low",
  out: "sold_out",
};

function buildKeyboard(productId: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: CHOICE_LABEL.ok, callback_data: `${CB_PREFIX}${productId}:ok` },
      { text: CHOICE_LABEL.low, callback_data: `${CB_PREFIX}${productId}:low` },
      { text: CHOICE_LABEL.out, callback_data: `${CB_PREFIX}${productId}:out` },
    ]],
  };
}

// Public entry: fan out one prompt per product to every moderator.
// Safe to call ad-hoc (e.g. /stockcheck admin command).
export async function runStockCheck(bot: TelegramBot, reason: "scheduled" | "manual" = "scheduled"): Promise<void> {
  const products = await getAvailableProducts().catch((err: unknown) => {
    logger.error({ err }, "stockCheck: getAvailableProducts failed");
    return [] as Awaited<ReturnType<typeof getAvailableProducts>>;
  });
  const mods = getModOnlyIds();
  if (products.length === 0 || mods.length === 0) {
    logger.info({ products: products.length, mods: mods.length, reason }, "stockCheck: nothing to send (no products, or no mod-only recipients — admins are excluded by design)");
    return;
  }
  logger.info({ products: products.length, mods: mods.length, reason }, "stockCheck: dispatching to mods-only");

  for (const mod of mods) {
    try {
      await bot.sendMessage(mod, `🧮 *Stock check* — tap one per strain.\n_Updates the whole product (all weights).\nUse /stock <variantId> ... for per-weight._`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err, mod }, "stockCheck: header send failed");
      continue;
    }
    for (const p of products) {
      try {
        const line = `${p.emoji ?? "🌿"} *${escapeMarkdown(p.name)}*`;
        await bot.sendMessage(mod, line, { parse_mode: "Markdown", reply_markup: buildKeyboard(p.id) });
      } catch (err) {
        logger.error({ err, mod, productId: p.id }, "stockCheck: product prompt failed");
      }
    }
  }
}

export function isStockCheckCallback(data: string | undefined): boolean {
  return !!data && data.startsWith(CB_PREFIX);
}

export async function handleStockCheckCallback(bot: TelegramBot, query: TelegramBot.CallbackQuery): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.from.id.toString();
  // Gate: mods-only. Admins don't get the prompts in the first place and
  // should not be tapping these buttons — they receive a separate rollup
  // below. Defence-in-depth in case an admin somehow sees a forwarded
  // prompt.
  if (!getModOnlyIds().includes(chatId)) {
    try { await bot.answerCallbackQuery(query.id, { text: "Mods only — this is the mod stock check.", show_alert: true }); } catch {}
    return;
  }
  // Parse `stk:<productId>:<choice>`.
  const rest = data.slice(CB_PREFIX.length);
  const [pidStr, choiceStr] = rest.split(":");
  const productId = parseInt(pidStr ?? "", 10);
  const choice = choiceStr as StockChoice;
  if (!Number.isFinite(productId) || !(choice in CHOICE_LABEL)) {
    try { await bot.answerCallbackQuery(query.id, { text: "Bad request." }); } catch {}
    return;
  }

  const targetState = CHOICE_TO_VARIANT_STATE[choice];
  const product = await getProduct(productId).catch(() => undefined);
  if (!product) {
    try { await bot.answerCallbackQuery(query.id, { text: "Product gone." }); } catch {}
    return;
  }
  const variants = await getProductVariants(productId).catch(() => [] as Awaited<ReturnType<typeof getProductVariants>>);
  let updated = 0;
  for (const v of variants) {
    try {
      const ok = await setVariantStock(v.id, targetState);
      if (ok) updated += 1;
    } catch (err) {
      logger.error({ err, variantId: v.id, targetState }, "stockCheck: setVariantStock failed");
    }
  }

  const actorRaw = query.from.username ? `@${query.from.username}` : query.from.first_name ?? chatId;
  const countSuffix = variants.length > 0 ? ` · ${updated}/${variants.length} weights` : "";
  const newBody =
    `${product.emoji ?? "🌿"} *${escapeMarkdown(product.name)}* → ${CHOICE_LABEL[choice]}\n` +
    `_by ${escapeMarkdown(actorRaw)}${countSuffix}_`;
  if (query.message) {
    try {
      await bot.editMessageText(newBody, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
      });
    } catch (err) {
      logger.error({ err }, "stockCheck: editMessageText failed");
    }
  }
  try { await bot.answerCallbackQuery(query.id, { text: `Set to ${CHOICE_LABEL[choice]}` }); } catch {}

  // Fan-out to the whole team (admins + mods). The actor sees the
  // in-place edit on their own message and is skipped here so they
  // don't get a duplicate ping. Zero-miscommunication goal: every
  // other mod + every admin learns about the change immediately.
  await notifyTeamStockChange(bot, {
    productName: product.name,
    productEmoji: product.emoji ?? "🌿",
    targetState,
    actor: actorRaw,
    actorChatId: chatId,
    countSuffix,
    source: "stockcheck",
  });
}

// Shared helper used by EVERY path that mutates stock (mod stock-check
// callback above + /stock CLI in stockAdmin.ts). One source of truth for
// team notifications so updates never get lost between code paths.
// Recipients = admins ∪ mods, minus the actor (who already saw a local
// confirmation and doesn't need to be told about their own action).
export async function notifyTeamStockChange(
  bot: TelegramBot,
  args: {
    productName: string;
    productEmoji: string;
    variantLabel?: string;
    variantId?: number;
    targetState: "in_stock" | "low" | "sold_out";
    actor: string;
    actorChatId?: string;
    countSuffix?: string;
    source: "stockcheck" | "stock_cli" | "flash_drop" | "product_admin";
  },
): Promise<void> {
  const dot = args.targetState === "in_stock" ? "🟢" : args.targetState === "low" ? "🟡" : "🔴";
  const stateLabel = args.targetState === "in_stock" ? "In stock" : args.targetState === "low" ? "Low" : "Sold out";
  const variantPart = args.variantLabel
    ? ` — ${escapeMarkdown(args.variantLabel)}${args.variantId ? `  \`#${args.variantId}\`` : ""}`
    : args.countSuffix ?? "";
  const sourceTag =
    args.source === "stockcheck" ? "stock-check tap"
    : args.source === "stock_cli" ? "/stock command"
    : args.source === "product_admin" ? "product manager"
    : "flash drop sell-through";
  // One clean block. No nested parens, no yelling caps, one "by ..." line.
  // Layout matches the EOD section and /stock_report so the team only ever
  // has to learn one visual grammar.
  const body =
    `📦 *Stock update* — ${dot} ${stateLabel}\n` +
    `${args.productEmoji} *${escapeMarkdown(args.productName)}*${variantPart}\n` +
    `_by ${escapeMarkdown(args.actor)} · ${sourceTag}_`;
  const recipients = new Set<string>([...getAdminIds(), ...getModeratorIds()]);
  if (args.actorChatId) recipients.delete(args.actorChatId);
  for (const recipient of recipients) {
    try {
      await bot.sendMessage(recipient, body, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err, recipient }, "notifyTeamStockChange: notify failed");
    }
  }
}

// Open hours vary by weekday (see brand.ts WEEKLY_HOURS), so the "at open"
// run uses an hourly tick with a per-day marker — same self-healing pattern
// as the EOD scheduler (>= guard catches a restart that straddles the open
// hour). The evening run stays fixed at 22:30, which is after close on
// every weekday (latest close is 22:00).
let lastOpenStockCheckDay = "";

export function startStockCheckScheduler(bot: TelegramBot): void {
  cron.schedule(
    "0 * * * *",
    () => {
      const day = businessDateKey();
      if (lastOpenStockCheckDay === day) return;
      const hour = businessHourNow();
      const { open, close } = todayHours();
      // Only during open hours: a restart after close shouldn't re-fire the
      // "at open" ping on top of the fixed 22:30 evening run.
      if (hour < open || hour >= close) return;
      lastOpenStockCheckDay = day;
      void runStockCheck(bot, "scheduled");
    },
    { timezone: TIMEZONE },
  );
  cron.schedule("30 22 * * *", () => { void runStockCheck(bot, "scheduled"); }, { timezone: TIMEZONE });
  logger.info("Stock-check scheduler started (at each day's open hour + 22:30 business time)");
}
