# Userbot Setup Playbook

The userbot is an MTProto session logged in **as a moderator's personal Telegram account**. It lets the bot world reach into a mod's personal inbox to fire the away-auto-reply when they're `/driving on`. Each mod needs their own session string. **Treat session strings like passwords** — anyone with one can act as that Telegram account.

## One-time prerequisites (operator)

1. Go to https://my.telegram.org → log in with your phone → **API development tools**.
2. Create an app (any name/short-name). Note the **api_id** (number) and **api_hash** (string).
3. Set them as Replit Secrets:
   - `TELEGRAM_API_ID` = the number
   - `TELEGRAM_API_HASH` = the string

## Per-moderator login (do this with the moderator present)

The mod must be sitting next to you with their phone unlocked, since Telegram will text a login code to them.

1. From the workspace root, run:
   ```bash
   pnpm --filter @workspace/api-server run userbot:login
   ```
2. Enter the moderator's phone (with country code, e.g. `+614xxxxxxxx`).
3. Telegram will text a login code to that phone. Get the code from the mod and paste it.
4. If the mod has 2FA on their account, enter that password too. (Otherwise leave blank.)
5. The script prints:
   - The mod's Telegram user id — this should match the chat id you have for them in `MODERATOR_CHAT_IDS`.
   - A long session string starting with `1A...`.
6. Add a secret:
   - **Name**: `USERBOT_SESSION_<chatId>` (e.g. `USERBOT_SESSION_1234567890`)
   - **Value**: the session string (paste it whole)
7. Restart the api-server. You should see `Userbot connected` in the logs for that chatId.

## Verifying it works

1. Have the moderator run `/driving on` in the bot.
2. From a non-mod test account, DM the mod's personal account directly.
3. The mod's account should send back the away-message within a second or two.
4. Send another DM from the same test account immediately — you should NOT get a second auto-reply (1hr per-customer debounce).
5. Have the moderator run `/driving off`. New DMs should no longer get an auto-reply.

## Revoking a session

If a session string leaks, the mod opens Telegram → **Settings → Devices** and terminates the userbot session. After that, the env var should be removed and a fresh `userbot:login` run.

## Caveats

- **Telegram ToS**: userbots are technically against the ToS for some account types. Telegram rarely enforces this on low-volume accounts answering their own DMs, but it's a risk you're taking on consciously.
- **AUTH_KEY_DUPLICATED**: if two processes share a session string, Telegram revokes it. The userbot is gated on the same polling flag as the bot — it only runs in the prod process by default. Don't set `BOT_POLLING_ENABLED=true` in dev while prod is live.
- **Bundling**: the `telegram` and `input` npm packages are externalized in `build.mjs` (gramjs is too gnarly to bundle). They must be in `node_modules` at runtime.
- **In-memory debounce**: the 1hr-per-customer cooldown resets on restart. Worst case a customer gets one extra auto-reply right after a deploy.
