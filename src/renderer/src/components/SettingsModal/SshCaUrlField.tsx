import React, { useId } from 'react';
import { Loader2, Search } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Runs Detect; also bound to Enter in the field. */
  onDetect: () => void;
  busy: boolean;
  /** Test id of the Detect button. */
  detectTestId: string;
}

/** The CA URL input with the Detect button next to it. */
export const SshCaUrlField: React.FC<Props> = ({ value, onChange, onDetect, busy, detectTestId }) => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-txt-secondary">
      <label htmlFor={id}>CA URL</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onDetect();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
          placeholder="https://ca.example.com:30900"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onDetect}
          disabled={busy || !value.trim()}
          data-testid={detectTestId}
          title="Look up the CA's settings from this URL"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/50 px-2.5 py-1.5 text-xs text-sky-300 hover:bg-sky-500/10 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          Detect
        </button>
      </div>
    </div>
  );
};
