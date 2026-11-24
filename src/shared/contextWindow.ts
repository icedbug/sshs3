/**
 * The context windows the AI settings offer, in tokens.
 *
 * The smallest one still holds an acting agent: its tool list and instructions are about 72,500
 * characters (a little over 18,000 tokens at four characters to a token) before the conversation, and
 * a run needs room on top to work in. A window that cannot hold that ends the run at once
 * (`ContextWindowTooSmallError` in main/ai/hub/DirectAgentRuntime.ts), so 16k is not offered any more.
 * tests/main/contextWindowChoices.test.ts runs an agent in the smallest choice.
 */
export const CONTEXT_WINDOW_CHOICES: readonly number[] = [32768, 65536, 128000, 256000, 900000];

/** What a setup without a saved value uses. */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** Whether an agent has too little room, or none, in a window of this size. */
export const tooSmallForAgents = (tokens: number): boolean => tokens < CONTEXT_WINDOW_CHOICES[0];

/** The smallest and the largest window the assistant may set from chat: those of the form. */
export const CONTEXT_WINDOW_LEAST = CONTEXT_WINDOW_CHOICES[0];
export const CONTEXT_WINDOW_MOST = CONTEXT_WINDOW_CHOICES[CONTEXT_WINDOW_CHOICES.length - 1];

/**
 * Why a context window the assistant asked for is refused, in plain words for it, or nothing when it
 * may be set. Any whole number from the smallest choice to the largest is taken: a model's own window
 * need not be one of the choices. What the settings store reads from an older file is not checked here.
 */
export function contextWindowRefusal(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value))
    return `"contextWindowTokens" must be a whole number of tokens, from ${CONTEXT_WINDOW_LEAST} to ${CONTEXT_WINDOW_MOST}.`;
  if (value < CONTEXT_WINDOW_LEAST)
    return `A context window of ${value} tokens is too small: an agent cannot work in less than ${CONTEXT_WINDOW_LEAST}. Nothing was changed. Choose ${CONTEXT_WINDOW_LEAST} or more, up to ${CONTEXT_WINDOW_MOST}.`;
  if (value > CONTEXT_WINDOW_MOST)
    return `A context window can be at most ${CONTEXT_WINDOW_MOST} tokens. Nothing was changed.`;
  return undefined;
}
