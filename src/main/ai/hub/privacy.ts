import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";

/** Mask BEFORE clipping. Call on complete records, not individual transport chunks. */
export function maskContext(value: string): string {
  return maskSecrets(stripVTControlCharacters(value));
}

/**
 * The secrets in a text, masked, and everything else left exactly as it was —
 * including the control codes a terminal draws with. For a recording that has
 * to replay as it looked, which `maskContext` (which strips them) cannot give.
 */
export function maskSecrets(value: string): string {
  return value
    // A whole key, BEGIN to END; a key cut off before its END is masked as far as
    // its base64 lines go, and no further, so what follows it is still shown.
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[private key redacted]")
    // eslint-disable-next-line security/detect-unsafe-regex -- each repetition starts at a newline, so it cannot backtrack across lines
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\r?\n[A-Za-z0-9+/=]{8,})*/g, "[private key redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g,
      "[redacted]",
    )
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    // The runs before `://` and around the keyword are bounded: unbounded, each
    // start position scans to the end of a long unbroken run (base64, a hex
    // dump, minified JSON) and masking 30,000 such characters takes a second.
    .replace(
      /([a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,255}:)[^\s/@]+@/gi,
      "$1[redacted]@",
    )
    .replace(
      /(["']?[\w-]{0,40}(?:password|passphrase|passwd|secret|token|api[_-]?key|credential)[\w-]{0,40}["']?\s*[:=]\s*)(?:"(?![^"\r\n]*(?:\$\(|`))[^"\r\n]*"|'[^'\r\n]*'|(?!\$\(|`)[^\s,;&|<>()`"']+)/gi,
      "$1[redacted]",
    );
}

export function boundedContext(value: string, max = 32_000): string {
  const clean = maskContext(value);
  return clean.length > max
    ? `[earlier output omitted]\n${clean.slice(-max)}`
    : clean;
}

/**
 * A text that is read from its start (a title, a line, a page): masked, and
 * cut at the end when too long. `boundedContext` keeps the end, which is right
 * for output and wrong for these.
 */
export function clip(value: string, max: number): string {
  const clean = maskContext(value);
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…` : clean;
}

export function safeError(error: unknown): string {
  return boundedContext(
    error instanceof Error ? error.message : String(error),
    2000,
  );
}

/** sha256 of an exact text: to match what was approved against what runs without keeping the text. */
export const exactHash = (value: string): string => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/**
 * A command (or check, or rollback) as a person is asked to approve it:
 * masked, and never cut. Too long to show in full means it is refused, not
 * shortened: a person cannot approve what they are not shown. `hidden` says
 * that the shown text is not exactly the text that will run, because secrets
 * in it were masked.
 */
export function forApproval(raw: string, max: number, what: string): { text: string; hidden: boolean } {
  const text = maskContext(raw);
  if (text.length > max)
    throw new Error(
      `The ${what} is too long to be shown in full for approval (${text.length} characters, at most ${max}). Make it shorter, or put it in a script on the server and run that.`,
    );
  return { text, hidden: text !== raw };
}
