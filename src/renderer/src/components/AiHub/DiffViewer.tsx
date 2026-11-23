import { writeClipboardText } from '../../lib/clipboard';
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  diffWordsWithSpace,
  parsePatch,
  structuredPatch,
  type StructuredPatch,
  type StructuredPatchHunk,
} from "diff";
import {
  codeToCopy,
  highlightCode,
  MAX_HIGHLIGHT_CHARS,
  readCodeBlock,
  type CodeSegment,
} from "../../lib/markdownCodeHighlight";

export { codeToCopy, highlightCode, MAX_HIGHLIGHT_CHARS, readCodeBlock, type CodeSegment };

/** Renders syntax-highlighted code using the shared Lezer editor highlighters. */
export function HighlightedCode({
  code,
  lang,
  className,
}: {
  code: string;
  lang?: string;
  className?: string;
}): JSX.Element {
  const segments = useMemo(() => (lang ? highlightCode(code, lang) : null), [code, lang]);
  return (
    <code className={className}>
      {segments
        ? segments.map((seg, idx) =>
            seg.className ? (
              <span key={idx} className={seg.className}>
                {seg.text}
              </span>
            ) : (
              seg.text
            ),
          )
        : code}
    </code>
  );
}

/* -------------------------------------------------------------------------- */
/* DiffViewer                                                                 */
/* -------------------------------------------------------------------------- */

export interface DiffViewerProps {
  /** Unified diff string (e.g. `--- a/file\n+++ b/file\n@@ ... @@`). */
  diff?: string;
  /** Original content when computing diff client-side. */
  before?: string;
  /** Modified content when computing diff client-side. */
  after?: string;
  /** Optional file path label displayed in the header. */
  filePath?: string;
  /** Initial layout mode: `"unified"` (inline) or `"split"` (side-by-side). */
  defaultMode?: "unified" | "split";
  /** Collapse runs of unchanged context longer than this many lines (0 disables collapsing). */
  maxUnchangedCollapsed?: number;
}

interface WordPart {
  text: string;
  changed: boolean;
}

type DiffLineKind = "context" | "add" | "del" | "meta";

interface AnnotatedLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  wordParts?: WordPart[];
}

type HunkEntry =
  | { kind: "line"; line: AnnotatedLine }
  | { kind: "collapsed"; id: string; lines: AnnotatedLine[] };

interface SplitRow {
  kind: "pair" | "collapsed" | "meta";
  id?: string;
  collapsedLines?: AnnotatedLine[];
  left?: AnnotatedLine | null;
  right?: AnnotatedLine | null;
  metaText?: string;
}

const MAX_WORD_DIFF_PAIR_CHARS = 4000;

function stripGitPrefix(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (name === "/dev/null") return undefined;
  return name.replace(/^[ab]\//, "");
}

function annotateHunk(hunk: StructuredPatchHunk): AnnotatedLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const annotated: AnnotatedLine[] = [];

  for (const rawLine of hunk.lines) {
    if (rawLine.startsWith("+")) {
      annotated.push({
        kind: "add",
        text: rawLine.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
    } else if (rawLine.startsWith("-")) {
      annotated.push({
        kind: "del",
        text: rawLine.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
    } else if (rawLine.startsWith("\\")) {
      annotated.push({
        kind: "meta",
        text: rawLine,
        oldLine: null,
        newLine: null,
      });
    } else {
      annotated.push({
        kind: "context",
        text: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  // Pair contiguous deletion + addition runs for word-level intra-line highlights.
  let idx = 0;
  while (idx < annotated.length) {
    if (annotated[idx].kind !== "del") {
      idx++;
      continue;
    }
    const delStart = idx;
    while (idx < annotated.length && annotated[idx].kind === "del") idx++;
    const delEnd = idx;
    const addStart = idx;
    while (idx < annotated.length && annotated[idx].kind === "add") idx++;
    const addEnd = idx;

    const pairs = Math.min(delEnd - delStart, addEnd - addStart);
    for (let p = 0; p < pairs; p++) {
      const delItem = annotated[delStart + p];
      const addItem = annotated[addStart + p];
      if (delItem.text.length + addItem.text.length > MAX_WORD_DIFF_PAIR_CHARS) continue;
      const changes = diffWordsWithSpace(delItem.text, addItem.text);
      delItem.wordParts = changes
        .filter((c) => !c.added)
        .map((c) => ({ text: c.value, changed: c.removed }));
      addItem.wordParts = changes
        .filter((c) => !c.removed)
        .map((c) => ({ text: c.value, changed: c.added }));
    }
  }

  return annotated;
}

function collapseUnchangedRuns(
  lines: AnnotatedLine[],
  hunkKey: string,
  maxUnchangedCollapsed: number,
): HunkEntry[] {
  if (maxUnchangedCollapsed <= 0) {
    return lines.map((line) => ({ kind: "line", line }));
  }

  const entries: HunkEntry[] = [];
  let idx = 0;
  let blockIdx = 0;

  while (idx < lines.length) {
    if (lines[idx].kind !== "context") {
      entries.push({ kind: "line", line: lines[idx] });
      idx++;
      continue;
    }

    const runStart = idx;
    while (idx < lines.length && lines[idx].kind === "context") idx++;
    const run = lines.slice(runStart, idx);

    if (run.length <= maxUnchangedCollapsed) {
      for (const line of run) entries.push({ kind: "line", line });
      continue;
    }

    const isLeading = runStart === 0;
    const isTrailing = idx === lines.length;
    const edgeDefault = Math.min(3, Math.max(1, Math.floor(maxUnchangedCollapsed / 2)));
    let keepTop = isLeading ? 0 : edgeDefault;
    let keepBottom = isTrailing ? 0 : edgeDefault;

    if (run.length - keepTop - keepBottom < 1) {
      const half = Math.floor((run.length - 1) / 2);
      keepTop = isLeading ? 0 : half;
      keepBottom = isTrailing ? 0 : half;
    }

    const hiddenCount = run.length - keepTop - keepBottom;
    if (hiddenCount < 1) {
      for (const line of run) entries.push({ kind: "line", line });
      continue;
    }

    for (let i = 0; i < keepTop; i++) {
      entries.push({ kind: "line", line: run[i] });
    }
    entries.push({
      kind: "collapsed",
      id: `${hunkKey}:${blockIdx++}`,
      lines: run.slice(keepTop, run.length - keepBottom),
    });
    for (let i = run.length - keepBottom; i < run.length; i++) {
      entries.push({ kind: "line", line: run[i] });
    }
  }

  return entries;
}

function buildSplitRows(
  entries: HunkEntry[],
  expandedBlocks: Record<string, boolean>,
): SplitRow[] {
  // Expand already-opened blocks first so del/add pairing never splits awkwardly.
  const flat: Array<
    { kind: "line"; line: AnnotatedLine } | { kind: "collapsed"; id: string; lines: AnnotatedLine[] }
  > = [];
  for (const entry of entries) {
    if (entry.kind === "collapsed" && expandedBlocks[entry.id]) {
      for (const line of entry.lines) flat.push({ kind: "line", line });
    } else {
      flat.push(entry);
    }
  }

  const rows: SplitRow[] = [];
  let idx = 0;
  while (idx < flat.length) {
    const item = flat[idx];
    if (item.kind === "collapsed") {
      rows.push({ kind: "collapsed", id: item.id, collapsedLines: item.lines });
      idx++;
      continue;
    }

    const line = item.line;
    if (line.kind === "context") {
      rows.push({ kind: "pair", left: line, right: line });
      idx++;
      continue;
    }
    if (line.kind === "meta") {
      rows.push({ kind: "meta", metaText: line.text });
      idx++;
      continue;
    }
    if (line.kind === "del") {
      const dels: AnnotatedLine[] = [];
      while (idx < flat.length && flat[idx].kind === "line" && (flat[idx] as { kind: "line"; line: AnnotatedLine }).line.kind === "del") {
        dels.push((flat[idx] as { kind: "line"; line: AnnotatedLine }).line);
        idx++;
      }
      const adds: AnnotatedLine[] = [];
      while (idx < flat.length && flat[idx].kind === "line" && (flat[idx] as { kind: "line"; line: AnnotatedLine }).line.kind === "add") {
        adds.push((flat[idx] as { kind: "line"; line: AnnotatedLine }).line);
        idx++;
      }
      const count = Math.max(dels.length, adds.length);
      for (let i = 0; i < count; i++) {
        rows.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
      }
      continue;
    }
    // Standalone add
    rows.push({ kind: "pair", left: null, right: line });
    idx++;
  }
  return rows;
}

function synthesizeRawPatch(diffText: string, filePath?: string): StructuredPatch[] {
  const rawLines = diffText.replace(/\r\n/g, "\n").split("\n");
  const lines = rawLines.filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith(" "));
  if (lines.length === 0) return [];
  let oldLines = 0;
  let newLines = 0;
  for (const l of lines) {
    if (l.startsWith("+")) newLines++;
    else if (l.startsWith("-")) oldLines++;
    else {
      oldLines++;
      newLines++;
    }
  }
  return [
    {
      oldFileName: filePath,
      newFileName: filePath,
      oldHeader: undefined,
      newHeader: undefined,
      hunks: [
        {
          oldStart: 1,
          oldLines,
          newStart: 1,
          newLines,
          lines,
        },
      ],
    },
  ];
}

function renderLineContent(line: AnnotatedLine): JSX.Element | string {
  if (!line.wordParts) return line.text;
  const wordCls = line.kind === "add" ? "ai-diff-word-add" : "ai-diff-word-del";
  return (
    <>
      {line.wordParts.map((part, idx) =>
        part.changed ? (
          <span key={idx} className={wordCls}>
            {part.text}
          </span>
        ) : (
          <span key={idx}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Renders unified or split diffs with dual line numbers, word-level intra-line highlights,
 * and collapsible unchanged context blocks.
 */
export function DiffViewer({
  diff,
  before,
  after,
  filePath,
  defaultMode = "unified",
  maxUnchangedCollapsed = 6,
}: DiffViewerProps): JSX.Element {
  const [mode, setMode] = useState<"unified" | "split">(defaultMode);
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setExpandedBlocks({});
  }, [diff, before, after, filePath]);

  const patches = useMemo<StructuredPatch[]>(() => {
    if (diff !== undefined && diff.trim().length > 0) {
      const parsed = parsePatch(diff);
      if (parsed.some((p) => p.hunks.length > 0 || p.isBinary || p.isRename || p.isCreate || p.isDelete)) {
        return parsed;
      }
      return synthesizeRawPatch(diff, filePath);
    }
    if (before !== undefined && after !== undefined) {
      if (before === after) return [];
      const name = filePath ?? "file";
      return [
        structuredPatch(name, name, before, after, undefined, undefined, {
          context: Number.MAX_SAFE_INTEGER,
        }),
      ];
    }
    return [];
  }, [diff, before, after, filePath]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const p of patches) {
      for (const h of p.hunks) {
        for (const l of h.lines) {
          if (l.startsWith("+")) added++;
          else if (l.startsWith("-")) removed++;
        }
      }
    }
    return { added, removed };
  }, [patches]);

  const displayName =
    filePath ??
    stripGitPrefix(patches[0]?.newFileName) ??
    stripGitPrefix(patches[0]?.oldFileName);

  const expandBlock = (id: string) => {
    setExpandedBlocks((prev) => ({ ...prev, [id]: true }));
  };

  const hasHunks = patches.some((p) => p.hunks.length > 0);

  return (
    <div className="ai-diff ai-diff-viewer" data-diff-mode={mode}>
      <div className="ai-diff-header">
        <div className="ai-diff-title">
          {displayName && <span className="ai-diff-filepath">{displayName}</span>}
          <span className="ai-diff-stats" style={{ fontVariantNumeric: "tabular-nums" }}>
            <span className="ai-diff-stats-add">+{stats.added}</span>{" "}
            <span className="ai-diff-stats-del">-{stats.removed}</span>
          </span>
        </div>
        <div className="ai-diff-modes" role="group" aria-label="Diff view mode">
          <button
            type="button"
            className="ai-diff-mode-btn"
            aria-pressed={mode === "unified"}
            onClick={() => setMode("unified")}
          >
            Unified
          </button>
          <button
            type="button"
            className="ai-diff-mode-btn"
            aria-pressed={mode === "split"}
            onClick={() => setMode("split")}
          >
            Split
          </button>
        </div>
      </div>

      {!hasHunks ? (
        <div className="ai-diff-empty">
          {patches.some((p) => p.isBinary) ? "Binary file changed" : "No changes"}
        </div>
      ) : (
        <div className={`ai-diff-body ${mode === "split" ? "ai-diff-split" : "ai-diff-unified"}`}>
          {patches.map((patch, pIdx) =>
            patch.hunks.map((hunk, hIdx) => {
              const hunkKey = `${pIdx}-${hIdx}`;
              const annotated = annotateHunk(hunk);
              const entries = collapseUnchangedRuns(annotated, hunkKey, maxUnchangedCollapsed);
              const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

              if (mode === "split") {
                const splitRows = buildSplitRows(entries, expandedBlocks);
                return (
                  <div key={hunkKey} className="ai-diff-hunk">
                    <div className="ai-diff-line-hunk">{hunkHeader}</div>
                    {splitRows.map((row, rIdx) => {
                      if (row.kind === "collapsed" && row.id && row.collapsedLines) {
                        const count = row.collapsedLines.length;
                        return (
                          <div key={rIdx} className="ai-diff-collapsed">
                            <button
                              type="button"
                              className="ai-diff-expand-btn"
                              aria-expanded={false}
                              onClick={() => expandBlock(row.id!)}
                            >
                              Show {count} unchanged {count === 1 ? "line" : "lines"}
                            </button>
                          </div>
                        );
                      }
                      if (row.kind === "meta") {
                        return (
                          <div key={rIdx} className="ai-diff-line ai-diff-line-meta">
                            <span className="ai-diff-code">{row.metaText}</span>
                          </div>
                        );
                      }
                      const left = row.left;
                      const right = row.right;
                      const leftCls = left
                        ? left.kind === "del"
                          ? "ai-diff-cell ai-diff-line-del"
                          : "ai-diff-cell ai-diff-line-ctx"
                        : "ai-diff-cell ai-diff-cell-empty";
                      const rightCls = right
                        ? right.kind === "add"
                          ? "ai-diff-cell ai-diff-line-add"
                          : "ai-diff-cell ai-diff-line-ctx"
                        : "ai-diff-cell ai-diff-cell-empty";
                      return (
                        <div key={rIdx} className="ai-diff-split-row">
                          <div className={leftCls}>
                            <span className="ai-diff-ln ai-diff-ln-old">
                              {left?.oldLine ?? ""}
                            </span>
                            <span className="ai-diff-marker">
                              {left ? (left.kind === "del" ? "-" : " ") : ""}
                            </span>
                            <span className="ai-diff-code">
                              {left ? renderLineContent(left) : ""}
                            </span>
                          </div>
                          <div className={rightCls}>
                            <span className="ai-diff-ln ai-diff-ln-new">
                              {right?.newLine ?? ""}
                            </span>
                            <span className="ai-diff-marker">
                              {right ? (right.kind === "add" ? "+" : " ") : ""}
                            </span>
                            <span className="ai-diff-code">
                              {right ? renderLineContent(right) : ""}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              }

              return (
                <div key={hunkKey} className="ai-diff-hunk">
                  <div className="ai-diff-line-hunk">{hunkHeader}</div>
                  {entries.map((entry, eIdx) => {
                    if (entry.kind === "collapsed") {
                      if (expandedBlocks[entry.id]) {
                        return entry.lines.map((line, lIdx) => (
                          <div key={`${eIdx}-${lIdx}`} className="ai-diff-line ai-diff-line-ctx">
                            <span className="ai-diff-ln ai-diff-ln-old">{line.oldLine ?? ""}</span>
                            <span className="ai-diff-ln ai-diff-ln-new">{line.newLine ?? ""}</span>
                            <span className="ai-diff-marker"> </span>
                            <span className="ai-diff-code">{line.text}</span>
                          </div>
                        ));
                      }
                      const count = entry.lines.length;
                      return (
                        <div key={eIdx} className="ai-diff-collapsed">
                          <button
                            type="button"
                            className="ai-diff-expand-btn"
                            aria-expanded={false}
                            onClick={() => expandBlock(entry.id)}
                          >
                            Show {count} unchanged {count === 1 ? "line" : "lines"}
                          </button>
                        </div>
                      );
                    }

                    const line = entry.line;
                    const lineCls =
                      line.kind === "add"
                        ? "ai-diff-line ai-diff-line-add"
                        : line.kind === "del"
                          ? "ai-diff-line ai-diff-line-del"
                          : line.kind === "meta"
                            ? "ai-diff-line ai-diff-line-meta"
                            : "ai-diff-line ai-diff-line-ctx";
                    const marker =
                      line.kind === "add"
                        ? "+"
                        : line.kind === "del"
                          ? "-"
                          : line.kind === "meta"
                            ? "\\"
                            : " ";
                    return (
                      <div key={eIdx} className={lineCls}>
                        <span className="ai-diff-ln ai-diff-ln-old">{line.oldLine ?? ""}</span>
                        <span className="ai-diff-ln ai-diff-ln-new">{line.newLine ?? ""}</span>
                        <span className="ai-diff-marker">{marker}</span>
                        <span className="ai-diff-code">{renderLineContent(line)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            }),
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* AnsiLogView                                                                */
/* -------------------------------------------------------------------------- */

export interface AnsiLogViewProps {
  text: string;
  /** Collapse middle lines into a head+tail preview when line count exceeds `maxLines`. */
  maxLines?: number;
  /** Highlight lines containing error/warn markers. Defaults to true. */
  highlightErrors?: boolean;
  className?: string;
}

export interface AnsiToken {
  text: string;
  className?: string;
  style?: CSSProperties;
}

export interface AnsiLine {
  tokens: AnsiToken[];
  plainText: string;
  severity?: "error" | "warn";
}

interface AnsiState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fgName?: string;
  fgColor?: string;
  bgName?: string;
  bgColor?: string;
}

const STANDARD_FG: Record<number, { name: string; color: string }> = {
  30: { name: "black", color: "var(--ai-ansi-black, #1e293b)" },
  31: { name: "red", color: "var(--ai-ansi-red, #f87171)" },
  32: { name: "green", color: "var(--ai-ansi-green, #4ade80)" },
  33: { name: "yellow", color: "var(--ai-ansi-yellow, #facc15)" },
  34: { name: "blue", color: "var(--ai-ansi-blue, #60a5fa)" },
  35: { name: "magenta", color: "var(--ai-ansi-magenta, #c084fc)" },
  36: { name: "cyan", color: "var(--ai-ansi-cyan, #22d3ee)" },
  37: { name: "white", color: "var(--ai-ansi-white, #e2e8f0)" },
  90: { name: "gray", color: "var(--ai-ansi-gray, #94a3b8)" },
  91: { name: "bright-red", color: "var(--ai-ansi-bright-red, #fca5a5)" },
  92: { name: "bright-green", color: "var(--ai-ansi-bright-green, #86efac)" },
  93: { name: "bright-yellow", color: "var(--ai-ansi-bright-yellow, #fde047)" },
  94: { name: "bright-blue", color: "var(--ai-ansi-bright-blue, #93c5fd)" },
  95: { name: "bright-magenta", color: "var(--ai-ansi-bright-magenta, #d8b4fe)" },
  96: { name: "bright-cyan", color: "var(--ai-ansi-bright-cyan, #67e8f9)" },
  97: { name: "bright-white", color: "var(--ai-ansi-bright-white, #f8fafc)" },
};

const STANDARD_BG: Record<number, { name: string; color: string }> = {
  40: { name: "black", color: "rgba(15, 23, 42, 0.7)" },
  41: { name: "red", color: "rgba(239, 68, 68, 0.22)" },
  42: { name: "green", color: "rgba(34, 197, 94, 0.22)" },
  43: { name: "yellow", color: "rgba(234, 179, 8, 0.22)" },
  44: { name: "blue", color: "rgba(59, 130, 246, 0.22)" },
  45: { name: "magenta", color: "rgba(168, 85, 247, 0.22)" },
  46: { name: "cyan", color: "rgba(6, 182, 212, 0.22)" },
  47: { name: "white", color: "rgba(226, 232, 240, 0.18)" },
  100: { name: "gray", color: "rgba(100, 116, 139, 0.28)" },
  101: { name: "bright-red", color: "rgba(248, 113, 113, 0.26)" },
  102: { name: "bright-green", color: "rgba(74, 222, 128, 0.26)" },
  103: { name: "bright-yellow", color: "rgba(250, 204, 21, 0.26)" },
  104: { name: "bright-blue", color: "rgba(96, 165, 250, 0.26)" },
  105: { name: "bright-magenta", color: "rgba(192, 132, 252, 0.26)" },
  106: { name: "bright-cyan", color: "rgba(34, 211, 238, 0.26)" },
  107: { name: "bright-white", color: "rgba(248, 250, 252, 0.24)" },
};

function ansi256ToCss(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 8) return STANDARD_FG[30 + n]?.color;
  if (n < 16) return STANDARD_FG[90 + (n - 8)]?.color;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const toByte = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${toByte(r)}, ${toByte(g)}, ${toByte(b)})`;
}

// eslint-disable-next-line no-control-regex
const ESCAPE_OR_CONTROL_RE = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const NON_SGR_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*(?!m)[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g;

/** Normalizes carriage-return spinner overwrites on a single line, keeping the final rendered frame. */
function normalizeSpinnerLine(rawLine: string): string {
  if (!rawLine.includes("\r")) return rawLine;
  const frames = rawLine.split("\r");
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    // eslint-disable-next-line no-control-regex
    const visible = frame.replace(/\x1b\[[0-9;]*m/g, "").replace(NON_SGR_RE, "");
    if (visible.length > 0 || i === 0) {
      return frame;
    }
  }
  return "";
}

function applySgrParams(state: AnsiState, rawParams: string): void {
  const params = rawParams === "" ? [0] : rawParams.split(";").map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      state.bold = false;
      state.dim = false;
      state.italic = false;
      state.underline = false;
      state.fgName = undefined;
      state.fgColor = undefined;
      state.bgName = undefined;
      state.bgColor = undefined;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 39) {
      state.fgName = undefined;
      state.fgColor = undefined;
    } else if (code === 49) {
      state.bgName = undefined;
      state.bgColor = undefined;
    } else if (STANDARD_FG[code]) {
      state.fgName = STANDARD_FG[code].name;
      state.fgColor = STANDARD_FG[code].color;
    } else if (STANDARD_BG[code]) {
      state.bgName = STANDARD_BG[code].name;
      state.bgColor = STANDARD_BG[code].color;
    } else if (code === 38 || code === 48) {
      const isFg = code === 38;
      const mode = params[i + 1];
      if (mode === 5 && params[i + 2] !== undefined) {
        const css = ansi256ToCss(params[i + 2]);
        if (css) {
          if (isFg) {
            state.fgName = undefined;
            state.fgColor = css;
          } else {
            state.bgName = undefined;
            state.bgColor = css;
          }
        }
        i += 2;
      } else if (mode === 2 && params[i + 4] !== undefined) {
        const r = Math.min(255, Math.max(0, params[i + 2]));
        const g = Math.min(255, Math.max(0, params[i + 3]));
        const b = Math.min(255, Math.max(0, params[i + 4]));
        const css = `rgb(${r}, ${g}, ${b})`;
        if (isFg) {
          state.fgName = undefined;
          state.fgColor = css;
        } else {
          state.bgName = undefined;
          state.bgColor = css;
        }
        i += 4;
      }
    }
  }
}

function buildTokenMeta(state: AnsiState): { className?: string; style?: CSSProperties } {
  const classes: string[] = [];
  const style: CSSProperties = {};
  let hasStyle = false;

  if (state.bold) {
    classes.push("ai-ansi-bold");
    style.fontWeight = 700;
    hasStyle = true;
  }
  if (state.dim) {
    classes.push("ai-ansi-dim");
    style.opacity = 0.72;
    hasStyle = true;
  }
  if (state.italic) {
    classes.push("ai-ansi-italic");
    style.fontStyle = "italic";
    hasStyle = true;
  }
  if (state.underline) {
    classes.push("ai-ansi-underline");
    style.textDecoration = "underline";
    hasStyle = true;
  }
  if (state.fgName) {
    classes.push(`ai-ansi-fg-${state.fgName}`);
  }
  if (state.fgColor) {
    style.color = state.fgColor;
    hasStyle = true;
  }
  if (state.bgName) {
    classes.push(`ai-ansi-bg-${state.bgName}`);
  }
  if (state.bgColor) {
    style.backgroundColor = state.bgColor;
    hasStyle = true;
  }

  return {
    className: classes.length > 0 ? classes.join(" ") : undefined,
    style: hasStyle ? style : undefined,
  };
}

const ERROR_LINE_RE = /\b(?:ERROR|FATAL|PANIC|EXCEPTION|TRACEBACK|FAILED)\b|^err(?:or)?:/i;
const WARN_LINE_RE = /\b(?:WARN|WARNING)\b/i;

function detectLineSeverity(plainText: string): "error" | "warn" | undefined {
  if (ERROR_LINE_RE.test(plainText)) return "error";
  if (WARN_LINE_RE.test(plainText)) return "warn";
  return undefined;
}

/** Parses raw terminal output (with ANSI SGR escapes and `\r` spinner frames) into clean line tokens. */
export function parseAnsiLines(text: string): AnsiLine[] {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const state: AnsiState = { bold: false, dim: false, italic: false, underline: false };

  return rawLines.map((rawLine) => {
    const line = normalizeSpinnerLine(rawLine);
    const tokens: AnsiToken[] = [];
    let cursor = 0;
    ESCAPE_OR_CONTROL_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = ESCAPE_OR_CONTROL_RE.exec(line)) !== null) {
      if (match.index > cursor) {
        const chunk = line.slice(cursor, match.index);
        tokens.push({ text: chunk, ...buildTokenMeta(state) });
      }
      if (match[1] !== undefined) {
        applySgrParams(state, match[1]);
      }
      cursor = match.index + match[0].length;
    }

    if (cursor < line.length) {
      tokens.push({ text: line.slice(cursor), ...buildTokenMeta(state) });
    }

    const plainText = tokens.map((t) => t.text).join("");
    return {
      tokens,
      plainText,
      severity: detectLineSeverity(plainText),
    };
  });
}

/** Strips ANSI escapes and normalizes `\r` spinner frames to clean plain text suitable for copying. */
export function stripAnsiAndNormalize(text: string): string {
  return parseAnsiLines(text)
    .map((line) => line.plainText)
    .join("\n");
}

/**
 * Pure-React ANSI SGR log viewer with carriage-return spinner normalization,
 * clean raw-text copy, error highlighting, and smart head+tail line collapse.
 */
export function AnsiLogView({
  text,
  maxLines,
  highlightErrors = true,
  className,
}: AnsiLogViewProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [text, maxLines]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const parsedLines = useMemo(() => parseAnsiLines(text), [text]);
  const cleanCopyText = useMemo(
    () => parsedLines.map((l) => l.plainText).join("\n"),
    [parsedLines],
  );

  const shouldCollapse =
    !expanded && maxLines !== undefined && maxLines > 0 && parsedLines.length > maxLines;

  let headLines = parsedLines;
  let tailLines: AnsiLine[] = [];
  let hiddenCount = 0;

  if (shouldCollapse && maxLines !== undefined) {
    const headCount = maxLines <= 1 ? 1 : Math.max(1, Math.floor(maxLines * 0.35));
    const tailCount = maxLines <= 1 ? 0 : Math.max(1, maxLines - headCount);
    headLines = parsedLines.slice(0, headCount);
    tailLines = tailCount > 0 ? parsedLines.slice(parsedLines.length - tailCount) : [];
    hiddenCount = parsedLines.length - headCount - tailCount;
  }

  const handleCopy = async () => {
    try {
      await writeClipboardText(cleanCopyText);
      setCopied(true);
    } catch {
      // Clipboard unavailable or denied.
    }
  };

  const renderAnsiLine = (line: AnsiLine, key: string | number) => {
    const sevClass =
      highlightErrors && line.severity === "error"
        ? " ai-ansi-line-error"
        : highlightErrors && line.severity === "warn"
          ? " ai-ansi-line-warn"
          : "";
    return (
      <div key={key} className={`ai-ansi-line${sevClass}`}>
        {line.tokens.length === 0
          ? "\u00A0"
          : line.tokens.map((tok, tIdx) =>
              tok.className || tok.style ? (
                <span key={tIdx} className={tok.className} style={tok.style}>
                  {tok.text}
                </span>
              ) : (
                <span key={tIdx}>{tok.text}</span>
              ),
            )}
      </div>
    );
  };

  return (
    <div className={className ? `ai-ansi-log ${className}` : "ai-ansi-log"}>
      <div className="ai-ansi-header">
        <span className="ai-ansi-meta" style={{ fontVariantNumeric: "tabular-nums" }}>
          {parsedLines.length} {parsedLines.length === 1 ? "line" : "lines"}
        </span>
        <button
          type="button"
          className="ai-code-btn ai-ansi-copy-btn"
          onClick={() => void handleCopy()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="ai-ansi-pre">
        <code>
          {headLines.map((line, i) => renderAnsiLine(line, `h-${i}`))}
          {shouldCollapse && (
            <div className="ai-ansi-collapse-bar">
              <button
                type="button"
                className="ai-ansi-expand-btn"
                aria-expanded={false}
                onClick={() => setExpanded(true)}
              >
                Show all {parsedLines.length} lines ({hiddenCount} hidden)
              </button>
            </div>
          )}
          {tailLines.map((line, i) => renderAnsiLine(line, `t-${i}`))}
        </code>
      </pre>
    </div>
  );
}
