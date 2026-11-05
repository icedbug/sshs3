import { describe, expect, it } from 'vitest';
import {
  buildCompressCommand,
  buildExtractCommand,
  defaultArchiveBaseName,
  detectArchiveKind,
  isAcceptedExit,
  isSafeSegment,
  pickFreeName,
  stripArchiveExtension,
  summarizeExecError,
  toShellCommand,
} from '../../src/main/archive/archiveCommands';

describe('detectArchiveKind', () => {
  it.each([
    ['a.zip', 'zip'],
    ['A.ZIP', 'zip'],
    ['a.tar.gz', 'tar'],
    ['a.tgz', 'tar'],
    ['a.tar.xz', 'tar'],
    ['a.tar.bz2', 'tar'],
    ['a.tar', 'tar'],
    ['a.txt', null],
    ['gz', null],
  ])('%s -> %s', (name, kind) => {
    expect(detectArchiveKind(name)).toBe(kind);
  });
});

describe('stripArchiveExtension', () => {
  it('removes the archive extension', () => {
    expect(stripArchiveExtension('photos.tar.gz')).toBe('photos');
    expect(stripArchiveExtension('photos.ZIP')).toBe('photos');
  });
  it('leaves other names and bare extensions alone', () => {
    expect(stripArchiveExtension('notes.txt')).toBe('notes.txt');
    expect(stripArchiveExtension('.zip')).toBe('.zip');
  });
});

describe('defaultArchiveBaseName', () => {
  it('uses the entry name for one entry and "archive" for several', () => {
    expect(defaultArchiveBaseName(['docs'])).toBe('docs');
    expect(defaultArchiveBaseName(['a', 'b'])).toBe('archive');
  });
});

describe('isSafeSegment', () => {
  it('accepts plain names and rejects traversal, separators and NUL', () => {
    expect(isSafeSegment('a b.txt')).toBe(true);
    expect(isSafeSegment('.hidden')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 5, null]) expect(isSafeSegment(bad)).toBe(false);
  });
});

describe('pickFreeName', () => {
  it('appends a counter before the extension until free', async () => {
    const taken = new Set(['a.zip', 'a (1).zip']);
    expect(await pickFreeName('a', '.zip', async (c) => taken.has(c))).toBe('a (2).zip');
  });
  it('returns the plain name when free', async () => {
    expect(await pickFreeName('a', '', async () => false)).toBe('a');
  });
});

describe('buildCompressCommand', () => {
  it('builds a tar.gz relative to the parent directory, with names after "--"', () => {
    expect(buildCompressCommand('tar.gz', '/d', ['-x', 'b'], '/d/a.tar.gz', 'linux')).toEqual({
      file: 'tar',
      args: ['-czf', '/d/a.tar.gz', '-C', '/d', '--', '-x', 'b'],
    });
  });
  it('uses zip on Linux and tar -a on macOS/Windows', () => {
    expect(buildCompressCommand('zip', '/d', ['b'], '/d/a.zip', 'linux')).toEqual({
      file: 'zip',
      args: ['-r', '-y', '-q', '/d/a.zip', '--', 'b'],
      cwd: '/d',
    });
    expect(buildCompressCommand('zip', 'C:\\d', ['b'], 'C:\\d\\a.zip', 'win32').file).toBe('tar');
    expect(buildCompressCommand('zip', '/d', ['b'], '/d/a.zip', 'darwin').args[0]).toBe('-a');
  });
});

describe('buildExtractCommand', () => {
  it('extracts tar archives with tar and never applies archive ownership', () => {
    expect(buildExtractCommand('tar', '/d/a.tgz', '/d/a', 'linux')).toEqual({
      file: 'tar',
      args: ['-xf', '/d/a.tgz', '-C', '/d/a', '--no-same-owner'],
    });
  });
  it('uses unzip for zip on Linux, tar elsewhere', () => {
    expect(buildExtractCommand('zip', '/d/a.zip', '/d/a', 'linux')).toEqual({
      file: 'unzip',
      args: ['-q', '/d/a.zip', '-d', '/d/a'],
      okExitCodes: [1],
    });
    expect(buildExtractCommand('zip', 'C:\\a.zip', 'C:\\a', 'win32').file).toBe('tar');
  });
});

describe('toShellCommand', () => {
  it('quotes every argument, including embedded quotes and spaces', () => {
    expect(toShellCommand({ file: 'tar', args: ['-xf', "/d/it's a.tgz", '-C', '/d/x y'] })).toBe(
      "tar '-xf' '/d/it'\\''s a.tgz' '-C' '/d/x y'"
    );
  });
  it('prefixes a cd when a working directory is set', () => {
    expect(toShellCommand({ file: 'zip', args: ['-r'], cwd: '/d e' })).toBe("cd '/d e' && zip '-r'");
  });
});

describe('summarizeExecError', () => {
  it('drops the command line and keeps stderr', () => {
    const err = new Error('Command failed: ssh -S x host cmd\nzip: command not found\n');
    expect(summarizeExecError(err, 'failed')).toBe('zip: command not found');
  });
  it('falls back when there is no detail', () => {
    expect(summarizeExecError(new Error('Command failed: ssh x'), 'Archive failed')).toBe('Archive failed');
  });
});

describe('isAcceptedExit', () => {
  const unzip = { file: 'unzip', args: [], okExitCodes: [1] };
  it('accepts only the listed exit codes', () => {
    expect(isAcceptedExit(Object.assign(new Error('x'), { code: 1 }), unzip)).toBe(true);
    expect(isAcceptedExit(Object.assign(new Error('x'), { code: 2 }), unzip)).toBe(false);
    expect(isAcceptedExit(Object.assign(new Error('x'), { code: 'ENOENT' }), unzip)).toBe(false);
    expect(isAcceptedExit(new Error('x'), { file: 'tar', args: [] })).toBe(false);
  });
});
