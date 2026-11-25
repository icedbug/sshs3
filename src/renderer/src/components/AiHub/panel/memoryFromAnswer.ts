import { clipAtWord } from "@shared/clipAtWord";

/** A reference to a command of the conversation, `[c1]` or `[c1, c3]`, with the space before it. */
const COMMAND_REF = /\s*\[c\d+(?:\s*,\s*c\d+)*\]/g;
/** Code, in a block or in backticks, which is kept as it is. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/**
 * What "Save to team memory" keeps of an answer: the conversation's title as the entry's title, and the
 * answer without its references to the conversation's commands, which point nowhere outside it. Both are
 * cut at a whole word.
 */
export function memoryFromAnswer(title: string | undefined, answer: string): { title: string; text: string } {
  const named = title?.trim() ? clipAtWord(title.trim(), 60) : "From an AI conversation";
  const text = answer
    .split(CODE)
    .map((part, i) => (i % 2 ? part : part.replace(COMMAND_REF, "")))
    .join("")
    .trim();
  return { title: named, text: clipAtWord(text, 1200) };
}
