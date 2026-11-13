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

const MAX_KEPT = 12;
/** Case is kept: `-R` and `-r` are different commands. Only the spacing is evened out. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const loose = (s: string): string => flat(s).toLowerCase();

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

/** The sources a text names: "(source: Title › Section)" and "(learned from: Title)". */
export function citedSources(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\((?:source|learned from):\s*([^)\n]+)\)?/gi)) {
    const name = m[1].split(/\s[›»>]\s|\s-{1,2}>\s/)[0].replace(/…$/, "").trim();
    if (name) out.add(name);
  }
  return [...out];
}

function resolves(cited: string, titles: string[]): boolean {
  const c = loose(cited);
  if (c.length < 3) return true;
  return titles.some((t) => {
    const title = loose(t);
    // A long title is cut where the page names it, and a title with a bracket in it ends early.
    return title === c || title.startsWith(c) || c.startsWith(title.slice(0, 40)) || (c.length >= 8 && title.includes(c));
  });
}

/**
 * Which of a page's commands are in none of the texts it was written from,
 * and which sources it names without resting on them. A line the page already
 * had counts as supported unless it was itself listed: what a person wrote, or
 * what an earlier check found in an earlier source, is not doubted again.
 */
export function checkPageText(input: {
  body: string;
  /** The text the page was just written from: the source, or the record of the run. */
  sourceText: string;
  /** The titles of everything the page rests on, the new source included. */
  sourceTitles: string[];
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
  const stillDoubted = new Set((input.previous?.unverified?.citations ?? []).map(loose));
  const citations = citedSources(input.body).filter((name) => {
    if (resolves(name, input.sourceTitles)) return false;
    // Named on the page before and not doubted then: the source it named may have been removed since.
    return !(input.previous && loose(input.previous.body).includes(loose(name)) && !stillDoubted.has(loose(name)));
  });
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
  const lower = text.toLowerCase();
  const commands = unverified.commands.filter((c) => text.includes(c));
  const citations = unverified.citations.filter((c) => lower.includes(loose(c)));
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
