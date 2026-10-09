export type TerminalAction = 'search' | 'copyLastOutput' | 'snippets' | 'aiAssistant' | 'aiInlineCommand';

/** Window event App dispatches for terminal shortcuts; only the focused terminal reacts to it. */
export const TERMINAL_ACTION_EVENT = 'sshs3:terminal-action';

export function dispatchTerminalAction(action: TerminalAction): void {
  window.dispatchEvent(new CustomEvent<TerminalAction>(TERMINAL_ACTION_EVENT, { detail: action }));
}
