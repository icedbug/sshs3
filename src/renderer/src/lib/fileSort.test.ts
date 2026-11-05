import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@shared/types/storage';
import { sortFileEntries } from './fileSort';

const entry = (name: string, isDirectory: boolean, size = 0): FileEntry =>
  ({ name, path: `/${name}`, isDirectory, size }) as FileEntry;

const names = (list: FileEntry[]) => list.map((e) => e.name);

const sample = [
  entry('.bashrc', false),
  entry('b.txt', false),
  entry('.git', true),
  entry('src', true),
  entry('a.txt', false),
  entry('.config', true),
  entry('docs', true),
  entry('.zshrc', false),
];

describe('sortFileEntries', () => {
  it('orders directories, dot-directories, files, dotfiles', () => {
    expect(names(sortFileEntries(sample, 'name', 'asc'))).toEqual([
      'docs', 'src', '.config', '.git', 'a.txt', 'b.txt', '.bashrc', '.zshrc',
    ]);
  });

  it('keeps the grouping when descending and only reverses within groups', () => {
    expect(names(sortFileEntries(sample, 'name', 'desc'))).toEqual([
      'src', 'docs', '.git', '.config', 'b.txt', 'a.txt', '.zshrc', '.bashrc',
    ]);
  });

  it('keeps the grouping for other sort keys', () => {
    const list = [entry('.big', false, 100), entry('small', false, 1), entry('.d', true, 5), entry('d', true, 9)];
    expect(names(sortFileEntries(list, 'size', 'asc'))).toEqual(['d', '.d', 'small', '.big']);
  });

  it('uses the last path segment for dot detection on recursive hits', () => {
    const list = [entry('x/.hidden', false), entry('x/visible', false)];
    expect(names(sortFileEntries(list, 'name', 'asc'))).toEqual(['x/visible', 'x/.hidden']);
  });

  it('does not mutate its input', () => {
    const copy = [...sample];
    sortFileEntries(sample, 'name', 'asc');
    expect(sample).toEqual(copy);
  });
});
