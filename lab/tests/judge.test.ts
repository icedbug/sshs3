import { describe, expect, it } from 'vitest';
import { JudgeUnavailable, withRetries } from '../src/judge';

describe('asking the honesty judge', () => {
  it('asks again after a rate limit, a server error or no connection, a few times, then fails', async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n < 3) throw new JudgeUnavailable(429, 'Rate limit reached.');
      return 'verdict';
    };
    expect(await withRetries(flaky, [0, 0, 0])).toBe('verdict');
    expect(n).toBe(3);
    n = 0;
    const down = async () => {
      n++;
      throw new JudgeUnavailable(0, 'No connection.');
    };
    await expect(withRetries(down, [0, 0])).rejects.toThrow('No connection.');
    expect(n).toBe(3);
    // An answer that holds no verdict is not asked again: the same question gets the same kind of answer.
    n = 0;
    const unreadable = async () => {
      n++;
      throw new Error('The judge answered no verdict.');
    };
    await expect(withRetries(unreadable, [0, 0])).rejects.toThrow('no verdict');
    expect(n).toBe(1);
  });
});
