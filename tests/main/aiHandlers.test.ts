import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ default: {}, app: { getPath: () => '/tmp' } }));

import { parseAskRequest, parseConfigUpdate, registerAiHandlers, type AiHost } from '../../src/main/ipc/aiHandlers';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { AI_MAX_PROMPT_CHARS } from '../../src/shared/types/ai';

describe('AI IPC input validation', () => {
  it('accepts a well-formed ask request and drops unknown fields', () => {
    const parsed = parseAskRequest({
      task: 'explain',
      prompt: '',
      context: 'error',
      environment: { kind: 'local', platform: 'linux', extra: 1 },
      apiKey: 'smuggled', // pragma: allowlist secret
    });
    expect(parsed).toEqual({ task: 'explain', prompt: '', context: 'error', environment: { kind: 'local', platform: 'linux', shell: undefined } });
  });

  it('rejects malformed ask requests', () => {
    expect(() => parseAskRequest(null)).toThrow('Invalid AI request');
    expect(() => parseAskRequest({ task: 'run', prompt: 'x' })).toThrow('Invalid AI request');
    expect(() => parseAskRequest({ task: 'command', prompt: 'x'.repeat(AI_MAX_PROMPT_CHARS + 1) })).toThrow('Invalid AI request');
    expect(() => parseAskRequest({ task: 'command', prompt: '  ' })).toThrow('Describe');
    expect(() => parseAskRequest({ task: 'explain', prompt: '' })).toThrow('Select some terminal text');
    expect(() => parseAskRequest({ task: 'command', prompt: 'x', environment: { kind: 'mars' } })).toThrow('environment');
  });

  it('validates settings updates', () => {
    expect(parseConfigUpdate({ enabled: true, apiKey: null })).toEqual({ enabled: true, apiKey: null });
    expect(() => parseConfigUpdate({ enabled: 'yes' })).toThrow('Invalid AI settings');
    expect(() => parseConfigUpdate({ provider: 'gemini' })).toThrow('Invalid AI settings');
    expect(() => parseConfigUpdate({ apiKey: 42 })).toThrow('Invalid AI settings');
    expect(parseConfigUpdate({ useHermes: true })).toEqual({ useHermes: true });
    expect(() => parseConfigUpdate({ useHermes: 'on' })).toThrow('Invalid AI settings');
  });

  describe('handlers', () => {
    function setup(view: Record<string, unknown>) {
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const hermesManager = {
        stop: vi.fn().mockResolvedValue(undefined),
        getManifest: vi.fn().mockResolvedValue({ tag: 'v2026.9.24', commit: 'c', python: 'python/bin/python3.13' }),
        isRunning: vi.fn().mockReturnValue(true),
      };
      const host = {
        aiConfigStore: { update: vi.fn().mockResolvedValue(view), getView: vi.fn() },
        aiService: { ask: vi.fn() },
        hermesManager,
        registerHandler: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler),
      } as unknown as AiHost;
      registerAiHandlers(host);
      return { handlers, hermesManager };
    }

    it('stops Hermes as soon as it or the assistant is turned off', async () => {
      const off = setup({ enabled: true, useHermes: false });
      await off.handlers.get(IPC_CHANNELS.AI_SAVE_CONFIG)!({}, { useHermes: false });
      expect(off.hermesManager.stop).toHaveBeenCalled();

      const on = setup({ enabled: true, useHermes: true });
      await on.handlers.get(IPC_CHANNELS.AI_SAVE_CONFIG)!({}, { useHermes: true });
      expect(on.hermesManager.stop).not.toHaveBeenCalled();
    });

    it('reports whether Hermes is bundled and running', async () => {
      const { handlers } = setup({});
      expect(await handlers.get(IPC_CHANNELS.AI_HERMES_STATUS)!({})).toEqual({ bundled: true, version: 'v2026.9.24', running: true });
    });
  });
});
