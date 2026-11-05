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

/** Team Vault / age private identities (Bech32, upper case); a truncated one is masked too. */
const AGE_SECRET_KEY = /AGE-SECRET-KEY-1[A-Z0-9]*/gi;

/** Signature, credential and session-token parameters of a presigned S3 URL. */
const PRESIGNED_URL_PARAM = /\b(X-Amz-(?:Signature|Credential|Security-Token))=[^&\s"'<>]+/gi;

/**
 * Only this much input is scanned. A few times MAX_STRING_LENGTH, so a secret that starts in the kept
 * text still ends inside the scanned text, but small: the URL and KEY=value patterns are quadratic on
 * input such as "a.a.a." (200 000 characters took 15 s, on the main process).
 */
const MAX_SCAN_LENGTH = 4 * MAX_STRING_LENGTH;

export function redactString(input: string): string {
  // Mask before truncating: cutting first can split a secret (a URL password before its "@", a key
  // header) so that no pattern matches the remainder.
  const cut = input.length > MAX_SCAN_LENGTH;
  let out = cut ? input.slice(0, MAX_SCAN_LENGTH) : input;
  out = out.replace(AGE_SECRET_KEY, REDACTED);
  out = out.replace(PRESIGNED_URL_PARAM, `$1=${REDACTED}`);
  out = out.replace(SECRET_PATTERNS[0], REDACTED);
  out = out.replace(SECRET_PATTERNS[1], REDACTED);
  out = out.replace(SECRET_PATTERNS[2], `$1=${REDACTED}`);
  out = out.replace(SECRET_PATTERNS[3], `Bearer ${REDACTED}`);
  out = out.replace(SECRET_PATTERNS[4], `$1${REDACTED}@`);
  out = out.replace(SECRET_PATTERNS[5], `$1=${REDACTED}`);
  if (cut || out.length > MAX_STRING_LENGTH) out = `${out.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
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
