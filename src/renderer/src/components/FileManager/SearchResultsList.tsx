import React, { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileSearch, FileText, FolderOpen } from 'lucide-react';
import type { SearchMatch } from '@shared/types/search';
import { classNames } from '../../lib/format';

interface SearchResultsListProps {
  matches: SearchMatch[];
  selectedMatchId: string | null;
  onSelect: (match: SearchMatch) => void;
  onJumpToFile?: (match: SearchMatch) => void;
  hasSearched: boolean;
}

type Row =
  | { type: 'header'; displayPath: string; count: number; firstMatch: SearchMatch }
  | { type: 'match'; match: SearchMatch };

const HEADER_ROW_HEIGHT = 28;
const MATCH_ROW_HEIGHT = 48;

function highlightSnippet(snippet: string, start: number, end: number) {
  if (end <= start || start < 0 || end > snippet.length) {
    return <>{snippet}</>;
  }
  return (
    <>
      {snippet.slice(0, start)}
      <mark className="rounded-sm bg-sky-500/30 text-sky-200">{snippet.slice(start, end)}</mark>
      {snippet.slice(end)}
    </>
  );
}

/** Groups matches by file, preserving the order each file was first seen in (matches
 * stream in arbitrarily as batches arrive, so files aren't naturally contiguous). */
function groupIntoRows(matches: SearchMatch[]): Row[] {
  const order: string[] = [];
  const groups = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    if (!groups.has(match.displayPath)) {
      order.push(match.displayPath);
      groups.set(match.displayPath, []);
    }
    groups.get(match.displayPath)!.push(match);
  }
  const rows: Row[] = [];
  for (const displayPath of order) {
    const group = groups.get(displayPath)!;
    rows.push({ type: 'header', displayPath, count: group.length, firstMatch: group[0] });
    for (const match of group) rows.push({ type: 'match', match });
  }
  return rows;
}

export const SearchResultsList: React.FC<SearchResultsListProps> = ({
  matches,
  selectedMatchId,
  onSelect,
  onJumpToFile,
  hasSearched,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => groupIntoRows(matches), [matches]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => (rows[index]?.type === 'header' ? HEADER_ROW_HEIGHT : MATCH_ROW_HEIGHT),
    overscan: 12,
  });

  if (matches.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-txt-muted">
        <FileSearch className="h-6 w-6 text-txt-muted/60" />
        {hasSearched ? 'No matches found.' : 'Enter a search term and press Enter.'}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const style: React.CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: virtualRow.size,
            transform: `translateY(${virtualRow.start}px)`,
          };

          if (row.type === 'header') {
            return (
              <div
                key={`header-${row.displayPath}`}
                style={style}
                className="flex items-center gap-1.5 border-b border-divider bg-app-surface-subtle px-3 text-xs font-medium text-txt-secondary"
              >
                <FileText className="h-3 w-3 shrink-0 text-sky-400" />
                <span className="truncate" title={row.displayPath}>
                  {row.displayPath}
                </span>
                <span className="shrink-0 text-txt-muted">
                  ({row.count} match{row.count === 1 ? '' : 'es'})
                </span>
                {onJumpToFile && (
                  <button
                    aria-label="Jump to file in pane"
                    type="button"
                    title="Jump to file in pane"
                    onClick={(e) => {
                      e.stopPropagation();
                      onJumpToFile(row.firstMatch);
                    }}
                    className="ml-auto shrink-0 rounded p-0.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
                  >
                    <FolderOpen className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          }

          const match = row.match;
          const isSelected = match.id === selectedMatchId;
          return (
            <button
              key={match.id}
              type="button"
              onClick={() => onSelect(match)}
              style={style}
              className={classNames(
                'flex w-full flex-col gap-0.5 border-b border-divider px-3 py-1.5 pl-6 text-left text-xs transition-colors',
                isSelected ? 'bg-sky-500/15' : 'hover:bg-app-surface-hover'
              )}
            >
              <span className="flex items-center gap-1.5 text-txt-muted">
                {match.lineNumber !== undefined && <span className="shrink-0">Line {match.lineNumber}</span>}
              </span>
              <span className="truncate font-mono text-xs text-txt-secondary" title={match.snippet}>
                {highlightSnippet(match.snippet, match.matchStart, match.matchEnd)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default SearchResultsList;
