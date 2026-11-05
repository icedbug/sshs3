import React, { useId, useState } from 'react';
import { X } from 'lucide-react';
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeTag, normalizeTags } from '@shared/tags';

export interface TagInputProps {
  /** Id for the text field, so a visible <label htmlFor> can name it. */
  id?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  /** Existing tags offered by the browser's autocomplete (those already on the profile are left out). */
  suggestions?: string[];
  disabled?: boolean;
}

/**
 * Chip editor for profile tags. Enter or comma adds the typed tag, Backspace in the empty field
 * removes the last one, and text still in the field is added on blur so Save never loses it.
 * Enter with an empty field is left alone, so it still submits the surrounding form.
 */
export const TagInput: React.FC<TagInputProps> = ({ id, ariaLabel, value, onChange, suggestions, disabled }) => {
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const listId = useId();
  const atLimit = value.length >= MAX_TAGS;

  const commit = (): boolean => {
    const parts = draft.split(',').map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length === 0) {
      setDraft('');
      setInvalid(false);
      return true;
    }
    if (parts.some((part) => normalizeTag(part) === null)) {
      setInvalid(true);
      return false;
    }
    onChange(normalizeTags([...value, ...parts]) ?? []);
    setDraft('');
    setInvalid(false);
    return true;
  };

  const remove = (tag: string) => onChange(value.filter((t) => t !== tag));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (draft.trim() === '' && e.key === 'Enter') return;
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      remove(value[value.length - 1]);
    }
  };

  const offered = (suggestions ?? []).filter((s) => !value.some((t) => t.toLowerCase() === s.toLowerCase()));

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 rounded-lg border bg-app-input px-2 py-1.5 focus-within:border-sky-500 ${
        invalid ? 'border-red-500' : 'border-border-subtle'
      }`}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded border border-border-subtle bg-app-surface px-2 py-0.5 text-xs text-txt-primary"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => remove(tag)}
              className="rounded text-txt-muted hover:text-txt-primary focus-visible:text-txt-primary"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled || atLimit}
        maxLength={MAX_TAG_LENGTH + 1}
        list={offered.length > 0 ? listId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${listId}-error` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (draft.trim() !== '') commit();
        }}
        placeholder={atLimit ? `Up to ${MAX_TAGS} tags` : value.length === 0 ? 'e.g. prod, db' : ''}
        className="min-w-[6rem] flex-1 bg-transparent text-sm text-txt-primary outline-none placeholder-txt-muted"
      />
      {invalid && (
        <span id={`${listId}-error`} role="alert" className="basis-full text-xs text-red-400">
          Tags start with a letter or digit and may contain letters, digits and . _ : / - (no spaces).
        </span>
      )}
      {offered.length > 0 && (
        <datalist id={listId}>
          {offered.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
};
