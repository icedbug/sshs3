import { AI_MAX_CONTEXT_CHARS } from './types/ai';
import { REDACTED, maskSecretsCounted, type MaskResult } from './secretMasking';

export interface PreparedContext extends MaskResult {
  /** True when the start of the text was cut off to fit the limit. */
  clipped: boolean;
}

const OMITTED_NOTE = '[…earlier output omitted]\n';

/** Keeps the last `max` characters: the end of an output is usually where the error is. */
export function clipContext(text: string, max = AI_MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${OMITTED_NOTE}${text.slice(text.length - max)}`;
}

function countMarkers(text: string): number {
  let n = 0;
  for (let i = text.indexOf(REDACTED); i !== -1; i = text.indexOf(REDACTED, i + REDACTED.length)) n += 1;
  return n;
}

/**
 * The one place that turns terminal text into what is shown in the "Show what will be sent" preview
 * and sent to the model. Masking runs on the whole text before it is clipped: cutting first could
 * remove the BEGIN line of a private key and leave its body readable. `count` is the number of
 * masked values that are still in the text after clipping, never more than were actually masked.
 */
export function prepareContext(raw: string): PreparedContext {
  const masked = maskSecretsCounted(raw.replace(/\r\n?/g, '\n'));
  const text = clipContext(masked.text);
  const clipped = text !== masked.text;
  return { text, count: clipped ? Math.min(masked.count, countMarkers(text)) : masked.count, clipped };
}
