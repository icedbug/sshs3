import React, { useEffect, useState, useRef } from 'react';
import { Link2, X, Loader2, Copy, Check, AlertTriangle } from 'lucide-react';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { describeIpcError } from '../../lib/format';
import { Button } from '../ui/Button';

interface PresignedUrlModalProps {
  open: boolean;
  providerId: string;
  entries: { path: string; name: string }[];
  onClose: () => void;
}

const EXPIRY_OPTIONS: { label: string; seconds: number }[] = [
  { label: '15 minutes', seconds: 15 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '12 hours', seconds: 12 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '7 days (maximum)', seconds: 7 * 24 * 60 * 60 },
];

export const PresignedUrlModal: React.FC<PresignedUrlModalProps> = ({ open, providerId, entries, onClose }) => {
  const [expiresIn, setExpiresIn] = useState(EXPIRY_OPTIONS[1].seconds);
  const [urls, setUrls] = useState<{ name: string; url: string; error?: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const generate = async (seconds: number) => {
    setLoading(true);
    setCopiedAll(false);
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          const url = await window.multissh.storageGetPresignedUrl(providerId, entry.path, seconds);
          return { name: entry.name, url };
        } catch (err) {
          return { name: entry.name, url: '', error: describeIpcError(err, 'Failed to generate URL') };
        }
      })
    );
    setUrls(results);
    setLoading(false);
  };

  useEffect(() => {
    if (!open) return;
    setUrls([]);
    void generate(expiresIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleBackdropClick = useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const handleExpiryChange = (seconds: number) => {
    setExpiresIn(seconds);
    void generate(seconds);
  };

  const copyOne = async (idx: number, url: string) => {
    await navigator.clipboard.writeText(url);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
  };

  const copyAll = async () => {
    const text = urls.filter((u) => u.url).map((u) => u.url).join('\n');
    await navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 animate-in fade-in duration-150 p-4"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Pre-signed URL" className="w-full max-w-lg rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">
              Generate Web URL{entries.length > 1 ? 's' : ''}
            </h2>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs text-txt-secondary">
          {/* LOW finding (code review): this modal generated/copied links
              with valid access without ever noting that anyone who gets the
              link can use it, not just the person it was copied for. */}
          <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>Anyone with this link can access the file — with no further login — until it expires.</span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-txt-primary">Link expires after</span>
            <select
              value={expiresIn}
              onChange={(e) => handleExpiryChange(Number(e.target.value))}
              className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.seconds} value={opt.seconds}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              Generating...
            </div>
          )}

          {!loading && (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {urls.map((item, idx) => (
                <div key={item.name + idx} className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
                  <div className="mb-1 truncate font-medium text-txt-primary">{item.name}</div>
                  {item.error ? (
                    <div className="text-red-400">{item.error}</div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={item.url}
                        onFocus={(e) => e.target.select()}
                        className="w-full min-w-0 flex-1 truncate rounded-md border border-border-subtle bg-app-input px-2 py-1 font-mono text-xs text-txt-primary outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void copyOne(idx, item.url)}
                        title="Copy link"
                        className="shrink-0 rounded p-1.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                      >
                        {copiedIdx === idx ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
          {urls.length > 1 && (
            <Button type="button" variant="primary" onClick={() => void copyAll()} disabled={loading}>
              {copiedAll ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              Copy All
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PresignedUrlModal;
