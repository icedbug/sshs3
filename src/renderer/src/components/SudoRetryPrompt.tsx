interface SudoRetryPromptProps {
  /** The exact command that Enter will type onto the prompt. */
  command: string;
}

/**
 * Docked below the terminal (not floating over it), so it never hides output or the prompt.
 * Enter only types the command onto the prompt; a second Enter in the shell runs it.
 */
export function SudoRetryPrompt({ command }: SudoRetryPromptProps) {
  return (
    <div
      data-testid="sudo-retry-prompt"
      role="status"
      className="flex shrink-0 items-start gap-3 border-t border-divider bg-app-surface px-3 py-1.5 text-xs text-txt-primary"
    >
      <span className="shrink-0 py-0.5 font-medium whitespace-nowrap">Re-run with sudo?</span>
      {/* The whole command is shown (wrapped, never truncated) so what is confirmed is what runs. */}
      <code
        className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all rounded border border-border-subtle bg-app-input px-2 py-0.5 font-mono"
      >
        {command}
      </code>
      <span className="flex shrink-0 items-center gap-3 whitespace-nowrap py-0.5 text-txt-muted">
        <span>
          <kbd className="rounded border border-border-subtle bg-app-surface-subtle px-1.5 py-0.5 text-txt-primary">Enter</kbd> Insert
        </span>
        <span>
          <kbd className="rounded border border-border-subtle bg-app-surface-subtle px-1.5 py-0.5 text-txt-primary">Esc</kbd> Dismiss
        </span>
      </span>
    </div>
  );
}
