import { describe, it, expect, vi } from 'vitest';
import { createRequestGuard, startGuarded } from '../../src/renderer/src/lib/requestGuard';
import { appendCapped } from '../../src/renderer/src/lib/tailBuffer';

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('startGuarded', () => {
  it('returns the result when nothing happened in between', async () => {
    const guard = createRequestGuard();
    const discard = vi.fn();
    const token = guard.begin();
    expect(await startGuarded(guard, token, async () => 'ok', discard)).toEqual({ value: 'ok' });
    expect(discard).not.toHaveBeenCalled();
  });

  it('hands a result to discard when the guard was invalidated or restarted meanwhile', async () => {
    const guard = createRequestGuard();
    const discard = vi.fn();

    const slow = deferred<string>();
    const first = startGuarded(guard, guard.begin(), () => slow.promise, discard);
    guard.invalidate(); // cancelled or unmounted
    slow.resolve('late');
    expect(await first).toBeUndefined();
    expect(discard).toHaveBeenCalledWith('late');

    const slow2 = deferred<string>();
    const second = startGuarded(guard, guard.begin(), () => slow2.promise, discard);
    guard.begin(); // restarted
    slow2.resolve('older');
    expect(await second).toBeUndefined();
    expect(discard).toHaveBeenCalledWith('older');
  });

  it('swallows the failure of a request that is no longer wanted, but not of the current one', async () => {
    const guard = createRequestGuard();
    const stale = deferred<string>();
    const first = startGuarded(guard, guard.begin(), () => stale.promise, vi.fn());
    guard.invalidate();
    stale.reject(new Error('too late to matter'));
    expect(await first).toBeUndefined();

    await expect(startGuarded(guard, guard.begin(), async () => Promise.reject(new Error('real')), vi.fn())).rejects.toThrow('real');
  });
});

describe('appendCapped', () => {
  it('appends while under the limit', () => {
    expect(appendCapped('abc\n', 'def\n', 100)).toBe('abc\ndef\n');
  });

  it('drops the oldest text, at a line boundary, when over the limit', () => {
    const out = appendCapped('one\ntwo\nthree\n', 'four\nfive\n', 14);
    expect(out.length).toBeLessThanOrEqual(14);
    expect(out.endsWith('five\n')).toBe(true);
    expect(out.startsWith('one')).toBe(false);
    expect(out.split('\n')[0]).toMatch(/^(three|four|five)$/); // never a cut-off first line
  });

  it('keeps just the tail of one chunk that alone exceeds the limit', () => {
    const out = appendCapped('', 'x'.repeat(50) + '\nlast line\n', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('last line\n')).toBe(true);
  });
});
