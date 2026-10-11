/**
 * Secret masking shared by the main process (log scrubbing, text sent to the AI assistant) and the
 * renderer. Pure string work: no Node, Buffer or Electron APIs.
 *
 * The aim is fail-closed masking of text that is about to leave the machine or reach a log, with few
 * false positives on ordinary terminal output. Rules run in a fixed order and each one sees the output
 * of the previous ones, so a value that was already replaced by REDACTED is never counted twice and
 * masking masked text is a no-op.
 *
 * Every rule is linear in the input. Quantifiers that scan a run of characters are bounded, a rule
 * either starts at a literal anchor or at the start of a run (lookbehind), and context checks such as
 * "this -p belongs to a mysql command" look at a window of at most CONTEXT_WINDOW characters.
 */

export const REDACTED = '[redacted]';

export interface MaskResult {
  text: string;
  count: number;
}

/** A replacement of text[start..end). `start` defaults to the start of the regex match. */
interface Hit {
  start?: number;
  end: number;
  replacement: string;
}

/**
 * `apply` returns a Hit to mask, null to decline the candidate (scanning continues right after the regex
 * match, so a value is still searched for nested secrets) or an index to continue scanning from.
 */
interface Rule {
  re: RegExp;
  /** The same pattern with escaped line breaks counting as a boundary; used only on text that holds `\\n`, `\\r` or `\\t`. */
  esc?: RegExp;
  apply: (m: RegExpExecArray, text: string) => Hit | number | null;
}

interface Tally {
  count: number;
}

const CONTEXT_WINDOW = 2000;

const withEscBoundary = (rule: Rule): Rule => ({ ...rule, esc: escBoundary(rule.re) });
const hasEscapedBreak = (text: string): boolean => textHas(text, '\\n') || textHas(text, '\\r') || textHas(text, '\\t');

/**
 * A literal backslash escape (`\\n`, `\\r`, `\\t` as two characters, as in JSON-encoded logs, HTTP dumps and
 * scripts held in strings) is a line break for the rules: its `n` must not count as a word character that
 * glues to the token behind it. Applied to the rules that start at a word boundary.
 */
const ESCAPED_BREAK = String.raw`(?<=\\[nrt])`;
function escBoundary(re: RegExp): RegExp {
  return new RegExp(re.source.replace(/\(\?<!(\[[^\]]+\])\)/g, (_m, cls: string) => `(?:(?<!${cls})|${ESCAPED_BREAK})`), re.flags);
}
/** True when the character before `i` is a word character that is not the `n`/`r`/`t` of an escaped line break. */
function glued(text: string, i: number): boolean {
  if (i <= 0 || !/[A-Za-z0-9_]/.test(text[i - 1])) return false;
  return !(i >= 2 && 'nrt'.includes(text[i - 1]) && text[i - 2] === '\\');
}
const PLACEHOLDER_G = /\[redacted\]/g;
const FILLER_G = /\\[nrt]|[\s"'`,;:()[\]{}<>&#=\\]/g;

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

function applyRule(text: string, rule: Rule, tally: Tally): string {
  const re = rule.esc && hasEscapedBreak(text) ? rule.esc : rule.re;
  re.lastIndex = 0;
  let out = '';
  let copied = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const hit = rule.apply(m, text);
    if (hit === null) {
      re.lastIndex = m.index + (m[0].length || 1);
      continue;
    }
    if (typeof hit === 'number') {
      re.lastIndex = Math.max(hit, m.index + (m[0].length || 1));
      continue;
    }
    const start = hit.start ?? m.index;
    // A region that only holds an existing placeholder is merged into one, not counted again; one that
    // also swallows new text (`sid=abc; [redacted]`) is a new secret.
    const region = text.slice(start, hit.end);
    if (!region.includes(REDACTED) || region.replace(PLACEHOLDER_G, '').replace(FILLER_G, '') !== '') tally.count++;
    out += text.slice(copied, start) + hit.replacement;
    copied = hit.end;
    re.lastIndex = hit.end;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Whole-match rule: the matched text is the secret. */
function wholeMatch(re: RegExp): Rule {
  return { re, apply: (m) => ({ end: m.index + m[0].length, replacement: REDACTED }) };
}

/** A placeholder only counts as a masked value when nothing is glued to it: `[redacted]tail` is not masked. */
const PLACEHOLDER_END = String.raw`(?![^\s,;)}\]&#"'<\\])`;
const VALUE_BOUNDARY = /[^\s,;)}\]&#"'<\\]/;

/**
 * A value after `=`, `:` or a flag: an already masked placeholder, a quoted string (masked whole,
 * spaces included, plus any text glued to the closing quote), an unterminated quote (masked to the end
 * of the line) or one non-space token. The variants differ only in where an unquoted token ends, so a
 * value is never read further than it is masked (that would make a long line quadratic).
 */
const QUOTED_VALUE = String.raw`"\[redacted\]"${PLACEHOLDER_END}|'\[redacted\]'${PLACEHOLDER_END}|"(?:[^"\\\r\n]|\\.){0,4096}"[^\s,;)}\]]*|'(?:[^'\\\r\n]|\\.){0,4096}'[^\s,;)}\]]*|["'][^\r\n]*`;
const valueRegExp = (unquoted: string) => new RegExp(String.raw`\[redacted\]${PLACEHOLDER_END}|${QUOTED_VALUE}|${unquoted}`, 'y');

const VALUE_RE = valueRegExp(String.raw`(?:\\[ \t]|\S)+`);
/** In a query string the value ends at & or #. */
const QUERY_VALUE_RE = valueRegExp(String.raw`[^\s&#]+`);
/** After a `;` (connection string) the value ends at the next `;` and may hold spaces. */
const SEMICOLON_VALUE_RE = valueRegExp(String.raw`[^;\r\n]*[^\s;]`);
/** Otherwise a value runs up to the next `;Name=` so that `AccountKey=abc;EndpointSuffix=x` keeps its tail. */
const SEGMENT_VALUE_RE = valueRegExp(String.raw`(?:\\[ \t]|[^\s;])*(?:;(?![A-Za-z][\w .-]{0,40}=)(?:\\[ \t]|[^\s;])*)*`);

function readValue(text: string, pos: number, re: RegExp = VALUE_RE): { end: number; raw: string } | null {
  re.lastIndex = pos;
  const m = re.exec(text);
  if (!m || !m[0]) return null;
  let raw = m[0];
  const first = raw.charCodeAt(0);
  if (first !== 34 && first !== 39 && raw !== REDACTED) {
    // Keep trailing delimiters (`a=b;`, `f(x, password=y)`, `{"pin": 1}`) out of the secret
    const hasParen = raw.includes('(');
    const hasBrace = raw.includes('{');
    const hasBracket = raw.includes('[');
    let n = raw.length;
    while (n > 0) {
      const c = raw.charCodeAt(n - 1);
      if (c === 59 || c === 44 || (c === 41 && !hasParen) || (c === 125 && !hasBrace) || (c === 93 && !hasBracket)) n--;
      else break;
    }
    if (n === 0) return null;
    raw = raw.slice(0, n);
  }
  return { end: pos + raw.length, raw };
}

/** True when the text at `pos` is a placeholder with nothing glued to it. */
function maskedAt(text: string, pos: number): boolean {
  return text.startsWith(REDACTED, pos) && !VALUE_BOUNDARY.test(text.charAt(pos + REDACTED.length));
}

/** A value that is exactly the placeholder was masked before; masking it again would change nothing. */
function isMasked(raw: string): boolean {
  return raw === REDACTED || raw === `"${REDACTED}"` || raw === `'${REDACTED}'`;
}

/** End of a value that runs to the closing `quote` (or to the end of the line when `quote` is empty). */
function scanValueEnd(text: string, from: number, quote: string, escapedBreak = false): number {
  const q = quote ? quote.charCodeAt(0) : -1;
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13 || c === q) break;
    if (c === 92 && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      // a literal `\n` / `\r` inside a one-line JSON string ends a header value
      if (escapedBreak && (next === 110 || next === 114)) break;
      if (next !== 10 && next !== 13) {
        i += 2;
        continue;
      }
    }
    i++;
  }
  return i;
}

function trimEndIndex(text: string, start: number, end: number): number {
  let i = end;
  while (i > start && (text.charCodeAt(i - 1) === 32 || text.charCodeAt(i - 1) === 9)) i--;
  return i;
}

/** Value that is either quoted with `quote` (up to the closing quote) or an ordinary token. */
function readArgument(text: string, pos: number, quote: string): { end: number; raw: string } | null {
  if (quote) {
    const end = scanValueEnd(text, pos, quote);
    return end > pos ? { end, raw: text.slice(pos, end) } : null;
  }
  return readValue(text, pos);
}

/** True when `s` holds a command separator outside quotes: `mysql -e "select 1; select 2" -p...` is one command. */
function hasCommandBreak(s: string): boolean {
  let quote = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && quote !== 39) {
      // a backslash escapes the next character; a backslash before a line break continues the command
      i += s.charCodeAt(i + 1) === 13 && s.charCodeAt(i + 2) === 10 ? 2 : 1;
    } else if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 10 || c === 59 || c === 124 || (c === 38 && s.charCodeAt(i + 1) === 38)) return true;
  }
  return false;
}

/** `docker run --name mongo -p 8080:80`: the word is a container name, not the command. */
const NAME_VALUE_BEFORE = /(?:--name|--hostname|--network|--net|--link|-h|-n)[ \t=]+$/;

const anchorMemo = { text: '', found: new Map<string, boolean>() };

/** Whether `anchor` occurs anywhere in `text`; remembered per text, so rules with a rare command word cost nothing. */
function textHas(text: string, anchor: string): boolean {
  if (anchorMemo.text !== text) {
    anchorMemo.text = text;
    anchorMemo.found.clear();
  }
  let found = anchorMemo.found.get(anchor);
  if (found === undefined) {
    found = text.includes(anchor);
    anchorMemo.found.set(anchor, found);
  }
  return found;
}

/** True when the command word (one of `anchors`) occurs shortly before `pos` in the same command. */
function inCommand(text: string, pos: number, anchors: readonly string[], stop?: RegExp): boolean {
  if (!anchors.some((anchor) => textHas(text, anchor))) return false;
  const win = text.slice(Math.max(0, pos - CONTEXT_WINDOW), pos);
  let at = -1;
  let len = 0;
  for (const anchor of anchors) {
    // the command word must start a word: `passmysql` is not mysql
    for (let i = win.lastIndexOf(anchor); i > at; i = i > 0 ? win.lastIndexOf(anchor, i - 1) : -1) {
      if (!glued(win, i) && !NAME_VALUE_BEFORE.test(win.slice(Math.max(0, i - 12), i))) {
        at = i;
        len = anchor.length;
        break;
      }
    }
  }
  if (at < 0) return false;
  const between = win.slice(at);
  return !hasCommandBreak(between) && !(stop && stop.test(between.slice(len)));
}

// ---------------------------------------------------------------------------------------------
// Private keys
// ---------------------------------------------------------------------------------------------

const PEM_MARKER_RE = /-----(BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END_RE = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_MARKER_LINE_RE = /-----(?:BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;

/** A line of base64, however short (the last line of a key body is). */
const KEY_BODY_LINE_RE = /^[ \t]*[A-Za-z0-9+/=]+[ \t]*$/;
/** A long base64 field closing the line, possibly after a log prefix: 16+ characters with an upper case letter. */
const KEY_BODY_TAIL_RE = /(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/=]*[A-Z])[A-Za-z0-9+/=]{16,}[ \t]*$/;
const KEY_HEADER_LINE_RE = /^[ \t]*(?:Proc-Type|DEK-Info|Version|Comment|Charset|Hash|MessageID)[ \t]*:/i;
/** The text that follows a BEGIN marker on the same line when the key is written on one line (JSON-escaped newlines). */
const KEY_SAME_LINE_BODY_RE = /^[ \t]*(?:(?:\\r)?\\n|[A-Za-z0-9+/=]{16,})/;

/** Start of the line that contains `pos`. */
function lineStartOf(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

/** End of the line that starts at or contains `pos`, without a trailing CR. */
function contentEndOf(text: string, pos: number): number {
  const e = text.indexOf('\n', pos);
  const end = e < 0 ? text.length : e;
  return end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
}

/** The first line after a BEGIN marker must clearly be key material; later lines may be short. */
const isStrongKeyLine = (line: string) => KEY_BODY_TAIL_RE.test(line) || KEY_HEADER_LINE_RE.test(line);
const isKeyLine = (line: string) => isStrongKeyLine(line) || KEY_BODY_LINE_RE.test(line) || PEM_MARKER_LINE_RE.test(line);

/**
 * Masks PEM, OpenSSH and PGP private key blocks. Text is only taken for key material while it looks
 * like it: after a BEGIN marker the base64 lines that follow are masked up to the END marker (or, when
 * the END is missing because the scrollback was cut, up to the first line that is not key material);
 * an END marker whose BEGIN line was cut off earlier masks the key lines above it, back to the start of
 * the text when the text starts inside the key. A marker that is only mentioned (grep output, an echo
 * in the command line) masks just itself.
 */
function maskPrivateKeys(text: string, tally: Tally): string {
  if (!text.includes('PRIVATE KEY')) return text;
  // [start, end, merge]: `merge` regions join the one before when only blanks lie between them
  const regions: Array<[number, number, boolean]> = [];
  let floor = 0;
  // Line boundaries and the next END marker are remembered, so that many markers on one long line do not
  // each rescan the rest of that line (or of the text)
  let nlFrom = 0;
  let nlAt = -2;
  const newlineAfter = (pos: number): number => {
    if (nlAt === -2 || pos < nlFrom || (nlAt >= 0 && pos > nlAt)) {
      nlAt = text.indexOf('\n', pos);
      nlFrom = pos;
    }
    return nlAt;
  };
  let bolTo = -1;
  let bolAt = 0;
  const lineStartBefore = (pos: number): number => {
    if (pos < bolAt || pos > bolTo) {
      bolAt = text.lastIndexOf('\n', pos - 1) + 1;
      bolTo = newlineAfter(pos) < 0 ? text.length : newlineAfter(pos);
    }
    return bolAt;
  };
  let endFrom = -1;
  let endHit: RegExpExecArray | null = null;
  const nextEnd = (from: number): RegExpExecArray | null => {
    if (endFrom < 0 || from < endFrom || (endHit !== null && endHit.index < from)) {
      PEM_END_RE.lastIndex = from;
      endHit = PEM_END_RE.exec(text);
      endFrom = from;
    }
    return endHit;
  };
  PEM_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PEM_MARKER_RE.exec(text)) !== null) {
    const markerEnd = m.index + m[0].length;
    if (markerEnd <= floor) continue;
    const lineStart = lineStartBefore(m.index);
    const nl = newlineAfter(markerEnd);
    const rawEnd = nl < 0 ? text.length : nl;
    const lineEnd = rawEnd > markerEnd && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    let start = m.index;
    let end = markerEnd;
    let merge = false;
    if (m[1] === 'END') {
      // key lines above the marker, up to the BEGIN marker line (inclusive) or the previous region
      let cur = lineStart;
      while (cur > 0 && cur > floor) {
        const prev = cur >= 2 ? text.lastIndexOf('\n', cur - 2) + 1 : 0;
        if (prev < floor) break;
        const line = text.slice(prev, cur - 1).replace(/\r$/, '');
        if (!isKeyLine(line) && line.trim() !== '') break;
        cur = prev;
        if (/-----BEGIN /.test(line)) break;
      }
      if (cur < lineStart) {
        start = cur;
        merge = true;
      }
    } else {
      const rest = text.slice(markerEnd, Math.min(lineEnd, markerEnd + 256));
      if (KEY_SAME_LINE_BODY_RE.test(rest)) {
        // the key is written on one line: up to its END marker, else to the end of the line
        const close = nextEnd(markerEnd);
        end = close && close.index < lineEnd ? close.index + close[0].length : lineEnd;
      } else if (markerEnd + rest.length === lineEnd && rest.trim() === '') {
        let pos = lineEnd + (text.charCodeAt(lineEnd) === 13 ? 2 : 1);
        let first = true;
        while (pos < text.length) {
          const le = contentEndOf(text, pos);
          const line = text.slice(pos, le);
          const next = le + (text.charCodeAt(le) === 13 ? 2 : 1);
          if (line.trim() === '') {
            pos = next;
            continue;
          }
          PEM_END_RE.lastIndex = 0;
          const close = PEM_END_RE.exec(line);
          if (close) {
            end = pos + close.index + close[0].length;
            break;
          }
          // a short base64 line is key material only as the very last line of the text; before an END marker
          // it is picked up from the marker's side
          const keyLine = isStrongKeyLine(line) || (!first && PEM_MARKER_LINE_RE.test(line)) || (KEY_BODY_LINE_RE.test(line) && text.slice(next).trim() === '');
          if (!keyLine) break;
          first = false;
          end = le;
          pos = next;
        }
      }
    }
    regions.push([start, end, merge]);
    floor = end;
    PEM_MARKER_RE.lastIndex = Math.max(PEM_MARKER_RE.lastIndex, end);
  }
  if (regions.length === 0) return text;

  let out = '';
  let copied = 0;
  let [curStart, curEnd] = regions[0];
  const flush = () => {
    out += text.slice(copied, curStart) + REDACTED;
    copied = curEnd;
    tally.count++;
  };
  for (let i = 1; i < regions.length; i++) {
    const [s, e, merge] = regions[i];
    if (s <= curEnd || (merge && /^\s*$/.test(text.slice(curEnd, s)))) {
      curEnd = Math.max(curEnd, e);
    } else {
      flush();
      [curStart, curEnd] = [s, e];
    }
  }
  flush();
  return out + text.slice(copied);
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** True when the start of a base64 blob decodes to text containing "PRIVATE KEY". */
function base64HeadHasPrivateKey(b64: string): boolean {
  let decoded = '';
  let acc = 0;
  let bits = 0;
  const limit = Math.min(b64.length, 96);
  for (let i = 0; i < limit; i++) {
    const v = B64_ALPHABET.indexOf(b64[i]);
    if (v < 0) break;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return decoded.includes('PRIVATE KEY');
}

/** A PEM private key that was base64 encoded as a whole (Kubernetes tls.key, `base64 id_rsa`). */
const BASE64_PEM_RULE: Rule = {
  re: /(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/]{14,}={0,2}(?:\r?\n[A-Za-z0-9+/]{16,}={0,2}){0,4000}/g,
  apply: (m) => (base64HeadHasPrivateKey(m[0]) ? { end: m.index + m[0].length, replacement: REDACTED } : null),
};

// ---------------------------------------------------------------------------------------------
// Token formats with a recognisable prefix
// ---------------------------------------------------------------------------------------------

const TOKEN_RULES: Rule[] = [
  // GitHub
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g,
  // Anthropic and OpenAI (sk-proj-... is covered by the generic sk- form)
  /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g,
  // Slack tokens and incoming webhooks, Discord webhooks
  /(?<![A-Za-z0-9_])xox[a-z]-[A-Za-z0-9-]{10,}/g,
  /(?:https?:\/\/)?hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{8,}/g,
  /(?:https?:\/\/)?discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[A-Za-z0-9_-]{20,}/g,
  // Google API keys, OAuth client secrets and access tokens
  /(?<![A-Za-z0-9_])AIza[A-Za-z0-9_-]{30,}/g,
  /(?<![A-Za-z0-9_])GOCSPX-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])ya29\.[A-Za-z0-9_-]{20,}/g,
  // GitLab, npm, Stripe, SendGrid, Hugging Face, DigitalOcean, PyPI, Docker Hub, Shopify, Telegram
  /(?<![A-Za-z0-9_])gl(?:pat|ptt|rt|dt|soat|cbt|imt|agent|oas|ffct)-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /(?<![A-Za-z0-9_])whsec_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9_])do[por]_v1_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_])pypi-[A-Za-z0-9_-]{30,}/g,
  /(?<![A-Za-z0-9_])dckr_pat_[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])shp(?:at|ca|pa|ss)_[A-Fa-f0-9]{32}/g,
  /(?<![\w:])\d{8,10}:AA[A-Za-z0-9_-]{32,}/g,
  // Slack app-level tokens, Notion, Terraform Cloud, Twilio API keys, HashiCorp Vault, age secret keys
  /(?<![A-Za-z0-9_])xapp-\d-[A-Za-z0-9-]{20,}/g,
  /(?<![A-Za-z0-9_])(?:secret_[A-Za-z0-9]{40,}|ntn_[A-Za-z0-9]{30,})/g,
  /(?<![A-Za-z0-9_])[A-Za-z0-9]{1,32}\.atlasv1\.[A-Za-z0-9_=-]{40,}/g,
  /(?<![A-Za-z0-9_])SK[0-9a-f]{32}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])hv[sbr]\.[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])AGE-SECRET-KEY-1[A-Z0-9]{50,}/g,
  // AWS access key ids
  /(?<![A-Za-z0-9_])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  // Password hashes (crypt $1$ $5$ $6$ $y$ $2b$ $apr1$ ..., LDAP {SSHA}, NTLM pairs from pwdump/secretsdump)
  /(?<![A-Za-z0-9_$])\$(?:1|5|6|7|y|2[abxy]?|argon2(?:id|i|d)|apr1|scrypt|pbkdf2[-\w]*)\$[\w./+=,$-]{16,}/g,
  /(?<![A-Za-z0-9_])\{(?:S?SHA(?:1|256|384|512)?|CRYPT|S?MD5|PBKDF2[-\w]*)\}[A-Za-z0-9+/=]{8,}/g,
  /(?<![A-Fa-f0-9])[A-Fa-f0-9]{32}:[A-Fa-f0-9]{32}(?![A-Fa-f0-9])/g,
  // Bare JWTs: header and payload start with base64url of `{"`
  /(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
].map(wholeMatch);

const AWS_SECRET_TOKEN_RE = /(?<![A-Za-z0-9/+=_-])[A-Za-z0-9/+=_-]{40,}(?![A-Za-z0-9/+=_-])/g;

/**
 * `aws sts ... --output text` and CSV exports put the access key id, the 40 character secret access key
 * and the session token on one line without any name. On a line that holds an access key id, every long
 * base64-like field is a credential.
 */
const AWS_CREDENTIAL_ROW_RULE: Rule = {
  re: /(?<![A-Za-z0-9_])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])[^\r\n]{0,4096}/g,
  apply: (m) => {
    const tail = m[0].slice(20).replace(AWS_SECRET_TOKEN_RE, REDACTED);
    return { end: m.index + m[0].length, replacement: REDACTED + tail };
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP headers
// ---------------------------------------------------------------------------------------------

const SCHEME_RE = /([A-Za-z][A-Za-z0-9._~+-]{0,30})[ \t]+(?=\S)/y;
const JSON_SCALAR_RE = /[^\s,}\]]+/y;

/**
 * Authorization, Proxy-Authorization, Cookie and Set-Cookie, as a header line, inside a quoted curl
 * argument or as a JSON/Python key. The whole value is masked up to the end of the line or the closing
 * quote; the auth scheme (Bearer, Basic, Digest ...) stays visible.
 */
const HEADER_RULE: Rule = {
  re: /(?<![\w-])(["']?)((?:Proxy-)?Authorization|(?:Set-)?Cookie)(["']?)[ \t]{0,8}(?::|=|,)[ \t]{0,8}(["']?)/gi,
  apply: (m, text) => {
    const vs = m.index + m[0].length;
    // `=` is an assignment (PowerShell @{Authorization="Basic x"}); a comma only separates the quoted name from
    // its value in a call (`Header.Set("Authorization", "Basic x")`), not words in a list of header names
    const sep = m[0].slice(m[1].length + m[2].length + m[3].length, m[0].length - m[4].length);
    if (sep.includes(',') && !(m[1] && m[3] && text.charAt(m.index - 1) === '(')) return null;
    // Already masked: look before scanning the rest of the line
    if (maskedAt(text, vs)) return null;
    SCHEME_RE.lastIndex = vs;
    const scheme = /cookie/i.test(m[2]) ? null : SCHEME_RE.exec(text);
    if (scheme && maskedAt(text, vs + scheme[0].length)) return null;
    // A list or object (`"authorization": ["Bearer x"]`, Go's `map[Authorization:[Bearer x]]`) is masked
    // as a whole, so the rest of the line survives
    const first = text.charCodeAt(vs);
    if (!m[4] && (first === 91 || first === 123)) {
      const close = balancedEnd(text, vs);
      if (close > 0) return { start: vs, end: close, replacement: REDACTED };
    }
    // A JSON key with a bare value (null, a number) ends at the next delimiter, not at the end of the line
    if (!m[4] && m[1] && m[3]) {
      JSON_SCALAR_RE.lastIndex = vs;
      const scalar = JSON_SCALAR_RE.exec(text);
      if (!scalar || /^(?:null|true|false)$/.test(scalar[0])) return null;
      return { start: vs, end: vs + scalar[0].length, replacement: REDACTED };
    }
    const terminator = m[4] || (m[1] && !m[3] ? m[1] : '');
    const end = trimEndIndex(text, vs, scanValueEnd(text, vs, terminator, true));
    if (end <= vs) return null;
    return { start: vs, end, replacement: scheme ? `${scheme[1]} ${REDACTED}` : REDACTED };
  },
};

const BEARER_PROSE = /^(?:authentication|authorization|authorisation|authenticated|authorized|auth|tokens?|schemes?|headers?|types?|realm|credentials?|flow|access|required|missing|invalid|expired|prefix|value|strategy|scopes?|methods?|challenge|security|protocol|format|prefixed)$/i;

const BEARER_RULE: Rule = {
  re: /(?<![A-Za-z0-9_])(Bearer)[ \t]{1,8}([A-Za-z0-9._~+/=-]{8,})/gi,
  // "using Bearer authentication" is prose: a word of the HTTP vocabulary is not a token (any other word is)
  apply: (m) => (BEARER_PROSE.test(m[2]) ? null : { end: m.index + m[0].length, replacement: `${m[1]} ${REDACTED}` }),
};

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

/**
 * user:password@host (also an empty user, as in redis://:pw@host, and passwords holding an @), and a
 * long opaque token used as the user name (https://TOKEN@github.com/...).
 */
const URL_USERINFO_RULE: Rule = {
  re: /:(?:\\?\/){2}(?:([^\s/:@]{0,128}:)([^\s/]+)|([A-Za-z0-9._~%+-]{20,512}))@/g,
  apply: (m) => {
    const end = m.index + m[0].length;
    // keep the slashes as they were written (`:\/\/` in PHP's json_encode output)
    const scheme = /^:(?:\\?\/){2}/.exec(m[0])?.[0] ?? '://';
    if (m[3] !== undefined) {
      if (!/\d/.test(m[3]) || !/[A-Za-z]/.test(m[3])) return null;
      return { end, replacement: `${scheme}${REDACTED}@` };
    }
    if (isMasked(m[2])) return null;
    return { end, replacement: `${scheme}${m[1]}${REDACTED}@` };
  },
};

/** Signature query parameters of Azure SAS tokens and presigned URLs. */
const SIGNATURE_PARAM_RULE: Rule = {
  re: /([?&](?:sig|signature|X-Amz-Signature|X-Goog-Signature)=)([^&\s"'#]+)/gi,
  apply: (m) => (isMasked(m[2]) ? null : { end: m.index + m[0].length, replacement: `${m[1]}${REDACTED}` }),
};

// ---------------------------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------------------------

/**
 * Options that carry a secret: --password, --db-password, --api-key, --client-secret, keytool's -storepass.
 * The name is matched in its normalised form (lower case, hyphens), so --db_password and --dbPassword count.
 */
const SENSITIVE_FLAG = /^(?!no-)(?:[a-z0-9]+-)*(?:password|passwd|pass|passphrase|pwd|secret|token|credentials?|api-?key|access-?key|secret-?key|secret-?access-?key|(?:store|key|deststore|destkey|srcstore|srckey)pass)(?:-(?:hash|value|text))?$/;

function normalizeFlag(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

const LONG_FLAG_RULE: Rule = {
  // Single-dash long options are real flags too (PowerShell -Password, keytool -storepass, java -password)
  re: /(?<![\w-])(--?)([A-Za-z][A-Za-z0-9_-]{0,48})(=|[ \t]+)/g,
  apply: (m, text) => {
    const flag = normalizeFlag(m[2]);
    // `--auth user:password` (httpie); a bare --auth is a switch (mongod --auth)
    const authFlag = flag === 'auth';
    if (!authFlag && !SENSITIVE_FLAG.test(flag)) return null;
    const vs = m.index + m[0].length;
    const v = readValue(text, vs);
    if (!v || isMasked(v.raw)) return null;
    // `--token --verbose`: the next word is another flag, not a value; `--token = x` is an assignment
    if (m[3] !== '=' && (v.raw.startsWith('-') || v.raw.startsWith('=') || v.raw.startsWith(':'))) return null;
    if (authFlag && !v.raw.includes(':')) return null;
    // `openssl -pass env:VAR`, `-pass file:path`: where the password is, not the password
    if (flag === 'pass' && /^["']?(?:env|file|fd|stdin)\b/.test(v.raw)) return null;
    return { start: vs, end: v.end, replacement: REDACTED };
  },
};

interface ShortFlagOptions {
  /** Matches the flag and the separator; the value starts right after the match. */
  re: RegExp;
  anchors: readonly string[];
  /** Words between the command and the flag that mean the flag belongs to another command. */
  stop?: RegExp;
  /** Accept values that start with a dash (attached forms such as mysql -pSECRET). */
  allowDash?: boolean;
}

function shortFlagRule({ re, anchors, stop, allowDash }: ShortFlagOptions): Rule {
  return {
    re,
    apply: (m, text) => {
      if (!inCommand(text, m.index, anchors, stop)) return null;
      const vs = m.index + m[0].length;
      const v = readValue(text, vs);
      if (!v || isMasked(v.raw) || (!allowDash && v.raw.startsWith('-'))) return null;
      // `ssh-keygen -N ""` sets an empty passphrase
      if (v.raw === '""' || v.raw === "''") return null;
      return { start: vs, end: v.end, replacement: REDACTED };
    },
  };
}

const MONGO_TOOLS = ['mongosh', 'mongodump', 'mongorestore', 'mongoexport', 'mongoimport', 'mongostat', 'mongotop', 'mongofiles', 'mongo'];

const SHORT_FLAG_RULES: Rule[] = [
  // mysql -pSECRET (attached only; a bare -p asks for the password interactively)
  shortFlagRule({ re: /(?<=[ \t])-p(?=\S)/g, anchors: ['mysql', 'mariadb', 'mycli'], allowDash: true }),
  // 7z a -pSECRET archive.7z
  shortFlagRule({ re: /(?<=[ \t])-p(?=\S)/g, anchors: ['7z', '7za', '7zr', '7zz'] }),
  shortFlagRule({ re: /(?<=[ \t])-p[ \t]*(?=\S)/g, anchors: ['sshpass'], stop: /\b(?:ssh|scp|sftp|rsync)\b/ }),
  shortFlagRule({ re: /(?<=[ \t])-p[ \t]*(?=\S)/g, anchors: ['docker login', 'podman login', 'nerdctl login'] }),
  shortFlagRule({ re: /(?<=[ \t])-a[ \t]+(?=\S)/g, anchors: ['redis-cli'] }),
  shortFlagRule({ re: /(?<=[ \t])-w[ \t]+(?=\S)/g, anchors: ['ldap'] }),
  // mongosh -p SECRET, cqlsh -p SECRET, hydra -p SECRET, az login -p SECRET
  shortFlagRule({ re: /(?<=[ \t])-p[ \t]+(?=\S)/g, anchors: [...MONGO_TOOLS, 'cqlsh', 'hydra', 'az login', 'az acr login'] }),
  // sqlcmd -P, bcp -P, ipmitool -P, mosquitto_pub -P, zip -P, unzip -P
  shortFlagRule({
    re: /(?<=[ \t])-P[ \t]*(?=\S)/g,
    anchors: ['sqlcmd', 'bcp', 'ipmitool', 'mosquitto_pub', 'mosquitto_sub', 'mosquitto_rr', 'zip', 'unzip', 'zipcloak'],
  }),
  // ssh-keygen -N new_passphrase, -P old_passphrase
  shortFlagRule({ re: /(?<=[ \t])-[NP][ \t]+(?=\S)/g, anchors: ['ssh-keygen'] }),
  // openssl enc -k password
  shortFlagRule({ re: /(?<=[ \t])-k[ \t]+(?=\S)/g, anchors: ['openssl'] }),
  // xfreerdp /p:SECRET
  shortFlagRule({ re: /(?<=[ \t])\/p:(?=\S)/g, anchors: ['xfreerdp', 'wlfreerdp', 'freerdp'] }),
];

/** Option and value of `user:password` arguments: the user name stays, the password goes. */
function userPasswordRule(re: RegExp, anchors: readonly string[]): Rule {
  return {
    re,
    apply: (m, text) => {
      if (!inCommand(text, m.index, anchors)) return null;
      const vs = m.index + m[0].length;
      const v = readArgument(text, vs, m[1]);
      if (!v || isMasked(v.raw)) return null;
      return { start: vs, end: v.end, replacement: REDACTED };
    },
  };
}

/**
 * curl -u user:password, --user user:password, --proxy-user user:password, also bundled or attached
 * (-sSu user:pw, -fsSLu user:pw, -uuser:pw).
 */
const CURL_USER_RULE = userPasswordRule(
  /(?<=[ \t])(?:(?:--user|--proxy-user)(?:=|[ \t]+)|-[A-Za-z0-9]*u[ \t]*)(["']?)[^\s:"'$]{0,64}:/g,
  ['curl']
);

/** httpie: http -a user:password, https --auth user:password, xh -a user:password */
const HTTPIE_AUTH_RULE = userPasswordRule(/(?<=[ \t])(?:-a|--auth)(?:=|[ \t]+)(["']?)[^\s:"'$]{0,64}:/g, ['http ', 'https ', 'xh ', 'xhs ']);

/** haproxy: stats auth admin:password */
const HAPROXY_STATS_RULE: Rule = {
  re: /(?<![\w-])stats[ \t]+auth[ \t]+(["']?)[^\s:"']{1,64}:/gi,
  apply: (m, text) => {
    const vs = m.index + m[0].length;
    const v = readArgument(text, vs, m[1]);
    if (!v || isMasked(v.raw)) return null;
    return { start: vs, end: v.end, replacement: REDACTED };
  },
};

/** sqlplus user/password@db, also sqlldr, expdp, impdp and rman target. */
const SQLPLUS_RULE: Rule = {
  re: /(?<![\w-])(?:sqlplus|sqlcl|sqlldr|expdp|impdp|rman[ \t]+target)(?:[ \t]+-[A-Za-z]\w*){0,6}[ \t]+(?:userid=)?[A-Za-z][\w$#.-]{0,63}\//gi,
  apply: (m, text) => {
    const vs = m.index + m[0].length;
    let end = vs;
    while (end < text.length && !/[\s@"']/.test(text.charAt(end))) end++;
    if (end <= vs || isMasked(text.slice(vs, end))) return null;
    return { start: vs, end, replacement: REDACTED };
  },
};

/** curl -b 'name=value' / --cookie 'name=value' (a bare file name after -b is left alone). */
const CURL_COOKIE_RULE: Rule = {
  re: /(?<=[ \t])(?:-b|--cookie)(?:=|[ \t]+)(["']?)(?=[^\s"'])/g,
  apply: (m, text) => {
    if (!inCommand(text, m.index, ['curl'])) return null;
    const vs = m.index + m[0].length;
    const v = readArgument(text, vs, m[1]);
    if (!v || isMasked(v.raw) || !v.raw.includes('=')) return null;
    return { start: vs, end: v.end, replacement: REDACTED };
  },
};

/** openssl -passin pass:SECRET, -passout pass:SECRET, -pass pass:SECRET (env: and file: are not secrets). */
const OPENSSL_PASS_RULE: Rule = {
  re: /(?<=[ \t])-pass(?:in|out|word)?[ \t]+(["']?)pass:/g,
  apply: (m, text) => {
    const vs = m.index + m[0].length;
    const v = readArgument(text, vs, m[1]);
    if (!v || isMasked(v.raw)) return null;
    return { start: vs, end: v.end, replacement: REDACTED };
  },
};

/** SQL: IDENTIFIED BY 'x', PASSWORD 'x', PASSWORD('x'). Only quoted values; `password = 'x'` is an assignment. */
const SQL_PASSWORD_RULE: Rule = {
  re: /(?<![\w"'-])(?:identified[ \t]{1,64}(?:with[ \t]{1,64}\w{1,40}[ \t]{1,64})?by|password|passwd)(?:[ \t]{1,64}\(?|[ \t]{0,64}\()[ \t]{0,64}(?=["'])/gi,
  apply: (m, text) => {
    const vs = m.index + m[0].length;
    const v = readValue(text, vs);
    if (!v || isMasked(v.raw)) return null;
    return { start: vs, end: v.end, replacement: REDACTED };
  },
};

/** .netrc one-liner: machine example.com login bob password hunter2 (also haproxy `user bob insecure-password x`). */
const NETRC_RULE: Rule = {
  re: /(?<![\w-])(?:login[ \t]+\S{1,128}[ \t]+password|user(?:name)?[ \t]+\S{1,128}[ \t]+insecure-password)[ \t]+/gi,
  apply: (m, text) => {
    const vs = m.index + m[0].length;
    const v = readValue(text, vs);
    if (!v || isMasked(v.raw)) return null;
    return { start: vs, end: v.end, replacement: REDACTED };
  },
};

// ---------------------------------------------------------------------------------------------
// NAME=value, NAME: value, "name": "value", <name>value</name>
// ---------------------------------------------------------------------------------------------

/** Cheap pre-filter so the full normalisation only runs for names that could be sensitive. */
const NAME_QUICK = /pass|pwd|pw|secret|token|cred|key|pin|auth|psk|salt/i;

/** Keywords that are safe to look for inside a longer name (run together, any case: DBPASSWORDs, mysqlSecret). */
const SENSITIVE_SUBSTRING = new RegExp(
  [
    'passw(?:or)?d',
    'pass_?phrase',
    // not "secretary" or "tokenizer"
    'secret(?!ar)',
    'token(?!i[sz])',
    'credential',
    'apikey',
    'pre_?shared_?key',
    '(?:api|access|private|auth|signing|encryption|master|account|subscription)_?key',
  ].join('|')
);

/** Short words only count as whole words, so that compass, bypass, passenger, mapping, spinner stay clean. */
const SENSITIVE_WORD = /(?:^|_)(?:pass|pw|pwd|pin|creds?|psk|salt)\d*(?:_|$)|key_data$/;

/**
 * Run-together names such as DBPASS, SSHPASS, ROOTPW or DBPWD. Ordinary words that end in "pass" are
 * excluded, and so is OLDPWD (the shell's previous directory).
 */
const RUN_TOGETHER_PASS = /^([a-z]{2,})(?:pass|pwd|pw)\d*$/;
const NOT_PASS_PREFIX = /^(?:by|com|sur|tres|over|under|encom|im|low|high|band|old|cur|boarding)$/;

/** Names ending in _KEY (APP_KEY, DEPLOY_KEY) except the well known non-secret kinds of key. */
const KEY_SUFFIX = /(?:^|_)([a-z0-9]+)_key$/;
const NOT_SECRET_KEY = new Set([
  'public', 'primary', 'foreign', 'sort', 'partition', 'hash', 'range', 'cache', 'group', 'order', 'join', 'unique',
  'composite', 'natural', 'surrogate', 'lookup', 'row', 'shard', 'map', 'object', 'idempotency', 'routing', 'message',
  'record', 'authorized', 'index', 'lock', 's3', 'gcs', 'blob', 'file', 'image', 'kms', 'dedup', 'config', 'table',
]);

/** A name whose value is a place or a limit about the secret, not the secret itself (secrets_dir, token_file, PASS_MAX_DAYS). */
const NOT_SECRET_SUFFIX = /(?:^|_)(?:dir|directory|path|file|folder|name|type|length|len|policy|enabled|ttl|timeout|url|uri|endpoint|days|age|min|max|limit|count|attempts|retries|interval|expiry|expires|rounds)$/;

/** Names that are secrets only when the value looks like an opaque credential (docker config "auth"). */
const OPAQUE_NAME = /(?:^|_)auth$/;
const OPAQUE_VALUE = /^["']?[A-Za-z0-9+/=_-]{16,}["']?$/;
/** The base64 of a short `user:password` (an .npmrc _auth or docker config auth entry). */
const SHORT_BASE64 = /^[A-Za-z0-9+/]{8,15}={0,2}$/;
/** `user:password` as the value of BASIC_AUTH, HTTP_AUTH, PROXY_AUTH; not host:port or a URL. */
const USER_PASSWORD = /^[^\s:"'/@]{1,64}:(?!\/\/)(?!\d+$)[^\s"']{3,}$/;

function looksOpaque(raw: string): boolean {
  if (OPAQUE_VALUE.test(raw)) return true;
  const v = raw.replace(/^["']|["']$/g, '');
  if (SHORT_BASE64.test(v) && (/\d/.test(v) || v.endsWith('=') || /[A-Z].*[A-Z]/.test(v))) return true;
  return USER_PASSWORD.test(v);
}

/**
 * Values that say a feature is off or unset (`PasswordAuthentication=no`), or a placeholder in angle
 * brackets (kubectl's `<set to the key 'password' in secret 'db'>`): not a password.
 */
const BENIGN_VALUE = /^(?:["']?(?:yes|no|true|false|on|off|none|null|nil|undefined|enabled|disabled|required|optional|prohibit-password|without-password|forced-commands-only)["']?$|<[^<>\r\n]{1,100}>)/i;

/** A plain English sentence (`passwd: all authentication tokens updated successfully.`) is not a value. */
const SENTENCE = /^[a-z][a-z' ,-]*(?: [a-z][a-z' ,-]*){3,}\.$/;

const NOT_SENSITIVE = 0;
const SENSITIVE = 1;
const SENSITIVE_IF_OPAQUE = 2;
/** primaryKey, key1, key2 (Azure access keys): a secret only when the value is a long mixed-case blob, not a column name or an id. */
const SENSITIVE_IF_LONG = 3;
const LONG_OPAQUE_VALUE = /^[A-Za-z0-9+/=_-]{20,}$/;
const KEY_NUMBERED = /(?:^|_)key[12]$/;

function looksLongOpaque(raw: string): boolean {
  const v = raw.replace(/^["']|["']$/g, '');
  return LONG_OPAQUE_VALUE.test(v) && /[A-Z]/.test(v) && /[a-z0-9]/.test(v);
}

function sensitivity(rawName: string): number {
  if (!NAME_QUICK.test(rawName)) return NOT_SENSITIVE;
  // Only the last two dotted segments describe the key, so host names such as token.example.com stay clean.
  const parts = rawName.split('.');
  const tail = parts.length > 2 ? parts.slice(-2).join('.') : rawName;
  const words = tail
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  if (NOT_SECRET_SUFFIX.test(words)) return NOT_SENSITIVE;
  if (SENSITIVE_SUBSTRING.test(tail.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase())) return SENSITIVE;
  if (SENSITIVE_WORD.test(words)) return SENSITIVE;
  const run = RUN_TOGETHER_PASS.exec(words.slice(words.lastIndexOf('_') + 1));
  if (run && !NOT_PASS_PREFIX.test(run[1])) return SENSITIVE;
  const key = KEY_SUFFIX.exec(words);
  if (key && key[1] === 'primary') return SENSITIVE_IF_LONG;
  if (key && !NOT_SECRET_KEY.has(key[1])) return SENSITIVE;
  if (KEY_NUMBERED.test(words)) return SENSITIVE_IF_LONG;
  return OPAQUE_NAME.test(words) ? SENSITIVE_IF_OPAQUE : NOT_SENSITIVE;
}

/** End of the `[...]` or `{...}` group that opens at `pos`, or -1 (unbalanced, or longer than `limit`). */
function balancedEnd(text: string, pos: number, limit = 2048): number {
  let depth = 0;
  let quote = 0;
  const stop = Math.min(text.length, pos + limit);
  for (let i = pos; i < stop; i++) {
    const c = text.charCodeAt(i);
    if (quote) {
      if (c === 92) i++;
      else if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 91 || c === 123) depth++;
    else if ((c === 93 || c === 125) && --depth === 0) return i + 1;
  }
  return -1;
}

/** Rest of the line from `pos`, without trailing blanks: an unquoted YAML/INI value may hold spaces. */
const LINE_VALUE_RE = valueRegExp(String.raw`[^\r\n]*[^\s]`);
/** Only a plain `name: value` / `name = value` at the start of a line takes the whole rest of the line. */
function atLineStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9 || text.charCodeAt(i) === 45)) i--;
  return i < 0 || text.charCodeAt(i) === 10;
}

/** `NAME=value` and `NAME: value` (no `==`, `=>`): at the start of a line the whole rest of the line is the value (env, .env, ini). */
const PLAIN_SEPARATOR = /^[ \t]*[=:][ \t]*$/;
/** `AccountKey=abc;EndpointSuffix=x`: the value ends at the next `;Name=`, it is not a line of words. */
const CONNECTION_STRING_HEAD = /^\S*;[A-Za-z]/;
const BLOCK_SCALAR_HEAD = /^(?:![^\s]*[ \t]+)?[|>][+-]?\d?$/;

/**
 * A YAML block scalar (`secret: |`, `key: !vault |`) is a value too: its indented lines follow the key.
 * Returns the end of the last line that belongs to it, or -1 when the value at `vs` is not a block scalar.
 */
function blockScalarEnd(text: string, keyPos: number, vs: number): number {
  // look at a short window only: a long line must not be rescanned for every match on it
  const nl = text.slice(vs, vs + 81).indexOf('\n');
  const le = nl >= 0 ? vs + nl : vs + 81 > text.length ? text.length : -1;
  if (le < 0 || !BLOCK_SCALAR_HEAD.test(text.slice(vs, le).trim())) return -1;
  let keyIndent = 0;
  for (let i = lineStartOf(text, keyPos); i < keyPos && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9); i++) keyIndent++;
  let last = -1;
  for (let pos = le + 1; pos < text.length; ) {
    const e = lineEndAt(text, pos);
    const line = text.slice(pos, e).replace(/\r$/, '');
    if (line.trim() !== '') {
      if (indentOf(line) <= keyIndent) break;
      last = pos + line.trimEnd().length;
    }
    pos = e + 1;
  }
  return last;
}

const ASSIGNMENT_RULE: Rule = {
  re: /(?<![\w-])(["']?)((?:[\w-]{1,40}\.){0,2}[\w-]{1,100})(["']?)([ \t]{0,64}(?:=>|:=|==|=|:)[ \t]{0,200})/g,
  apply: (m, text) => {
    let kind = sensitivity(m[2]);
    // `\npassword=x` in a one-line JSON string: the `n` of the escape is not part of the name
    const escaped = kind === NOT_SENSITIVE && !m[1] && 'nrt'.includes(m[2][0]) && m[2].length > 1 && text.charAt(m.index - 1) === '\\';
    if (escaped) kind = sensitivity(m[2].slice(1));
    if (kind === NOT_SENSITIVE) return null;
    const vs = m.index + m[0].length;
    // The shell's own working directory variable is not a password
    if (m[2] === 'PWD' && /^["']?[/~]/.test(text.slice(vs, vs + 2))) return null;
    if (maskedAt(text, vs)) return null;
    // `'X-Api-Key: abc'`: one quote opened before the name encloses the whole pair
    const enclosing = m[1] && !m[3] ? m[1] : '';
    let end: number;
    if (enclosing) {
      end = trimEndIndex(text, vs, scanValueEnd(text, vs, enclosing));
    } else {
      const c = text.charCodeAt(vs);
      // An array or object under a sensitive name is masked as a whole (`"api_keys": ["a", "b"]`)
      if ((c === 91 || c === 123) && kind === SENSITIVE && !text.startsWith(REDACTED, vs)) {
        const close = balancedEnd(text, vs);
        if (close > 0) return { start: vs, end: close, replacement: REDACTED };
      }
      // In a query string or a connection string the value stops at the next delimiter
      const before = m.index > 0 ? text.charAt(m.index - 1) : '';
      let re = SEGMENT_VALUE_RE;
      const spaced = /[ \t]$/.test(m[4]) && (m[4].includes(':') || /^[ \t]/.test(m[4].slice(m[4].search(/[=:]/) - 1)));
      if ((before === '?' || before === '&') && m[4].includes('=')) re = QUERY_VALUE_RE;
      else if (before === ';') re = SEMICOLON_VALUE_RE;
      else if (kind === SENSITIVE && !m[1] && !m[3] && !escaped && (spaced || (PLAIN_SEPARATOR.test(m[4]) && !CONNECTION_STRING_HEAD.test(text.slice(vs, vs + 200)))) && atLineStart(text, m.index)) re = LINE_VALUE_RE;
      const v = readValue(text, vs, re);
      if (!v) return null;
      end = v.end;
    }
    if (end <= vs) return null;
    const raw = text.slice(vs, end);
    if (isMasked(raw) || BENIGN_VALUE.test(raw)) return null;
    if (kind === SENSITIVE_IF_OPAQUE && !looksOpaque(raw)) return end;
    if (kind === SENSITIVE_IF_LONG && !looksLongOpaque(raw)) return end;
    if (kind === SENSITIVE_IF_LONG) return { start: vs, end, replacement: REDACTED };
    if (kind === SENSITIVE && !enclosing) {
      const block = blockScalarEnd(text, m.index, vs);
      if (block > end) return { start: vs, end: block, replacement: REDACTED };
    }
    if (SENTENCE.test(raw)) return null;
    return { start: vs, end, replacement: REDACTED };
  },
};

/** <password>x</password> (Maven settings.xml, Tomcat and similar). */
const XML_TEXT_RE = /[^<\r\n]+/y;

function xmlTextHit(text: string, vs: number): Hit | null {
  XML_TEXT_RE.lastIndex = vs;
  const t = XML_TEXT_RE.exec(text);
  if (!t) return null;
  const end = trimEndIndex(text, vs, vs + t[0].length);
  if (end <= vs || isMasked(text.slice(vs, end))) return null;
  return { start: vs, end, replacement: REDACTED };
}

const XML_ELEMENT_RULE: Rule = {
  re: /<([A-Za-z_][\w.-]{0,63})>/g,
  apply: (m, text) => (sensitivity(m[1]) !== SENSITIVE ? null : xmlTextHit(text, m.index + m[0].length)),
};

/** Hadoop and Hibernate: <name>fs.s3a.secret.key</name><value>x</value> */
const XML_NAME_VALUE_RULE: Rule = {
  re: /<name>([^<\r\n]{1,100})<\/name>[ \t\r\n]{0,64}<value>/g,
  apply: (m, text) => (sensitivity(m[1].trim()) !== SENSITIVE ? null : xmlTextHit(text, m.index + m[0].length)),
};

/** web.config and similar: <add key="password" value="x" /> */
const XML_ATTRIBUTE_RULE: Rule = {
  re: /(?<![\w-])(?:key|name)[ \t]{0,4}=[ \t]{0,4}(["'])([\w.:/@-]{1,100})\1[ \t]{1,8}value[ \t]{0,4}=[ \t]{0,4}(?=["'])/gi,
  apply: (m, text) => (sensitivity(m[2]) !== SENSITIVE ? null : pairValueHit(text, m.index + m[0].length)),
};

// ---------------------------------------------------------------------------------------------
// The name is somewhere else than next to the value
// ---------------------------------------------------------------------------------------------

/** The value that starts at `vs` as one token or one quoted string; null when it is masked already or a plain setting. */
function pairValueHit(text: string, vs: number): Hit | null {
  if (maskedAt(text, vs)) return null;
  const v = readValue(text, vs);
  if (!v || isMasked(v.raw) || BENIGN_VALUE.test(v.raw)) return null;
  return { start: vs, end: v.end, replacement: REDACTED };
}

/** The value that starts at `vs` and runs to the end of the line (a table cell, `label: some words`). */
function lineValueHit(text: string, vs: number): Hit | null {
  if (maskedAt(text, vs)) return null;
  const v = readValue(text, vs, LINE_VALUE_RE);
  if (!v || isMasked(v.raw) || BENIGN_VALUE.test(v.raw) || SENTENCE.test(v.raw)) return null;
  return { start: vs, end: v.end, replacement: REDACTED };
}

/**
 * Kubernetes env entries and ECS/Azure style pairs: the name is the value of one key and the secret the
 * value of the next (`- name: DB_PASSWORD` then `value: x`, `{"name": "DB_PASSWORD", "value": "x"}`).
 */
const NAME_VALUE_RULE: Rule = {
  re: /(?<![\w-])(["']?)(?:name|key)\1[ \t]{0,16}:[ \t]{0,16}(["']?)([\w./:@-]{1,120})\2[ \t]{0,16},?[ \t]{0,16}(?:\r?\n[ \t]{0,40})?(?:(?!["']?value["']?[ \t]{0,16}:)["']?\w{1,40}["']?[ \t]{0,16}:[ \t]{0,16}(?:"[^"\r\n]{0,100}"|[^\s,{}\]"]{1,100})[ \t]{0,16},[ \t]{0,16}(?:\r?\n[ \t]{0,40})?){0,3}(["']?)value\4[ \t]{0,16}:[ \t]{0,16}/gi,
  apply: (m, text) => (sensitivity(m[3]) !== SENSITIVE ? null : pairValueHit(text, m.index + m[0].length)),
};

/** The same pair with the value first: {"value": "x", "name": "DB_PASSWORD"} */
const VALUE_NAME_RULE: Rule = {
  re: /((["'])value\2[ \t]{0,16}:[ \t]{0,16})("(?:[^"\\\r\n]|\\.){0,4096}"|'(?:[^'\\\r\n]|\\.){0,4096}'|[^\s,}\]]{1,200})[ \t]{0,16},[ \t]{0,16}(["'])(?:name|key)\4[ \t]{0,16}:[ \t]{0,16}(["'])([\w./:@-]{1,120})\5/gi,
  apply: (m) => {
    if (sensitivity(m[6]) !== SENSITIVE || isMasked(m[3]) || BENIGN_VALUE.test(m[3])) return null;
    const start = m.index + m[1].length;
    return { start, end: start + m[3].length, replacement: REDACTED };
  },
};

/** az storage account keys list: {"keyName": "key1", "permissions": "FULL", "value": "x"} */
const KEY_NAME_VALUE_RULE: Rule = {
  re: /(?<![\w-])(["']?)keyName\1[ \t]{0,16}:[ \t]{0,16}["'][^"'\r\n]{1,100}["'][^{}]{0,200}?(["']?)value\2[ \t]{0,16}:[ \t]{0,16}/gi,
  apply: (m, text) => pairValueHit(text, m.index + m[0].length),
};

/** `aws configure set aws_secret_access_key x`, also with `--profile p` first. */
const AWS_CONFIGURE_SET_RULE: Rule = {
  re: /(?<![\w-])aws[ \t]+configure[ \t]+set[ \t]+(?:--profile[ \t]+\S{1,100}[ \t]+)?([\w.-]{1,100})[ \t]+(?=\S)/g,
  apply: (m, text) => (sensitivity(m[1]) !== SENSITIVE ? null : pairValueHit(text, m.index + m[0].length)),
};

/** aws ssm get-parameter --with-decryption: the Value of a SecureString, whatever the parameter is called. */
const SECURE_STRING_RULE: Rule = {
  re: /(["']?)Type\1[ \t]{0,16}:[ \t]{0,16}["']?SecureString["']?[^{}]{0,400}?(["']?)Value\2[ \t]{0,16}:[ \t]{0,16}/g,
  apply: (m, text) => pairValueHit(text, m.index + m[0].length),
};

/** az keyvault secret show: the `value` of an object whose id is a vault secret URL, whatever the secret is called. */
const KEY_VAULT_SECRET_RULE: Rule = {
  re: /"id"[ \t]{0,16}:[ \t]{0,16}"https:\/\/[^"\s]{1,200}\.vault\.[a-z.]{3,30}\/secrets\/[^"\s]{1,200}"[\s\S]{0,600}?"value"[ \t]{0,16}:[ \t]{0,16}/g,
  apply: (m, text) => pairValueHit(text, m.index + m[0].length),
};

/** wp-config.php define('DB_PASSWORD', 'x'), setProperty("password", "x"), os.environ['API_KEY'] = 'x'. */
const KEYED_VALUE_RULE: Rule = {
  re: /\([ \t]{0,8}(["'])([\w.-]{1,100})\1[ \t]{0,8},[ \t]{0,200}(?=["'])|\[[ \t]{0,8}(["'])([\w.-]{1,100})\3[ \t]{0,8}\][ \t]{0,8}(?:=>|:=|==|=)[ \t]{0,200}/g,
  apply: (m, text) => (sensitivity(m[2] ?? m[4]) !== SENSITIVE ? null : pairValueHit(text, m.index + m[0].length)),
};

/** ipsec.secrets: `%any : PSK "x"` */
const IPSEC_SECRET_RULE: Rule = {
  re: /:[ \t]{1,8}(?:PSK|XAUTH|EAP|NTLM)[ \t]{1,8}(?=\S)/g,
  apply: (m, text) => pairValueHit(text, m.index + m[0].length),
};

/** JSON inside a JSON string: {\"password\":\"x\"} (kubectl annotations, logged request bodies). */
const ESCAPED_JSON_RULE: Rule = {
  re: /(\\{1,4})"([\w.-]{1,100})\1"[ \t]{0,16}:[ \t]{0,16}/g,
  apply: (m, text) => {
    if (sensitivity(m[2]) !== SENSITIVE) return null;
    const quote = `${m[1]}"`;
    const vs = m.index + m[0].length;
    if (maskedAt(text, vs)) return null;
    if (!text.startsWith(quote, vs)) return pairValueHit(text, vs);
    const start = vs + quote.length;
    const end = text.indexOf(quote, start);
    if (end <= start || end - start > 4096 || isMasked(text.slice(start, end))) return null;
    return { start, end, replacement: REDACTED };
  },
};

// ---------------------------------------------------------------------------------------------
// Configuration where the name and the value are separated by blanks only
// ---------------------------------------------------------------------------------------------

/** Directives that are always a credential: redis requirepass, keepalived auth_pass, slapd rootpw ... */
const DIRECTIVE_NAME = /^(?:requirepass|masterauth|masteruserpass|auth[-_]?pass|bind[-_]?pw|rootbindpw|rootpw|smtp[-_]?pass(?:word)?|proxy[-_]?pass(?:word)?)$/i;
const SINGLE_TOKEN = /^(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)$/;
/** A version number (`secretstorage   3.3.3`): package listings are tables of name and version. */
const VERSION_LIKE = /^v?\d+(?:\.\d+){1,3}(?:[-+~.\w]*)$/;
/** A line near by that names a host or account: the context of a .netrc or msmtprc password line. */
const CONFIG_CONTEXT = /(?:^|\n)[ \t]*(?:machine|login|user(?:name)?|host|account|default|from|bind(?:dn)?)[ \t]/i;

/**
 * `name value` at the start of a line (.netrc, msmtprc, BIND `secret "x";`, vault kv tables, psql \x
 * output, `| adminPass | x |`). A name that is not a known directive needs a value that is one token, so
 * a sentence such as "Password policy was updated" is left alone.
 */
const DIRECTIVE_RULE: Rule = {
  re: /^[ \t]{0,64}\|{0,4}[ \t]{0,64}([A-Za-z][\w.-]{0,60})(?:[ \t]{0,64}\|[ \t]{0,64}|[ \t]{1,200})(?=[^\s|=:])/gm,
  apply: (m, text) => {
    const strong = DIRECTIVE_NAME.test(m[1]);
    // `detect-secrets   1.5.0` (pip list, dpkg) is a package, not a setting: a name with dots or hyphens needs to be a known directive
    if (!strong && (!/^\w+$/.test(m[1]) || sensitivity(m[1]) !== SENSITIVE)) return null;
    const vs = m.index + m[0].length;
    if (maskedAt(text, vs)) return null;
    let end = vs;
    while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) end++;
    end = trimEndIndex(text, vs, end);
    // a table border or a statement terminator after the value
    for (let c = text.charCodeAt(end - 1); end > vs && (c === 124 || c === 59); c = text.charCodeAt(end - 1)) end = trimEndIndex(text, vs, end - 1);
    if (end <= vs) return null;
    const raw = text.slice(vs, end);
    if (!SINGLE_TOKEN.test(raw) || isMasked(raw) || BENIGN_VALUE.test(raw)) return null;
    if (!strong && VERSION_LIKE.test(raw)) return null;
    // a plain word is a value only in a file that looks like credentials, or after a directive that is one
    if (!strong && !/[^A-Za-z"']/.test(raw) && !CONFIG_CONTEXT.test(text.slice(Math.max(0, m.index - 300), m.index))) return null;
    return { start: vs, end, replacement: REDACTED };
  },
};

/** `AWS Secret Access Key [None]: x`, `API Key: x`, `Secret ID = x`: a label of several capitalised words (not `const key = x`). */
const LABEL_RULE: Rule = {
  re: /^[ \t]{0,64}((?:[A-Z][A-Za-z0-9]{0,20}[ \t]{1,4}){1,3}[A-Z][A-Za-z0-9]{0,20})(?:[ \t]{0,4}\[[^\]\r\n]{0,40}\])?[ \t]{0,64}[=:][ \t]{0,200}(?=\S)/gm,
  apply: (m, text) => {
    const words = m[1].split(/[ \t]+/);
    if (sensitivity(words.slice(-2).join('_')) !== SENSITIVE) return null;
    return lineValueHit(text, m.index + m[0].length);
  },
};

// ---------------------------------------------------------------------------------------------
// Kubernetes Secret manifests
// ---------------------------------------------------------------------------------------------

const YAML_DATA_RE = /^([ \t]*)(?:data|stringData):[ \t]*\r?$/gm;
const JSON_DATA_RE = /(\\*)"(?:data|stringData)\1"[ \t]{0,16}:[ \t]{0,16}\{/g;
const JSON_KIND_RE = /(\\*)"kind\1"[ \t]{0,16}:[ \t]{0,16}\1"(\w{1,40})\1"/g;
const KIND_WINDOW = 8000;

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i;
}

function lineEndAt(text: string, pos: number): number {
  const e = text.indexOf('\n', pos);
  return e < 0 ? text.length : e;
}

/** Looks for the `kind:` line of the object that owns a `data:` block, first after the block, then before it. */
function yamlKind(text: string, dataStart: number, blockEnd: number, indent: number): string {
  const scan = (from: number, to: number, forward: boolean): string => {
    let pos = from;
    while (forward ? pos < to : pos > to) {
      const start = forward ? pos : text.lastIndexOf('\n', pos - 2) + 1;
      const line = text.slice(start, lineEndAt(text, start)).replace(/\r$/, '');
      pos = forward ? lineEndAt(text, start) + 1 : start;
      if (line.startsWith('---')) return '';
      if (line.trim() === '') continue;
      const ind = indentOf(line);
      if (ind < indent) return '';
      const kind = ind === indent ? /^kind:[ \t]*["']?(\w+)/.exec(line.slice(ind)) : null;
      if (kind) return kind[1];
    }
    return '';
  };
  return scan(blockEnd, Math.min(text.length, blockEnd + KIND_WINDOW), true) || scan(dataStart, Math.max(0, dataStart - KIND_WINDOW), false);
}

/** Replacement ranges for the values under `data:` / `stringData:` of YAML Secret documents. */
function yamlSecretValues(text: string, edits: Array<[number, number]>): void {
  YAML_DATA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = YAML_DATA_RE.exec(text)) !== null) {
    const indent = m[1].length;
    const first = lineEndAt(text, m.index) + 1;
    const found: Array<[number, number]> = [];
    let pos = first;
    while (pos < text.length) {
      const e = lineEndAt(text, pos);
      const line = text.slice(pos, e).replace(/\r$/, '');
      if (line.trim() !== '' && indentOf(line) <= indent) break;
      const ind = indentOf(line);
      const colon = line.slice(ind).search(/:(?:[ \t]|$)/);
      if (line.trim() !== '' && colon >= 0 && !line.slice(ind).startsWith('#')) {
        const rest = line.slice(ind + colon + 1);
        const value = rest.trim();
        const vs = pos + ind + colon + 1 + (rest.length - rest.trimStart().length);
        if (/^[|>][+-]?\d?$/.test(value)) {
          // block scalar: the following deeper lines are the value
          let next = e + 1;
          let last = -1;
          let from = -1;
          while (next < text.length) {
            const ne = lineEndAt(text, next);
            const nl = text.slice(next, ne).replace(/\r$/, '');
            if (nl.trim() !== '' && indentOf(nl) <= ind) break;
            if (nl.trim() !== '') {
              if (from < 0) from = next + indentOf(nl);
              last = next + nl.trimEnd().length;
            }
            next = ne + 1;
          }
          if (from >= 0 && text.slice(from, last) !== REDACTED) found.push([from, last]);
          pos = next;
          continue;
        }
        if (value !== '' && value !== REDACTED) found.push([vs, vs + value.length]);
      }
      pos = e + 1;
    }
    if (found.length === 0) continue;
    if (yamlKind(text, m.index, pos, indent) !== 'Secret') continue;
    for (const f of found) edits.push(f);
    YAML_DATA_RE.lastIndex = Math.max(YAML_DATA_RE.lastIndex, pos);
  }
}

function jsonKind(text: string, open: number, close: number): string {
  JSON_KIND_RE.lastIndex = 0;
  const after = JSON_KIND_RE.exec(text.slice(close, close + KIND_WINDOW));
  if (after) return after[2];
  const win = text.slice(Math.max(0, open - KIND_WINDOW), open);
  let last = '';
  JSON_KIND_RE.lastIndex = 0;
  for (let k = JSON_KIND_RE.exec(win); k !== null; k = JSON_KIND_RE.exec(win)) last = k[2];
  return last;
}

/** Replacement ranges for the string values of `"data": {...}` / `"stringData": {...}` (plain or backslash-escaped JSON). */
function jsonSecretValues(text: string, edits: Array<[number, number]>): void {
  if (!/"(?:data|stringData)/.test(text)) return;
  JSON_DATA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JSON_DATA_RE.exec(text)) !== null) {
    const quote = `${m[1]}"`;
    const open = m.index;
    const found: Array<[number, number]> = [];
    let i = m.index + m[0].length;
    const skipBlank = () => {
      while (i < text.length && /\s/.test(text.charAt(i))) i++;
    };
    for (let n = 0; n < 4096; n++) {
      skipBlank();
      if (!text.startsWith(quote, i)) break;
      const keyEnd = text.indexOf(quote, i + quote.length);
      if (keyEnd < 0) break;
      i = keyEnd + quote.length;
      skipBlank();
      if (text.charAt(i) !== ':') break;
      i++;
      skipBlank();
      if (!text.startsWith(quote, i)) break;
      const vs = i + quote.length;
      const ve = m[1] ? text.indexOf(quote, vs) : scanValueEnd(text, vs, '"');
      if (ve < 0 || (m[1] === '' && text.charAt(ve) !== '"')) break;
      if (ve > vs && text.slice(vs, ve) !== REDACTED) found.push([vs, ve]);
      i = ve + quote.length;
      skipBlank();
      if (text.charAt(i) === ',') i++;
    }
    if (found.length === 0 || jsonKind(text, open, i) !== 'Secret') continue;
    for (const f of found) edits.push(f);
    JSON_DATA_RE.lastIndex = Math.max(JSON_DATA_RE.lastIndex, i);
  }
}

/**
 * Every value under `data:` and `stringData:` of a Secret manifest (`kubectl get secret -o yaml|json`,
 * the last-applied-configuration annotation) is a credential, whatever its key is called
 * (.dockerconfigjson, DATABASE_URL). ConfigMaps and other kinds are left alone.
 */
function maskSecretManifests(text: string, tally: Tally): string {
  if (!/(?:data|stringData)\b/.test(text) || !text.includes('Secret')) return text;
  const edits: Array<[number, number]> = [];
  yamlSecretValues(text, edits);
  jsonSecretValues(text, edits);
  if (edits.length === 0) return text;
  edits.sort((a, b) => a[0] - b[0]);
  let out = '';
  let copied = 0;
  for (const [start, end] of edits) {
    if (start < copied) continue;
    out += text.slice(copied, start) + REDACTED;
    copied = end;
    tally.count++;
  }
  return out + text.slice(copied);
}

// ---------------------------------------------------------------------------------------------

const RULES: Rule[] = [
  BASE64_PEM_RULE,
  AWS_CREDENTIAL_ROW_RULE,
  ...TOKEN_RULES,
  HEADER_RULE,
  BEARER_RULE,
  URL_USERINFO_RULE,
  SIGNATURE_PARAM_RULE,
  LONG_FLAG_RULE,
  ...SHORT_FLAG_RULES,
  CURL_USER_RULE,
  HTTPIE_AUTH_RULE,
  CURL_COOKIE_RULE,
  HAPROXY_STATS_RULE,
  SQLPLUS_RULE,
  OPENSSL_PASS_RULE,
  SQL_PASSWORD_RULE,
  NETRC_RULE,
  XML_ELEMENT_RULE,
  XML_NAME_VALUE_RULE,
  XML_ATTRIBUTE_RULE,
  NAME_VALUE_RULE,
  VALUE_NAME_RULE,
  KEY_NAME_VALUE_RULE,
  AWS_CONFIGURE_SET_RULE,
  SECURE_STRING_RULE,
  KEY_VAULT_SECRET_RULE,
  KEYED_VALUE_RULE,
  IPSEC_SECRET_RULE,
  ESCAPED_JSON_RULE,
  LABEL_RULE,
  DIRECTIVE_RULE,
  ASSIGNMENT_RULE,
].map((rule) => (rule.re.source.includes('(?<![') ? withEscBoundary(rule) : rule));

/**
 * Masking can expose a new match to an earlier rule (a masked value that held a quote or a command
 * separator), so the rules run again until the text stops changing. That makes the result a fixed point:
 * masking masked text changes nothing and counts nothing.
 */
const MAX_PASSES = 4;

const EXOTIC_RE = /[\u00a0\u1680\u2000-\u200f\u202f\u205f\u2060\u3000\ufeff\uff1a\uff1d]/;

/**
 * Terminals and editors can put look-alike characters where a rule expects ASCII: a no-break space after
 * the separator, a fullwidth colon, zero-width characters inside a name. They are mapped to their plain
 * form (only when such a character is present, so ordinary text is never touched).
 */
function normalizeLookalikes(text: string): string {
  if (!EXOTIC_RE.test(text)) return text;
  return text
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/(?<=[^\u0080-\uffff])[\u200b-\u200f\u2060\ufeff]+|[\u200b-\u200f\u2060\ufeff]+(?=[^\u0080-\uffff])/g, '')
    .replace(/(?<=[\w"'\]])\uff1a/g, ':')
    .replace(/(?<=[\w"'\]])\uff1d/g, '=');
}

/** Masks secrets in `input` and reports how many were masked. Never truncates. */
export function maskSecretsCounted(input: string): MaskResult {
  if (!input) return { text: input, count: 0 };
  const tally: Tally = { count: 0 };
  let text = input;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // masking can put a placeholder next to a look-alike colon, so every pass starts from plain characters
    text = normalizeLookalikes(text);
    const before = text;
    text = maskPrivateKeys(text, tally);
    text = maskSecretManifests(text, tally);
    for (const rule of RULES) text = applyRule(text, rule, tally);
    if (text === before) break;
  }
  return { text: normalizeLookalikes(text), count: tally.count };
}

export function maskSecrets(input: string): string {
  return maskSecretsCounted(input).text;
}
