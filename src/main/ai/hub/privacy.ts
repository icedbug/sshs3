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
    .replace(/-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/g, "[private key redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|rk_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,})\b/g,
      "[redacted]",
    )
    // A JSON Web Token: three base64url parts, the first two starting with {"…
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
    // kubeconfig keys and certificates' private halves, and a docker config's auth.
    .replace(/\b((?:client-key|token)-data:\s*)\S+/g, "$1[redacted]")
    .replace(/("auth"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    // A password given as a flag: --password x, --password=x, mysql -pSECRET.
    .replace(/(--pass(?:word)?[= ])(?!\$\(|`)[^\s;&|]+/gi, "$1[redacted]")
    .replace(/\b((?:mysql|mysqldump|mariadb|mysqladmin)\b[^\n;&|]*?\s-p)(?!\s)[^\s;&|]+/g, "$1[redacted]")
    // The runs before `://` and around the keyword are bounded: unbounded, each
    // start position scans to the end of a long unbroken run (base64, a hex
    // dump, minified JSON) and masking 30,000 such characters takes a second.
    // The password in a URL, up to the last @ before the host (a password may hold @ and /).
    .replace(
      /([a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,255}:)[^\s]*@(?=[^\s@/]+(?:[/:?#\s]|$))/gi,
      "$1[redacted]@",
    )
    .replace(
      /(["']?[\w-]{0,40}(?:password|passphrase|passwd|secret|token|api[_-]?key|credential|_pass|_pwd|^pwd|\bpwd)[\w-]{0,40}["']?\s*[:=]\s*)(?:"(?![^"\r\n]*(?:\$\(|`))[^"\r\n]*"|'[^'\r\n]*'|(?!\$\(|`)[^\s,;&|<>()`"']+)/gi,
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

/**
 * Every string inside a value, masked; the shape left as it was. For what
 * leaves this computer as structured data (the team bucket, a runtime's tool
 * results), where masking the JSON text itself could break its quoting.
 */
export function maskStrings<T>(value: T): T {
  if (typeof value === "string") return maskContext(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskStrings(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskStrings(v);
    return out as T;
  }
  return value;
}

/**
 * Terminal output with its secrets masked, as a terminal shows it. Masking
 * the raw stream misses a secret that colour codes cut into pieces (jq,
 * kubectl and yq colour a key, its colon and its value separately). So the
 * visible text is checked: if it holds no secret, the output is kept with
 * its colours; if it does, the visible text is kept, masked, and the colours
 * of that piece are given up.
 */
export function maskTerminalOutput(raw: string): string {
  const visible = stripVTControlCharacters(raw);
  const masked = maskSecrets(visible);
  return masked === visible ? maskSecrets(raw) : masked;
}
