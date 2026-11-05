import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { defineTargetTouched, settleTargetTouched, wasTargetTouched, whenTargetSettledLater } from '../../src/main/storage/targetTouched';

describe('targetTouched', () => {
  it('treats a stream without the signal as touched (previous clean-up behaviour)', () => {
    expect(wasTargetTouched(new PassThrough())).toBe(true);
    expect(wasTargetTouched(undefined)).toBe(true);
    expect(wasTargetTouched({ targetTouched: 'yes' })).toBe(true);
  });

  it('follows the live value of the getter', () => {
    let touched = false;
    const stream = defineTargetTouched(new PassThrough(), () => touched);
    expect(wasTargetTouched(stream)).toBe(false);
    touched = true;
    expect(wasTargetTouched(stream)).toBe(true);
  });
});

// Security review: a server that never answers the open must not keep a failed or cancelled transfer from finishing.
describe('settleTargetTouched', () => {
  it('returns after the timeout when the open never settles, leaving the flag as it was', async () => {
    const stream = { targetTouched: false, targetSettled: () => new Promise<void>(() => {}) };
    const started = Date.now();
    expect(await settleTargetTouched(stream, 30)).toBe(false); // not settled
    expect(Date.now() - started).toBeLessThan(1000);
    expect(wasTargetTouched(stream)).toBe(false);
  });

  it('returns at once for a stream without the hook, and when the open settles', async () => {
    await expect(settleTargetTouched({})).resolves.toBe(true);
    await expect(settleTargetTouched({ targetSettled: () => Promise.resolve() }, 5000)).resolves.toBe(true);
  });

  // Code review: an open that answers after the timeout can still truncate the file, so it is cleaned up afterwards.
  it('runs the late clean-up once a slow open finally settles', async () => {
    let answer!: () => void;
    const stream = { targetTouched: false, targetSettled: () => new Promise<void>((r) => { answer = r; }) };
    let cleaned = false;
    whenTargetSettledLater(stream, () => { cleaned = wasTargetTouched(stream); });
    stream.targetTouched = true; // the open succeeded after all
    answer();
    await new Promise((r) => setImmediate(r));
    expect(cleaned).toBe(true);
  });
});
