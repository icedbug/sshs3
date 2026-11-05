import React, { useEffect, useState, useRef } from 'react';
import { AlertTriangle, FileDiff, Loader2, X } from 'lucide-react';
import { describeIpcError } from '../../lib/format';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface FileDiffModalProps {
  open: boolean;
  onClose: () => void;
  relativePath: string;
  sourceProviderId: string;
  sourcePath: string;
  targetProviderId: string;
  targetPath: string;
}

type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

/** Cap how much text we'll diff — a plain O(n*m) LCS gets slow well before this many lines. */
const MAX_DIFF_LINES = 4000;
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Classic LCS-based line diff. Fine for the file sizes this modal accepts (see MAX_DIFF_LINES). */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

/** Compares the two files behind a 'changed' diff entry, line by line. */
export const FileDiffModal: React.FC<FileDiffModalProps> = ({
  open,
  onClose,
  relativePath,
  sourceProviderId,
  sourcePath,
  targetProviderId,
  targetPath,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ops, setOps] = useState<DiffOp[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    setOps(null);

    Promise.all([
      window.multissh.fileRead(sourceProviderId, sourcePath, MAX_READ_BYTES),
      window.multissh.fileRead(targetProviderId, targetPath, MAX_READ_BYTES),
    ])
      .then(([src, tgt]) => {
        if (cancelled) return;
        if (src.isBinary || tgt.isBinary) {
          setNotice('One or both files look binary — showing no line diff.');
          return;
        }
        const srcLines = src.content.split('\n');
        const tgtLines = tgt.content.split('\n');
        if (srcLines.length > MAX_DIFF_LINES || tgtLines.length > MAX_DIFF_LINES) {
          setNotice(`File is too large to diff line by line (over ${MAX_DIFF_LINES} lines).`);
          return;
        }
        if (src.truncated || tgt.truncated) {
          setNotice('One or both files were truncated before diffing (very large file) — the diff below may be incomplete.');
        }
        setOps(diffLines(srcLines, tgtLines));
      })
      .catch((err) => {
        if (!cancelled) setError(describeIpcError(err, String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, sourceProviderId, sourcePath, targetProviderId, targetPath]);

  const handleBackdropClick = useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  if (!open) return null;

  const hasChanges = ops?.some((op) => op.type !== 'same');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4" onClick={handleBackdropClick}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="File diff" className="w-[92vw] max-w-[1600px] h-[88vh] flex flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileDiff className="h-4 w-4 shrink-0 text-sky-400" />
            <h2 className="truncate text-sm font-semibold text-txt-primary" title={relativePath}>
              {relativePath}
            </h2>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 text-xs">
          {loading && (
            <div className="flex items-center gap-2 p-4 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading both files...
            </div>
          )}
          {!loading && error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-red-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {!loading && !error && notice && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}
          {!loading && !error && ops && !notice && !hasChanges && (
            <div className="rounded-lg border border-border-subtle bg-app-surface p-4 text-center text-txt-muted">
              No line differences — the files only differ in size/timestamp metadata.
            </div>
          )}
          {!loading && !error && ops && hasChanges && (
            <div className="rounded-lg border border-border-subtle bg-app-surface">
              <pre className="p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                {ops.map((op, idx) => (
                  <div
                    key={idx}
                    className={
                      op.type === 'add'
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : op.type === 'del'
                          ? 'bg-red-500/10 text-red-300'
                          : 'text-txt-secondary'
                    }
                  >
                    {op.type === 'add' ? '+ ' : op.type === 'del' ? '- ' : '  '}
                    {op.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FileDiffModal;
