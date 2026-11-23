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
