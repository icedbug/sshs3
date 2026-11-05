/**
 * Pure helper function to parse CSV/TSV text into structured headers and rows.
 * Correctly handles quoted values, escaped quotes (""), and multiple delimiters (, ; \t).
 */
export interface CsvParseResult {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

export function detectDelimiter(firstLine: string, ext?: string): string {
  if (ext === 'tsv') return '\t';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;

  if (tabCount > commaCount && tabCount > semiCount) return '\t';
  if (semiCount > commaCount) return ';';
  return ',';
}

export function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      fields.push(current);
      current = '';
      i++;
      continue;
    }
    current += char;
    i++;
  }
  fields.push(current);
  return fields;
}

export function parseCsv(text: string, forceDelimiter?: string, ext?: string): CsvParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { headers: [], rows: [], delimiter: forceDelimiter || ',' };
  }

  // Split lines respecting quotes
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        currentLine += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      currentLine += char;
      continue;
    }
    if ((char === '\n' || (char === '\r' && text[i + 1] === '\n')) && !inQuotes) {
      lines.push(currentLine);
      currentLine = '';
      if (char === '\r') i++;
      continue;
    }
    currentLine += char;
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  const validLines = lines.filter((l) => l.trim().length > 0);
  if (validLines.length === 0) {
    return { headers: [], rows: [], delimiter: forceDelimiter || ',' };
  }

  const delimiter = forceDelimiter || detectDelimiter(validLines[0], ext);
  const rawHeaders = parseCsvLine(validLines[0], delimiter);
  const headers = rawHeaders.map((h, idx) => h.trim() || `Column ${idx + 1}`);

  const rows: string[][] = [];
  for (let i = 1; i < validLines.length; i++) {
    const row = parseCsvLine(validLines[i], delimiter);
    // Pad or trim row to match header length
    while (row.length < headers.length) {
      row.push('');
    }
    rows.push(row.slice(0, headers.length));
  }

  return { headers, rows, delimiter };
}
