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
