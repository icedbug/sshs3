import { describe, expect, it } from 'vitest';
import { nextMenuIndex, nextTabIndex } from './rovingNavigation';

describe('nextMenuIndex', () => {
  it('steps down and wraps at the end', () => {
    expect(nextMenuIndex(3, 0, 'ArrowDown')).toBe(1);
    expect(nextMenuIndex(3, 2, 'ArrowDown')).toBe(0);
  });

  it('steps up and wraps at the start', () => {
    expect(nextMenuIndex(3, 2, 'ArrowUp')).toBe(1);
    expect(nextMenuIndex(3, 0, 'ArrowUp')).toBe(2);
  });

  it('starts at the first item going down and the last going up when nothing is focused', () => {
    expect(nextMenuIndex(3, -1, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(3, -1, 'ArrowUp')).toBe(2);
  });

  it('jumps to the ends with Home and End', () => {
    expect(nextMenuIndex(4, 2, 'Home')).toBe(0);
    expect(nextMenuIndex(4, 1, 'End')).toBe(3);
  });

  it('ignores other keys and empty menus', () => {
    expect(nextMenuIndex(3, 0, 'a')).toBeNull();
    expect(nextMenuIndex(3, 0, 'Enter')).toBeNull();
    expect(nextMenuIndex(0, -1, 'ArrowDown')).toBeNull();
  });
});

describe('nextTabIndex', () => {
  it('steps right and left and wraps at both ends', () => {
    expect(nextTabIndex(3, 0, 'ArrowRight')).toBe(1);
    expect(nextTabIndex(3, 2, 'ArrowRight')).toBe(0);
    expect(nextTabIndex(3, 0, 'ArrowLeft')).toBe(2);
    expect(nextTabIndex(3, 2, 'ArrowLeft')).toBe(1);
  });

  it('jumps with Home and End and starts at an end when nothing is focused', () => {
    expect(nextTabIndex(4, 2, 'Home')).toBe(0);
    expect(nextTabIndex(4, 1, 'End')).toBe(3);
    expect(nextTabIndex(3, -1, 'ArrowRight')).toBe(0);
    expect(nextTabIndex(3, -1, 'ArrowLeft')).toBe(2);
  });

  it('ignores the vertical arrows, other keys and an empty strip', () => {
    expect(nextTabIndex(3, 0, 'ArrowDown')).toBeNull();
    expect(nextTabIndex(3, 0, 'Enter')).toBeNull();
    expect(nextTabIndex(0, -1, 'ArrowRight')).toBeNull();
  });
});
