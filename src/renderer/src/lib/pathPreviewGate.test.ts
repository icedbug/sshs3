import { describe, expect, it } from 'vitest';
import { allowPreview, hoverModifierSatisfied, isRelativePath, mergeCwd, needsExistenceCheck } from './pathPreviewGate';

const slashed = { bareToken: false, relative: false, cwdReliable: true } as const;

describe('allowPreview', () => {
  it('drops a path that is known not to exist', () => {
    expect(allowPreview(slashed, 'missing')).toBe(false);
    expect(allowPreview({ ...slashed, relative: true }, 'missing')).toBe(false);
  });

  it('keeps a path that exists, or whose lookup was not possible', () => {
    expect(allowPreview(slashed, 'exists')).toBe(true);
    expect(allowPreview(slashed, 'unknown')).toBe(true);
  });

  it('requires bare words to exist', () => {
    const bare = { bareToken: true, relative: true, cwdReliable: false };
    expect(allowPreview(bare, 'exists')).toBe(true);
    expect(allowPreview(bare, 'missing')).toBe(false);
    expect(allowPreview(bare, 'unknown')).toBe(false);
  });

  it('does not judge a relative path while the working directory is only assumed', () => {
    const guess = { bareToken: false, relative: true, cwdReliable: false };
    expect(needsExistenceCheck(guess)).toBe(false);
    expect(allowPreview(guess, 'missing')).toBe(true);
  });

  it('still checks absolute paths when the working directory is unknown', () => {
    expect(needsExistenceCheck({ bareToken: false, relative: false, cwdReliable: false })).toBe(true);
  });
});

describe('isRelativePath', () => {
  it.each(['src/a.ts', './a', '../a', 'README.md', 'a b/c'])('treats %s as relative', (p) => {
    expect(isRelativePath(p)).toBe(true);
  });

  it.each(['/etc/hosts', '~/x', '~', 'C:\\Users\\me', 'C:/x', '\\\\srv\\share\\f', "'/etc/hosts'"])(
    'treats %s as anchored',
    (p) => {
      expect(isRelativePath(p)).toBe(false);
    }
  );
});

describe('hoverModifierSatisfied', () => {
  it('always passes in hover mode', () => {
    expect(hoverModifierSatisfied('hover', { ctrlKey: false, metaKey: false })).toBe(true);
  });

  it('needs Ctrl or Cmd in ctrl mode', () => {
    expect(hoverModifierSatisfied('ctrl', { ctrlKey: false, metaKey: false })).toBe(false);
    expect(hoverModifierSatisfied('ctrl', { ctrlKey: true, metaKey: false })).toBe(true);
    expect(hoverModifierSatisfied('ctrl', { ctrlKey: false, metaKey: true })).toBe(true);
  });
});

describe('mergeCwd', () => {
  const reliable = { dir: '/srv/app', reliable: true };
  const guess = { dir: '/home/me', reliable: false };

  it('keeps a reliable directory when only a guess from the output arrives', () => {
    expect(mergeCwd(reliable, guess)).toBe(reliable);
  });

  it('lets a reliable report replace anything, and a guess replace a guess', () => {
    const next = { dir: '/srv/other', reliable: true };
    expect(mergeCwd(guess, next)).toBe(next);
    expect(mergeCwd(reliable, next)).toBe(next);
    const newer = { dir: '/tmp', reliable: false };
    expect(mergeCwd(guess, newer)).toBe(newer);
  });
});
