import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { trustBundle } from '../src/tls';

describe("the lab's trust bundle", () => {
  it('can be asked for by several runs at the same moment', async () => {
    // Two workers of one campaign start their web servers at once after a restart: both ask for it.
    const paths = await Promise.all(Array.from({ length: 6 }, () => trustBundle()));
    expect(new Set(paths).size).toBe(1);
    expect(await fs.readFile(paths[0]!, 'utf8')).toContain('BEGIN CERTIFICATE');
  });
});
