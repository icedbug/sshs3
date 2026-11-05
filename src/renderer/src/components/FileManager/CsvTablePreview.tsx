import React, { useState, useMemo } from 'react';
import { Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { parseCsv } from '../../lib/csvParser';

export interface CsvTablePreviewProps {
  csvContent: string;
  fileName: string;
}

export const CsvTablePreview: React.FC<CsvTablePreviewProps> = ({ csvContent, fileName }) => {
  const [filterQuery, setFilterQuery] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  const ext = fileName.split('.').pop()?.toLowerCase();
  const parsed = useMemo(() => parseCsv(csvContent, undefined, ext), [csvContent, ext]);

  const filteredRows = useMemo(() => {
    let rows = parsed.rows;
    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase();
      rows = rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(q)));
    }
    if (sortCol !== null && sortCol >= 0 && sortCol < parsed.headers.length) {
      rows = [...rows].sort((a, b) => {
        const valA = a[sortCol] || '';
        const valB = b[sortCol] || '';
        const numA = Number(valA);
        const numB = Number(valB);
        if (valA.trim() !== '' && valB.trim() !== '' && !isNaN(numA) && !isNaN(numB)) {
          return sortAsc ? numA - numB : numB - numA;
        }
        return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      });
    }
    return rows;
  }, [parsed, filterQuery, sortCol, sortAsc]);

  const handleHeaderClick = (colIdx: number) => {
    if (sortCol === colIdx) {
      if (sortAsc) {
        setSortAsc(false);
      } else {
        setSortCol(null);
        setSortAsc(true);
      }
    } else {
      setSortCol(colIdx);
      setSortAsc(true);
    }
  };

  const delimiterName = parsed.delimiter === '\t' ? 'TSV (Tab)' : parsed.delimiter === ';' ? 'CSV (Semicolon)' : 'CSV (Comma)';

  return (
    <div
      data-testid="csv-table-preview"
      className="relative flex flex-col h-full w-full overflow-hidden select-none bg-app-card"
    >
      {/* Top Filter Bar */}
      <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-2 text-xs select-none">
        <div className="flex items-center gap-2">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 h-3.5 w-3.5 text-txt-muted pointer-events-none" />
            <input
              type="text"
              placeholder="Filter table rows..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="w-56 rounded-lg border border-border-subtle bg-app-input pl-8 pr-3 py-1 text-xs text-txt-primary placeholder-txt-muted outline-none focus:border-sky-500"
            />
          </div>
          <span className="rounded bg-app-surface-subtle border border-border-subtle px-2 py-0.5 text-2xs font-mono text-txt-muted">
            {delimiterName}
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs text-txt-muted font-mono">
          <span>
            Showing {filteredRows.length} of {parsed.rows.length} rows ({parsed.headers.length} columns)
          </span>
        </div>
      </div>

      {/* Main Table View */}
      <div className="flex-1 w-full h-full overflow-auto p-0">
        <table className="w-full border-collapse text-left text-xs font-mono">
          <thead className="sticky top-0 z-10 bg-app-surface border-b border-divider shadow-sm">
            <tr>
              <th className="w-12 px-3 py-2 text-2xs font-semibold text-txt-muted border-r border-divider text-center">
                #
              </th>
              {parsed.headers.map((header, idx) => (
                <th
                  key={idx}
                  onClick={() => handleHeaderClick(idx)}
                  className="group px-3 py-2 text-txt-primary font-semibold border-r border-divider hover:bg-app-surface-hover cursor-pointer transition-colors whitespace-nowrap select-none"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{header}</span>
                    {sortCol === idx ? (
                      sortAsc ? (
                        <ArrowUp className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                      ) : (
                        <ArrowDown className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 text-txt-muted/60 opacity-0 group-hover:opacity-100 shrink-0" />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-divider/50 bg-app-card">
            {filteredRows.length === 0 ? (
              <tr>
                <td
                  colSpan={parsed.headers.length + 1}
                  className="px-4 py-8 text-center text-txt-muted text-xs italic"
                >
                  {parsed.rows.length === 0 ? 'No tabular data found' : 'No rows match filter criteria'}
                </td>
              </tr>
            ) : (
              filteredRows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="hover:bg-app-surface-hover/60 transition-colors"
                >
                  <td className="w-12 px-3 py-1.5 text-center text-2xs font-mono text-txt-muted/70 bg-app-surface/30 border-r border-divider">
                    {rowIdx + 1}
                  </td>
                  {row.map((cell, cellIdx) => (
                    <td
                      key={cellIdx}
                      className="px-3 py-1.5 text-txt-primary border-r border-divider/50 truncate max-w-xs"
                      title={cell}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CsvTablePreview;
