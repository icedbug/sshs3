import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { endsAtPrompt, isPromptLine, type CommandOutputTracker } from './terminalOutput';
import { detectSudoRetry, isRootPromptLine, manualSudoInput, type SudoRetrySuggestion } from './sudoRetry';
import { createRendererLogger } from './log';

const log = createRendererLogger('sudo-retry');

/** Output must be quiet this long before we decide the command has finished. */
const QUIET_MS = 250;
/** Enter is ignored this long after the prompt appears, so a reflexive double-Enter does not run it. */
const ACCEPT_GUARD_MS = 400;

export interface UseSudoRetryOptions {
  enabled: boolean;
  /** The session is known to log in as root (an SSH profile with user `root`). */
  rootUser?: boolean;
  termRef: RefObject<Terminal | null>;
  trackerRef: RefObject<CommandOutputTracker | null>;
  /** Types the suggested command onto the prompt (without pressing Enter). */
  run: (sudoCommand: string) => void;
}

/**
 * Offers to re-run a command that just failed with a permission error, prefixed with `sudo`.
 * Enter on a prompt line arms the check; once output goes quiet and the shell is back at a prompt, the
 * command and its own output are inspected. Any other input, Esc, or the screen changing under the
 * offer dismisses it.
 */
export function useSudoRetry({ enabled, rootUser = false, termRef, trackerRef, run }: UseSudoRetryOptions) {
  const [suggestion, setSuggestion] = useState<SudoRetrySuggestion | null>(null);
  const suggestionRef = useRef<SudoRetrySuggestion | null>(null);
  suggestionRef.current = suggestion;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const rootUserRef = useRef(rootUser);
  rootUserRef.current = rootUser;
  const runRef = useRef(run);
  runRef.current = run;
  const armedRef = useRef(false);
  const shownAtRef = useRef(0);
  /** What the offer was built from, to notice when the screen no longer shows that command. */
  const shownSignatureRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dismiss = useCallback(() => {
    clearTimeout(timerRef.current);
    armedRef.current = false;
    if (suggestionRef.current) setSuggestion(null);
  }, []);

  const evaluate = useCallback(() => {
    const term = termRef.current;
    const tracker = trackerRef.current;
    if (!armedRef.current || !enabledRef.current || !term || !tracker) return;
    const buf = term.buffer.active;
    if (buf.type !== 'normal') {
      armedRef.current = false;
      return;
    }
    const cursorLine = buf.getLine(buf.baseY + buf.cursorY);
    const cursorText = cursorLine?.translateToString(true) ?? '';
    if (!cursorText.trim()) return;
    // Back at a prompt: one the patterns know, or any line where the cursor stands after a terminator
    // and a space (`bash-5.3$ `, zsh's `user@host ~ % `, fish's `user@host ~> `).
    const cursorX = buf.cursorX ?? cursorText.length;
    const atPrompt =
      isPromptLine(cursorText) ||
      endsAtPrompt(
        cursorLine?.translateToString(false, 0, cursorX) ?? '',
        cursorLine?.translateToString(true, cursorX) ?? ''
      );
    // Still running (or waiting for input): stay armed and look again on the next output.
    if (!atPrompt) return;
    armedRef.current = false;
    const result = tracker.lastCommandResult({ atPrompt: true });
    if (!result) {
      // Only for shells that send OSC 133 marks, where a missing result points at the marks.
      const snapshot = tracker.debugSnapshot();
      if (snapshot.mode === 'osc') log.debug('no result', snapshot);
      return;
    }
    const found = detectSudoRetry({
      command: result.command,
      output: result.output,
      exitCode: result.exitCode,
      atRootPrompt: rootUserRef.current || isRootPromptLine(cursorText),
    });
    // Structure only, never the text of the command or the screen.
    log.debug('considered', {
      offered: Boolean(found),
      commandLen: result.command.length,
      outputLines: result.output.split('\n').length,
      ...tracker.debugSnapshot(),
    });
    if (found) {
      shownAtRef.current = Date.now();
      shownSignatureRef.current = `${result.command}\n${result.output}`;
      setSuggestion(found);
    }
  }, [termRef, trackerRef]);

  /** Output arrived while an offer is showing: drop it when it no longer matches the screen. */
  const revalidate = useCallback(() => {
    if (!suggestionRef.current) return;
    const result = trackerRef.current?.lastCommandResult({ atPrompt: true });
    if (!result || `${result.command}\n${result.output}` !== shownSignatureRef.current) dismiss();
  }, [trackerRef, dismiss]);

  /** The user pressed Enter in the terminal. */
  const notifyEnter = useCallback(() => {
    dismiss();
    // Armed on every Enter in the normal screen. Whether it started a command is decided later from the
    // finished screen (a prompt in front of the line, see lastCommandResult), because over a slow
    // connection the echo of what was typed has not been drawn yet when Enter is pressed.
    armedRef.current = enabledRef.current && termRef.current?.buffer.active.type === 'normal';
  }, [dismiss, termRef]);

  /** Anything other than Enter was typed. */
  const notifyInput = useCallback(() => {
    if (suggestionRef.current) dismiss();
  }, [dismiss]);

  /** Output arrived from the session. */
  const notifyOutput = useCallback(() => {
    // A full-screen program took over the screen: whatever it printed is not a command result.
    if (termRef.current && termRef.current.buffer.active.type !== 'normal') armedRef.current = false;
    if (!armedRef.current && !suggestionRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(armedRef.current ? evaluate : revalidate, QUIET_MS);
  }, [termRef, evaluate, revalidate]);

  /**
   * The manual action: types `sudo` in front of the last command whether or not an error was detected.
   * Returns what was done so the caller can tell the user (see `manualSudoInput`).
   */
  const rerunWithSudo = useCallback(
    (command: string | null) => {
      dismiss();
      const input = manualSudoInput(command);
      if (input.kind !== 'refused') runRef.current(input.text);
      return input.kind;
    },
    [dismiss]
  );

  const accept = useCallback(() => {
    const current = suggestionRef.current;
    if (!current) return;
    dismiss();
    runRef.current(current.sudoCommand);
  }, [dismiss]);

  /**
   * Key handler for the terminal's custom key hook. Returns true when the key was consumed
   * (the terminal must not forward it to the shell).
   */
  const handleKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!suggestionRef.current || e.type !== 'keydown') return false;
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (Date.now() - shownAtRef.current >= ACCEPT_GUARD_MS) accept();
        return true;
      }
      return false;
    },
    [accept, dismiss]
  );

  useEffect(() => {
    if (!enabled) dismiss();
  }, [enabled, dismiss]);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { suggestion, notifyEnter, notifyInput, notifyOutput, handleKey, dismiss, rerunWithSudo };
}
