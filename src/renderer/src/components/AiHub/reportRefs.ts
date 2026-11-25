/**
 * Turns `[c3]` into a link when c3 names a command of this conversation.
 * Anything else in brackets is left as it was.
 */
export function linkRefs(text: string, refs: ReadonlySet<string>): string {
  if (refs.size === 0) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\[(c\d+(?:\s*,\s*c\d+)*)\](?!\()/g, (whole, list: string) => {
            const names = list.split(/\s*,\s*/);
            return names.every((n) => refs.has(n)) ? names.map((n) => `[${n}](#ref-${n})`).join(" ") : whole;
          }),
    )
    .join("");
}

/** Parsed file/line citation extracted from a report or log. */
export interface FileRef {
  /** Exact matched citation text (e.g. "prod-web-01:/etc/nginx/nginx.conf:42"). */
  raw: string;
  /** Optional remote host (or user@host) prefix before `:/`. */
  host?: string;
  /** Absolute POSIX or Windows file path. */
  path: string;
  /** Optional 1-based line number. */
  line?: number;
  /** Optional 1-based column number when `:line:col` is present. */
  column?: number;
}

/**
 * Where a citation may be opened from this computer: the local path for a
 * reference without a host. A reference with a host names a file on that
 * server (`prod-01:/etc/shadow`); opening its path here would show this
 * computer's (or, in the web app, the web server's) own file of that name.
 */
export function openableLocalFileRef(ref: FileRef): { path: string } | { refused: string } {
  if (ref.host)
    return {
      refused: `${ref.raw} is a file on ${ref.host}, not on this computer. Open it from a terminal or file pane connected to ${ref.host}.`,
    };
  return { path: ref.path };
}

/** A tokenized segment from `tokenizeReportRefs`. */
export type ReportRefSegment =
  | { kind: "text"; text: string }
  | { kind: "cmd"; text: string; ref: string }
  | { kind: "file"; text: string; fileRef: FileRef };

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const LINE_COL_SUFFIX_RE = /^(.*?):(\d+)(?::(\d+))?$/;
const HOST_ABS_RE = /^((?:[a-zA-Z0-9._-]+@)?[a-zA-Z][a-zA-Z0-9._-]{1,63}):(\/(?!\/)[^\s]*)$/;
const WIN_DRIVE_ABS_RE = /^[A-Za-z]:(?:\\|\/)[^\s:*?"<>|]+$/;
const WIN_UNC_ABS_RE = /^\\\\[A-Za-z0-9._-]+\\[^\s:*?"<>|]+$/;
const POSIX_ABS_RE = /^\/(?!\/)[a-zA-Z0-9._~@+-]+(?:\/[a-zA-Z0-9._~@+-]+)*\/?$/;

function splitLineCol(candidate: string): { base: string; line?: number; column?: number } {
  const m = LINE_COL_SUFFIX_RE.exec(candidate);
  if (!m) return { base: candidate };
  const base = m[1];
  const lineNum = Number(m[2]);
  const colNum = m[3] !== undefined ? Number(m[3]) : undefined;
  if (!Number.isSafeInteger(lineNum) || lineNum < 1) {
    return { base: candidate };
  }
  if (colNum !== undefined && (!Number.isSafeInteger(colNum) || colNum < 1)) {
    return { base: candidate };
  }
  // Guard against treating a trailing numeric segment without an actual path as a line number.
  if (!base) return { base: candidate };
  return { base, line: lineNum, column: colNum };
}

/**
 * Parses a single candidate file citation (`host:/abs/path(:line)?`, `/abs/path(:line)?`,
 * or Windows `C:\path(:line)?`), returning null for URLs, timestamps, or relative paths.
 */
export function parseFileRef(input: string): FileRef | null {
  const raw = input.trim();
  if (!raw || URL_SCHEME_RE.test(raw)) return null;

  const { base, line, column } = splitLineCol(raw);

  // 1. Remote host + POSIX path: `prod-01:/etc/nginx/nginx.conf` or `user@host:/var/log/syslog`
  const hostMatch = HOST_ABS_RE.exec(base);
  if (hostMatch && hostMatch[1]) {
    const [, host, absPath] = hostMatch;
    if (POSIX_ABS_RE.test(absPath)) {
      return { raw, host, path: absPath, line, column };
    }
    return null;
  }

  // 2. Windows drive or UNC path: `C:\Users\app\main.ts` / `C:/Users/app/main.ts` / `\\srv\share\f`
  if (WIN_DRIVE_ABS_RE.test(base) || WIN_UNC_ABS_RE.test(base)) {
    return { raw, path: base, line, column };
  }

  // 3. Local POSIX absolute path: `/etc/multipath.conf`
  if (POSIX_ABS_RE.test(base)) {
    return { raw, path: base, line, column };
  }

  return null;
}

const TOKEN_SCAN_RE = new RegExp(
  [
    // Markdown links `[label](url)` kept verbatim
    "\\[[^\\]\\n]+\\]\\([^)\\s]+\\)",
    // URLs (`https://...`, `s3://...`, `file://...`) kept verbatim so inner paths are ignored
    "[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^\\s<>()]+",
    // Command references `[c1]` or `[c1, c3]`
    "\\[(c\\d+(?:\\s*,\\s*c\\d+)*)\\]",
    // `host:/abs/path(:line(:col)?)?`
    "(?:[a-zA-Z0-9._-]+@)?[a-zA-Z][a-zA-Z0-9._-]{1,63}:\\/(?!\\/)[a-zA-Z0-9._~@\\/+-]+(?::\\d+(?::\\d+)?)?",
    // Windows `C:\path` or `C:/path` or `\\server\share\path`
    "(?:[A-Za-z]:(?:\\\\|\\/)|\\\\\\\\[A-Za-z0-9._-]+\\\\)[a-zA-Z0-9._~@\\\\\\/+-]+(?::\\d+(?::\\d+)?)?",
    // Local POSIX `/abs/path`: >=2 segments, root file with extension, or root name with :line
    "(?:\\/(?:[a-zA-Z0-9._~@-]+\\/)+[a-zA-Z0-9._~@+-]+|\\/[a-zA-Z0-9_-]+\\.[a-zA-Z0-9._-]+|\\/[a-zA-Z0-9._~@-]+:\\d+(?::\\d+)?)(?::\\d+(?::\\d+)?)?",
  ].join("|"),
  "g",
);

const BOUNDARY_BEFORE_RE = /^[\s([<"'`=,;|]$/;
const TRAILING_PUNCT_RE = /[.,;!?)}\]'"]+$/;

function trimTrailingPunctuation(raw: string): { candidate: string; trailing: string } {
  let candidate = raw;
  let trailing = "";
  while (candidate.length > 0) {
    const m = TRAILING_PUNCT_RE.exec(candidate);
    if (!m) break;
    const tail = m[0];
    // Preserve balanced closing `)` if `(` appears inside the path itself.
    if (tail.startsWith(")")) {
      const opens = (candidate.match(/\(/g) ?? []).length;
      const closes = (candidate.match(/\)/g) ?? []).length;
      if (opens >= closes) break;
    }
    trailing = tail + trailing;
    candidate = candidate.slice(0, candidate.length - tail.length);
  }
  return { candidate, trailing };
}

function pushTextSegment(segments: ReportRefSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.kind === "text") {
    last.text += text;
  } else {
    segments.push({ kind: "text", text });
  }
}

/**
 * Splits `text` into plain text, command ref (`kind: "cmd"`), and file/line ref (`kind: "file"`)
 * segments while ignoring URLs, timestamps, and relative paths.
 * Concatenating `seg.text` across all returned segments always equals `text`.
 */
export function tokenizeReportRefs(text: string, cmdRefs?: ReadonlySet<string>): ReportRefSegment[] {
  if (!text) return [];
  const segments: ReportRefSegment[] = [];
  let cursor = 0;
  TOKEN_SCAN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TOKEN_SCAN_RE.exec(text)) !== null) {
    const whole = match[0];
    const start = match.index;
    const end = start + whole.length;

    // 1. Markdown links or URLs -> emit untouched as plain text
    if ((whole.startsWith("[") && whole.includes("](")) || URL_SCHEME_RE.test(whole)) {
      if (start > cursor) pushTextSegment(segments, text.slice(cursor, start));
      pushTextSegment(segments, whole);
      cursor = end;
      continue;
    }

    // 2. Command references `[c1]` or `[c1, c3]`
    if (whole.startsWith("[") && match[1]) {
      const names = match[1].split(/\s*,\s*/);
      if (cmdRefs && cmdRefs.size > 0 && names.every((n) => cmdRefs.has(n))) {
        if (start > cursor) pushTextSegment(segments, text.slice(cursor, start));
        if (names.length === 1) {
          segments.push({ kind: "cmd", text: whole, ref: names[0] });
        } else {
          pushTextSegment(segments, "[");
          names.forEach((name, idx) => {
            if (idx > 0) pushTextSegment(segments, ", ");
            segments.push({ kind: "cmd", text: name, ref: name });
          });
          pushTextSegment(segments, "]");
        }
        cursor = end;
        continue;
      }
      if (start > cursor) pushTextSegment(segments, text.slice(cursor, start));
      pushTextSegment(segments, whole);
      cursor = end;
      continue;
    }

    // 3. File citation: require safe left boundary so relative paths (`foo/bar/baz`) are skipped.
    const prevChar = start > 0 ? text[start - 1] : "";
    if (prevChar && !BOUNDARY_BEFORE_RE.test(prevChar)) {
      continue;
    }

    const { candidate, trailing } = trimTrailingPunctuation(whole);
    const parsed = parseFileRef(candidate);
    if (!parsed) {
      continue;
    }

    if (start > cursor) pushTextSegment(segments, text.slice(cursor, start));
    segments.push({ kind: "file", text: candidate, fileRef: parsed });
    if (trailing) pushTextSegment(segments, trailing);
    cursor = end;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }
  return segments;
}

/** Extracts all unique (or ordered) file references found in prose text (excluding fenced code blocks). */
export function extractFileRefs(text: string): FileRef[] {
  const found: FileRef[] = [];
  const parts = text.split(/(```[\s\S]*?```)/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    const inlineParts = parts[i].split(/(`[^`\n]*`)/);
    for (let j = 0; j < inlineParts.length; j++) {
      if (j % 2 === 1) {
        const inner = inlineParts[j].slice(1, -1);
        const direct = parseFileRef(inner);
        if (direct) found.push(direct);
      } else {
        for (const seg of tokenizeReportRefs(inlineParts[j])) {
          if (seg.kind === "file") found.push(seg.fileRef);
        }
      }
    }
  }
  return found;
}

/** Encodes a FileRef as an in-app markdown hash link (`#file-...`). */
export function encodeFileRefHref(fileRef: FileRef): string {
  return `#file-${encodeURIComponent(fileRef.raw)}`;
}

/** Decodes an `#file-...` link href produced by `encodeFileRefHref` back into a `FileRef`. */
export function decodeFileRefHref(href: string | undefined): FileRef | null {
  if (!href || !href.startsWith("#file-")) return null;
  try {
    return parseFileRef(decodeURIComponent(href.slice(6)));
  } catch {
    return null;
  }
}

/**
 * Turns standalone file/line citations (`host:/abs/path:line`, `/abs/path:line`, `C:\path:line`)
 * and single-token inline-code file citations (`` `/abs/path` ``) into `#file-...` markdown links,
 * leaving fenced code blocks, URLs, timestamps, and existing markdown links untouched.
 */
export function linkFileRefs(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        if (part.startsWith("```")) return part;
        // Already the text of a link (this text was linked once before): linking it again nests a
        // link in a link, which shows as its markup.
        if (parts[i - 1]?.endsWith("[") && parts[i + 1]?.startsWith("](")) return part;
        const inner = part.slice(1, -1);
        const direct = parseFileRef(inner);
        return direct ? `[${part}](${encodeFileRefHref(direct)})` : part;
      }
      return tokenizeReportRefs(part)
        .map((seg) =>
          seg.kind === "file" ? `[${seg.text}](${encodeFileRefHref(seg.fileRef)})` : seg.text,
        )
        .join("");
    })
    .join("");
}

/** Links both `[cN]` command references (when `refs` is non-empty) and file/line citations. */
export function linkReportRefs(text: string, refs?: ReadonlySet<string>): string {
  const withCmds = refs && refs.size > 0 ? linkRefs(text, refs) : text;
  return linkFileRefs(withCmds);
}
