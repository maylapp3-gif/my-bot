import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { handleStart } from "./handlers/start.js";
import {
  sendVerifyGate,
  isVerifyCustomerCallback,
  handleVerifyCustomerCallback,
  isVerifyAdminCallback,
  handleVerifyAdminCallback,
  handleVerifyUsernameText,
  handleVerifyQueue,
  handleModBypass,
} from "./handlers/verify.js";
import { handleOrder, handleMyOrders } from "./handlers/order.js";
import { handleContact, handleLegal, handleHowItWorks } from "./handlers/contact.js";
import {
  handleAdmin,
  handleListProducts,
  handlePendingOrders,
  handleConfirmAll,
  handleAllOrders,
  handleEod,
  handleOrderStatusUpdate,
  handleSubscribers,
  handleBroadcast,
  handleAddRelay,
  handleRemoveRelay,
  handleListRelays,
  isAdmin,
} from "./handlers/admin.js";
import { handleAnnounce } from "./handlers/announce.js";
import {
  isOpenNow,
  closedPhase,
  todayHoursHuman,
  openHourHumanToday,
  nextOpenInfo,
  nextOpenDayWord,
  weeklyScheduleLine,
} from "./hours.js";
import { BRAND_NAME } from "./brand.js";
import {
  startBroadcastFlow,
  hasBroadcastSession,
  handleBroadcastMessage,
  isBroadcastCallback,
  handleBroadcastCallback,
} from "./handlers/broadcastFlow.js";
import {
  startRecipientPicker,
  isRecipientPickerCallback,
  handleRecipientPickerCallback,
} from "./handlers/recipientPicker.js";
import {
  openProductMenu,
  handleProductAdminCallback,
  handleProductAdminText,
  hasProductAdminSession,
  isProductAdminCallback,
} from "./handlers/productAdmin.js";
import {
  openCustomerMenu,
  openProductBrowser,
  handleCustomerMenuCallback,
  isCustomerMenuCallback,
  handleCustomerMenuButton,
  isCustomerMenuButton,
} from "./handlers/customerMenu.js";
import {
  openCart,
  isCartCallback,
  handleCartCallback,
  hasCartSession,
  hasCheckoutSession,
  hasPromoSession,
  handleCheckoutStep,
  handlePromoTextStep,
  clearCheckoutSession,
  clearPromoSession,
} from "./handlers/cart.js";
import { handlePromos, handleAddPromo, handleDelPromo } from "./handlers/promoAdmin.js";
import {
  handleRaffles,
  handleAddRaffle,
  handleDelRaffle,
  handleDrawRaffle,
  handleRaffleEntry,
  isRaffleEntryCallback,
  handleRaffleEntryCallback,
} from "./handlers/raffle.js";
import {
  handleAddRegular,
  handleRemoveRegular,
  handleListRegulars,
} from "./handlers/regulars.js";
import { handleDriving } from "./handlers/driving.js";
import {
  handleTake,
  handleRelease,
  handleForceRelease,
  handleReply,
  handleActive,
  handleMods,
  isModInlineCallback,
  handleModInlineCallback,
  tryConsumeForceReply,
  relayCustomerMessage,
  relayAIResponse,
  AI_FALLBACK_DELAY_MS,
} from "./handlers/moderation.js";
import { isOrderActionCallback, handleOrderActionCallback } from "./handlers/orderActions.js";
import {
  handlePick,
  isMatchmakerCallback,
  handleMatchmakerCallback,
} from "./handlers/matchmaker.js";
import { handleReferral } from "./handlers/referral.js";
import {
  handleAddBundle,
  handleBundleItem,
  handleListBundles,
  handleDelBundle,
  isBundleCallback,
  handleBundleCallback,
} from "./handlers/bundles.js";
import { handleStock } from "./handlers/stockAdmin.js";
import { handleStockReport } from "./handlers/stockReport.js";
import { handlePickup } from "./handlers/pickup.js";
import { startClaimsJanitor } from "./moderation.js";
import { handleDash, isDashCallback, handleDashCallback } from "./handlers/dash.js";
import { handleQr, isQrCallback, handleQrCallback } from "./handlers/quickReply.js";
import { isReorderCallback, handleReorderCallback } from "./handlers/reorder.js";
import {
  isFlashDropCallback,
  handleFlashDropCallback,
  handleDropCommand,
  handleDropCancel,
  handleDropsList,
} from "./handlers/flashDrop.js";
import { getClaimer, isModerator, scheduleFallback, getModeratorIds } from "./moderation.js";
import { isSuspiciousCallback, handleSuspiciousCallback } from "./handlers/suspicious.js";
import {
  trackMessage,
  isBlocked,
  needsVerification,
  getVerifyState,
  resetVerification,
  removeSubscriber,
  findSubscribers,
  blockAndWipe,
  banHandle,
  unbanHandle,
  backfillVariantsForLegacyProducts,
  getAllProductsOrdered,
  updateProductFields,
} from "./db.js";
import { normalizeHandle, USERNAME_RE } from "./verifyCore.js";
import { getAIResponse, aiSpendAllowed, noteAiSpend, pruneAiSpendBuckets } from "./ai.js";
import { aiPickEmojiForName } from "./aiEmoji.js";
import { startSelfDestructScheduler } from "./selfDestruct.js";
import { startDataRetentionScheduler } from "./dataRetention.js";
import { startPendingOrderReminder } from "./pendingOrderReminder.js";
import { startFollowUpReminder } from "./followUpReminder.js";
import { maybeHandleHiddenOp, warnIfPassphraseMissing } from "./hiddenOps.js";
import { startEodScheduler } from "./eod.js";
import { startStockCheckScheduler, runStockCheck, isStockCheckCallback, handleStockCheckCallback } from "./stockCheck.js";
import { startBackupScheduler } from "./backup.js";
import { startSecuritySweepScheduler, sendSecuritySweep } from "./securitySweep.js";
import { startPromoBroadcaster, handlePromoBroadcastCommand } from "./promoBroadcaster.js";
import {
  handlePanicWipe,
  handleBackupNow,
  handleListBackups,
  handleRestoreSubscribers,
} from "./handlers/security.js";

export function startBot(): TelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  // Polling guard — see comments in earlier version. Prevents duplicate-
  // message bug when dev + prod race on the same bot token.
  const isDeployment = process.env.REPLIT_DEPLOYMENT === "1";
  const explicit = process.env.BOT_POLLING_ENABLED;
  const pollingEnabled =
    explicit === undefined ? isDeployment : explicit === "true" || explicit === "1";

  if (!pollingEnabled) {
    logger.warn(
      { isDeployment, explicit: explicit ?? "(unset)" },
      "Telegram polling DISABLED in this process (prevents duplicate-message bug from dev+prod racing on same token). Set BOT_POLLING_ENABLED=true to override.",
    );
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  logger.info({ isDeployment }, "Telegram bot started with polling");

  // NOTE: variant backfill is admin-only via /backfill_variants. We deliberately
  // do NOT run it on every boot, because the idempotency key is "product has 0
  // variants", which would also re-create an "Each" variant for any product an
  // admin had intentionally cleared between deploys.

  // Redact the token from polling errors so it never lands in logs.
  bot.on(
    "polling_error",
    (
      err: Error & {
        response?: {
          request?: { uri?: { pathname?: string; path?: string; href?: string }; href?: string };
        };
      },
    ) => {
      try {
        const resp = err.response;
        if (resp?.request?.uri) {
          if (resp.request.uri.pathname) resp.request.uri.pathname = "[REDACTED]";
          if (resp.request.uri.path) resp.request.uri.path = "[REDACTED]";
          if (resp.request.uri.href) resp.request.uri.href = "[REDACTED]";
        }
        if (resp?.request?.href) resp.request.href = "[REDACTED]";
        const tokenRe = /bot\d+(?::|%3A)[A-Za-z0-9_%-]+/gi;
        const msg = (err.message ?? "").replace(tokenRe, "bot[REDACTED]");
        const stack = (err.stack ?? "").replace(tokenRe, "bot[REDACTED]");
        logger.error(
          { code: (err as { code?: string }).code, message: msg, stack },
          "Telegram polling error (redacted)",
        );
      } catch {
        logger.error("Telegram polling error (sanitiser failed)");
      }
    },
  );

  startSelfDestructScheduler(bot);
  startDataRetentionScheduler();
  startPendingOrderReminder(bot);
  startFollowUpReminder(bot);
  warnIfPassphraseMissing();
  startEodScheduler(bot);
  startStockCheckScheduler(bot);
  startClaimsJanitor(bot);

  startBackupScheduler(bot);
  startPromoBroadcaster(bot);
  startSecuritySweepScheduler(bot);

  // Keep the in-memory AI-spend rate-limit buckets from growing unbounded:
  // hourly prune drops timestamps that have aged out of both windows.
  setInterval(() => pruneAiSpendBuckets(), 60 * 60 * 1000);

  // Verification gate for customer slash-commands. onText handlers fire
  // independently of the bot.on("message") router, so each customer-facing
  // command must call this first. Returns true (and shows the neutral gate)
  // when the caller is an unverified new customer; admins/mods are never
  // gated, and the grandfathered base reads NULL so it sails through. Fails
  // closed: any error blocks and re-shows the gate.
  const gateBlocked = async (msg: TelegramBot.Message): Promise<boolean> => {
    // Gate ONLY private customer DMs. Relay groups have no subscriber row and
    // would otherwise trip the missing-row fail-closed rule and get spammed.
    if (msg.chat.type !== "private") return false;
    const chatId = msg.chat.id.toString();
    if (isModerator(chatId)) return false;
    try {
      if (!(await needsVerification(chatId))) return false;
    } catch (err) {
      logger.error({ err, chatId }, "command gate check failed — failing closed");
    }
    try {
      await sendVerifyGate(bot, chatId);
    } catch (err) {
      logger.error({ err, chatId }, "command gate re-show failed");
    }
    return true;
  };

  // ===========================================================================
  // /start, /myid, /help, /legal, /howitworks, /contact
  // ===========================================================================
  bot.onText(/^\/start(?:@\w+)?(?:\s+\S.*)?$/, async (msg) => {
    try {
      const sent = await handleStart(bot, msg);
      if (sent) await trackMessage(msg.chat.id.toString(), sent.message_id);
    } catch (err) {
      logger.error({ err }, "/start handler error");
    }
  });

  bot.onText(/^\/myid$/, async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      await bot.sendMessage(
        chatId,
        `🆔 *Your chat ID:* \`${chatId}\`\n\nSend this to the operator if you're being added as an admin or moderator.`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      logger.error({ err }, "/myid handler error");
    }
  });

  bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      const sent = await bot.sendMessage(
        msg.chat.id,
        `*${BRAND_NAME} — Help*\n\n` +
          `/products  —  the menu (tap a size to add to cart)\n` +
          `/cart  —  see your cart, send the order\n` +
          `/orders  —  your past orders\n` +
          `/howitworks  —  the move, top to bottom\n` +
          `/contact  —  pull up the team\n` +
          `/legal  —  the rules\n` +
          `/menu  —  open the main menu\n\n` +
          `_cash · in person · ${weeklyScheduleLine()}_\n\n` +
          `This bot is for *ordering only* — for anything else, tap *Contact* and message us here.\n\n` +
          `🔒 _every message wipes after 24h._`,
        { parse_mode: "Markdown" },
      );
      await trackMessage(msg.chat.id.toString(), sent.message_id);
    } catch (err) {
      logger.error({ err }, "/help handler error");
    }
  });

  bot.onText(/^\/legal(?:@\w+)?$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      const sent = await handleLegal(bot, msg);
      if (sent) await trackMessage(msg.chat.id.toString(), sent.message_id);
    } catch (err) {
      logger.error({ err }, "/legal handler error");
    }
  });

  bot.onText(/^\/howitworks(?:@\w+)?$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      const sent = await handleHowItWorks(bot, msg);
      if (sent) await trackMessage(msg.chat.id.toString(), sent.message_id);
    } catch (err) {
      logger.error({ err }, "/howitworks handler error");
    }
  });

  bot.onText(/^\/products$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      await openProductBrowser(bot, msg.chat.id.toString());
    } catch (err) {
      logger.error({ err }, "/products handler error");
    }
  });

  // /order and /cart both open the cart. /order is kept around for muscle-
  // memory; the actual order-placement happens via cart's "Send Order" button.
  bot.onText(/^\/order(?:\s+[\s\S]*)?$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      await handleOrder(bot, msg);
    } catch (err) {
      logger.error({ err }, "/order handler error");
    }
  });

  bot.onText(/^\/cart$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      await openCart(bot, msg.chat.id.toString());
    } catch (err) {
      logger.error({ err }, "/cart handler error");
    }
  });

  // /cancel — bails out of an active checkout / promo prompt; otherwise nudges.
  bot.onText(/^\/cancel$/, async (msg) => {
    const chatId = msg.chat.id.toString();
    if (await gateBlocked(msg)) return;
    if (hasCheckoutSession(chatId)) {
      clearCheckoutSession(chatId);
      try {
        await bot.sendMessage(chatId, "_Checkout cancelled. Your cart is still saved._", {
          parse_mode: "Markdown",
        });
      } catch {}
      return;
    }
    if (hasPromoSession(chatId)) {
      clearPromoSession(chatId);
      try {
        await bot.sendMessage(chatId, "_Promo cancelled._", { parse_mode: "Markdown" });
      } catch {}
      return;
    }
    try {
      await bot.sendMessage(
        chatId,
        "_Nothing to cancel. Tap 🛒 Cart to view your order, or /help for the menu._",
        { parse_mode: "Markdown" },
      );
    } catch {}
  });

  bot.onText(/^\/orders$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      await handleMyOrders(bot, msg);
    } catch (err) {
      logger.error({ err }, "/orders handler error");
    }
  });

  bot.onText(/^\/contact(?:@\w+)?$/, async (msg) => {
    try {
      if (await gateBlocked(msg)) return;
      const sent = await handleContact(bot, msg);
      if (sent) await trackMessage(msg.chat.id.toString(), sent.message_id);
    } catch (err) {
      logger.error({ err }, "/contact handler error");
    }
  });

  // ===========================================================================
  // Admin commands
  // ===========================================================================
  bot.onText(/^\/admin$/, async (msg) => {
    try { await handleAdmin(bot, msg); } catch (err) { logger.error({ err }, "/admin error"); }
  });

  bot.onText(/^\/add_product$/, async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) return;
      await openProductMenu(bot, chatId);
    } catch (err) { logger.error({ err }, "/add_product error"); }
  });

  bot.onText(/^\/list_products$/, async (msg) => {
    try { await handleListProducts(bot, msg); } catch (err) { logger.error({ err }, "/list_products error"); }
  });

  bot.onText(/^\/(products_admin|manage_products)$/, async (msg) => {
    try { await openProductMenu(bot, msg.chat.id.toString()); } catch (err) { logger.error({ err }, "/products_admin error"); }
  });

  bot.onText(/^\/menu$/, async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      if (isAdmin(chatId)) {
        await openProductMenu(bot, chatId);
      } else {
        if (await gateBlocked(msg)) return;
        await openCustomerMenu(bot, chatId, msg.from?.first_name);
      }
    } catch (err) { logger.error({ err }, "/menu error"); }
  });

  // Promo manager (admin)
  bot.onText(/^\/promos$/, async (msg) => {
    try { await handlePromos(bot, msg); } catch (err) { logger.error({ err }, "/promos error"); }
  });
  bot.onText(/^\/add_promo\s+([\s\S]+)$/, async (msg, match) => {
    try { if (match) await handleAddPromo(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/add_promo error"); }
  });
  bot.onText(/^\/del_promo\s+(\S+)$/, async (msg, match) => {
    try { if (match) await handleDelPromo(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/del_promo error"); }
  });

  // Raffle manager (admin). Note `/raffles` must be registered so it does NOT
  // also match the customer `/raffle` handler below (the trailing `s` differs).
  bot.onText(/^\/raffles$/, async (msg) => {
    try { await handleRaffles(bot, msg); } catch (err) { logger.error({ err }, "/raffles error"); }
  });
  bot.onText(/^\/add_raffle\s+([\s\S]+)$/, async (msg, match) => {
    try { if (match) await handleAddRaffle(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/add_raffle error"); }
  });
  bot.onText(/^\/del_raffle\s+(\S+)$/, async (msg, match) => {
    try { if (match) await handleDelRaffle(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/del_raffle error"); }
  });
  bot.onText(/^\/draw_raffle\s+([\s\S]+)$/, async (msg, match) => {
    try { if (match) await handleDrawRaffle(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/draw_raffle error"); }
  });

  // Customer raffle entry: `/raffle CODE` (or bare `/raffle` for usage). Gated
  // behind the verification wall, exactly like the other business actions.
  bot.onText(/^\/raffle(?:@\w+)?(?:\s+(\S+))?$/, async (msg, match) => {
    try {
      if (await gateBlocked(msg)) return;
      await handleRaffleEntry(bot, msg, match?.[1]);
    } catch (err) { logger.error({ err }, "/raffle error"); }
  });

  // Driver away mode (moderators)
  bot.onText(/^\/driving(?:\s+([\s\S]+))?$/, async (msg, match) => {
    try { await handleDriving(bot, msg, match?.[1] ?? ""); } catch (err) { logger.error({ err }, "/driving error"); }
  });

  // NOTE: Subscriber/broadcast/backup/restore/panic-wipe/regulars/promo-blast
  // commands are deliberately NOT registered as slash commands — they live
  // behind the hidden ops passphrase (see bot/hiddenOps.ts). The decoy
  // intentionally hides any surface that hints at a stored contact list.

  // /backfill_variants — admin re-run of the boot backfill
  bot.onText(/^\/backfill_variants$/, async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!isAdmin(chatId)) return;
    try {
      const r = await backfillVariantsForLegacyProducts();
      await bot.sendMessage(
        chatId,
        `🧱 Backfill done.\n• Created variants: ${r.created}\n• Skipped (already had variants or unparseable price): ${r.skipped}`,
      );
    } catch (err) {
      logger.error({ err }, "/backfill_variants error");
      await bot.sendMessage(chatId, "Backfill failed — check logs.");
    }
  });

  // /regen_emojis — admin: re-pick emoji for every product via AI (name-biased)
  bot.onText(/^\/regen_emojis$/, async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!isAdmin(chatId)) return;
    try {
      await bot.sendMessage(chatId, "🪄 Regenerating emojis (AI is reading every product name)…");
      const products = await getAllProductsOrdered();
      let updated = 0;
      let failed = 0;
      for (const p of products) {
        try {
          const e = await aiPickEmojiForName(p.name, p.description ?? "");
          await updateProductFields(p.id, { emoji: e });
          updated++;
        } catch (err) {
          logger.error({ err, productId: p.id }, "regen_emojis: pick failed");
          failed++;
        }
      }
      await bot.sendMessage(
        chatId,
        `🪄 Done.\n• Updated: ${updated}\n• Failed: ${failed}\n\nOpen /menu to spot-check.`,
      );
    } catch (err) {
      logger.error({ err }, "/regen_emojis error");
      await bot.sendMessage(chatId, "Couldn't regen emojis — check logs.");
    }
  });

  // ===========================================================================
  // Single callback_query handler — routes by prefix
  // ===========================================================================
  bot.on("callback_query", async (query) => {
    try {
      // Blocklist choke point — a blocked account can't reach ANY callback,
      // including the verification fast path below (which deliberately bypasses
      // the verify gate). Mods/admins are never blocked. We fail open only on a
      // DB error so a transient blip can't lock out the whole customer base.
      {
        const cbId = (query.message?.chat.id ?? query.from.id).toString();
        if (
          query.message?.chat.type === "private" &&
          !isAdmin(cbId) &&
          !isModerator(cbId)
        ) {
          try {
            if (await isBlocked(cbId)) {
              try { await bot.answerCallbackQuery(query.id); } catch {}
              return;
            }
          } catch (err) {
            logger.error({ err }, "callback blocklist check failed");
          }
        }
      }
      // Verification gate. The Verify tap itself always goes through. For an
      // unverified customer, every OTHER inline button is blocked with a nudge
      // so a stale keyboard can't be used to reach business actions. Admins/
      // mods are never gated.
      if (isVerifyCustomerCallback(query.data)) {
        await handleVerifyCustomerCallback(bot, query);
        return;
      }
      // Gate only private customer DMs (business inline buttons only ever live
      // in DMs). Groups have no subscriber row and must not be gated.
      const cbChatId = (query.message?.chat.id ?? query.from.id).toString();
      if (
        query.message?.chat.type === "private" &&
        !isAdmin(cbChatId) &&
        !isModerator(cbChatId) &&
        (await needsVerification(cbChatId))
      ) {
        try { await bot.answerCallbackQuery(query.id, { text: "Finish verifying first." }); } catch {}
        return;
      }

      if (isVerifyAdminCallback(query.data)) {
        await handleVerifyAdminCallback(bot, query);
      } else if (isProductAdminCallback(query.data)) {
        await handleProductAdminCallback(bot, query);
      } else if (isCartCallback(query.data)) {
        await handleCartCallback(bot, query);
      } else if (isCustomerMenuCallback(query.data)) {
        await handleCustomerMenuCallback(bot, query);
      } else if (isOrderActionCallback(query.data)) {
        await handleOrderActionCallback(bot, query);
      } else if (isDashCallback(query.data)) {
        await handleDashCallback(bot, query);
      } else if (isQrCallback(query.data)) {
        await handleQrCallback(bot, query);
      } else if (isReorderCallback(query.data)) {
        await handleReorderCallback(bot, query);
      } else if (isFlashDropCallback(query.data)) {
        await handleFlashDropCallback(bot, query);
      } else if (isMatchmakerCallback(query.data)) {
        await handleMatchmakerCallback(bot, query);
      } else if (isBundleCallback(query.data)) {
        await handleBundleCallback(bot, query);
      } else if (isModInlineCallback(query.data)) {
        await handleModInlineCallback(bot, query);
      } else if (isSuspiciousCallback(query.data)) {
        await handleSuspiciousCallback(bot, query);
      } else if (isStockCheckCallback(query.data)) {
        await handleStockCheckCallback(bot, query);
      } else if (isRaffleEntryCallback(query.data)) {
        await handleRaffleEntryCallback(bot, query);
      } else if (isRecipientPickerCallback(query.data)) {
        await handleRecipientPickerCallback(bot, query);
      } else if (isBroadcastCallback(query.data)) {
        await handleBroadcastCallback(bot, query);
      } else {
        try { await bot.answerCallbackQuery(query.id); } catch {}
      }
    } catch (err) {
      logger.error({ err }, "callback_query error");
    }
  });

  // Other admin commands (orders, subs, broadcast, relays, eod)
  bot.onText(/^\/drop(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
    try { await handleDropCommand(bot, msg, match?.[1] ?? ""); } catch (err) { logger.error({ err }, "/drop error"); }
  });
  bot.onText(/^\/drop_cancel(?:@\w+)?\s+(\d+)$/, async (msg, match) => {
    try { await handleDropCancel(bot, msg, match?.[1] ?? ""); } catch (err) { logger.error({ err }, "/drop_cancel error"); }
  });
  bot.onText(/^\/drops(?:@\w+)?$/, async (msg) => {
    try { await handleDropsList(bot, msg); } catch (err) { logger.error({ err }, "/drops error"); }
  });

  bot.onText(/^\/pending_orders$/, async (msg) => {
    try { await handlePendingOrders(bot, msg); } catch (err) { logger.error({ err }, "/pending_orders error"); }
  });
  bot.onText(/^\/all_orders$/, async (msg) => {
    try { await handleAllOrders(bot, msg); } catch (err) { logger.error({ err }, "/all_orders error"); }
  });
  bot.onText(/^\/announce(?:\s+([\s\S]+))?$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      const body = match?.[1] ?? "";
      // No args → start the interactive compose flow (supports photos).
      // Args present → keep the one-shot text behavior for muscle memory.
      if (!body.trim()) {
        if (!isAdmin(chatId)) {
          await bot.sendMessage(chatId, "⛔ Admin access required.");
          return;
        }
        await startBroadcastFlow(bot, chatId, "mods");
        return;
      }
      await handleAnnounce(bot, msg, body);
    } catch (err) { logger.error({ err }, "/announce error"); }
  });
  bot.onText(/^\/broadcast(?:\s+([\s\S]+))?$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      const body = match?.[1] ?? "";
      if (!body.trim()) {
        if (!isAdmin(chatId)) {
          await bot.sendMessage(chatId, "⛔ Admin access required.");
          return;
        }
        await startBroadcastFlow(bot, chatId, "subscribers");
        return;
      }
      await handleBroadcast(bot, msg, body);
    } catch (err) { logger.error({ err }, "/broadcast error"); }
  });
  bot.onText(/^\/send(?:@\w+)?$/, async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, "⛔ Admin access required.");
        return;
      }
      await startRecipientPicker(bot, chatId);
    } catch (err) { logger.error({ err }, "/send error"); }
  });

  bot.onText(/^\/eod$/, async (msg) => {
    try { await handleEod(bot, msg); } catch (err) { logger.error({ err }, "/eod error"); }
  });
  bot.onText(/^\/sweep(?:@\w+)?$/, async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, "⛔ Admin access required.");
        return;
      }
      await bot.sendMessage(chatId, "🛡️ Running the security check now…");
      await sendSecuritySweep(bot, chatId);
    } catch (err) { logger.error({ err }, "/sweep error"); }
  });
  bot.onText(/^\/confirmall$/, async (msg) => {
    try { await handleConfirmAll(bot, msg); } catch (err) { logger.error({ err }, "/confirmall error"); }
  });
  bot.onText(/^\/(confirm|cancel)_(\d+)$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      // Moderators (not just admins) can confirm/cancel — they're the ones
      // receiving the order alerts on their phones.
      if (!isAdmin(chatId) && !isModerator(chatId)) {
        await bot.sendMessage(
          chatId,
          "That command is for our team. Tap 🛒 Cart to manage your order, or /orders to see your history.",
        );
        return;
      }
      if (match) await handleOrderStatusUpdate(bot, msg, `${match[1]}_${match[2]}`);
    } catch (err) { logger.error({ err }, "order status update error"); }
  });
  bot.onText(/^\/stockcheck(?:@\w+)?$/, async (msg) => {
    try {
      const id = msg.from?.id?.toString();
      if (!id || !getModeratorIds().includes(id)) return;
      await bot.sendMessage(msg.chat.id, "🧮 Firing stock check now…");
      await runStockCheck(bot, "manual");
    } catch (err) { logger.error({ err }, "/stockcheck error"); }
  });
  // /remove_sub <@username or chatId> [more...] — admin-only HARD wipe of a
  // subscriber and all their live state. Accepts several targets in one go.
  // Plain-text replies (no Markdown) so a stray char in a username can't
  // bounce the confirmation.
  bot.onText(/^\/remove_sub(?:@\w+)?\s+(.+)$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) return;
      const targets = (match?.[1] ?? "").split(/\s+/).map((t) => t.trim()).filter(Boolean);
      if (targets.length === 0) {
        await bot.sendMessage(chatId, "Usage: /remove_sub <@username or id> [more…]");
        return;
      }
      const lines: string[] = [];
      const wiped: string[] = [];
      for (const target of targets) {
        const matches = await findSubscribers(target);
        if (matches.length === 0) {
          lines.push(`❓ ${target} — no match, skipped`);
          continue;
        }
        // Refuse to guess on an ambiguous username (username is not unique).
        // Make the admin disambiguate with the exact numeric ID so we never
        // delete the wrong person.
        if (matches.length > 1) {
          const ids = matches.map((m) => m.chatId).join(", ");
          lines.push(`⚠️ ${target} — ${matches.length} customers share this @. Re-run with the exact ID: ${ids}`);
          continue;
        }
        const sub = matches[0];
        // blockAndWipe (not bare purge): also blocklists the chat id so /start
        // can't re-create the account, and records the LeafedOut handle's hash
        // when the customer was verified===true — so a wiped dangerous regular
        // can't just verify a brand-new Telegram account back in.
        const res = await blockAndWipe(sub.chatId, "admin_removed", chatId);
        const who = sub.username ? `@${sub.username}` : (sub.firstName ?? sub.chatId);
        const orderNote = res.ordersDeleted > 0 ? ` (+${res.ordersDeleted} order${res.ordersDeleted === 1 ? "" : "s"})` : "";
        lines.push(`🗑 ${who} — wiped${orderNote}`);
        wiped.push(`🗑 ${who}${orderNote}`);
        logger.info({ removedChatId: sub.chatId, ordersDeleted: res.ordersDeleted, by: chatId }, "admin /remove_sub block+wipe");
      }
      await bot.sendMessage(chatId, `Done.\n${lines.join("\n")}`);

      // Notify the whole mod team whenever a suspicious account is actually
      // wiped, so removals are never silent. Skip the actor (they already got
      // the summary above) and only fire if something was really removed.
      if (wiped.length > 0) {
        // Plain text (no Markdown) — same reasoning as the actor summary: a
        // stray char in a username must never bounce the notification.
        const note =
          `🚨 Suspicious account${wiped.length === 1 ? "" : "s"} removed by ${chatId}:\n` +
          wiped.join("\n");
        for (const modId of getModeratorIds()) {
          if (modId === chatId) continue;
          try {
            await bot.sendMessage(modId, note);
          } catch (err) {
            logger.error({ err, modId }, "/remove_sub mod-notify failed");
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "/remove_sub error");
      await bot.sendMessage(msg.chat.id, "Couldn't complete the removal — check logs.");
    }
  });
  // /reset_verify <@user or id> — admin-only: force a customer back through the
  // new-customer verification gate. Resolves @username or numeric id the same
  // way as /remove_sub and refuses on an ambiguous @. Used to re-test the flow
  // or re-verify an account; the next message to the bot (or to a moderator's
  // DM, once the userbot process has restarted) re-offers Start.
  bot.onText(/^\/reset_verify(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) return;
      const target = (match?.[1] ?? "").trim();
      if (!target) {
        await bot.sendMessage(chatId, "Usage: /reset_verify <@username or id>");
        return;
      }
      const matches = await findSubscribers(target);
      if (matches.length === 0) {
        await bot.sendMessage(chatId, `❓ ${target} — no match.`);
        return;
      }
      if (matches.length > 1) {
        const ids = matches.map((m) => m.chatId).join(", ");
        await bot.sendMessage(
          chatId,
          `⚠️ ${target} — ${matches.length} customers share this @. Re-run with the exact ID: ${ids}`,
        );
        return;
      }
      const sub = matches[0];
      const who = sub.username ? `@${sub.username}` : (sub.firstName ?? sub.chatId);
      const ok = await resetVerification(sub.chatId);
      if (!ok) {
        await bot.sendMessage(chatId, `Couldn't reset ${who}.`);
        return;
      }
      logger.info({ resetChatId: sub.chatId, by: chatId }, "admin /reset_verify");
      await bot.sendMessage(
        chatId,
        `🔄 ${who} reset to unverified. They'll be asked to verify again on their next message to the bot. ` +
          `For the moderator-DM flow, this takes effect after the next publish/restart.`,
      );
    } catch (err) {
      logger.error({ err }, "/reset_verify error");
      await bot.sendMessage(msg.chat.id, "Couldn't complete the reset — check logs.");
    }
  });
  // /bypass <@user or id> — moderator escape hatch: manually wave a still-gated
  // customer through verification for genuine exceptions. Guardrails, audit
  // fanout to admins, and refusal rules live in handleModBypass (verify.ts).
  bot.onText(/^\/bypass(?:@\w+)?(?:\s+(\S+))?$/, async (msg, match) => {
    try {
      await handleModBypass(bot, msg, match?.[1] ?? "");
    } catch (err) {
      logger.error({ err }, "/bypass error");
    }
  });
  // /ban_handle <handle> — admin-only: bar a LeafedOut profile from verifying
  // ANY Telegram account, even a brand-new one. Use it to keep a known-dangerous
  // person out proactively, without waiting for them to reappear. Blocking a
  // verified customer already records their handle here automatically.
  bot.onText(/^\/ban_handle(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) return;
      const handle = normalizeHandle(match?.[1] ?? "");
      if (!USERNAME_RE.test(handle)) {
        await bot.sendMessage(chatId, "Usage: /ban_handle <LeafedOut handle> (letters, numbers, . _ - only)");
        return;
      }
      await banHandle(handle, chatId);
      logger.info({ by: chatId }, "admin /ban_handle");
      await bot.sendMessage(
        chatId,
        "⛔ That LeafedOut profile is now barred from verifying any account. Use /unban_handle with the same handle to undo.",
      );
    } catch (err) {
      logger.error({ err }, "/ban_handle error");
      await bot.sendMessage(msg.chat.id, "Couldn't ban that handle — check logs.");
    }
  });
  // /unban_handle <handle> — admin-only: lift a handle ban (recovery from a
  // mistaken ban, or to let a previously-blocked person back in).
  bot.onText(/^\/unban_handle(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) return;
      const handle = normalizeHandle(match?.[1] ?? "");
      if (!USERNAME_RE.test(handle)) {
        await bot.sendMessage(chatId, "Usage: /unban_handle <LeafedOut handle>");
        return;
      }
      const existed = await unbanHandle(handle);
      logger.info({ by: chatId, existed }, "admin /unban_handle");
      await bot.sendMessage(
        chatId,
        existed
          ? "✅ Ban lifted. That LeafedOut profile can verify again."
          : "ℹ️ No ban was on that handle — nothing to undo.",
      );
    } catch (err) {
      logger.error({ err }, "/unban_handle error");
      await bot.sendMessage(msg.chat.id, "Couldn't lift that ban — check logs.");
    }
  });
  bot.onText(/^\/add_relay(?:@\w+)?\s+(.+)$/, async (msg, match) => {
    try { if (match) await handleAddRelay(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/add_relay error"); }
  });
  bot.onText(/^\/remove_relay(?:@\w+)?$/, async (msg) => {
    try { await handleRemoveRelay(bot, msg); } catch (err) { logger.error({ err }, "/remove_relay error"); }
  });
  bot.onText(/^\/list_relays(?:@\w+)?$/, async (msg) => {
    try { await handleListRelays(bot, msg); } catch (err) { logger.error({ err }, "/list_relays error"); }
  });

  // Moderation commands (live customer-chat handover)
  bot.onText(/^\/take\s+(-?\d+)$/, async (msg, match) => {
    try { if (match) await handleTake(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/take error"); }
  });
  bot.onText(/^\/release\s+(-?\d+)$/, async (msg, match) => {
    try { if (match) await handleRelease(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/release error"); }
  });
  bot.onText(/^\/forcerelease\s+(-?\d+)$/, async (msg, match) => {
    try { if (match) await handleForceRelease(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/forcerelease error"); }
  });
  bot.onText(/^\/reply\s+(-?\d+)\s+([\s\S]+)$/, async (msg, match) => {
    try { if (match) await handleReply(bot, msg, match[1], match[2]); } catch (err) { logger.error({ err }, "/reply error"); }
  });
  bot.onText(/^\/dash$/, async (msg) => {
    try { await handleDash(bot, msg); } catch (err) { logger.error({ err }, "/dash error"); }
  });
  bot.onText(/^\/qr$/, async (msg) => {
    try { await handleQr(bot, msg); } catch (err) { logger.error({ err }, "/qr error"); }
  });
  bot.onText(/^\/active$/, async (msg) => {
    try { await handleActive(bot, msg); } catch (err) { logger.error({ err }, "/active error"); }
  });
  bot.onText(/^\/mods$/, async (msg) => {
    try { await handleMods(bot, msg); } catch (err) { logger.error({ err }, "/mods error"); }
  });
  bot.onText(/^\/verify_queue$/, async (msg) => {
    try { await handleVerifyQueue(bot, msg); } catch (err) { logger.error({ err }, "/verify_queue error"); }
  });

  // Wave 2/3: matchmaker + referral + bundles + stock + happy-hour status.
  bot.onText(/^\/pick$/, async (msg) => {
    try { if (await gateBlocked(msg)) return; await handlePick(bot, msg); } catch (err) { logger.error({ err }, "/pick error"); }
  });
  bot.onText(/^\/referral$/, async (msg) => {
    try { if (await gateBlocked(msg)) return; await handleReferral(bot, msg); } catch (err) { logger.error({ err }, "/referral error"); }
  });
  bot.onText(/^\/add_bundle\s+([\s\S]+)$/, async (msg, match) => {
    try { if (match) await handleAddBundle(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/add_bundle error"); }
  });
  bot.onText(/^\/bundle_item\s+([\s\S]+)$/, async (msg, match) => {
    try { if (match) await handleBundleItem(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/bundle_item error"); }
  });
  bot.onText(/^\/list_bundles$/, async (msg) => {
    try { await handleListBundles(bot, msg); } catch (err) { logger.error({ err }, "/list_bundles error"); }
  });
  bot.onText(/^\/del_bundle\s+(\d+)$/, async (msg, match) => {
    try { if (match) await handleDelBundle(bot, msg, match[1]); } catch (err) { logger.error({ err }, "/del_bundle error"); }
  });
  bot.onText(/^\/stock_report(?:@\w+)?$/, async (msg) => {
    try { await handleStockReport(bot, msg); } catch (err) { logger.error({ err }, "/stock_report error"); }
  });
  bot.onText(/^\/pickup(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
    try { await handlePickup(bot, msg, match?.[1]); } catch (err) { logger.error({ err }, "/pickup error"); }
  });
  bot.onText(/^\/stock(?:\s+(\S+)\s+(\S+))?$/, async (msg, match) => {
    try {
      const vid = match?.[1] ?? "";
      const state = match?.[2] ?? "";
      if (!vid || !state) {
        await bot.sendMessage(
          msg.chat.id,
          "Usage: `/stock <variantId> <in_stock|low|sold_out>`",
          { parse_mode: "Markdown" },
        );
        return;
      }
      await handleStock(bot, msg, vid, state);
    } catch (err) {
      logger.error({ err }, "/stock error");
    }
  });
  bot.onText(/^\/happy_hour$/, async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      if (!isAdmin(chatId)) return;
      const { getHappyHourState, happyHourWindowLabel } = await import("./happyHour.js");
      const s = getHappyHourState();
      const label = happyHourWindowLabel();
      await bot.sendMessage(
        chatId,
        s.percent < 1
          ? `Happy hour: *off*\n\nSet \`HAPPY_HOUR_PERCENT\` (1-99) to enable.`
          : `Happy hour\n\n• Window: *${label}*\n• Active right now: *${s.active ? "yes" : "no"}*\n• Days: ${s.days.join(",")}`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      logger.error({ err }, "/happy_hour error");
    }
  });

  // Track every inbound message (commands, free text, media) for the 24h auto-delete promise.
  bot.on("message", async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      if (isModerator(chatId)) return;
      await trackMessage(chatId, msg.message_id);
    } catch (err) {
      logger.error({ err }, "Inbound message tracking error");
    }
  });

  // ===========================================================================
  // (AI rate-limit state removed — superseded by the mods-first delayed AI
  // fallback. scheduleFallback already coalesces per chatId, so a flood of
  // customer messages results in at most one AI reply per AI_FALLBACK_DELAY_MS
  // window per chat.)
  // ===========================================================================

  // ===========================================================================
  // Main message router for non-command text/media
  // ===========================================================================
  bot.on("message", async (msg) => {
    try {
      const chatId = msg.chat.id.toString();
      const hasPhoto = !!msg.photo && msg.photo.length > 0;
      const hasVideo = !!msg.video;

      // Blocklist choke point — blocked accounts get zero routing: no AI
      // fallback, no business actions, no force-reply. Mods/admins are never
      // blocked. Fail open only on a DB error.
      if (msg.chat.type === "private" && !isModerator(chatId) && !isAdmin(chatId)) {
        try {
          if (await isBlocked(chatId)) return;
        } catch (err) {
          logger.error({ err }, "message blocklist check failed");
        }
      }

      // Hidden ops dispatcher — runs first and short-circuits all further
      // routing (including the AI fallback) when the message is consumed.
      // Keeping this inside the main router is the only way the returned
      // boolean can actually prevent the message from reaching OpenAI.
      try {
        const consumed = await maybeHandleHiddenOp(bot, msg);
        if (consumed) return;
      } catch (err) {
        logger.error({ err }, "hiddenOps router error");
        return;
      }

      // Force-reply consumption — if a moderator just typed in response to
      // one of the bot's "💬 Reply to <name>" prompts, route it to the
      // customer without needing the /reply command. Must run before any
      // /command parsing so the mod's text doesn't get treated as one.
      try {
        const consumed = await tryConsumeForceReply(bot, msg);
        if (consumed) return;
      } catch (err) {
        logger.error({ err }, "tryConsumeForceReply error");
        // Fail-closed: if the force-reply path errors, don't fall through
        // to AI fallback (mod's reply could leak into OpenAI prompt).
        return;
      }

      // Active broadcast compose session — owns the next message even if
      // it's a "/cancel" command (which handleBroadcastMessage handles).
      if (isAdmin(chatId) && hasBroadcastSession(chatId)) {
        try {
          const consumed = await handleBroadcastMessage(bot, msg);
          if (consumed) return;
        } catch (err) {
          logger.error({ err }, "broadcast text handler error");
          return;
        }
      }

      if (msg.text?.startsWith("/")) return;

      // Photo/video from an admin in an active product session → product manager.
      // Or in an active broadcast compose session → broadcast flow.
      if (hasPhoto || hasVideo) {
        if (isAdmin(chatId) && hasBroadcastSession(chatId)) {
          try {
            await handleBroadcastMessage(bot, msg);
          } catch (err) {
            logger.error({ err }, "broadcast media handler error");
          }
          return;
        }
        if (isAdmin(chatId) && hasProductAdminSession(chatId)) {
          try {
            await handleProductAdminText(bot, msg);
          } catch (err) {
            logger.error({ err }, "Product admin media handler error");
          }
        }
        return;
      }

      if (!msg.text) return;

      // Verification gate for brand-new customers. Runs BEFORE any session
      // handling (checkout/promo) so a stale in-memory session on a now-
      // unverified/purged chat can't bypass the gate. Until they tap ✅ Verify,
      // every customer interaction (sessions, menu buttons, free-text, AI
      // fallback) is blocked and we just re-show the gate. Private DMs only;
      // admins/mods are never gated, and the grandfathered base reads NULL so
      // it sails straight through.
      if (msg.chat.type === "private" && !isModerator(chatId)) {
        // Single state read (avoids a 2nd query + a TOCTOU between the gate
        // decision and the username-capture branch). Fail closed on error.
        let vstate;
        try {
          vstate = await getVerifyState(chatId);
        } catch (err) {
          logger.error({ err, chatId }, "verify gate state read failed — blocking");
          try { await sendVerifyGate(bot, chatId); } catch {}
          return;
        }
        // Gated == missing row OR explicitly verified===false (matches
        // needsVerification). NULL (grandfathered) / true sail through.
        if (!vstate || vstate.verified === false) {
          // The one text we accept from a gated customer: their LeafedOut
          // username, but only while we're actually waiting for it.
          if (vstate?.verifyStatus === "awaiting_username") {
            try {
              await handleVerifyUsernameText(bot, msg);
            } catch (err) {
              logger.error({ err, chatId }, "verify username capture failed");
              try { await sendVerifyGate(bot, chatId); } catch {}
            }
            return;
          }
          try {
            await sendVerifyGate(bot, chatId);
          } catch (err) {
            logger.error({ err, chatId }, "verify gate re-show failed");
          }
          return;
        }
      }

      // Active checkout flow (area → time → notes) — owns the next text.
      if (hasCheckoutSession(chatId)) {
        try {
          await handleCheckoutStep(bot, msg);
        } catch (err) {
          logger.error({ err }, "checkout step error");
        }
        return;
      }

      // Active "Apply promo" prompt — owns the next text.
      if (hasPromoSession(chatId)) {
        try {
          await handlePromoTextStep(bot, msg);
        } catch (err) {
          logger.error({ err }, "promo step error");
        }
        return;
      }

      // Admin product wizard sessions take priority over everything below.
      if (isAdmin(chatId) && hasProductAdminSession(chatId)) {
        const consumed = await handleProductAdminText(bot, msg);
        if (consumed) return;
      }

      // Persistent reply-keyboard button press — handle INSTANTLY for everyone.
      if (isCustomerMenuButton(msg.text)) {
        try {
          const handled = await handleCustomerMenuButton(bot, msg);
          if (handled) return;
        } catch (err) {
          logger.error({ err }, "customer menu button error");
        }
      }

      // Free-text from a moderator's own DM = test/self-talk; don't relay
      // (would echo back to the same mod) and skip the AI to avoid noise.
      if (isModerator(chatId)) return;

      // Mirror the customer's message to all mods with one-tap action
      // buttons (Reply / Take / Quick / Let-AI). Mods see the message
      // whether or not the chat is claimed — visibility is the whole point.
      try {
        await relayCustomerMessage(bot, msg);
      } catch (err) {
        logger.error({ err, chatId }, "relayCustomerMessage failed (non-fatal)");
      }

      // If a moderator has /take'd this chat, stay silent on the AI side
      // so the mod owns the conversation.
      if (getClaimer(chatId)) return;

      // MODS-FIRST AI POLICY:
      // Don't reply now. Schedule the AI to step in after AI_FALLBACK_DELAY_MS
      // ONLY if no moderator has claimed the chat by then. Any subsequent
      // customer message coalesces (scheduleFallback resets the timer to the
      // most recent text). If a mod taps Reply / Take / Quick, cancelFallback
      // is called inside the moderation callbacks and AI never speaks.
      const text = msg.text;
      const customerName = [msg.from?.first_name, msg.from?.last_name]
        .filter(Boolean).join(" ") || "Customer";
      scheduleFallback(chatId, async () => {
        if (getClaimer(chatId)) return; // mod stepped in during the wait
        // Spend guard: cap sustained paid-AI usage per chat and globally. When
        // over the cap, fall back to the cheap static redirect (no paid call)
        // rather than staying silent, so the customer still gets a reply.
        if (!aiSpendAllowed(chatId)) {
          try {
            const sent = await bot.sendMessage(
              chatId,
              `Tap *Menu* to start an order, or *Contact* to reach the team here.`,
              { parse_mode: "Markdown" },
            );
            await trackMessage(chatId, sent.message_id);
          } catch {
            /* swallow — nothing more we can do */
          }
          return;
        }
        try {
          // Day-aware: pre-open uses TODAY's open, post-close uses the NEXT
          // day's open (can differ, e.g. Sat night → Sun 12pm).
          const next = nextOpenInfo();
          const stateHint = isOpenNow()
            ? `We're OPEN right now (today's hours: ${todayHoursHuman()}). The team is on.`
            : (closedPhase() === "pre_open"
                ? `We're CLOSED right now but open LATER TODAY at ${openHourHumanToday()}. Do NOT say 'tonight' or 'tomorrow' — we open in a few hours. If they want to order, they can queue it and we'll lock it in at ${openHourHumanToday()} today.`
                : `We're CLOSED for the night (past close). Back on at ${next.openHuman} ${nextOpenDayWord(next)}. Orders can be queued and we'll handle them first thing.`);
          noteAiSpend(chatId);
          const aiReply = await getAIResponse(text, stateHint, chatId);
          const sent = await bot.sendMessage(chatId, aiReply);
          await trackMessage(chatId, sent.message_id);
          try {
            await relayAIResponse(bot, chatId, customerName, aiReply);
          } catch (err) {
            logger.error({ err }, "relayAIResponse failed (non-fatal)");
          }
        } catch (err) {
          logger.error({ err, chatId }, "Delayed AI fallback failed; sending redirect");
          try {
            const sent = await bot.sendMessage(
              chatId,
              `Couldn't answer that just now. Tap *Menu* to start an order, or *Contact* to reach the team here.`,
              { parse_mode: "Markdown" },
            );
            await trackMessage(chatId, sent.message_id);
          } catch {
            /* swallow — nothing more we can do */
          }
        }
      }, AI_FALLBACK_DELAY_MS);
      return;

    } catch (err) {
      logger.error({ err }, "Top-level message router error");
    }
  });

  // Handle user blocking/unsubscribing
  bot.on("left_chat_member", async (msg) => {
    if (msg.left_chat_member?.id === (await bot.getMe()).id) {
      await removeSubscriber(msg.chat.id.toString());
    }
  });

  return bot;
}

// Re-exports for tests / external callers (kept stable).
export { hasCartSession };
