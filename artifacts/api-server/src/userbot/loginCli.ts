// CLI to log a moderator's personal Telegram account into the userbot once
// and print a session string to copy into a secret named
// USERBOT_SESSION_<chatId>.
//
// Run from the workspace root:
//   pnpm --filter @workspace/api-server run userbot:login
//
// Prereqs:
//   - TELEGRAM_API_ID and TELEGRAM_API_HASH in your env (get from
//     https://my.telegram.org → API development tools).
//   - The moderator's phone (with country code) and Telegram-texted login
//     code, plus 2FA password if they have one set.
//
// Treat the printed session string like a password. Anyone with it can act
// as that Telegram account.
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiIdRaw || !apiHash) {
    console.error(
      "Missing TELEGRAM_API_ID and/or TELEGRAM_API_HASH.\n\n" +
        "Get them from https://my.telegram.org → API development tools, then\n" +
        "set them as secrets and re-run this command.",
    );
    process.exit(1);
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isFinite(apiId)) {
    console.error(`TELEGRAM_API_ID must be a number, got: ${apiIdRaw}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = (q: string) => rl.question(q);

  console.log("Userbot login — paste the prompts as Telegram asks for them.\n");

  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => (await ask("Phone (e.g. +614xxxxxxxx): ")).trim(),
    password: async () =>
      (await ask("2FA password (leave blank if none): ")).trim(),
    phoneCode: async () => (await ask("Login code Telegram just texted you: ")).trim(),
    onError: (err) => {
      console.error("Login error:", err);
    },
  });

  const me = (await client.getMe()) as {
    id?: { toString?: () => string };
    username?: string;
    firstName?: string;
  };
  const userId = me?.id?.toString?.() ?? "<unknown>";
  const handle = me?.username ?? me?.firstName ?? "<unknown>";

  const sessionString = stringSession.save();
  const secretName = `USERBOT_SESSION_${userId}`;
  const outFile = resolve(process.cwd(), `userbot-session-${userId}.txt`);
  writeFileSync(outFile, sessionString, { mode: 0o600 });

  console.log(`\n✓ Logged in as @${handle} (Telegram user id: ${userId})\n`);
  console.log("───────────────────────────────────────────────────────");
  console.log("NEXT STEPS (mobile-friendly — no Shell copy needed):");
  console.log("───────────────────────────────────────────────────────");
  console.log(`1. Open the file panel on the left and find:`);
  console.log(`     userbot-session-${userId}.txt`);
  console.log(`2. Tap it to open. Long-press inside, Select All, Copy.`);
  console.log(`3. Open Replit Secrets (lock icon).`);
  console.log(`4. Add a new secret:`);
  console.log(`     Name:  ${secretName}`);
  console.log(`     Value: <paste what you copied>`);
  console.log(`5. DELETE the file (right-click → Delete) — it's a password.`);
  console.log(`6. Restart the api-server workflow.`);
  console.log("───────────────────────────────────────────────────────\n");
  console.log(`File written to: ${outFile}\n`);
  console.log(
    "Treat that string like a password — anyone with it can act as this account.",
  );

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
