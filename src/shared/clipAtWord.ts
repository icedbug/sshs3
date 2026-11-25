/**
 * The text cut to at most `max` characters at the end of a whole word, with "…" when it was cut, so a
 * title made from a question reads "how many nginx worker…" rather than "how many nginx worker proce".
 * A text with no space in its second half is cut where it reaches the limit.
 */
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const end = /\s/.test(text[max - 1]) ? cut.length : cut.lastIndexOf(" ");
  return `${(end > max / 2 ? cut.slice(0, end) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}
