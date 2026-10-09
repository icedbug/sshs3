import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { mockIsEncryptionAvailable } = vi.hoisted(() => ({
  mockIsEncryptionAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('electron', () => {
  const mockObj = {
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data') },
    safeStorage: {
      isEncryptionAvailable: mockIsEncryptionAvailable,
      encryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`, 'utf-8')),
      decryptString: vi.fn((buf: Buffer) => buf.toString('utf-8').replace(/^cipher:/, '')),
    },
  };
  return { ...mockObj, default: mockObj };
});

import { AiConfigStore } from '../../src/main/ai/AiConfigStore';

describe('AiConfigStore', () => {
  let tempDir: string;
  let store: AiConfigStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-ai-config-test-'));
    store = new AiConfigStore(path.join(tempDir, 'ai-config.json'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('is off by default with the Anthropic provider', async () => {
    expect(await store.getView()).toEqual({ enabled: false, provider: 'anthropic', model: 'claude-opus-5-5', useHermes: false, hasApiKey: false });
  });

  it('stores the API key encrypted and never returns it in the view', async () => {
    const view = await store.update({ enabled: true, apiKey: ' sk-test-key ' }); // pragma: allowlist secret
    expect(view).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', useHermes: false, hasApiKey: true });
    expect(view).not.toHaveProperty('apiKey');

    const raw = await fs.readFile(store.getFilePath(), 'utf-8');
    expect(raw).not.toContain('sk-test-key');
    expect(JSON.parse(raw).apiKey).toMatch(/^enc:v1:/);
    expect((await store.getConfig()).apiKey).toBe('sk-test-key');
    if (process.platform !== 'win32') {
      expect((await fs.stat(store.getFilePath())).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the key when the update leaves it out and removes it on null', async () => {
    await store.update({ apiKey: 'sk-test-key' }); // pragma: allowlist secret
    await store.update({ model: 'claude-sonnet-5-5' });
    expect((await store.getConfig()).apiKey).toBe('sk-test-key');
    await store.update({ apiKey: null });
    expect((await store.getView()).hasApiKey).toBe(false);
  });

  it('validates the endpoint URL', async () => {
    await expect(store.update({ baseUrl: 'not a url' })).rejects.toThrow('full URL');
    await expect(store.update({ baseUrl: 'file:///etc/passwd' })).rejects.toThrow('http or https');
    await expect(store.update({ baseUrl: 'http://user:pw@host/v1' })).rejects.toThrow('API key field'); // pragma: allowlist secret
    const view = await store.update({ provider: 'openai-compatible', baseUrl: ' http://localhost:11434/v1 ' });
    expect(view.baseUrl).toBe('http://localhost:11434/v1');
    expect((await store.update({ baseUrl: '' })).baseUrl).toBeUndefined();
  });

  it('falls back to defaults for a corrupt file', async () => {
    await fs.writeFile(store.getFilePath(), '{not json');
    expect((await store.getView()).enabled).toBe(false);
  });
});
