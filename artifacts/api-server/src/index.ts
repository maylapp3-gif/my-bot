import type TelegramBot from "node-telegram-bot-api";
import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index";
import { startAllUserbots } from "./userbot/index";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Start Telegram bot
let bot: TelegramBot | null = null;
try {
  bot = startBot();
  logger.info("Telegram bot initialized");
} catch (err) {
  logger.error({ err }, "Failed to start Telegram bot");
}

// Start userbot listeners (one per moderator personal account, gated on
// the same polling flag as the bot — both processes can't share a session).
// The bot instance is threaded in so a userbot can privately alert its own
// moderator (through the bot) when a suspicious stranger DMs their personal
// account.
if (bot) {
  startAllUserbots(bot).catch((err) => {
    logger.error({ err }, "Failed to start userbot listeners");
  });
} else {
  logger.warn(
    "Bot polling disabled in this process — skipping userbot listeners too (would race the prod session)",
  );
}
