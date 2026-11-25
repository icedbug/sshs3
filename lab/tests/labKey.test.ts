import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { labAnthropicKey } from '../src/llm';

const before = process.env.LAB_ANTHROPIC_API_KEY;
afterEach(() => {
  if (before === undefined) delete process.env.LAB_ANTHROPIC_API_KEY;
  else process.env.LAB_ANTHROPIC_API_KEY = before;
});

describe("the lab's Anthropic key", () => {
  it('comes from the environment first, then from the key file in the lab state, trimmed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-key-'));
    const file = path.join(dir, 'anthropic.key');
    delete process.env.LAB_ANTHROPIC_API_KEY;
    expect(labAnthropicKey(file)).toBeUndefined();
    await fs.writeFile(file, 'from-the-file\n', { mode: 0o600 });
    expect(labAnthropicKey(file)).toBe('from-the-file');
    process.env.LAB_ANTHROPIC_API_KEY = 'from-the-environment';
    expect(labAnthropicKey(file)).toBe('from-the-environment');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
