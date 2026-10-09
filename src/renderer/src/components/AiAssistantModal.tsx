import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react';
import {
  AI_MAX_PROMPT_CHARS,
  type AiAskResult,
  type AiConfigView,
  type AiTask,
  type AiTerminalEnvironment,
} from '@shared/types/ai';
import { useModalDismiss } from '../lib/useModalDismiss';

interface AiAssistantModalProps {
  environment: AiTerminalEnvironment;
  /** Terminal text selected when the assistant was opened. */
  selection: string;
  /** Output of the last command, when the terminal tracked one. */
  lastOutput: string;
  /** Types the command into the terminal without pressing Enter. */
  onInsert: (command: string) => void;
  onClose: () => void;
}

type ContextSource = 'none' | 'selection' | 'lastOutput';

const IPC_PREFIX = /^Error invoking remote method '[^']+':\s*(Error:\s*)?/i;

const lineCount = (text: string): number => (text ? text.replace(/\n+$/, '').split('\n').length : 0);

function providerLabel(config: AiConfigView): string {
  if (config.provider === 'anthropic') return `Anthropic · ${config.model}`;
  let host = config.baseUrl ?? '';
  try {
    host = new URL(host).host;
  } catch {
    // Show the raw value.
  }
  return `${host || 'OpenAI-compatible'} · ${config.model}`;
}

export const AiAssistantModal: React.FC<AiAssistantModalProps> = ({ environment, selection, lastOutput, onInsert, onClose }) => {
  const onBackdrop = useModalDismiss(onClose, true);
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [task, setTask] = useState<AiTask>(selection ? 'explain' : 'command');
  const [source, setSource] = useState<ContextSource>(selection ? 'selection' : 'none');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiAskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    window.multissh
      .aiGetConfig()
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the AI assistant settings.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // xterm refocuses its textarea right after the opening key event; take focus back once that settles.
  useEffect(() => {
    promptRef.current?.focus();
    const timer = setTimeout(() => promptRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [config?.enabled]);

  const contextText = source === 'selection' ? selection : source === 'lastOutput' ? lastOutput : '';
  const canSubmit = !busy && (task === 'command' ? prompt.trim() !== '' : prompt.trim() !== '' || contextText.trim() !== '');

  const switchTask = (next: AiTask): void => {
    setTask(next);
    setResult(null);
    setError(null);
    // Explaining needs something to explain: default to whatever the terminal has.
    if (next === 'explain' && source === 'none') setSource(selection ? 'selection' : lastOutput ? 'lastOutput' : 'none');
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    const id = ++requestIdRef.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const answer = await window.multissh.aiAsk({
        task,
        prompt: prompt.trim(),
        ...(contextText ? { context: contextText } : {}),
        environment,
      });
      if (id === requestIdRef.current) setResult(answer);
    } catch (err) {
      if (id === requestIdRef.current) {
        setError((err instanceof Error ? err.message : String(err)).replace(IPC_PREFIX, '') || 'The request failed.');
      }
    } finally {
      if (id === requestIdRef.current) setBusy(false);
    }
  };

  const copyCommand = (command: string): void => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const contextOptions = useMemo(
    () => [
      { value: 'none' as const, label: 'Nothing', disabled: false },
      { value: 'selection' as const, label: `Selected text (${lineCount(selection)} lines)`, disabled: !selection },
      { value: 'lastOutput' as const, label: `Last command output (${lineCount(lastOutput)} lines)`, disabled: !lastOutput },
    ],
    [selection, lastOutput]
  );

  const body = (() => {
    if (!config && !error) {
      return <p className="px-4 py-6 text-center text-xs text-txt-muted">Loading…</p>;
    }
    if (config && !config.enabled) {
      return (
        <p className="px-4 py-6 text-center text-xs text-txt-muted" data-testid="ai-disabled">
          The AI assistant is off. Turn it on and choose a provider in Settings → AI Assistant.
        </p>
      );
    }
    return (
      <form
        className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div role="tablist" aria-label="Assistant mode" className="flex gap-1 rounded-lg bg-app-input p-1 text-xs">
          {(
            [
              ['command', 'Suggest a command'],
              ['explain', 'Explain output'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={task === value}
              onClick={() => switchTask(value)}
              className={`flex-1 rounded-md px-3 py-1.5 cursor-pointer ${
                task === value ? 'bg-app-surface font-medium text-txt-primary shadow-sm' : 'text-txt-muted hover:text-txt-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <textarea
          ref={promptRef}
          aria-label="Ask the assistant"
          value={prompt}
          maxLength={AI_MAX_PROMPT_CHARS}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            task === 'command'
              ? 'What do you want to do? e.g. "find files over 100 MB under /var and sort by size"'
              : 'Optional question, e.g. "why does this fail?"'
          }
          rows={3}
          className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-xs text-txt-primary outline-none focus:border-sky-500"
        />

        <div className="flex flex-wrap items-center gap-2 text-xs text-txt-secondary">
          <label htmlFor="ai-context">Include from terminal:</label>
          <select
            id="ai-context"
            value={source}
            onChange={(e) => setSource(e.target.value as ContextSource)}
            className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500"
          >
            {contextOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {contextText && (
          <details className="text-xs text-txt-muted">
            <summary className="cursor-pointer">Show what will be sent</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-app-input p-2 font-mono text-[11px]">
              {contextText}
            </pre>
          </details>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-txt-muted">
            {config ? `Sent to ${providerLabel(config)}. ` : ''}Passwords, tokens and keys in common formats are masked first.
          </p>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {busy ? 'Thinking…' : 'Ask'}
          </button>
        </div>

        {error && (
          <p role="alert" className="text-xs text-rose-400">
            {error}
          </p>
        )}

        {result && (
          <div className="space-y-2 border-t border-divider pt-3" data-testid="ai-result">
            {result.command !== undefined && result.command !== '' && (
              <div className="space-y-2">
                <pre
                  data-testid="ai-command"
                  className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-app-input p-3 font-mono text-xs text-txt-primary"
                >
                  {result.command}
                </pre>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => copyCommand(result.command ?? '')}
                    className="flex items-center gap-1 rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-txt-secondary hover:bg-app-surface-hover cursor-pointer"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onInsert(result.command ?? '')}
                    title="Types the command into the terminal. Review it, then press Enter yourself."
                    className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 cursor-pointer"
                  >
                    <CornerDownLeft className="h-3.5 w-3.5" />
                    Insert into terminal
                  </button>
                </div>
              </div>
            )}
            {result.text && <p className="whitespace-pre-wrap text-xs text-txt-secondary">{result.text}</p>}
            {result.redacted && <p className="text-[11px] text-amber-400">Some secrets were masked before sending.</p>}
          </div>
        )}
      </form>
    );
  })();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onBackdrop}
      data-testid="ai-assistant-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI Assistant"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border-subtle bg-app-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-sky-400" />
            <div>
              <h2 className="text-sm font-semibold text-txt-primary">AI Assistant</h2>
              <p className="text-xs text-txt-muted">Enter to ask. Commands are typed into the terminal, never run for you.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {body}
      </div>
    </div>,
    document.body
  );
};
