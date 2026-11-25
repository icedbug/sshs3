import crypto from "node:crypto";
import { isIPv6 } from "node:net";
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
export function scrubPii(text: string, mode: PiiScrubMode = "standard", preservePublicIps = false): string {
  if (!text || mode === "off") return text;

  // Emails
  let out = text.replace(
    /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g,
    "[email redacted]",
  );

  // A sentence-ending period is punctuation. A fifth numeric segment is part of a version.
  if (mode === "strict" || !preservePublicIps) {
    out = out.replace(/(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d|\.\d)/g, (ip) => {
      if (!isValidIpv4(ip) || (mode === "standard" && RFC1918_OR_LOCAL_IPV4_RE.test(ip))) return ip;
      return "[ip redacted]";
    });
  }

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
    // eslint-disable-next-line security/detect-unsafe-regex -- address, zone and candidate lengths are all bounded before IPv6 validation.
    out = out.replace(/(?<![\w:])[\da-f]{0,4}:[\da-f:.]{1,45}(?:%[\w.-]{1,64})?(?![\w:])/gi, (candidate) => {
      const text = candidate.replace(/[.,]+$/, "");
      return isIPv6(text) ? "[ip redacted]" + candidate.slice(text.length) : candidate;
    });
    // Also redact un-prefixed hyphenated/spaced local phone numbers like 070-1234567 or 555-123-4567
    out = out.replace(
      /(?<!\w)(?:0\d{1,3}-\d{5,8}|\d{3}-\d{3}-\d{4})(?!\w)/g,
      "[phone redacted]",
    );
  }

  return out;
}

export function workspaceHostNames(servers: ReadonlyArray<{ host?: string; name?: string }> = [], target?: string): Set<string> {
  const values = [target, ...(Array.isArray(servers) ? servers.flatMap((s) => [s?.host, s?.name]) : [])];
  return new Set(values.filter((s): s is string => typeof s === "string" && /^[\w.-]+$/.test(s)).map((s) => s.toLowerCase().replace(/\.$/, "")));
}

/** The model can use public service addresses in standard mode. Stored and exported records keep their own policy. */
export function maskProviderText(text: string, piiMode?: PiiScrubMode, hosts?: ReadonlySet<string>): string {
  const clean = maskContext(text);
  const scrubbed = piiMode ? scrubPii(clean, piiMode, true) : clean;
  if (piiMode !== "strict" || !hosts?.size) return scrubbed;
  return scrubbed.replace(/[\w.-]+/g, (token) => hosts.has(token.toLowerCase().replace(/\.$/, "")) ? "[host redacted]" : token);
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
 * One word on a command line that may be a password: single-quoted (always taken), or double-quoted
 * or bare. A double-quoted or bare word that is a variable or a command substitution is not taken:
 * it holds no secret, and it is code a person approving the command should see. Nor is a placeholder
 * of a runbook or a template (`{{password}}`), quoted or not: its value is put in later. A bare word
 * ends before a backtick, which in a shell starts code and in prose closes it.
 */
const WORD = "(?![\"']?\\{\\{)(?:'[^'\\r\\n]*'|(?!\"?\\$[({A-Za-z_]|\"?`)(?:\"[^\"\\r\\n]*\"|[^\\s;&|\"'<>`]+))";
/** The same, as a word of its own after a flag: an option that follows (`-p --eval …`) is not the flag's value. */
const NEXT_WORD = `(?!-)${WORD}`;
/** The rest of one command: up to the next `;`, `&`, `|` or line break that is not inside quotes. Bounded. */
const REST = "(?:[^\\n;&|'\"]|'[^'\\n]*'|\"[^\"\\n]*\"){0,400}";

/** A word that is a variable, a command substitution or a redirection: shown as it is. */
const IS_CODE = /^"?\$[({A-Za-z_]|^"?`|^\d*[<>]|^["']?\{\{/;

type SegmentRule = (segment: string) => string;
const flagRule = (flag: string, word = WORD, flags = "g"): SegmentRule => {
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from the fixed pieces above and a flag written here
  const re = new RegExp(`(\\s${flag})${word}`, flags);
  return (segment) => segment.replace(re, "$1[redacted]");
};
const both = (...rules: SegmentRule[]): SegmentRule => (segment) => rules.reduce((s, rule) => rule(s), segment);
const when = (test: RegExp, rule: SegmentRule): SegmentRule => (segment) => (test.test(segment) ? rule(segment) : segment);

const passwordAfterP = flagRule("-p\\s*", NEXT_WORD, "");
const passwordAfterBigP = flagRule("-P\\s*", NEXT_WORD);
const passwordAfterW = flagRule("-w\\s*", NEXT_WORD);
const registryLogin = when(/\slogin\b/, flagRule("-p[\\s=]*", NEXT_WORD, ""));
const archivePassword = flagRule("-h?p", "(?!\\s)" + WORD);
const puttyPassword = flagRule("-pw\\s+", NEXT_WORD);
/** `-U name%password`, quoted or not. */
const sambaUser: SegmentRule = (segment) => segment.replace(/(\s(?:-U\s*|--user[=\s])["']?[^\s%;&|"']{1,100}%)(?!\{\{|\$[({A-Za-z_])[^\s;&|"']+/g, "$1[redacted]");
/**
 * `htpasswd -b [file] user password`: with `b` among its flags the password is a word of the command,
 * the third after the flags, or the second when `n` (print, no file) is among them.
 */
const htpasswd: SegmentRule = (segment) => {
  const words = [...segment.matchAll(/'[^'\n]*'|"[^"\n]*"|[^\s'"]+/g)].slice(1);
  const flags = words.filter((w) => /^-[A-Za-z0-9]+$/.test(w[0])).map((w) => w[0]).join("");
  if (!flags.includes("b")) return segment;
  const plain = words.filter((w) => !w[0].startsWith("-"));
  const password = plain[flags.includes("n") ? 1 : 2];
  if (!password || IS_CODE.test(password[0])) return segment;
  return `${segment.slice(0, password.index)}[redacted]${segment.slice(password.index + password[0].length)}`;
};

const snmpPassphrases = flagRule("-[AX]\\s*", NEXT_WORD);
/** FreeRDP's `/p:password`. */
const freerdpPassword: SegmentRule = (segment) =>
  segment.replace(/(\s\/p:)(?!\{\{|\$[({A-Za-z_])("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|"']+)/g, "$1[redacted]");

/**
 * Programs that take a password as an ordinary word on their command line, and where in the command
 * it stands. Anchored on the program's name, so ordinary text is left alone: `-p` is a port to ssh
 * and a password to sshpass.
 */
const COMMAND_RULES: Record<string, SegmentRule> = {
  "redis-cli": both(
    flagRule("-a\\s+", NEXT_WORD),
    // `AUTH [user] password`: the last word of it.
    flagRule("auth\\s+(?:[^\\s;&|'\"<>]+\\s+(?=[^\\s;&|-]))?", NEXT_WORD, "gi"),
    flagRule("config\\s+set\\s+(?:requirepass|masterauth)\\s+", NEXT_WORD, "gi"),
  ),
  "redis-benchmark": flagRule("-a\\s+", NEXT_WORD),
  docker: registryLogin,
  podman: registryLogin,
  nerdctl: registryLogin,
  buildah: registryLogin,
  skopeo: registryLogin,
  helm: registryLogin,
  crane: registryLogin,
  oras: registryLogin,
  mongosh: passwordAfterP,
  mongo: passwordAfterP,
  mongodump: passwordAfterP,
  mongorestore: passwordAfterP,
  mongoexport: passwordAfterP,
  mongoimport: passwordAfterP,
  mongostat: passwordAfterP,
  mongotop: passwordAfterP,
  ldapsearch: passwordAfterW,
  ldapmodify: passwordAfterW,
  ldapadd: passwordAfterW,
  ldapdelete: passwordAfterW,
  ldapwhoami: passwordAfterW,
  ldapcompare: passwordAfterW,
  ldapmodrdn: passwordAfterW,
  ldapexop: passwordAfterW,
  ldappasswd: flagRule("-[was]\\s*", NEXT_WORD),
  zip: passwordAfterBigP,
  unzip: passwordAfterBigP,
  zipcloak: passwordAfterBigP,
  ipmitool: passwordAfterBigP,
  mosquitto_pub: passwordAfterBigP,
  mosquitto_sub: passwordAfterBigP,
  sqlcmd: passwordAfterBigP,
  bcp: passwordAfterBigP,
  "7z": archivePassword,
  "7za": archivePassword,
  "7zr": archivePassword,
  "7zz": archivePassword,
  rar: archivePassword,
  unrar: archivePassword,
  plink: puttyPassword,
  pscp: puttyPassword,
  psftp: puttyPassword,
  smbclient: sambaUser,
  rpcclient: sambaUser,
  smbget: sambaUser,
  htpasswd,
  openssl: both(flagRule("-pass(?:in|out|word)?\\s+pass:", "(?!\\s)" + WORD), when(/\senc\b/, flagRule("-k\\s+", NEXT_WORD))),
  // A keystore's password (`-storepass:env NAME` and `:file` name where it is, and are not taken).
  keytool: flagRule("-(?:src|dest|new)?(?:storepass|keypass)\\s+|-new\\s+", NEXT_WORD),
  // `vault login TOKEN`; `name=value` after it is the generic rule's.
  vault: when(/\slogin\b/, flagRule("login\\s+(?:-\\S+\\s+)*", "(?![^\\s=]*=)" + NEXT_WORD, "")),
  etcdctl: (segment) => segment.replace(/(\s--user[=\s]["']?[^\s:;&|"']{1,100}:)(?!\{\{|\$[({A-Za-z_])[^\s;&|"']+/g, "$1[redacted]"),
  influx: flagRule("-password(?:=|\\s+)", NEXT_WORD),
  cqlsh: flagRule("-p\\s*", NEXT_WORD),
  useradd: flagRule("-p\\s+", NEXT_WORD),
  usermod: flagRule("-p\\s+", NEXT_WORD),
  // SNMPv3's passphrases: -A for authentication, -X for privacy (-a and -x are the protocols).
  snmpwalk: snmpPassphrases,
  snmpbulkwalk: snmpPassphrases,
  snmpget: snmpPassphrases,
  snmpgetnext: snmpPassphrases,
  snmpbulkget: snmpPassphrases,
  snmpset: snmpPassphrases,
  snmptable: snmpPassphrases,
  snmptrap: snmpPassphrases,
  xfreerdp: freerdpPassword,
  wlfreerdp: freerdpPassword,
  "sdl-freerdp": freerdpPassword,
  rabbitmqctl: flagRule("(?:add_user|change_password|authenticate_user)\\s+\\S+\\s+", NEXT_WORD, ""),
  rabbitmqadmin: flagRule("-p\\s+", NEXT_WORD),
  consul: flagRule("-token(?:=|\\s+)", NEXT_WORD),
  mysqladmin: flagRule("password\\s+", NEXT_WORD, ""),
  nmcli: flagRule("(?:password|wifi-sec\\.psk|802-1x\\.password)\\s+", NEXT_WORD),
  aws: flagRule("configure\\s+set\\s+\\S*(?:secret|token)\\S*\\s+", NEXT_WORD, ""),
  kubectl: when(/\screate\s+secret\b/, flagRule("--from-literal[=\\s][\\w.-]+=", "(?!\\s)" + WORD)),
  oc: when(/\screate\s+secret\b/, flagRule("--from-literal[=\\s][\\w.-]+=", "(?!\\s)" + WORD)),
  lftp: (segment) => segment.replace(/(\s-u\s+[^\s,;&|"']{1,100},)(?!\{\{|\$[({A-Za-z_])[^\s;&|"']+/, "$1[redacted]"),
  sqlplus: (segment) => segment.replace(/(\s[\w$#.-]{1,60}\/)(?!\{\{|\$[({A-Za-z_])[^\s@;&|"'/]+(?=@|\s|$)/, "$1[redacted]"),
};
// eslint-disable-next-line security/detect-non-literal-regexp -- the program names above and the fixed pieces
const COMMAND_SEGMENT = new RegExp(`(?<![\\w./-])(${Object.keys(COMMAND_RULES).join("|")})(?![\\w.-])${REST}`, "g");

/** sshpass's own options come before the command it wraps: a `-p` after that command is the wrapped program's. */
const SSHPASS = new RegExp(`\\b(sshpass\\s+(?:-[A-Za-z]+\\s+(?:[^-\\s]\\S*\\s+)?){0,4}?-p\\s*)${WORD}`, "g");

/**
 * Programs that read a password from their input: `echo PW | sudo -S …`, `echo 'user:PW' | chpasswd`,
 * `echo PW | docker login --password-stdin`. An optional `sudo` in front of them is part of it.
 */
const PASSWORD_READER =
  "(?:sudo\\b[^\\n;&|]{0,80}?\\s)?(?:chpasswd\\b|sudo\\b[^\\n;&|]{0,80}?\\s(?:-[A-Za-z]*S[A-Za-z]*(?![\\w-])|--stdin\\b)|passwd\\b[^\\n;&|]{0,80}?--stdin\\b|(?:docker|podman|nerdctl|buildah|skopeo|helm|crane|oras)\\b[^\\n;&|]{0,200}?--password-stdin\\b|smbpasswd\\b|vncpasswd\\b|kinit\\b|cryptsetup\\b|gpg2?\\b[^\\n;&|]{0,200}?--passphrase-fd\\b|htpasswd\\b[^\\n;&|]{0,80}?\\s-[A-Za-z0-9]*i)";
const ECHO_TO_READER = new RegExp(`\\b(echo|printf)\\b(${REST})(\\|\\s*${PASSWORD_READER})`, "g");
const HERE_STRING_TO_READER = new RegExp(`\\b(${PASSWORD_READER}${REST}<<<\\s*)(${WORD})`, "g");
const CHPASSWD_HEREDOC = /(\bchpasswd\b[^\n]{0,80}<<-?\s*["']?(\w{1,40})["']?[^\n]{0,80}\n)([\s\S]{0,4000}?)(\n[ \t]*\2\b)/g;
/** sshpass -e and redis-cli read these from the environment. */
const PASSWORD_ENV = new RegExp(`\\b((?:SSHPASS|REDISCLI_AUTH)=)${WORD}`, "g");

/**
 * An environment variable whose name ends in PASS, PASSWORD, PWD, TOKEN, SECRET or KEY: `export DBPASS=…`.
 * A KEY that names a file (`SSH_KEY=~/.ssh/id_ed25519`) is not one, nor is a small number or a yes or
 * no (`BYPASS=1`, `NO_TOKEN=true`).
 */
const SECRET_ENV = new RegExp(`\\b([A-Z][A-Z0-9_]{0,60}(?:PASS|PASSWD|PASSWORD|PWD|TOKEN|SECRET)=)(?!(?:\\d{1,6}|true|false|yes|no|on|off)(?![^\\s;&|]))${WORD}`, "g");
const KEY_ENV = new RegExp(`\\b([A-Z][A-Z0-9_]{0,60}KEY=)(?![~/.]|(?:\\d{1,6}|true|false|yes|no|on|off)(?![^\\s;&|]))${WORD}`, "g");

/** `name:password` with the password masked; anything else masked whole. */
function maskCredential(word: string, keepName: boolean): string {
  if (IS_CODE.test(word)) return word;
  const quote = /^["']/.test(word) ? word[0] : "";
  const inner = quote ? word.slice(1, word.endsWith(quote) ? -1 : undefined) : word;
  const name = keepName ? /^[\w.@-]{1,64}:/.exec(inner)?.[0] : undefined;
  // `name:{{password}}` is a placeholder, put in later; `"name:$PW"` a variable (in single quotes it is the literal text).
  const value = inner.slice(name?.length ?? 0);
  if (value.startsWith("{{") || (quote !== "'" && IS_CODE.test(value))) return word;
  // A printf format keeps its line break: only the value is the secret.
  const tail = /(?:\\n|\\r)+$/.exec(inner)?.[0] ?? "";
  return `${quote}${name ?? ""}[redacted]${tail}${quote}`;
}

/** What `echo` or `printf` hands to a program that reads a password: every word that is one. */
function maskEchoed(program: string, args: string, toChpasswd: boolean): string {
  let first = true;
  return args.replace(/\$\([^)\n]*\)|`[^`\n]*`|'[^'\n]*'|"[^"\n]*"|[^\s'"]+/g, (word) => {
    const wasFirst = first;
    first = false;
    if (program === "echo" && /^-[neE]+$/.test(word)) {
      first = wasFirst;
      return word;
    }
    // printf's first word is its format: it is the secret only when it holds no placeholder.
    if (program === "printf" && wasFirst && /%/.test(word)) return word;
    return maskCredential(word, toChpasswd);
  });
}

/** Passwords written as ordinary words on a command line (see the rules above). */
function maskCommandLineSecrets(value: string): string {
  return value
    .replace(COMMAND_SEGMENT, (segment: string, program: string) => COMMAND_RULES[program]?.(segment) ?? segment)
    .replace(SSHPASS, "$1[redacted]")
    .replace(ECHO_TO_READER, (_match: string, program: string, args: string, reader: string) => `${program}${maskEchoed(program, args, /chpasswd/.test(reader))}${reader}`)
    .replace(HERE_STRING_TO_READER, (_match: string, before: string, word: string) => `${before}${maskCredential(word, /chpasswd/.test(before))}`)
    .replace(CHPASSWD_HEREDOC, (_match: string, head: string, _tag: string, body: string, end: string) =>
      `${head}${body.replace(/^([ \t]*[\w.@-]{1,64}:)\S+/gm, "$1[redacted]")}${end}`,
    )
    .replace(PASSWORD_ENV, "$1[redacted]")
    // SQL, also inside `mysql -e "…"` or `psql -c "…"`: CREATE/ALTER USER … IDENTIFIED BY '…',
    // ALTER ROLE … [WITH] [ENCRYPTED] PASSWORD '…', SET PASSWORD [FOR …] = '…' (or PASSWORD('…')).
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
    .replace(/(\bIDENTIFIED\s+(?:WITH\s+[\w$]+\s+)?BY\s+(?:PASSWORD\s+)?)'[^'\r\n]*'/gi, "$1'[redacted]'")
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
    .replace(/(\bSET\s+PASSWORD\b[^=;\r\n]{0,160}=\s*(?:PASSWORD\s*\(\s*)?)'[^'\r\n]*'/gi, "$1'[redacted]'")
    .replace(/(\bPASSWORD\s+)'(?!\{\{)[^'\r\n]*'/gi, "$1'[redacted]'")
    // An environment variable named as a secret (SECRET_ENV, KEY_ENV).
    .replace(SECRET_ENV, "$1[redacted]")
    .replace(KEY_ENV, "$1[redacted]")
    // jenkins-cli.jar -auth user:password (`-auth @file` reads it from a file).
    .replace(/\b(jenkins-cli\b[^\n;&|]{0,200}?\s-auth\s+["']?[^\s:;&|"'@]{1,100}:)(?!\{\{|\$[({A-Za-z_])[^\s;&|"']+/g, "$1[redacted]");
}

/**
 * The secrets in a text, masked, and everything else left exactly as it was —
 * including the control codes a terminal draws with. For a recording that has
 * to replay as it looked, which `maskContext` (which strips them) cannot give.
 */
export function maskSecrets(value: string): string {
  return maskCommandLineSecrets(value)
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
    // HashiCorp Vault tokens (service, batch and recovery tokens)
    .replace(/\bhv[sbr]\.[A-Za-z0-9_-]{12,}/g, "[redacted]")
    // Slack and Microsoft Teams incoming webhook URLs
    .replace(/https?:\/\/hooks\.slack\.com\/(?:services|workflows)\/[^\s"'<>]+|hooks\.slack\.com\/(?:services|workflows)\/[^\s"'<>]+/gi, "[redacted]")
    .replace(/https?:\/\/[A-Za-z0-9.-]*webhook\.office\.com\/[^\s"'<>]+|webhook\.office\.com\/[^\s"'<>]+/gi, "[redacted]")
    .replace(/https?:\/\/outlook\.office365\.com\/webhook\/[^\s"'<>]+|https?:\/\/outlook\.office\.com\/webhook\/[^\s"'<>]+|outlook\.office365\.com\/webhook\/[^\s"'<>]+|outlook\.office\.com\/webhook\/[^\s"'<>]+/gi, "[redacted]")
    // S3 presigned URL query signatures & security tokens
    .replace(/([?&]X-Amz-(?:Signature|Security-Token)=)[^\s&"'<>]+/gi, "$1[redacted]")
    // A JSON Web Token: three base64url parts, the first two starting with {"…
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]")
    // A crypt(3)-style hash: Cisco type 5/8/9, /etc/shadow ($1$, $5$, $6$, $y$, bcrypt, argon2).
    .replace(/\$(?:1|5|6|8|9|y|2[aby]?|apr1|argon2(?:id|i|d)?)\$[^\s$]{0,200}\$[^\s"',;]{8,200}/g, "[redacted]")
    // Network devices: `enable secret 9 <hash>`, `username x secret 5 <hash>`,
    // `password 7 <type 7>`, `enable password <plain>`.
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
    .replace(/\b((?:enable\s+)?(?:secret|password)\s+[0-9]\s+)(?!\[redacted\])\S+/gi, "$1[redacted]")
    .replace(/\b(enable\s+(?:secret|password)\s+)(?![0-9]\s)(?!\[redacted\])\S+/gi, "$1[redacted]")
    // SNMP communities, in device config, net-snmp config and the snmp* tools.
    .replace(/\b(snmp-server\s+community\s+)\S+/gi, "$1[redacted]")
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
    .replace(/\b(snmp-server\s+host\s+\S+\s+(?:(?:informs|traps)\s+)?version\s+(?:1|2c)\s+)\S+/gi, "$1[redacted]")
    .replace(/\b((?:ro|rw)community6?\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(snmp(?:walk|bulkwalk|get|getnext|bulkget|set|table|trap)\b[^\n;&|]{0,200}?\s-c\s*)[^\s;&|]+/g, "$1[redacted]")
    // IPsec / VPN pre-shared keys written without `:` or `=`.
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
    .replace(/\b((?:pre-?shared-?key|psk)(?:\s+(?:local|remote|ascii|hex|[0-9]))?\s+)(?!address\b|[:=])(?!\[redacted\])[^\s,;]+/gi, "$1[redacted]")
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
    .replace(/\b(crypto\s+isakmp\s+key\s+(?:[0-9]\s+)?)\S+/gi, "$1[redacted]")
    // Redis: `requirepass <password>` and `masterauth <password>` (redis.conf, CONFIG SET), the value
    // CONFIG GET prints on the line after the name, and `>password` in an ACL rule. A sentence about
    // them ("set requirepass in redis.conf") is left as it is.
    .replace(
      /\b((?:requirepass|masterauth)[ \t]+)(?!\[redacted\])("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|"'<>]+)/gi,
      (match: string, prefix: string, value: string, offset: number, whole: string) =>
        (PROSE_WORD.test(value) || /^(?:is|was|are|has|had|must|should|can|will|needs?|does|do)$/i.test(value)) &&
        /^ +[A-Za-z]/.test(whole.slice(offset + match.length, offset + match.length + 8))
          ? match
          : `${prefix}${/^["']/.test(value) ? `${value[0]}[redacted]${value[0]}` : "[redacted]"}`,
    )
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored at a line start on a keyword, each part bounded or separated by fixed characters, so it cannot backtrack
    .replace(/^((?:\d+\)[ \t]*)?["']?(?:requirepass|masterauth)["']?[ \t]*\r?\n(?:\d+\)[ \t]*)?)("?)(?!\[redacted\])([^\r\n"]+)("?)$/gim, "$1$2[redacted]$4")
    .replace(/^([ \t]*(?:user[ \t]+\S+|.*\bACL[ \t]+SETUSER[ \t]+\S+)[ \t].*)$/gim, (line: string) =>
      line.replace(/([ \t]['"]?[<>])(?!\[redacted\])[^\s'"]+/g, "$1[redacted]"),
    )
    .replace(/\b(Bearer|Basic)\s+(?!(?:auth|authentication|token|tokens|scheme|realm|access|header|credentials?)\b)[^\s"']+/gi, "$1 [redacted]")
    // kubeconfig keys and certificates' private halves, and a docker config's auth.
    .replace(/\b((?:client-key|token)-data:\s*)\S+/g, "$1[redacted]")
    .replace(/("auth"\s*:\s*")[^"]+"/g, '$1[redacted]"')
    // A password given as a flag: --password x, --password=x, mysql -pSECRET.
    .replace(/(--pass(?:word)?[= ])(?!["']?(?:\$[({A-Za-z_]|`|\{\{))[^\s;&|]+/gi, "$1[redacted]")
    // A flag whose name ends in password, passphrase, token or api-key, with its value as the next word:
    // --http-password x, --token x, --api-key x. (With `=` the rule for `name = value` further down has it.)
    // eslint-disable-next-line security/detect-unsafe-regex -- the optional first part is bounded and ends in a fixed `-`, so it cannot backtrack
    .replace(/(--(?:[a-z][a-z-]{0,30}-)?(?:password|passphrase|token|api-?key) )(?!-|\$[({A-Za-z_]|"\$|`|\[redacted\]|["']?\{\{)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|"'<>]+)/gi, "$1[redacted]")
    .replace(/\b(curl\b[^\n;&|]{0,200}?\s(?:-u|--user|-U|--proxy-user)\s*["']?[^\s:;&|"']{1,100}:)(?!\$[({A-Za-z_]|`|\{\{)[^\s;&|"']+/g, "$1[redacted]")
    .replace(/\b((?:mysql|mysqldump|mariadb|mysqladmin)\b[^\n;&|]*?\s-p)(?!\s|["']?(?:\$[({A-Za-z_]|`|\{\{))[^\s;&|]+/g, "$1[redacted]")
    // The runs before `://` and around the keyword are bounded: unbounded, each
    // start position scans to the end of a long unbroken run (base64, a hex
    // dump, minified JSON) and masking 30,000 such characters takes a second.
    // The password in a URL (including empty-username redis://:pass@host), up to the last @ before the
    // host: a password may hold @ and /. A port followed by a path with an @ in it is not a password.
    .replace(
      /([a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{0,255}:)(?!\d{1,5}\/)[^\s]{1,255}@(?=[^\s@/]+(?:[/:?#\s"'`,;]|$))/gi,
      "$1[redacted]@",
    )
    .replace(
      /(["']?[\w-]{0,40}(?:password|passphrase|passwd|secret|token|api[_-]?key|credential|pre-?shared[-_]?key|psk|snmp[\w-]{0,20}community|community[_-]?string|_pass|_pwd|^pwd|\bpwd|\bpw\b)[\w-]{0,40}["']?\s*[:=]\s*)(?:"(?!\$[({A-Za-z_]|[^"\r\n]*(?:\$\(|`|\{\{))[^"\r\n]*"|'(?!\{\{)[^'\r\n]*'|(?!\$[({A-Za-z_]|`|\{\{)[^\s,;&|<>()`"']+)/gi,
      (match: string, prefix: string, offset: number, whole: string) =>
        isPolicyValue(prefix, match.slice(prefix.length), whole.slice(offset + match.length, offset + match.length + 24))
          ? match
          : `${prefix}[redacted]`,
    )
    // In prose: "the password is Hunter2-x", "admin pw was s3cr3t!". Only a value
    // that looks like a secret: "the password is stored in the vault" stays.
    .replace(
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
      /\b((?:password|passphrase|passwd|pwd|pw|secret|token|api[ _-]?key|pin(?: ?code)?)\s+(?:is|was|=)\s+)("[^"\r\n]{1,200}"|'[^'\r\n]{1,200}'|[^\s,;]{1,200})/gi,
      (match: string, prefix: string, value: string) => {
        const quoted = /^["']/.test(value);
        const bare = quoted ? value.slice(1, -1) : value.replace(/[.!?):]+$/, "");
        // A placeholder of a runbook or a template: its value is put in later.
        if (bare.startsWith("{{")) return match;
        if (!quoted && !looksLikeSecret(bare)) return match;
        return `${prefix}${quoted ? `${value[0]}[redacted]${value[0]}` : `[redacted]${value.slice(bare.length)}`}`;
      },
    );
}

/**
 * Whether a text holds something maskSecrets would hide. Only secrets count: a byte-order mark,
 * a zero-width character or a terminal colour code, which maskContext also strips, is not one.
 */
export function containsSecrets(value: string): boolean {
  return maskSecrets(value) !== value;
}

/**
 * The first line of a text that holds a secret, as it reads with the secret hidden: to show a person
 * where it is without showing it. Undefined when the text holds none.
 */
export function secretLine(value: string): string | undefined {
  const masked = maskSecrets(value).split("\n");
  const lines = value.split("\n");
  // A key that spans lines leaves fewer lines once masked: its first one is where it begins.
  const at = masked.findIndex((line, i) => line !== lines[i]);
  if (at < 0) return undefined;
  const line = oneLine(masked[at]);
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Units that, after a number, make a policy ("90 days", "12 characters"), not a secret. */
const POLICY_UNIT = /^\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|w|months?|years?|y|characters?|chars?|times?|attempts?|tries|retries|versions?|%|percent)\b/i;
/** Words that, as a value, say how secrets are handled ("secrets: weekly"), not what one is. */
const POLICY_WORD = /^(?:never|always|required|optional|none|n\/a|daily|weekly|monthly|quarterly|yearly|annually|hourly|rotated|expired|disabled|enabled|yes|no|true|false|null|unset|empty|redacted|\[redacted\])$/i;
/**
 * Words a sentence goes on with after "password:" in what a person writes ("password: set a new one",
 * "password: the one in the vault"): verbs of asking and doing, small words, and words that say where
 * or how a secret is kept. Not words anyone would choose as a password and then write more after.
 */
const PROSE_WORD =
  /^(?:set|use|choose|pick|make|create|generate|rotate|change|reset|update|replace|keep|store|put|give|send|share|ask|check|see|read|write|enter|type|copy|move|remove|add|get|find|look|leave|please|the|a|an|this|that|it|its|same|your|our|their|my|his|her|any|each|every|all|in|on|at|for|from|to|with|by|of|if|when|and|or|but|as|so|not|unchanged|missing|stored|saved|kept|held|found|given|sent|shared|written|taken|managed|handled|needed|known|unknown|wrong|temporary)$/i;

/**
 * A value after `password:` that is a fact about passwords, not a password:
 * a number with a unit ("production passwords: 90 days"), a policy word, or
 * an ordinary lowercase word after a plural heading ("secrets: weekly on Monday").
 */
function isPolicyValue(prefix: string, value: string, after: string): boolean {
  const bare = value.replace(/^["']|["']$/g, "");
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored on a keyword, each part bounded or separated by fixed words, so it cannot backtrack
  if (/^\d{1,4}(?:[.,]\d+)?$/.test(bare) && POLICY_UNIT.test(after)) return true;
  if (POLICY_WORD.test(bare)) return true;
  const plural = /(?:passwords|passphrases|secrets|tokens|credentials|keys)["']?\s*[:=]\s*$/i.test(prefix);
  // A count after a plural name: "contextWindowTokens: 400000", "max_tokens=4096". One token is a secret.
  if (plural && /^\d{1,10}[}\]]*$/.test(value)) return true;
  // A sentence that goes on after a colon ("password: set a new one", "password: please choose a long
  // one"): its first word is one a sentence goes on with, and more words follow it on the line.
  if (/:\s*$/.test(prefix) && value === bare && PROSE_WORD.test(bare) && /^ +[A-Za-z]/.test(after)) return true;
  return plural && /^[a-z]{2,20}$/.test(bare) && /^\s+[a-z]/i.test(after);
}

/** A bare word in prose that has the look of a secret: letters mixed with digits or symbols, or odd casing. */
function looksLikeSecret(value: string): boolean {
  if (value.length < 6 || /^[/~]|^https?:/i.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  const letters = /[A-Za-z]/.test(value);
  if (letters && /[0-9]/.test(value)) return true;
  if (letters && /[^A-Za-z0-9]/.test(value) && !/^[A-Za-z]+[.-][A-Za-z]+$/.test(value)) return true;
  return value.length >= 10 && /[a-z]/.test(value) && /[A-Z]/.test(value.slice(1));
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

/**
 * Text from outside as one line: every line break and control character becomes a space, and runs of
 * spaces one. A field that is put into a line of a prompt (a title, a label, a name) cannot then begin
 * a line of its own, which a reader would take for the prompt's.
 */
export function oneLine(value: string): string {
  // \s covers the Unicode line and paragraph separators; the C0 and C1 ranges cover NEL, VT, FF and the rest.
  // eslint-disable-next-line no-control-regex -- the control characters are what is taken out
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Text from outside as its lines, for putting a mark before each (a quoted block): every kind of line
 * break ends a line, other control characters are gone, and empty lines are left out.
 */
export function plainLines(value: string): string[] {
  return value
    .split(/\r\n?|[\n\v\f\u0085\u2028\u2029]/)
    .map(oneLine)
    .filter(Boolean);
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

/**
 * The marks sshs3 writes where it hid a secret: `maskSecrets` and `maskHighEntropySecrets` ("[redacted]",
 * "[private key redacted]"), `scrubPii` ("[email redacted]", "[ip redacted]", "[phone redacted]"),
 * `maskProviderText` ("[host redacted]"), and the panel's own mask ("[REDACTED]").
 */
const MASK_MARK = /\[(?:private key |email |ip |phone |host )?redacted\]/i;

/** The first mark of a hidden value in a text, or undefined. */
export function maskMarkIn(value: string): string | undefined {
  return MASK_MARK.exec(value)?.[0];
}

/**
 * What the agent is told when a command it asked for holds such a mark. The agent only ever sees
 * secrets masked, so a command it writes from what it saw (its own earlier call, a runbook, a
 * memory) holds the mark and not the value: run, it would set a password to the word "[redacted]".
 */
export function maskedValueRefusal(what: string, mark: string): string {
  return `Nothing ran. The ${what} holds "${mark}". sshs3 wrote that in place of a password, key or token it hid from you, so it is not the real value: run as it stands, the ${what} would use the text "${mark}". You never see the real value. Ask the person to enter it themselves: they can run this step in the terminal with the real value, or put the value on the server (a file only they can read, an environment variable) for your command to read.`;
}

/** One line under the tool calls a model is shown again, when a call there holds such a mark. */
export const TOOL_LOG_HIDDEN_NOTE =
  '[sshs3] A call above holds "[redacted]" or a mark like it where sshs3 hid a value from you. The mark is not the real value, and a command that holds it is refused.';

/** sha256 of an exact text: to match what was approved against what runs without keeping the text. */
export const exactHash = (value: string): string => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export const observationHash = (id: string, observation: { exitCode: number; output: string }): string =>
  exactHash(JSON.stringify([id, observation.exitCode, observation.output]));

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
