import { clip, maskContext } from "./privacy";

/**
 * What a page says, held against where it says it came from. A model writes
 * the pages, and agents run what the pages say; a command the model made up
 * looks exactly like one it copied. So two things are checked without a
 * model: every line in a page's code blocks has to be in the text the page
 * was written from, and every source it names has to be one it rests on.
 * What fails is not removed (the model may only have tidied a line): it is
 * listed on the page, shown to the agent that opens it, and put up for review.
 */

export interface Unverified {
  commands: string[];
  citations: string[];
}

export interface CitedSourceRef {
  title: string;
  section?: string;
  raw: string;
  kind: "source" | "learned from";
}

export interface CheckPageSourceInfo {
  title: string;
  headings?: string[];
  chunks?: Array<{ heading?: string }>;
}

const MAX_KEPT = 12;
/** Case is kept: `-R` and `-r` are different commands. Only the spacing is evened out. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const loose = (s: string): string => flat(s).toLowerCase();
const normCitation = (s: string): string =>
  loose(s)
    .replace(/\s*(?:[›»]|-{1,2}>|>)\s*/g, " > ")
    .replace(/\s+/g, " ")
    .trim();

/** The lines in a text's fenced code blocks, as an agent would type them. Comments and one-word lines are left out. */
export function commandLines(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of body.matchAll(/```[^\n]*\n([\s\S]*?)(?:```|$)/g))
    for (const raw of block[1].split("\n")) {
      let line = flat(raw);
      // A prompt in front of the command is not part of it.
      line = line.replace(/^(?:\$|>|[\w.-]+@[\w.-]+[:~\w/.-]*[$#])\s+/, "");
      // A line continued on the next is checked without its backslash.
      line = line.replace(/\s*\\$/, "");
      if (line.startsWith("#") || line.startsWith("//")) continue;
      // An explanation after the command is the page's own.
      line = line.replace(/\s+#\s.*$/, "");
      if (line.length < 6 || !/\s/.test(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  return out;
}

/**
 * Extracts structured source citations from a body, preserving `<section>`
 * from `(source: Title > Section)` / `(source: Title › Section)` as well as
 * `(learned from: Title)`.
 */
export function citedSourceRefs(body: string): CitedSourceRef[] {
  const out: CitedSourceRef[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\((source|learned from):\s*([^)\n]+)\)?/gi)) {
    const kind = m[1].toLowerCase() === "learned from" ? "learned from" : "source";
    const raw = m[2].trim();
    const parts = raw
      .split(/\s*(?:[›»]|-{1,2}>|>)\s*/)
      .map((part) => part.replace(/…$/, "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    const title = parts[0];
    const section = parts.length > 1 ? parts.slice(1).join(" › ") : undefined;
    const key = `${kind}:${loose(title)}:${loose(section ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, section, raw, kind });
  }
  return out;
}

/** The sources a text names: "(source: Title › Section)" and "(learned from: Title)". */
export function citedSources(body: string): string[] {
  const out = new Set<string>();
  for (const ref of citedSourceRefs(body)) {
    if (ref.title) out.add(ref.title);
  }
  return [...out];
}

function titleMatches(cited: string, candidateTitle: string): boolean {
  const c = loose(cited);
  if (c.length < 3) return true;
  const title = loose(candidateTitle);
  // A long title is cut where the page names it, and a title with a bracket in it ends early.
  return title === c || title.startsWith(c) || c.startsWith(title.slice(0, 40)) || (c.length >= 8 && title.includes(c));
}

function resolves(cited: string, titles: string[]): boolean {
  return titles.some((t) => titleMatches(cited, t));
}

function sectionResolves(citedSection: string, headings: string[]): boolean {
  const normSec = normCitation(citedSection);
  if (normSec.length < 2) return true;
  const secSegments = normSec.split(/\s*>\s*/).filter(Boolean);
  const secWords = normSec.split(/[^a-z0-9_.-]+/).filter((w) => w.length >= 3);

  return headings.some((rawHeading) => {
    const normHead = normCitation(rawHeading);
    if (!normHead) return false;
    if (
      normHead === normSec ||
      normHead.endsWith(`> ${normSec}`) ||
      normSec.endsWith(`> ${normHead}`) ||
      normHead.startsWith(normSec) ||
      (normSec.length >= 4 && normHead.includes(normSec))
    ) {
      return true;
    }
    const headSegments = normHead.split(/\s*>\s*/).filter(Boolean);
    if (secSegments.length === 1 && headSegments.some((seg) => seg === normSec || (normSec.length >= 4 && seg.includes(normSec)))) {
      return true;
    }
    if (secWords.length > 0 && secWords.every((w) => normHead.includes(w))) {
      return true;
    }
    return false;
  });
}

function headingsForSource(
  citedTitle: string,
  sources: CheckPageSourceInfo[] | undefined,
  sourceHeadings: string[] | Record<string, string[]> | undefined,
): string[] {
  const out: string[] = [];
  if (sources) {
    for (const s of sources) {
      if (!titleMatches(citedTitle, s.title)) continue;
      for (const h of s.headings ?? []) if (h?.trim()) out.push(h.trim());
      for (const c of s.chunks ?? []) if (c.heading?.trim()) out.push(c.heading.trim());
    }
  }
  if (Array.isArray(sourceHeadings)) {
    for (const h of sourceHeadings) if (h?.trim()) out.push(h.trim());
  } else if (sourceHeadings) {
    for (const [title, list] of Object.entries(sourceHeadings)) {
      if (!titleMatches(citedTitle, title)) continue;
      for (const h of list) if (h?.trim()) out.push(h.trim());
    }
  }
  return out;
}

function previousContainsCitation(previousBody: string, ref: CitedSourceRef): boolean {
  const prevNorm = normCitation(previousBody);
  if (!ref.section) return prevNorm.includes(loose(ref.title));
  const full = normCitation(`${ref.title} > ${ref.section}`);
  return prevNorm.includes(full);
}

/**
 * Which of a page's commands are in none of the texts it was written from,
 * and which sources or source sections it names without resting on them.
 * A line or citation the page already had counts as supported unless it was
 * itself listed: what a person wrote, or what an earlier check found in an
 * earlier source, is not doubted again.
 */
export function checkPageText(input: {
  body: string;
  /** The text the page was just written from: the source, or the record of the run. */
  sourceText: string;
  /** The titles of everything the page rests on, the new source included. */
  sourceTitles: string[];
  /** Optional source chunk headings used to verify cited `(source: Title > Section)` references. */
  sources?: CheckPageSourceInfo[];
  /** Optional headings array (for single-source checks) or title-keyed headings map. */
  sourceHeadings?: string[] | Record<string, string[]>;
  previous?: { body: string; unverified?: Unverified };
}): Unverified | undefined {
  const source = flat(input.sourceText);
  // A page is stored with secrets masked; the source may still have them. Either form counts as found.
  const masked = flat(maskContext(input.sourceText));
  const before = input.previous ? flat(input.previous.body) : "";
  const doubted = new Set(input.previous?.unverified?.commands ?? []);
  const commands = commandLines(input.body).filter(
    (line) => !source.includes(line) && !masked.includes(line) && !(before.includes(line) && !doubted.has(line)),
  );

  const allTitles = [
    ...input.sourceTitles,
    ...(input.sources?.map((s) => s.title) ?? []),
    ...(input.sourceHeadings && !Array.isArray(input.sourceHeadings) ? Object.keys(input.sourceHeadings) : []),
  ];
  const stillDoubted = new Set((input.previous?.unverified?.citations ?? []).map(normCitation));

  const citations: string[] = [];
  const seenCitations = new Set<string>();
  for (const ref of citedSourceRefs(input.body)) {
    const label = ref.section ? `${ref.title} › ${ref.section}` : ref.title;
    const labelNorm = normCitation(label);
    const titleOk = resolves(ref.title, allTitles);
    if (!titleOk) {
      const keptByPrevious =
        input.previous &&
        previousContainsCitation(input.previous.body, ref) &&
        !stillDoubted.has(labelNorm) &&
        !stillDoubted.has(loose(ref.title));
      if (!keptByPrevious && !seenCitations.has(labelNorm)) {
        seenCitations.add(labelNorm);
        citations.push(label);
      }
      continue;
    }

    if (ref.kind === "source" && ref.section) {
      const headings = headingsForSource(ref.title, input.sources, input.sourceHeadings);
      if (headings.length > 0 && !sectionResolves(ref.section, headings)) {
        const keptByPrevious =
          input.previous &&
          previousContainsCitation(input.previous.body, ref) &&
          !stillDoubted.has(labelNorm);
        if (!keptByPrevious && !seenCitations.has(labelNorm)) {
          seenCitations.add(labelNorm);
          citations.push(label);
        }
      }
    }
  }

  if (commands.length === 0 && citations.length === 0) return undefined;
  return {
    commands: commands.slice(0, MAX_KEPT).map((c) => clip(c, 240)),
    citations: citations.slice(0, MAX_KEPT).map((c) => clip(c, 120)),
  };
}

/** What is left of a list when the text changed: only what the text still says. */
export function stillUnverified(body: string, unverified: Unverified | undefined): Unverified | undefined {
  if (!unverified) return undefined;
  const text = flat(body);
  const lowerNorm = normCitation(body);
  const commands = unverified.commands.filter((c) => text.includes(c));
  const citations = unverified.citations.filter((c) => lowerNorm.includes(normCitation(c)));
  return commands.length || citations.length ? { commands, citations } : undefined;
}

/** One line for the agent that opens the page, or undefined when nothing is doubted. */
export function unverifiedNote(unverified: Unverified | undefined): string | undefined {
  if (!unverified || (unverified.commands.length === 0 && unverified.citations.length === 0)) return undefined;
  return [
    unverified.commands.length
      ? "These lines on the page were not found in the sources it was written from; the assistant may have written them itself. Check each against the system before you rely on it."
      : "",
    unverified.citations.length ? "The page names sources it does not rest on; what it attributes to them is not backed." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
