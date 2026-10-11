/**
 * Fail-closed masking for everything that reaches the log. Applied to the
 * message and to every context value before anything is written, so a call
 * site that forgets to scrub still cannot leak a PIN, passphrase or key.
 */

import { REDACTED, maskSecrets } from '../../shared/secretMasking';

const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 2000;
/** Upper bound for the text handed to the masker, so one enormous log argument cannot stall the main process. */
const MAX_MASK_INPUT = 1024 * 1024;

/** Key names whose values are never logged, matched case-insensitively as substrings. */
const SENSITIVE_KEY = /pass(word|phrase|wd)?|secret|token|private[-_]?key|credential|authorization|cookie|api[-_]?key/i;

/** `pin` as a word (pin, fido2Pin, card_pin) but not inside e.g. "mapping" or "spinner". */
const PIN_KEY = /(^|[^a-zA-Z])pin($|[^a-z])|[a-z0-9]Pin($|[^a-z])/;

export function redactString(input: string): string {
  // Mask first, then clip: clipping first can cut a private key in the middle and leave the tail of its
  // last line next to the marker, where it no longer looks like key material.
  const masked = maskSecrets(input.length > MAX_MASK_INPUT ? input.slice(0, MAX_MASK_INPUT) : input);
  return masked.length > MAX_STRING_LENGTH ? `${masked.slice(0, MAX_STRING_LENGTH)}…[truncated]` : masked;
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
