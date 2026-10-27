/**
 * Wire-level challenge overrides (U29-1, ADR-032). Pure helpers shared by the schema's lint
 * and the adversary: the encoding grammar and an RFC 7396 JSON merge patch.
 */

export const WIRE_ENCODING_KINDS = [
  "standard",
  "url_safe",
  "unpadded",
  "invalid_json",
  "raw",
  "raw_json",
] as const;
export type WireEncodingKind = (typeof WIRE_ENCODING_KINDS)[number];

export const WIRE_RAW_PREFIX = "raw:";
/** `raw_json:<json>`: the (rendered) JSON text is base64-encoded verbatim, so its text and
 * whitespace are preserved and templates (canaries) work inside it. */
export const WIRE_RAW_JSON_PREFIX = "raw_json:";

/** True for `standard`, `url_safe`, `unpadded`, `invalid_json` or `raw:<anything>`. */
export function isWireEncoding(value: string): boolean {
  return (
    value === "standard" ||
    value === "url_safe" ||
    value === "unpadded" ||
    value === "invalid_json" ||
    value.startsWith(WIRE_RAW_PREFIX) ||
    value.startsWith(WIRE_RAW_JSON_PREFIX)
  );
}

/** A `raw:` value is served verbatim, and an HTTP stack trims leading and trailing spaces
 * and tabs, so those are refused rather than silently trimmed. */
export function wireEncodingProblem(value: string): string | null {
  if (value.startsWith(WIRE_RAW_PREFIX)) {
    const raw = value.slice(WIRE_RAW_PREFIX.length);
    if (/^[ \t]|[ \t]$/.test(raw)) {
      return "a raw: header must not start or end with a space or tab (it would not be served verbatim)";
    }
  }
  return null;
}

/**
 * The JSON text inside a base64 or base64url string, when it decodes to JSON; else null.
 * Lint uses it to see through a `raw:` header.
 */
export function decodeBase64Json(value: string): string | null {
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(value)) return null;
  try {
    const text = Buffer.from(value, "base64").toString("utf8");
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

/** The kind of an encoding string (`raw:<s>` -> `raw`). The raw string itself is never
 * recorded in the ledger, only the kind. */
export function wireEncodingKind(value: string): WireEncodingKind {
  if (value.startsWith(WIRE_RAW_JSON_PREFIX)) return "raw_json";
  return value.startsWith(WIRE_RAW_PREFIX) ? "raw" : (value as WireEncodingKind);
}

/** A header value must be sendable: no control characters (tab excepted) and nothing above
 * latin-1. */
export function headerValueProblem(value: string): string | null {
  if (/^[ \t]|[ \t]$/.test(value)) return "starts or ends with a space or tab";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return "contains a control character";
    if (code > 0xff) return "contains a character above latin-1";
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * RFC 7396 JSON merge patch. A non-object patch replaces the target; in an object patch a
 * `null` member deletes the key, an object member merges recursively, and anything else
 * (arrays included) replaces. The target is not mutated.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = {};
  if (isPlainObject(target)) {
    for (const [k, v] of Object.entries(target)) setOwn(result, k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete result[k];
    else setOwn(result, k, applyMergePatch(result[k], v));
  }
  return result;
}

/**
 * U30-4 (ADR-032 #5): where an MCP tool route places its `PaymentRequired`. Tool routes only,
 * generated corpora only. A value is a mode name, or `<mode>:<argument>` for the modes that
 * take one (`structured_raw` and `text_raw`: the literal; `jsonrpc*`: the error code).
 */
export const WIRE_CHANNEL_MODES = [
  "both",
  "structured_only",
  "text_only",
  "text_differs",
  "structured_differs",
  "text_second",
  "structured_raw",
  "text_raw",
  "jsonrpc",
  "jsonrpc_ns",
  "jsonrpc_elicit",
  "not_error",
] as const;
export type WireChannelMode = (typeof WIRE_CHANNEL_MODES)[number];

export interface ParsedChannels {
  mode: WireChannelMode;
  /** The text after the first colon: a literal for `*_raw`, the error code for `jsonrpc*`. */
  arg?: string;
}

const CHANNEL_NO_ARG: ReadonlySet<string> = new Set([
  "both",
  "structured_only",
  "text_only",
  "text_differs",
  "structured_differs",
  "text_second",
  "not_error",
]);
const CHANNEL_RAW: ReadonlySet<string> = new Set(["structured_raw", "text_raw"]);
const CHANNEL_CODE: ReadonlySet<string> = new Set(["jsonrpc", "jsonrpc_ns", "jsonrpc_elicit"]);
const CHANNEL_CODE_RE = /^-?[0-9]{1,10}$/;

/** The mode and argument of a `wire.channels` value, or null when it is not a valid one. */
export function parseWireChannels(value: string): ParsedChannels | null {
  if (CHANNEL_NO_ARG.has(value)) return { mode: value as WireChannelMode };
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const mode = value.slice(0, at);
  const arg = value.slice(at + 1);
  if (CHANNEL_RAW.has(mode)) return { mode: mode as WireChannelMode, arg };
  if (CHANNEL_CODE.has(mode) && CHANNEL_CODE_RE.test(arg)) {
    return { mode: mode as WireChannelMode, arg };
  }
  return null;
}

/** The literal text of a `structured_raw:` or `text_raw:` value (templates not yet rendered). */
export function wireChannelsLiteral(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = parseWireChannels(value);
  return parsed !== null && CHANNEL_RAW.has(parsed.mode) ? (parsed.arg ?? "") : null;
}

/** True when `wire.channels` places the object in both channels unchanged (absent or `both`). */
export function isBothChannels(value: string | undefined): boolean {
  return value === undefined || value === "both";
}
