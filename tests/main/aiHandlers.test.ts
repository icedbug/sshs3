import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ default: {}, app: { getPath: () => '/tmp' } }));

import { parseAskRequest, parseConfigUpdate } from '../../src/main/ipc/aiHandlers';
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
  });
});
