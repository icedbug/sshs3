import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@shared/types/storage';
import { entriesMatchingPattern, invertSelection } from './selectionOps';

const e = (name: string): FileEntry => ({ name, path: `/d/${name}`, size: 0, isDirectory: false });
const list = [e('a.log'), e('b.log'), e('c.txt'), e('sub/d.LOG')];

describe('invertSelection', () => {
  it('selects exactly the unselected entries', () => {
    expect([...invertSelection(list, new Set(['/d/a.log', '/d/c.txt']))]).toEqual(['/d/b.log', '/d/sub/d.LOG']);
  });

  it('selects everything when nothing is selected and nothing when all are', () => {
    expect(invertSelection(list, new Set()).size).toBe(4);
    expect(invertSelection(list, new Set(list.map((x) => x.path))).size).toBe(0);
  });
});

describe('entriesMatchingPattern', () => {
  it('globs the whole name, case-insensitively', () => {
    expect(entriesMatchingPattern(list, '*.log')).toEqual(['/d/a.log', '/d/b.log', '/d/sub/d.LOG']);
  });

  it('matches plain text as a substring', () => {
    expect(entriesMatchingPattern(list, 'txt')).toEqual(['/d/c.txt']);
  });

  it('matches nothing for a blank pattern', () => {
    expect(entriesMatchingPattern(list, '  ')).toEqual([]);
  });
});
