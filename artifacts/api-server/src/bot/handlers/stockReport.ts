import TelegramBot from "node-telegram-bot-api";
import { logger } from "../../lib/logger.js";
import { getAllProductsOrdered, getProductVariants } from "../db.js";
import { escapeMarkdown } from "../escape.js";
import { isAdmin } from "./admin.js";

const STATE_DOT: Record<string, string> = {
  in_stock: "🟢",
  low: "🟡",
  sold_out: "🔴",
};

const STATE_LABEL: Record<string, string> = {
  in_stock: "in stock",
  low: "low",
  sold_out: "sold out",
};

// Build the full per-variant snapshot. Includes hidden products (admin only)
// so the admin can see EVERYTHING — there is zero customer surface to this.
export async function buildStockReport(): Promise<string> {
  const products = await getAllProductsOrdered();
  if (products.length === 0) return "📦 *Stock report*\n\nNo products in the catalogue.";

  let inStock = 0;
  let low = 0;
  let soldOut = 0;
  const sections: string[] = [];

  for (const p of products) {
    const vs = await getProductVariants(p.id).catch(() => [] as Awaited<ReturnType<typeof getProductVariants>>);
    const hiddenTag = p.available ? "" : " _(hidden)_";
    const preorderTag = p.preorder ? " 🕒" : "";
    if (vs.length === 0) {
      sections.push(`${p.emoji ?? "🌿"} *${escapeMarkdown(p.name)}*${preorderTag}${hiddenTag}\n   _no sizes set_`);
      continue;
    }
    const lines = vs.map((v) => {
      const dot = STATE_DOT[v.stock] ?? "•";
      if (v.stock === "in_stock") inStock += 1;
      else if (v.stock === "low") low += 1;
      else soldOut += 1;
      return `   ${dot} ${escapeMarkdown(v.label)}  \`#${v.id}\``;
    });
    sections.push(`${p.emoji ?? "🌿"} *${escapeMarkdown(p.name)}*${preorderTag}${hiddenTag}\n${lines.join("\n")}`);
  }

  const tally = `${inStock} in stock · ${low} low · ${soldOut} sold out`;
  const header =
    `📦 *Stock report*\n` +
    `_${tally}_`;
  const footer =
    `_To change a size: \`/stock <id> in_stock | low | sold_out\`\n` +
    `For a quick all-sizes flip per strain: \`/stockcheck\`_`;

  return [header, ...sections, footer].join("\n\n");
}

export async function handleStockReport(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id.toString();
  if (!isAdmin(chatId)) return;
  try {
    const text = await buildStockReport();
    // Chunk on line boundaries to stay under Telegram's 4096-char cap.
    const chunks: string[] = [];
    let current = "";
    for (const line of text.split("\n")) {
      if (current.length + line.length + 1 > 3500) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current) chunks.push(current);
    for (const c of chunks) {
      await bot.sendMessage(chatId, c, { parse_mode: "Markdown" });
    }
  } catch (err) {
    logger.error({ err }, "/stock_report failed");
    await bot.sendMessage(chatId, "Couldn't build the stock report — check logs.");
  }
}

// Reused by EOD: flagged-only summary (low + sold out) suitable to append to
// the daily report. Always returns something — even on a clean day — so the
// admin sees a one-line confirmation that stock state was checked.
// Grouped by product so the eye scans it in one pass.
export async function buildFlaggedStockSection(): Promise<string> {
  const products = await getAllProductsOrdered();
  type Flag = { variant: string; variantId: number; state: string };
  const grouped: { product: string; emoji: string; flags: Flag[] }[] = [];
  let total = 0;
  for (const p of products) {
    const vs = await getProductVariants(p.id).catch(() => [] as Awaited<ReturnType<typeof getProductVariants>>);
    const flags: Flag[] = [];
    for (const v of vs) {
      if (v.stock === "in_stock") continue;
      flags.push({ variant: v.label, variantId: v.id, state: v.stock });
    }
    if (flags.length > 0) {
      grouped.push({ product: p.name, emoji: p.emoji ?? "🌿", flags });
      total += flags.length;
    }
  }
  if (total === 0) {
    return `📦 *Stock* — ✓ all sizes in stock`;
  }
  const sections = grouped.map((g) => {
    const lines = g.flags.map((f) => {
      const dot = STATE_DOT[f.state] ?? "•";
      return `   ${dot} ${escapeMarkdown(f.variant)}  \`#${f.variantId}\``;
    });
    return `${g.emoji} *${escapeMarkdown(g.product)}*\n${lines.join("\n")}`;
  });
  return (
    `📦 *Stock needing action* — ${total} size${total === 1 ? "" : "s"}\n\n` +
    `${sections.join("\n\n")}\n\n` +
    `_Full snapshot: \`/stock_report\`_`
  );
}
