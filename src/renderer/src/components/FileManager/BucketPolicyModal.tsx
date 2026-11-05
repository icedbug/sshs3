import React, { useEffect, useState, useRef } from 'react';
import { FileJson, X, Loader2 } from 'lucide-react';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useConfirm } from '../ConfirmDialog';
import { describeIpcError } from '../../lib/format';

interface BucketPolicyModalProps {
  open: boolean;
  providerId: string;
  bucketPath: string;
  bucketName: string;
  onClose: () => void;
  onSaved?: () => void;
}

type Tab = 'policy' | 'cors';

const DEFAULT_CORS = `[
  {
    "AllowedMethods": ["GET"],
    "AllowedOrigins": ["*"],
    "AllowedHeaders": ["*"]
  }
]`;

export const BucketPolicyModal: React.FC<BucketPolicyModalProps> = ({
  open,
  providerId,
  bucketPath,
  bucketName,
  onClose,
  onSaved,
}) => {
  const [tab, setTab] = useState<Tab>('policy');
  const [policyText, setPolicyText] = useState('');
  const [corsText, setCorsText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTab('policy');
    setLoading(true);
    Promise.all([
      window.multissh.storageGetBucketPolicy(providerId, bucketPath),
      window.multissh.storageGetBucketCors(providerId, bucketPath),
    ])
      .then(([policy, cors]) => {
        setPolicyText(policy ?? '');
        setCorsText(cors ?? '');
      })
      .catch((err) => setError(describeIpcError(err, 'Failed to retrieve bucket configuration')))
      .finally(() => setLoading(false));
  }, [open, providerId, bucketPath]);

  const handleBackdropClick = useModalDismiss(onClose, open, !saving);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (tab === 'policy') {
        if (policyText.trim()) {
          JSON.parse(policyText);
        }
        await window.multissh.storageSetBucketPolicy(providerId, bucketPath, policyText.trim() || null);
      } else {
        await window.multissh.storageSetBucketCors(providerId, bucketPath, corsText.trim() || null);
      }
      onSaved?.();
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? 'Invalid JSON syntax'
          : err instanceof Error
            ? err.message
            : 'Failed to save'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const label = tab === 'policy' ? 'Bucket Policy' : 'CORS Rules';
    if (!(await confirm({ title: `Delete ${label}`, message: `Delete the ${label} for "${bucketName}"?` }))) return;
    setSaving(true);
    setError(null);
    try {
      if (tab === 'policy') {
        await window.multissh.storageSetBucketPolicy(providerId, bucketPath, null);
        setPolicyText('');
      } else {
        await window.multissh.storageSetBucketCors(providerId, bucketPath, null);
        setCorsText('');
      }
      onSaved?.();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Bucket policy and CORS" className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-app-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <FileJson className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Bucket Policy &amp; CORS — {bucketName}</h2>
          </div>
          <button aria-label="Close" title="Close" type="button" onClick={onClose} className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex border-b border-divider bg-app-surface px-2">
          {(['policy', 'cors'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                'px-3 py-2 text-xs font-medium transition-colors ' +
                (tab === t
                  ? 'border-b-2 border-sky-500 text-sky-400 font-semibold'
                  : 'text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover')
              }
            >
              {t === 'policy' ? 'Bucket Policy' : 'CORS Rules'}
            </button>
          ))}
        </div>

        <div className="p-4 text-xs text-txt-secondary">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              Loading configuration...
            </div>
          )}
          {error && (
            <div role="alert" className="mb-3 rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">{error}</div>
          )}
          {!loading && tab === 'policy' && (
            <textarea
              value={policyText}
              onChange={(e) => setPolicyText(e.target.value)}
              placeholder='{"Version": "2012-10-17", "Statement": []}'
              spellCheck={false}
              className="h-72 w-full resize-none rounded-lg border border-border-subtle bg-app-input p-3 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
            />
          )}
          {!loading && tab === 'cors' && (
            <textarea
              value={corsText}
              onChange={(e) => setCorsText(e.target.value)}
              placeholder={DEFAULT_CORS}
              spellCheck={false}
              className="h-72 w-full resize-none rounded-lg border border-border-subtle bg-app-input p-3 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={saving || loading}
            className="rounded-lg border border-red-800/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/50 disabled:opacity-50 transition-colors"
          >
            Delete {tab === 'policy' ? 'Policy' : 'CORS'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || loading}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 shadow-sm transition-colors"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BucketPolicyModal;
