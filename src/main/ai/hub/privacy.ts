import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { AiPiiScrubbingMode } from "../../../shared/types/ai";

export type PiiScrubMode = AiPiiScrubbingMode;

export interface MaskContextOptions {
  piiMode?: PiiScrubMode;
  highEntropy?: boolean;
}

export interface UntrustedTextInspection {
  text: string;
  strippedCount: number;
  strippedCategories: string[];
}

export interface HighEntropyMatch {
  token: string;
  entropy: number;
  index: number;
}

export interface HighEntropyOptions {
  minLength?: number;
  minEntropy?: number;
  maxMatches?: number;
  maxScanChars?: number;
}

const DEFAULT_HIGH_ENTROPY_SCAN_CHARS = 64_000;
const DEFAULT_HIGH_ENTROPY_MIN_LENGTH = 24;
const DEFAULT_HIGH_ENTROPY_THRESHOLD = 4.3;
const DEFAULT_HIGH_ENTROPY_MAX_MATCHES = 50;

const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/**
 * Strips invisible Unicode smuggling characters (Unicode Tags U+E0000-U+E007F,
 * bidirectional overrides/isolates U+202A-U+202E and U+2066-U+2069, and
 * zero-width obfuscators/BOM U+200B-U+200D and U+FEFF) while preserving
 * ordinary European/Swedish UTF-8 text and ZWJ-joined emoji sequences.
 */
export function inspectUntrustedText(value: string): UntrustedTextInspection {
  if (!value) {
    return { text: value, strippedCount: 0, strippedCategories: [] };
  }
  let strippedCount = 0;
  const categories = new Set<string>();
  const chars = Array.from(value);
  const out: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0) ?? 0;

    if (cp >= 0xe0000 && cp <= 0xe007f) {
      strippedCount++;
      categories.add("unicode-tags");
      continue;
    }
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
      strippedCount++;
      categories.add("bidi-override");
      continue;
    }
    if (cp === 0x200d) {
      const prev = i > 0 ? chars[i - 1] : "";
      const next = i + 1 < chars.length ? chars[i + 1] : "";
      if (
        prev &&
        next &&
        EXTENDED_PICTOGRAPHIC_RE.test(prev) &&
        EXTENDED_PICTOGRAPHIC_RE.test(next)
      ) {
        out.push(ch);
        continue;
      }
      strippedCount++;
      categories.add("zero-width");
      continue;
    }
    if (cp === 0x200b || cp === 0x200c) {
      strippedCount++;
      categories.add("zero-width");
      continue;
    }
    if (cp === 0xfeff) {
      strippedCount++;
      categories.add("bom");
      continue;
    }
    out.push(ch);
  }

  return {
    text: strippedCount === 0 ? value : out.join(""),
    strippedCount,
    strippedCategories: [...categories],
  };
}

export function stripInvisibleUnicode(value: string): string {
  return inspectUntrustedText(value).text;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(token: string): number {
  if (!token) return 0;
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  const len = token.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const HEX_CHECKSUM_RE = /^[0-9a-fA-F]{32,128}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CANDIDATE_SECRET_RE = /[A-Za-z0-9+/_-]{20,512}={0,2}/g;

function looksLikePathOrUrl(text: string, index: number, len: number): boolean {
  const before = text.slice(Math.max(0, index - 16), index);
  const after = text.slice(index + len, index + len + 4);
  if (/https?:\/\/[^\s]*$/i.test(before)) return true;
  if (before.endsWith("/") && (after.startsWith("/") || /\.[a-z0-9]{1,5}\b/i.test(after))) {
    return true;
  }
  return false;
}

/**
 * Bounded detector for high-entropy opaque secrets/blobs. Carefully excludes
 * pure hex checksums (SHA-256/SHA-512/MD5), UUIDs, and ordinary file paths.
 */
export function detectHighEntropySecrets(
  value: string,
  options: HighEntropyOptions = {},
): HighEntropyMatch[] {
  const minLength = options.minLength ?? DEFAULT_HIGH_ENTROPY_MIN_LENGTH;
  const minEntropy = options.minEntropy ?? DEFAULT_HIGH_ENTROPY_THRESHOLD;
  const maxMatches = options.maxMatches ?? DEFAULT_HIGH_ENTROPY_MAX_MATCHES;
  const maxScanChars = options.maxScanChars ?? DEFAULT_HIGH_ENTROPY_SCAN_CHARS;

  const sample = value.length > maxScanChars ? value.slice(0, maxScanChars) : value;
  const matches: HighEntropyMatch[] = [];
  CANDIDATE_SECRET_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = CANDIDATE_SECRET_RE.exec(sample)) !== null) {
    const token = m[0];
    if (token.length < minLength) continue;
    if (HEX_CHECKSUM_RE.test(token) || UUID_RE.test(token)) continue;
    if (/^[A-Za-z]+$/.test(token) || /^\d+$/.test(token)) continue;
    if (token.startsWith("[") || token === "redacted") continue;
    if (looksLikePathOrUrl(sample, m.index, token.length)) continue;

    // Require at least two distinct character classes (digits, upper, lower, symbol)
    const classes =
      (/[a-z]/.test(token) ? 1 : 0) +
      (/[A-Z]/.test(token) ? 1 : 0) +
      (/\d/.test(token) ? 1 : 0) +
      (/[+/=_-]/.test(token) ? 1 : 0);
    if (classes < 3 && !(classes === 2 && token.length >= 32)) continue;

    const entropy = shannonEntropy(token);
    if (entropy >= minEntropy) {
      matches.push({ token, entropy, index: m.index });
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}

/** Masks high-entropy secret/blob tokens detected by `detectHighEntropySecrets`. */
export function maskHighEntropySecrets(
  value: string,
  options: HighEntropyOptions = {},
): string {
  const matches = detectHighEntropySecrets(value, options);
  if (matches.length === 0) return value;
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    if (m.index < cursor) continue;
    out += value.slice(cursor, m.index) + "[redacted]";
    cursor = m.index + m.token.length;
  }
  return out + value.slice(cursor);
}

const RFC1918_OR_LOCAL_IPV4_RE =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|169\.254\.\d{1,3}\.\d{1,3})$/;

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * Scrubs PII (emails, IP addresses, and phone numbers) according to the configured mode:
 * - "off": returns text unchanged.
 * - "standard": masks emails, formatted international/North-American phones, and public IPs while keeping RFC1918/loopback IPs.
 * - "strict": masks emails, all IPs (including RFC1918), and broader phone patterns.
 */
export function scrubPii(text: string, mode: PiiScrubMode = "standard"): string {
  if (!text || mode === "off") return text;

  // Emails
  let out = text.replace(
    /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g,
    "[email redacted]",
  );

  // IPv4 addresses (bounded octet check; skip trailing/leading dots like version strings)
  out = out.replace(
    /(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/g,
    (ip) => {
      if (!isValidIpv4(ip)) return ip;
      if (mode === "standard" && RFC1918_OR_LOCAL_IPV4_RE.test(ip)) return ip;
      return "[ip redacted]";
    },
  );

  // Formatted phone numbers (e.g. +46 70 123 45 67, +1-555-234-5678, (555) 234-5678)
  out = out.replace(
    /(?<!\w)\+\d{1,3}[\s.-]\(\d{1,4}\)[\s.-]\d{2,4}[\s.-]\d{2,4}(?!\w)|(?<!\w)\+\d{1,3}[\s.-]\d{2,4}[\s.-]\d{2,4}[\s.-]\d{2,4}[\s.-]\d{2,4}(?!\w)|(?<!\w)\+\d{1,3}[\s.-]\d{2,4}[\s.-]\d{2,4}[\s.-]\d{2,4}(?!\w)|(?<!\w)\+\d{1,3}[\s.-]\d{2,4}[\s.-]\d{2,4}(?!\w)/g,
    "[phone redacted]",
  );
  out = out.replace(
    /(?<!\w)\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)/g,
    "[phone redacted]",
  );

  if (mode === "strict") {
    // Also redact un-prefixed hyphenated/spaced local phone numbers like 070-1234567 or 555-123-4567
    out = out.replace(
      /(?<!\w)(?:0\d{1,3}-\d{5,8}|\d{3}-\d{3}-\d{4})(?!\w)/g,
      "[phone redacted]",
    );
  }

  return out;
}

/** Mask BEFORE clipping. Call on complete records, not individual transport chunks. */
export function maskContext(value: string, options: MaskContextOptions = {}): string {
  const cleanUnicode = stripInvisibleUnicode(value);
  const withoutVt = stripVTControlCharacters(cleanUnicode);
  let masked = maskSecrets(withoutVt);
  if (options.highEntropy) {
    masked = maskHighEntropySecrets(masked);
  }
  if (options.piiMode && options.piiMode !== "off") {
    masked = scrubPii(masked, options.piiMode);
  }
  return masked;
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
      /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|rk_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{16,})\b/g,
      "[redacted]",
    )
    // HashiCorp Vault tokens (service and batch tokens)
    .replace(/\bhv[sb]\.[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    // Slack and Microsoft Teams incoming webhook URLs
    .replace(/https?:\/\/hooks\.slack\.com\/(?:services|workflows)\/[^\s"'<>]+|hooks\.slack\.com\/(?:services|workflows)\/[^\s"'<>]+/gi, "[redacted]")
    .replace(/https?:\/\/[A-Za-z0-9.-]*webhook\.office\.com\/[^\s"'<>]+|webhook\.office\.com\/[^\s"'<>]+/gi, "[redacted]")
    .replace(/https?:\/\/outlook\.office365\.com\/webhook\/[^\s"'<>]+|https?:\/\/outlook\.office\.com\/webhook\/[^\s"'<>]+|outlook\.office365\.com\/webhook\/[^\s"'<>]+|outlook\.office\.com\/webhook\/[^\s"'<>]+/gi, "[redacted]")
    // S3 presigned URL query signatures & security tokens
    .replace(/([?&]X-Amz-(?:Signature|Security-Token)=)[^\s&"'<>]+/gi, "$1[redacted]")
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
    // The password in a URL (including empty-username redis://:pass@host and passwords with @), up to the host.
    .replace(
      /([a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{0,255}:)[^\s/]{1,255}@(?=[^\s@/]+(?:[/:?#\s"'`,;]|$))/gi,
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
 * Truncates long text keeping both the head (default 35%) and tail (65%) with an
 * omitted-lines notice in the middle, ensuring root-cause errors at the top of logs
 * are preserved alongside recent output. Never exceeds `maxChars`.
 */
export function headTailTruncate(
  text: string,
  maxChars: number,
  headRatio = 0.35,
): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars < 80) {
    if (maxChars <= 3) return text.slice(0, maxChars);
    const half = Math.floor((maxChars - 3) * Math.min(1, Math.max(0, headRatio)));
    const tail = maxChars - 3 - half;
    return `${text.slice(0, half)}...${tail > 0 ? text.slice(-tail) : ""}`;
  }

  const ratio = Math.min(0.9, Math.max(0.1, headRatio));
  const buildNotice = (omittedText: string): string => {
    const lines = omittedText.split("\n").length;
    return `\n[... ${lines} lines (${omittedText.length} chars) omitted ...]\n`;
  };

  // Reserve room for the notice, then tighten if the actual notice is wider than estimated.
  let reserved = 64;
  for (let pass = 0; pass < 3; pass++) {
    const room = Math.max(0, maxChars - reserved);
    const rawHead = Math.floor(room * ratio);
    const rawTail = room - rawHead;

    let headEnd = rawHead;
    if (headEnd > 0) {
      const nl = text.lastIndexOf("\n", headEnd);
      if (nl >= Math.floor(headEnd * 0.5)) headEnd = nl;
    }

    let tailStart = text.length - rawTail;
    if (tailStart < text.length) {
      const nl = text.indexOf("\n", tailStart);
      if (nl !== -1 && nl - tailStart <= Math.floor(rawTail * 0.5)) {
        tailStart = nl + 1;
      }
    }

    if (tailStart <= headEnd) {
      headEnd = Math.floor(room * ratio);
      tailStart = text.length - (room - headEnd);
    }

    const notice = buildNotice(text.slice(headEnd, tailStart));
    const candidate = `${text.slice(0, headEnd)}${notice}${text.slice(tailStart)}`;
    if (candidate.length <= maxChars) return candidate;
    reserved = notice.length + (candidate.length - maxChars) + 4;
  }

  const fallbackNotice = "\n[... omitted ...]\n";
  const room = Math.max(0, maxChars - fallbackNotice.length);
  const head = Math.floor(room * ratio);
  const tail = room - head;
  return `${text.slice(0, head)}${fallbackNotice}${tail > 0 ? text.slice(-tail) : ""}`.slice(0, maxChars);
}

/**
 * Masks secrets/invisible characters (and optional PII) then applies head/tail
 * truncation so both initial errors and recent output survive.
 */
export function boundedHeadTailContext(
  value: string,
  max = 32_000,
  headRatio = 0.35,
  options: MaskContextOptions = {},
): string {
  const clean = maskContext(value, options);
  return headTailTruncate(clean, max, headRatio);
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

/** The longest message a person may start or continue a conversation with. */
export const PERSON_PROMPT_MAX = 16_000;
/**
 * The longest prompt of the hub's own runs (reading, pages, reviews, the
 * workforce lead). Their builders bound the data they quote, so this is a
 * ceiling that is not normally met, not the place where they are cut.
 */
export const HUB_PROMPT_MAX = 200_000;

/**
 * A text that is read as a whole and whose two ends matter: a prompt, which
 * opens with what is asked and often closes with the answer format or the
 * question. Masked; when too long the MIDDLE is left out and the text says so,
 * so that the instructions are never what is lost.
 */
export function boundedPrompt(value: string, max: number): string {
  const clean = maskContext(value);
  if (clean.length <= max) return clean;
  const note = (n: number): string => `
[… ${n} characters left out here: the text was too long …]
`;
  const room = Math.max(0, max - note(clean.length).length);
  const head = Math.ceil((room * 2) / 3);
  const tail = room - head;
  return `${clean.slice(0, head).trimEnd()}${note(clean.length - head - tail)}${tail > 0 ? clean.slice(-tail).trimStart() : ""}`;
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
  const clean = stripInvisibleUnicode(raw);
  const visible = stripVTControlCharacters(clean);
  const masked = maskSecrets(visible);
  return masked === visible ? maskSecrets(clean) : masked;
}
