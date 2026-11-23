import { copyToClipboard } from '../../lib/clipboard';
import React, { useEffect, useState } from 'react';
import { Check, Copy, FileText, FolderOpen, Loader2 } from 'lucide-react';
import type { SearchMatch } from '@shared/types/search';
import { describeIpcError } from '../../lib/format';

interface SearchPreviewPaneProps {
  providerId: string;
  match: SearchMatch | null;
  onJumpToFile?: (match: SearchMatch) => void;
}

const CONTEXT_LINES = 6;

export const SearchPreviewPane: React.FC<SearchPreviewPaneProps> = ({
  providerId,
  match,
  onJumpToFile,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [startLine, setStartLine] = useState(1);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!match || match.lineNumber === undefined) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.multissh
      .searchPreview(providerId, match.path, match.lineNumber, CONTEXT_LINES)
      .then((result) => {
        if (cancelled) return;
        // Drop a trailing empty line from the final newline, keep everything else.
        const rawLines = result.content.split('\n');
        if (rawLines[rawLines.length - 1] === '') rawLines.pop();
        setLines(rawLines);
        setStartLine(result.startLine);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(describeIpcError(err, 'Could not load a preview for this file'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, match]);

  const handleCopyPath = () => {
    if (!match) return;
    void copyToClipboard(match.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!match) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-txt-muted select-none">
        <FileText className="h-8 w-8 text-txt-muted/30" />
        <span className="font-medium text-txt-secondary">Select a match to preview code</span>
        <span className="text-xs text-txt-muted max-w-sm">
          Click on any result in the list to inspect surrounding file lines. You can also drag the center divider to resize panels.
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-divider bg-app-surface px-3 py-2 text-xs text-txt-secondary">
        <div className="flex min-w-0 items-center gap-1.5" title={match.path}>
          <FileText className="h-3.5 w-3.5 shrink-0 text-sky-400" />
          <span className="truncate font-mono text-txt-primary">{match.displayPath}</span>
          {match.lineNumber !== undefined && (
            <span className="shrink-0 font-mono text-sky-400/80">:{match.lineNumber}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            type="button"
            onClick={handleCopyPath}
            title="Copy path to clipboard"
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? 'Copied' : 'Copy path'}</span>
          </button>
          {onJumpToFile && (
            <button
              type="button"
              onClick={() => onJumpToFile(match)}
              title="Reveal in File Explorer"
              className="flex items-center gap-1 rounded bg-app-surface-subtle px-2 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors border border-border-subtle/50"
            >
              <FolderOpen className="h-3 w-3 text-sky-400" />
              <span>Reveal in Explorer</span>
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-app-surface-subtle font-mono text-xs">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-txt-muted">
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
            Loading preview...
          </div>
        )}
        {!loading && error && <div className="p-3 text-red-300">{error}</div>}
        {!loading && !error && lines.length === 0 && match.lineNumber === undefined && (
          <div className="p-3 text-txt-muted">No line-level preview available for this result.</div>
        )}
        {!loading && !error && lines.length > 0 && (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, idx) => {
                const lineNo = startLine + idx;
                const isMatchLine = lineNo === match.lineNumber;
                return (
                  <tr key={lineNo} className={isMatchLine ? 'bg-sky-500/15' : undefined}>
                    <td className="select-none whitespace-nowrap border-r border-divider px-2 py-0.5 text-right text-txt-muted">
                      {lineNo}
                    </td>
                    <td className="whitespace-pre px-2 py-0.5 text-txt-primary">{line || ' '}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default SearchPreviewPane;
