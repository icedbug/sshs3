import { isWindowsPath } from './terminalPathPreview';

/** When the hover card opens: as soon as the pointer dwells on a path, or only while Ctrl/Cmd is held. */
export type PathHoverMode = 'hover' | 'ctrl';

/** Result of looking a path up on the session's file system. */
export type ExistenceCheck = 'exists' | 'missing' | 'unknown';

export function hoverModifierSatisfied(mode: PathHoverMode, e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return mode === 'hover' || e.ctrlKey || e.metaKey;
}

/** A path that is resolved against the working directory (not absolute, not `~`). */
export function isRelativePath(raw: string): boolean {
  const cleaned = raw.trim().replace(/^['"]/, '');
  return !(cleaned.startsWith('/') || cleaned.startsWith('~') || isWindowsPath(cleaned));
}

export interface PreviewGateInput {
  /** No slash, no extension and not a well-known filename: any word in the output could look like this. */
  bareToken: boolean;
  relative: boolean;
  /**
   * The working directory comes from the shell itself (OSC 7) or from its process. A directory guessed
   * from prompt-like text in the output is not reliable: any text that looks like a prompt changes it.
   */
  cwdReliable: boolean;
}

/**
 * A relative path is looked up against the working directory, so while that is only a guess a miss
 * says nothing about the file. Everything else is worth checking.
 */
export function needsExistenceCheck({ bareToken, relative, cwdReliable }: PreviewGateInput): boolean {
  return bareToken || !relative || cwdReliable;
}

/**
 * Whether the hover card may open. Text that merely looks like a path (`Node.js`, `and/or`, a proposed
 * `src/new.ts`) is dropped when the file is known not to exist; bare words additionally need to exist.
 * When the lookup was not possible (no connection, unknown cwd) the card is shown as before.
 */
export function allowPreview(input: PreviewGateInput, existence: ExistenceCheck): boolean {
  if (input.bareToken) return existence === 'exists';
  if (!needsExistenceCheck(input)) return true;
  return existence !== 'missing';
}

export interface CwdState {
  dir: string;
  /** Reported by the shell (OSC 7) or read from its process, as opposed to guessed from the output. */
  reliable: boolean;
}

/**
 * The directory to keep when `incoming` is reported. A directory guessed from prompt-like text (any such
 * line in the output looks like a prompt) never replaces one that came from the shell or its process;
 * otherwise the next prompt redraw would turn a reliable directory back into a guess.
 */
export function mergeCwd(current: CwdState, incoming: CwdState): CwdState {
  return current.reliable && !incoming.reliable ? current : incoming;
}
