// Telegram Markdown V1 escape — covers the active formatters: _ * ` [ ] and ( ) for links,
// plus backslash to prevent escape-char hijacking.
// We only escape user-supplied text embedded into a parse_mode="Markdown" message.
export function escapeMarkdown(input: string | undefined | null): string {
  if (!input) return "";
  return String(input).replace(/([\\_*`\[\]()])/g, "\\$1");
}

// Strip control chars & trim. Returns "" if effectively empty.
export function cleanInput(input: string | undefined | null): string {
  if (!input) return "";
  // eslint-disable-next-line no-control-regex
  return String(input).replace(/[\x00-\x1F\x7F]/g, "").trim();
}
