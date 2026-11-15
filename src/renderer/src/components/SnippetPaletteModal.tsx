import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Pencil, Play, Plus, Sparkles, Terminal, Trash2, X } from 'lucide-react';
import type { Snippet } from '@shared/types/snippets';
import { SNIPPET_MAX_COMMAND_CHARS, SNIPPET_MAX_NAME_CHARS } from '@shared/types/snippets';
import { useModalDismiss } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useConfirm } from './ConfirmDialog';
import { plural } from '../lib/plural';
import {
  expandSnippet,
  getDefaultSnippetValues,
  getMissingSnippetVariables,
  hasSnippetVariables,
  parseSnippetVariables,
  type SnippetContext,
} from '../lib/snippets';

interface SnippetPaletteModalProps {
  /** Connection the terminal belongs to: snippets limited to it are listed, and new ones can be limited to it. */
  hostKey: string;
  hostLabel: string;
  context: SnippetContext;
  /** `run` is true for Ctrl+Enter: the command is executed instead of just typed. */
  onInsert: (command: string, run: boolean) => void;
  /** Optional handler when the user chooses "Run in AI". Falls back to `sshs3:ai-attach`. */
  onRunInAi?: (command: string, snippet: Snippet) => void;
  /** Optional snippet to open directly in the parameter fill-in/preview form. */
  initialSnippet?: Snippet;
  onClose: () => void;
}

type Draft = { id?: string; name: string; command: string; hostOnly: boolean };

export const SnippetPaletteModal: React.FC<SnippetPaletteModalProps> = ({
  hostKey,
  hostLabel,
  context,
  onInsert,
  onRunInAi,
  initialSnippet,
  onClose,
}) => {
  const onBackdrop = useModalDismiss(onClose, true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  useDialogFocus(dialogRef, true);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filling, setFilling] = useState<Snippet | null>(() => initialSnippet ?? null);
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    initialSnippet ? getDefaultSnippetValues(initialSnippet.command) : {}
  );
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const firstParamRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // xterm refocuses its textarea right after the opening key/mouse event; take focus back once that settles.
  useEffect(() => {
    if (filling) {
      firstParamRef.current?.focus();
      const timer = setTimeout(() => firstParamRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
    searchRef.current?.focus();
    const timer = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial focus recovery only

  useEffect(() => {
    if (draft) nameRef.current?.focus();
    else if (filling) firstParamRef.current?.focus();
    else searchRef.current?.focus();
  }, [draft === null, filling?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- refocus only when switching views

  useEffect(() => {
    let cancelled = false;
    window.multissh
      ?.snippetsList?.(hostKey)
      .then((list) => {
        if (!cancelled) setSnippets(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hostKey]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? snippets.filter((s) => s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q))
      : snippets;
  }, [snippets, query]);

  const activeIndex = Math.min(selected, Math.max(visible.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, visible]);

  const fillingVars = useMemo(
    () => (filling ? parseSnippetVariables(filling.command) : []),
    [filling]
  );

  const previewCommand = useMemo(
    () => (filling ? expandSnippet(filling.command, context, new Date(), paramValues) : ''),
    [filling, context, paramValues]
  );

  const missingVars = useMemo(
    () => (filling ? getMissingSnippetVariables(filling.command, paramValues) : []),
    [filling, paramValues]
  );

  const runInAi = (command: string, snippet: Snippet): void => {
    if (onRunInAi) {
      onRunInAi(command, snippet);
    } else {
      window.dispatchEvent(
        new CustomEvent('sshs3:ai-attach', {
          detail: {
            label: snippet.name,
            text: command,
            prompt: command,
          },
        })
      );
    }
    onClose();
  };

  const openFillForm = (snippet: Snippet): void => {
    setFilling(snippet);
    setParamValues(getDefaultSnippetValues(snippet.command));
  };

  const activateSnippet = (snippet: Snippet, run: boolean): void => {
    if (hasSnippetVariables(snippet.command)) {
      openFillForm(snippet);
      return;
    }
    onInsert(expandSnippet(snippet.command, context), run);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (visible.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((activeIndex + 1) % visible.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((activeIndex - 1 + visible.length) % visible.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateSnippet(visible[activeIndex], e.ctrlKey || e.metaKey);
    }
  };

  const startEdit = (snippet?: Snippet): void => {
    setError(null);
    setFilling(null);
    setDraft(
      snippet
        ? { id: snippet.id, name: snippet.name, command: snippet.command, hostOnly: Boolean(snippet.hostKey) }
        : { name: '', command: '', hostOnly: false }
    );
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.command.trim()) {
      setError('Name and command are required.');
      return;
    }
    try {
      const saved = await window.multissh.snippetsSave({
        id: draft.id,
        name: draft.name,
        command: draft.command,
        ...(draft.hostOnly ? { hostKey, hostLabel } : {}),
      });
      setSnippets((prev) => {
        const exists = prev.some((s) => s.id === saved.id);
        return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved];
      });
      setDraft(null);
    } catch {
      setError('Could not save the snippet.');
    }
  };

  const remove = async (id: string): Promise<void> => {
    const name = snippets.find((s) => s.id === id)?.name;
    const confirmed = await confirm({
      title: 'Delete snippet',
      message: name ? `Delete the snippet "${name}"? This cannot be undone.` : 'Delete this snippet? This cannot be undone.',
      confirmLabel: 'Delete snippet',
    });
    if (!confirmed) return;
    setSnippets((prev) => prev.filter((s) => s.id !== id));
    window.multissh.snippetsDelete(id).catch(() => {
      // Deleting failed: show what is really stored again.
      window.multissh.snippetsList(hostKey).then(setSnippets).catch(() => {});
    });
  };

  const headerTitle = draft
    ? draft.id
      ? 'Edit snippet'
      : 'New snippet'
    : filling
      ? filling.name
      : 'Snippets';

  const headerSubtitle = draft
    ? 'Variables: {{host}}, {{user}}, {{date}}, {{var}}, {{var=default}}'
    : filling
      ? 'Fill in workflow parameters and preview before running'
      : '↑/↓ to navigate, Enter to insert or configure, Ctrl+Enter to run';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onBackdrop}
      data-testid="snippet-palette-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Snippets"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border-subtle bg-app-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-txt-primary">{headerTitle}</h2>
            <p className="text-xs text-txt-muted">{headerSubtitle}</p>
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

        {draft ? (
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void saveDraft();
            }}
          >
            <input
              ref={nameRef}
              type="text"
              aria-label="Snippet name"
              value={draft.name}
              maxLength={SNIPPET_MAX_NAME_CHARS}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Name"
              className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-xs text-txt-primary outline-none focus:border-sky-500"
            />
            <textarea
              aria-label="Snippet command"
              value={draft.command}
              maxLength={SNIPPET_MAX_COMMAND_CHARS}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="Command (e.g. kubectl logs -n {{namespace=default}} {{pod}})"
              rows={5}
              className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
            />
            <label className="flex items-center gap-2 text-xs text-txt-secondary">
              <input
                type="checkbox"
                checked={draft.hostOnly}
                onChange={(e) => setDraft({ ...draft, hostOnly: e.target.checked })}
              />
              Only for this connection ({hostLabel || 'this terminal'})
            </label>
            <p className="text-[11px] text-txt-muted">Snippets are stored unencrypted. Do not put passwords or tokens in them.</p>
            {error && (
              <p role="alert" className="text-xs text-rose-400">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-lg border border-border-subtle px-3 py-2 text-xs text-txt-secondary hover:bg-app-surface-hover cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 cursor-pointer"
              >
                Save
              </button>
            </div>
          </form>
        ) : filling ? (
          <form
            data-testid="snippet-fill-form"
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
            onSubmit={(e) => {
              e.preventDefault();
              onInsert(previewCommand, false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onInsert(previewCommand, true);
              }
            }}
          >
            <div className="grid gap-2.5 sm:grid-cols-2">
              {fillingVars.map((v, idx) => (
                <label key={v.name} className="flex flex-col gap-1 text-xs">
                  <span className="flex items-center justify-between font-medium text-txt-secondary">
                    <span>{v.name}</span>
                    {v.defaultValue !== undefined ? (
                      <span className="text-[10px] font-normal text-txt-muted">default: {v.defaultValue || '""'}</span>
                    ) : (
                      <span className="text-[10px] font-normal text-amber-400">required</span>
                    )}
                  </span>
                  <input
                    ref={idx === 0 ? firstParamRef : undefined}
                    type="text"
                    aria-label={v.name}
                    value={paramValues[v.name] ?? ''}
                    placeholder={v.defaultValue ?? `Enter ${v.name}`}
                    onChange={(e) =>
                      setParamValues((prev) => ({
                        ...prev,
                        [v.name]: e.target.value,
                      }))
                    }
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
                  />
                </label>
              ))}
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] font-medium text-txt-muted">
                <span>Live preview</span>
                {missingVars.length > 0 && (
                  <span className="text-amber-400">Unfilled: {missingVars.join(', ')}</span>
                )}
              </div>
              <pre
                data-testid="snippet-live-preview"
                className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-subtle bg-app-input p-3 font-mono text-xs text-txt-primary"
              >
                {previewCommand}
              </pre>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => setFilling(null)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs text-txt-secondary hover:bg-app-surface-hover cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => runInAi(previewCommand, filling)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-300 hover:bg-violet-500/25 cursor-pointer"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Run in AI
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-txt-primary hover:bg-app-surface-hover cursor-pointer"
                >
                  <Terminal className="h-3.5 w-3.5" />
                  Stage in Terminal
                </button>
                <button
                  type="button"
                  onClick={() => onInsert(previewCommand, true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 cursor-pointer"
                >
                  <Play className="h-3.5 w-3.5" />
                  Run in Terminal
                </button>
              </div>
            </div>
          </form>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-divider px-4 py-2">
              <input
                ref={searchRef}
                type="text"
                aria-label="Search snippets"
                aria-controls="snippet-list"
                aria-activedescendant={visible.length > 0 ? `snippet-item-${activeIndex}` : undefined}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(0);
                }}
                onKeyDown={onSearchKeyDown}
                placeholder="Search snippets…"
                className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-xs text-txt-primary outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={() => startEdit()}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-border-subtle px-3 py-2 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
            </div>

            <div role="status" aria-live="polite" className="sr-only">
              {visible.length === 0 ? 'No snippets' : plural(visible.length, 'snippet')}
            </div>
            <ul id="snippet-list" ref={listRef} aria-label="Snippets" className="min-h-0 flex-1 overflow-y-auto p-2">
              {visible.length === 0 && (
                <li className="px-3 py-6 text-center text-xs text-txt-muted">
                  {snippets.length === 0 ? 'No snippets yet. Click New to add one.' : 'No matches.'}
                </li>
              )}
              {visible.map((snippet, index) => {
                const vars = parseSnippetVariables(snippet.command);
                return (
                  <li
                    key={snippet.id}
                    id={`snippet-item-${index}`}
                    aria-current={index === activeIndex ? 'true' : undefined}
                    data-active={index === activeIndex}
                    onMouseMove={() => index !== activeIndex && setSelected(index)}
                    className={`group flex items-start gap-1 rounded-lg ${
                      index === activeIndex ? 'bg-app-surface-hover ring-1 ring-sky-500/60' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => activateSnippet(snippet, e.ctrlKey || e.metaKey)}
                      className="min-w-0 flex-1 px-3 py-2 text-left cursor-pointer"
                    >
                      <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-txt-primary">
                        <span>{snippet.name}</span>
                        {snippet.hostKey && (
                          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-normal text-sky-400">
                            {snippet.hostLabel || 'this connection'}
                          </span>
                        )}
                        {vars.length > 0 && (
                          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal text-violet-300">
                            {plural(vars.length, 'param')}
                          </span>
                        )}
                      </span>
                      <pre className="mt-1 max-h-14 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] text-txt-muted">
                        {snippet.command.length > 300 ? `${snippet.command.slice(0, 300)}…` : snippet.command}
                      </pre>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        vars.length > 0
                          ? openFillForm(snippet)
                          : runInAi(expandSnippet(snippet.command, context), snippet)
                      }
                      aria-label="Run in AI"
                      title={vars.length > 0 ? 'Configure parameters and run in AI' : 'Run in AI'}
                      className="my-2 rounded-md p-1.5 text-txt-muted opacity-0 hover:text-violet-300 focus:opacity-100 group-hover:opacity-100 cursor-pointer"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(snippet)}
                      aria-label="Edit snippet"
                      className="my-2 rounded-md p-1.5 text-txt-muted opacity-0 hover:text-txt-primary focus:opacity-100 group-hover:opacity-100 cursor-pointer"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(snippet.id)}
                      aria-label="Delete snippet"
                      className="my-2 mr-2 rounded-md p-1.5 text-txt-muted opacity-0 hover:text-rose-400 focus:opacity-100 group-hover:opacity-100 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
