import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => {
  const mockObj = {
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data') },
    safeStorage: { isEncryptionAvailable: vi.fn().mockReturnValue(false) },
  };
  return { ...mockObj, default: mockObj };
});

import { AiConfigStore } from '../../src/main/ai/AiConfigStore';
import { AiService } from '../../src/main/ai/AiService';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function anthropicMessage(text: string, stopReason = 'end_turn') {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

describe('AiService', () => {
  let tempDir: string;
  let store: AiConfigStore;
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: AiService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-ai-service-test-'));
    store = new AiConfigStore(path.join(tempDir, 'ai-config.json'));
    fetchMock = vi.fn();
    service = new AiService(store, { fetch: fetchMock as unknown as typeof fetch });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const lastRequest = () => {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    const headers = new Headers(init.headers);
    return { url: String(url), headers, body: JSON.parse(String(init.body)) };
  };

  it('refuses to send anything while the assistant is off', async () => {
    await store.update({ apiKey: 'sk-test' }); // pragma: allowlist secret
    await expect(service.ask({ task: 'command', prompt: 'list files' })).rejects.toThrow('turned off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for an API key before calling Anthropic', async () => {
    await store.update({ enabled: true });
    await expect(service.ask({ task: 'command', prompt: 'list files' })).rejects.toThrow('No Anthropic API key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the Claude API with low effort and refusal fallbacks, and parses the command', async () => {
    await store.update({ enabled: true, apiKey: 'sk-test' }); // pragma: allowlist secret
    fetchMock.mockResolvedValue(jsonResponse(anthropicMessage('```sh\ndf -h\n```\nShows disk usage.')));

    const result = await service.ask({
      task: 'command',
      prompt: 'show disk usage',
      context: 'token=abc123secret', // pragma: allowlist secret
      environment: { kind: 'ssh' },
    });

    expect(result).toEqual({ command: 'df -h', text: 'Shows disk usage.', redacted: true });
    const req = lastRequest();
    expect(req.url).toContain('https://api.anthropic.com/v1/messages');
    expect(req.headers.get('x-api-key')).toBe('sk-test');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'low' } });
    expect(JSON.stringify(req.body)).not.toContain('abc123secret');
  });

  it('leaves out effort and fallbacks for models that do not take them', async () => {
    await store.update({ enabled: true, apiKey: 'sk-test', model: 'claude-haiku-4-5' }); // pragma: allowlist secret
    fetchMock.mockResolvedValue(jsonResponse(anthropicMessage('It means the file is missing.')));
    const result = await service.ask({ task: 'explain', prompt: '', context: 'ENOENT' });
    expect(result).toEqual({ text: 'It means the file is missing.', redacted: false });
    const req = lastRequest();
    expect(req.body).not.toHaveProperty('fallbacks');
    expect(req.body).not.toHaveProperty('output_config');
    expect(req.headers.get('anthropic-beta')).toBeNull();
  });

  it('reports a refusal and a rejected key in plain words', async () => {
    await store.update({ enabled: true, apiKey: 'sk-test' }); // pragma: allowlist secret
    fetchMock.mockResolvedValueOnce(jsonResponse(anthropicMessage('', 'refusal')));
    await expect(service.ask({ task: 'command', prompt: 'x' })).rejects.toThrow('declined');

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
    );
    await expect(service.ask({ task: 'command', prompt: 'x' })).rejects.toThrow('rejected the API key');
  });

  it('calls an OpenAI-compatible endpoint such as a local Ollama', async () => {
    await store.update({ enabled: true, provider: 'openai-compatible', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1/' });
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: '```\nls -la\n```' } }] }));

    const result = await service.ask({ task: 'command', prompt: 'list all files' });

    expect(result.command).toBe('ls -la');
    const req = lastRequest();
    expect(req.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(req.headers.get('authorization')).toBeNull();
    expect(req.body.model).toBe('llama3.1');
    expect(req.body.messages[0].role).toBe('system');
  });

  it('explains failures of an OpenAI-compatible endpoint', async () => {
    await store.update({ enabled: true, provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: 'k' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(service.ask({ task: 'command', prompt: 'x' })).rejects.toThrow('Could not reach localhost:11434');

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(service.ask({ task: 'command', prompt: 'x' })).rejects.toThrow('rejected the API key');
    expect(lastRequest().headers.get('authorization')).toBe('Bearer k');

    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
    await expect(service.ask({ task: 'command', prompt: 'x' })).rejects.toThrow('empty answer');
  });

  it('needs an endpoint for the OpenAI-compatible provider', async () => {
    await store.update({ enabled: true, provider: 'openai-compatible' });
    await expect(service.ask({ task: 'command', prompt: 'x' })).rejects.toThrow('No endpoint');
  });
});
