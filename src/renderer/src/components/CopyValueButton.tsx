import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** A small icon button that copies `value` to the clipboard and briefly confirms it. */
export const CopyValueButton: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => {});
      }}
      className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
};
