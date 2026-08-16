// Central config for moderator-facing constants.
// MOD_HANDLE is the Telegram @username customers are told to DM directly
// for any non-order chat. The userbot logs in as this same account so it
// can auto-reply when the moderator is in /driving mode.
export const MOD_HANDLE = (process.env.MOD_HANDLE || "YourModHandle").replace(/^@/, "");
export const MOD_HANDLE_LINK = `@${MOD_HANDLE}`;

// The bot's @username, used inside the userbot's away auto-reply so the
// customer can be redirected to the bot for self-serve ordering.
export const BOT_USERNAME = (process.env.BOT_USERNAME || "YourBotUsername").replace(/^@/, "");
export const BOT_LINK = `@${BOT_USERNAME}`;
