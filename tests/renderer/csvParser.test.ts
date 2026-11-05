import { describe, it, expect } from 'vitest';
import { parseCsv, detectDelimiter } from '../../src/renderer/src/lib/csvParser';

describe('csvParser', () => {
  it('detects comma, semicolon and tab delimiters', () => {
    expect(detectDelimiter('id,name,value')).toBe(',');
    expect(detectDelimiter('id;name;value')).toBe(';');
    expect(detectDelimiter('id\tname\tvalue')).toBe('\t');
    expect(detectDelimiter('id,name', 'tsv')).toBe('\t');
  });

  it('parses basic CSV content into headers and rows', () => {
    const csv = `id,name,role\n1,Alice,Admin\n2,Bob,User`;
    const res = parseCsv(csv);
    expect(res.headers).toEqual(['id', 'name', 'role']);
    expect(res.rows).toEqual([
      ['1', 'Alice', 'Admin'],
      ['2', 'Bob', 'User'],
    ]);
  });

  it('handles quoted fields and commas inside quotes', () => {
    const csv = `name,address,note\n"Smith, John","123 Main St, Apt 4","Hello, world!"`;
    const res = parseCsv(csv);
    expect(res.headers).toEqual(['name', 'address', 'note']);
    expect(res.rows).toEqual([
      ['Smith, John', '123 Main St, Apt 4', 'Hello, world!'],
    ]);
  });

  it('handles escaped quotes ("")', () => {
    const csv = `id,quote\n1,"He said ""hello"" to me"`;
    const res = parseCsv(csv);
    expect(res.rows[0][1]).toBe('He said "hello" to me');
  });

  it('handles multiline cells inside quotes', () => {
    const csv = `id,description\n1,"Line 1\nLine 2"`;
    const res = parseCsv(csv);
    expect(res.rows[0][1]).toBe('Line 1\nLine 2');
  });
});
