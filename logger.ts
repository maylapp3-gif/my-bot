import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

// Telegram bot tokens look like `<digits>:<base64-like>` and may also appear
// URL-encoded as `<digits>%3A<base64-like>`. Redact both forms anywhere they
// appear in serialized log payloads (URLs, stacks, messages, etc.).
const TOKEN_RE = /bot\d+(?::|%3A)[A-Za-z0-9_-]{20,}/gi;

// Forensic-minimization: never write raw customer identity into persistent
// logs. When a Telegram error object is serialized, its `response.body`
// often echoes the full inbound update (first_name, username, etc). We
// recursively redact any key whose name matches this set, regardless of
// depth. Keys are matched case-insensitively. Chat IDs are kept — they're
// the unit of correlation we DO want in logs.
//
// Identity-only on purpose: keys like `text`, `body`, and `caption` are
// deliberately NOT in this list because they collide with our own internal
// fields (inline-button labels, internal request wrappers, etc.) and would
// turn every keyboard debug log into "[REDACTED_PII]". Message bodies that
// might leak through stringified Telegram payloads are an accepted residual.
const PII_KEYS = new Set([
  "first_name",
  "last_name",
  "firstname",
  "lastname",
  "username",
  "phone_number",
  "phonenumber",
  "delivery_area",
  "deliveryarea",
  "notes",
]);

function scrubTokensDeep(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return value.replace(TOKEN_RE, "[REDACTED]");
  if (Array.isArray(value)) return value.map((v) => scrubTokensDeep(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k.toLowerCase())) {
        out[k] = "[REDACTED_PII]";
      } else {
        out[k] = scrubTokensDeep(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

const baseErrSerializer = pino.stdSerializers.err;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  serializers: {
    err: (err: unknown) => scrubTokensDeep(baseErrSerializer(err as Error)),
  },
  formatters: {
    log: (obj) => scrubTokensDeep(obj) as Record<string, unknown>,
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
