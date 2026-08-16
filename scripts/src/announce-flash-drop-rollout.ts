// One-shot announcement: brief moderators on the new Flash Drop +
// stock-integration behavior. Sends a single plain-text message to
// every configured admin + moderator via the Telegram Bot HTTP API.
//
// Run once with:
//   pnpm --filter @workspace/scripts run announce:flashdrop
//
// Plain text only — no Markdown parse_mode — so stray characters in
// the body can never bounce delivery.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

function parseIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s));
}

const adminIds = parseIds(process.env.ADMIN_CHAT_IDS);
const modIds = parseIds(process.env.MODERATOR_CHAT_IDS);
const recipients = Array.from(new Set([...adminIds, ...modIds]));

if (recipients.length === 0) {
  console.error("No ADMIN_CHAT_IDS or MODERATOR_CHAT_IDS configured");
  process.exit(1);
}

const body = [
  "📣 Team update — Flash Drops + stock changes",
  "",
  "Two new things to know:",
  "",
  "1) FLASH DROPS",
  "Admin can fire a limited-stock blast to every subscriber with one command:",
  "",
  "  /drop <variantId> <qty> [copy...]",
  "",
  "Look up variantId in /stock_report. Reply to a photo with the command to attach an image.",
  "",
  "Example: /drop 42 5 fresh GMO just landed, FCFS",
  "",
  "Subscribers get a card with a single 🟢 Grab one button. Tapping = atomic stock claim (no oversell — two taps on the last unit cannot both win) + the customer is dropped straight into Delivery/Pickup checkout.",
  "",
  "What you (mods) will see:",
  "• A MOD PREVIEW of the broadcast (same photo + copy customers see, no Grab button on your copy).",
  "• A live ping on every grab: \"🟢 @user grabbed 1× X — N left (drop #ID)\".",
  "• A SOLD OUT ping when it hits zero.",
  "",
  "Admin extras:",
  "  /drops            — list active drops + remaining qty",
  "  /drop_cancel <id> — pull a drop early, strips buttons from broadcasts",
  "",
  "2) STOCK NOW AUTO-UPDATES ON DROP SELL-THROUGH",
  "When a drop hits zero, the variant flips to SOLD OUT automatically. You'll get the same 📦 Stock update card as a normal stock change, tagged \"via flash drop sell-through\". The Menu hides it from new customers immediately — no manual /stock call needed from you.",
  "",
  "3) ONE-TAP REORDER",
  "Every confirmed order now carries a 🔁 Same again button for the customer. Tap = their last order is rebuilt into the cart, ready to send. Expect more repeat orders coming in with little or no chat.",
  "",
  "No change to the rest of the workflow — your stock-check pings, /stock CLI, claims, and DM handover all work exactly as before.",
].join("\n");

let sent = 0;
let failed = 0;
for (const id of recipients) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: id, text: body, disable_web_page_preview: true }),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      failed++;
      console.error(`✗ ${id}: ${json.description}`);
    } else {
      sent++;
      console.log(`✓ ${id}`);
    }
  } catch (err) {
    failed++;
    console.error(`✗ ${id}:`, err);
  }
}

console.log(`\nDone. ${sent} sent, ${failed} failed.`);
