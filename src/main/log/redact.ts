/**
 * Fail-closed masking for everything that reaches the log. Applied to the
 * message and to every context value before anything is written, so a call
 * site that forgets to scrub still cannot leak a PIN, passphrase or key.
 */

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 2000;

/** Key names whose values are never logged, matched case-insensitively as substrings. */
const SENSITIVE_KEY = /pass(word|phrase|wd)?|secret|token|private[-_]?key|credential|authorization|cookie|api[-_]?key/i;

/** `pin` as a word (pin, fido2Pin, card_pin) but not inside e.g. "mapping" or "spinner". */
const PIN_KEY = /(^|[^a-zA-Z])pin($|[^a-z])|[a-z0-9]Pin($|[^a-z])/;

const SECRET_PATTERNS: RegExp[] = [
  // PEM / OpenSSH private key blocks
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // AWS access key ids and long base64 secrets assigned to well-known names
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(aws_secret_access_key|aws_session_token)\s*[=:]\s*\S+/gi,
  // Authorization headers and bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // user:password@host in URLs
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi,
  // KEY=value style assignments for sensitive names (env dumps, command lines)
  /\b([a-z0-9_]*(?:password|passphrase|passwd|secret|token)[a-z0-9_]*|pin)\s*[=:]\s*\S+/gi,
];

export function redactString(input: string): string {
  return maskSecrets(input.length > MAX_STRING_LENGTH ? `${input.slice(0, MAX_STRING_LENGTH)}…[truncated]` : input);
}

/** Masks the secret patterns in `input` without truncating it (also used for text sent to the AI assistant). */
export function maskSecrets(input: string): string {
  let out = input;
  out = out.replace(SECRET_PATTERNS[0], REDACTED);
  out = out.replace(SECRET_PATTERNS[1], REDACTED);
  out = out.replace(SECRET_PATTERNS[2], `$1=${REDACTED}`);
  out = out.replace(SECRET_PATTERNS[3], `Bearer ${REDACTED}`);
  out = out.replace(SECRET_PATTERNS[4], `$1${REDACTED}@`);
  out = out.replace(SECRET_PATTERNS[5], `$1=${REDACTED}`);
  return out;
}

/** Returns a JSON-safe, masked copy of `value`; values that cannot be represented are dropped. */
export function redactValue(value: unknown, key?: string, depth = 0, seen = new WeakSet<object>()): unknown {
  if (key !== undefined && (SENSITIVE_KEY.test(key) || PIN_KEY.test(key))) return REDACTED;
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined; // functions, symbols
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, undefined, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const masked = redactValue(v, k, depth + 1, seen);
    if (masked !== undefined) out[k] = masked;
  }
  return out;
}
