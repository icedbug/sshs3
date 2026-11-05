import React, { useEffect, useState, useRef } from 'react';
import { X } from 'lucide-react';
import type { K8sProfile } from '@shared/types/kubernetes';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { newProfileId } from '../../lib/k8sProfiles';
import { ELECTRON_IPC_PREFIX } from '../../lib/format';

interface K8sTeamProfileFormProps {
  open: boolean;
  vaultName: string;
  /** The template being edited; null adds a new one. */
  initial: K8sProfile | null;
  onSave: (profile: K8sProfile) => Promise<void>;
  onClose: () => void;
}

/** Edits a shared cluster template: name, server, project and TLS option. There is no token field on purpose. */
export const K8sTeamProfileForm: React.FC<K8sTeamProfileFormProps> = ({ open, vaultName, initial, onSave, onClose }) => {
  const [name, setName] = useState('');
  const [server, setServer] = useState('');
  const [namespace, setNamespace] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setServer(initial?.server ?? '');
    setNamespace(initial?.namespace ?? '');
    setInsecure(initial?.insecureSkipTlsVerify ?? false);
    setError(null);
  }, [open, initial]);

  useModalDismiss(onClose, open, !saving);
  const dialogRef = useRef<HTMLFormElement>(null);
  useDialogFocus(dialogRef, open);
  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!server.trim()) {
      setError('Server URL is required');
      return;
    }
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: initial?.id ?? newProfileId(),
        name: name.trim(),
        server: server.trim(),
        namespace: namespace.trim() || undefined,
        insecureSkipTlsVerify: insecure,
      });
      onClose();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(raw.replace(ELECTRON_IPC_PREFIX, ''));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs text-txt-primary placeholder:text-txt-muted/70 focus:border-sky-500/50 focus:outline-none transition-colors';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Shared cluster"
        onSubmit={submit}
        className="w-full max-w-md space-y-3.5 rounded-xl border border-border-subtle bg-app-card p-5 text-xs shadow-2xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-txt-primary">{initial ? 'Edit shared cluster' : 'Add shared cluster'}</h2>
            <p className="text-xs text-txt-muted">Shared with everyone in {vaultName}. No token is stored here.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover">
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="block">
          <span className="mb-1 block font-medium text-txt-secondary">Name</span>
          <input aria-label="Name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="block">
          <span className="mb-1 block font-medium text-txt-secondary">Server URL</span>
          <input
            aria-label="Server URL"
            className={`${inputClass} font-mono`}
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="https://api.mycluster.example.com:6443"
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-medium text-txt-secondary">
            Project / Namespace <span className="font-normal text-txt-muted">(optional)</span>
          </span>
          <input
            aria-label="Project / Namespace"
            className={inputClass}
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            placeholder="Leave empty to list every project a member can access"
          />
        </label>
        <label className="flex items-center gap-2.5">
          <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
          <span className="text-txt-primary">Skip TLS certificate verification</span>
        </label>
        {error && <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 p-2.5 text-red-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={onClose} className="rounded-lg px-3.5 py-1.5 text-txt-muted hover:bg-app-surface-hover">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-sky-600 px-4 py-1.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
};
