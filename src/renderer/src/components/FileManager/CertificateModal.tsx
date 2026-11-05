import React, { useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import type { CertificatePreviewResult } from '../../../../shared/types/certificate';
import { describeIpcError } from '../../lib/format';
import { describePreviewError } from '../../lib/certificatePreview';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { Button } from '../ui/Button';
import { CertificatePreview } from '../CertificatePreview';

interface CertificateModalProps {
  open: boolean;
  providerId: string;
  entry: FileEntry | undefined;
  onClose: () => void;
}

/** Human-readable certificate details for the selected file; the file is parsed in the main process. */
export const CertificateModal: React.FC<CertificateModalProps> = ({ open, providerId, entry, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CertificatePreviewResult | null>(null);
  const [hostInput, setHostInput] = useState('');
  const [checkedHost, setCheckedHost] = useState('');
  const entryPath = entry?.path;

  // A new file or a reopened dialog starts without a host to check.
  useEffect(() => {
    setHostInput('');
    setCheckedHost('');
    setResult(null);
  }, [open, entryPath]);

  useEffect(() => {
    if (!open || !entryPath) return undefined;
    let cancelled = false;
    setError(null);
    setLoading(true);
    window.multissh
      .certificatePreview(providerId, entryPath, checkedHost || undefined)
      .then((res) => {
        if (cancelled) return;
        if (res.certs.length > 0) setResult(res);
        else {
          setResult(null);
          setError(describePreviewError(res.error));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setResult(null);
        setError(describeIpcError(err, 'Failed to read the certificate'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, providerId, entryPath, checkedHost]);

  const handleBackdropClick = useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open || !entry) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Certificate"
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-app-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
            <h2 className="truncate text-sm font-semibold text-txt-primary" title={entry.path}>
              {entry.name}
            </h2>
          </div>
          <button aria-label="Close" title="Close" type="button" onClick={onClose} className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 text-xs text-txt-secondary">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              Reading certificate...
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">{error}</div>
          )}
          {result && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setCheckedHost(hostInput.trim());
              }}
            >
              <input
                aria-label="Host name to check"
                type="text"
                value={hostInput}
                onChange={(e) => setHostInput(e.target.value)}
                placeholder="Check a host name or IP, e.g. www.example.com"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-border-subtle bg-app-input px-2 py-1 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
              />
              <Button type="submit" variant="secondary" disabled={hostInput.trim() === '' && checkedHost === ''}>
                {hostInput.trim() === '' ? 'Clear' : 'Check'}
              </Button>
            </form>
          )}
          {result && !loading && checkedHost && !result.checkedHost && (
            <div role="alert" className="mt-2 rounded-lg border border-amber-800/80 bg-amber-950/40 p-2 text-xs text-amber-300">
              That is not a valid host name or IP address.
            </div>
          )}
          {result && <CertificatePreview result={result} full />}
          {result && (
            <p className="text-[10px] text-txt-muted">
              Only the validity dates are checked against this computer&apos;s clock, and a host name check only compares names. The chain and revocation are not verified.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-divider bg-app-surface px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CertificateModal;
