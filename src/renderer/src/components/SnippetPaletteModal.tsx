import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Snippet } from '@shared/types/snippets';
import { SNIPPET_MAX_COMMAND_CHARS, SNIPPET_MAX_NAME_CHARS } from '@shared/types/snippets';
import { useModalDismiss } from '../lib/useModalDismiss';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useConfirm } from './ConfirmDialog';
import { plural } from '../lib/plural';
import { expandSnippet, type SnippetContext } from '../lib/snippets';

interface SnippetPaletteModalProps {
  /** Connection the terminal belongs to: snippets limited to it are listed, and new ones can be limited to it. */
  hostKey: string;
  hostLabel: string;
  context: SnippetContext;
  /** `run` is true for Ctrl+Enter: the command is executed instead of just typed. */
  onInsert: (command: string, run: boolean) => void;
  onClose: () => void;
}

type Draft = { id?: string; name: string; command: string; hostOnly: boolean };

export const SnippetPaletteModal: React.FC<SnippetPaletteModalProps> = ({
  hostKey,
  hostLabel,
  context,
  onInsert,
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
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // xterm refocuses its textarea right after the opening key/mouse event; take focus back once that settles.
  useEffect(() => {
    searchRef.current?.focus();
    const timer = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (draft) nameRef.current?.focus();
    else searchRef.current?.focus();
  }, [draft === null]); // eslint-disable-line react-hooks/exhaustive-deps -- refocus only when switching between list and form

  useEffect(() => {
    let cancelled = false;
    window.multissh
      .snippetsList(hostKey)
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

  const insert = (snippet: Snippet, run: boolean): void => onInsert(expandSnippet(snippet.command, context), run);

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
      insert(visible[activeIndex], e.ctrlKey || e.metaKey);
    }
  };

  const startEdit = (snippet?: Snippet): void => {
    setError(null);
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
            <h2 className="text-sm font-semibold text-txt-primary">{draft ? (draft.id ? 'Edit snippet' : 'New snippet') : 'Snippets'}</h2>
            <p className="text-xs text-txt-muted">
              {draft
                ? 'Variables: {{host}}, {{user}}, {{date}}'
                : '↑/↓ to navigate, Enter to insert, Ctrl+Enter to insert and run'}
            </p>
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
              placeholder="Command"
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
              {visible.map((snippet, index) => (
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
                    onClick={(e) => insert(snippet, e.ctrlKey || e.metaKey)}
                    className="min-w-0 flex-1 px-3 py-2 text-left cursor-pointer"
                  >
                    <span className="block text-xs font-medium text-txt-primary">
                      {snippet.name}
                      {snippet.hostKey && (
                        <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-normal text-sky-400">
                          {snippet.hostLabel || 'this connection'}
                        </span>
                      )}
                    </span>
                    <pre className="mt-1 max-h-14 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] text-txt-muted">
                      {snippet.command.length > 300 ? `${snippet.command.slice(0, 300)}…` : snippet.command}
                    </pre>
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
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
