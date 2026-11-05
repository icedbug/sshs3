import React, { useState, useEffect, useRef } from 'react';
import { FilePlus, FolderPlus, X, Loader2 } from 'lucide-react';
import type { SourceType } from './types';
import { describeIpcError } from '../../lib/format';
import { Button } from '../ui/Button';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface NewFolderModalProps {
  open: boolean;
  currentPath: string;
  sourceType: SourceType;
  /** What gets created; defaults to a folder (or a bucket at the S3 root). */
  kind?: 'folder' | 'file';
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export const NewFolderModal: React.FC<NewFolderModalProps> = ({
  open,
  currentPath,
  sourceType,
  kind = 'folder',
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const handleBackdropClick = useModalDismiss(onClose, open, !submitting);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  const isFile = kind === 'file';
  const isS3Root = !isFile && sourceType === 's3' && (currentPath === '/' || currentPath === '');
  const title = isFile ? 'Create New File' : isS3Root ? 'Create S3 Bucket' : 'Create New Folder';
  const noun = isFile ? 'File' : isS3Root ? 'Bucket' : 'Folder';
  const label = `${noun} Name`;
  const placeholder = isFile ? 'New file name' : isS3Root ? 'my-new-bucket' : 'New folder name';

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(`${noun} name cannot be empty`);
      return;
    }

    if (isFile && /[/\0]/.test(trimmed)) {
      setError('File names cannot contain "/".');
      return;
    }

    if (isS3Root) {
      if (!/^[a-z0-9.-]{3,63}$/.test(trimmed)) {
        setError('Bucket names must be 3-63 characters, lowercase letters, numbers, dots, or hyphens.');
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      await onCreate(trimmed);
      onClose();
    } catch (err) {
      setError(describeIpcError(err, `Failed to create ${noun.toLowerCase()}`));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-sm rounded-xl border border-border-subtle bg-app-card p-5 shadow-2xl space-y-4"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-txt-primary">
            {isFile ? (
              <FilePlus className="h-5 w-5 text-sky-400 shrink-0" />
            ) : (
              <FolderPlus className="h-5 w-5 text-sky-400 shrink-0" />
            )}
            <span>{title}</span>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded p-1 text-txt-muted hover:bg-app-surface hover:text-txt-primary disabled:opacity-40 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-txt-secondary block">
              {label}
            </label>
            <input
              ref={inputRef}
              data-autofocus
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={placeholder}
              disabled={submitting}
              className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs text-txt-primary placeholder-txt-muted focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
            />
            {currentPath && (
              <p className="text-xs text-txt-muted truncate font-mono">
                Inside: {currentPath}
              </p>
            )}
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-400">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting} className="bg-app-surface">
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
