import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => {
  const mockObj = { app: { getPath: vi.fn().mockReturnValue('/tmp/user-data'), isPackaged: false } };
  return { ...mockObj, default: mockObj };
});

import {
  HERMES_DISABLED_TOOLSETS,
  HermesManager,
  hermesBaseEnvironment,
  hermesPolicyBlocks,
  writeManagedConfig,
} from '../../src/main/ai/HermesManager';

class FakeChild extends EventEmitter {
  public exitCode: number | null = null;
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();
  public kill = vi.fn(() => {
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  });
}

describe('Hermes guardrails', () => {
  it('enables only the memory, session search and to-do tools and denies every shell command', () => {
    const policy = hermesPolicyBlocks();
    expect(policy).toContain('platform_toolsets:\n  api_server: ["memory", "session_search", "todo"]\n');
    expect(policy).toContain('mcp_servers: {}');
    expect(policy).toContain('tools:\n  tool_search:\n    enabled: "off"\n');
    expect(policy).toContain('  deny: ["*"]');
    for (const name of ['terminal', 'file', 'code_execution', 'browser', 'computer_use', 'web', 'cronjob', 'delegation']) {
      expect(HERMES_DISABLED_TOOLSETS).toContain(name);
    }
  });

  it('passes on only what Python and HTTPS need, never credentials or the user home', () => {
    const env = hermesBaseEnvironment(
      {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy:3128',
        LANG: 'sv_SE.UTF-8',
        HOME: '/home/jacob',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
        AWS_SECRET_ACCESS_KEY: 'shh', // pragma: allowlist secret
        AWS_PROFILE: 'prod',
        KUBECONFIG: '/home/jacob/.kube/config',
        GITHUB_TOKEN: 'ghp_x', // pragma: allowlist secret
        NODE_OPTIONS: '--inspect',
        ELECTRON_RUN_AS_NODE: '1',
      },
      '/data/hermes'
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      LANG: 'sv_SE.UTF-8',
      HOME: '/data/hermes',
      USERPROFILE: '/data/hermes',
    });
  });
});

describe('writeManagedConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-hermes-config-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rewrites the model and the policy, and keeps settings Hermes stores itself', async () => {
    const file = path.join(dir, 'config.yaml');
    await fs.writeFile(
      file,
      [
        'model:',
        '  provider: "openrouter"',
        '  default: "old"',
        'platform_toolsets:',
        '  api_server: [terminal, file]',
        'display:',
        '  interim_assistant_messages: false',
        'approvals:',
        '  mode: off',
        'memory:',
        '  memory_enabled: true',
        '',
      ].join('\n')
    );
    await writeManagedConfig(file, { kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-secret' }); // pragma: allowlist secret
    const written = await fs.readFile(file, 'utf-8');

    expect(written.startsWith('model:\n  provider: "anthropic"\n  default: "claude-opus-5-5"\n')).toBe(true);
    expect(written).toContain('display:\n  interim_assistant_messages: false');
    expect(written).toContain('memory:\n  memory_enabled: true');
    expect(written).not.toContain('terminal, file');
    expect(written).not.toContain('mode: off');
    expect(written).not.toContain('openrouter');
    expect(written).not.toContain('sk-ant-secret');
    expect(written.match(/^model:/gm)).toHaveLength(1);
    expect(written.match(/^approvals:/gm)).toHaveLength(1);
  });

  it('points a custom endpoint at the key in the environment, not in the file', async () => {
    const file = path.join(dir, 'config.yaml');
    await writeManagedConfig(file, { kind: 'custom', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', apiKey: 'k' });
    const written = await fs.readFile(file, 'utf-8');
    expect(written).toContain('  base_url: "http://localhost:11434/v1"\n  key_env: "SSHS3_MODEL_API_KEY"\n');
  });

  it("sends Anthropic through the user's own endpoint instead of api.anthropic.com", async () => {
    const file = path.join(dir, 'config.yaml');
    await writeManagedConfig(file, { kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', baseUrl: 'https://gateway.example/llm' });
    const written = await fs.readFile(file, 'utf-8');
    expect(written.startsWith(
      'model:\n  provider: "custom"\n  default: "claude-opus-5-5"\n  base_url: "https://gateway.example/llm"\n' +
        '  api_mode: "anthropic_messages"\n  key_env: "SSHS3_MODEL_API_KEY"\n'
    )).toBe(true);
  });
});

describe('HermesManager', () => {
  let runtimeDir: string;
  let homeDir: string;
  let child: FakeChild;
  let spawn: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-hermes-runtime-'));
    homeDir = path.join(runtimeDir, 'home');
    await fs.mkdir(path.join(runtimeDir, 'python', 'bin'), { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'python', 'bin', 'python3.13'), '');
    await fs.writeFile(
      path.join(runtimeDir, 'manifest.json'),
      JSON.stringify({ tag: 'v2026.9.24', commit: 'abc', python: 'python/bin/python3.13' })
    );
    spawn = vi.fn(() => {
      child = new FakeChild();
      return child;
    });
    fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
  });

  afterEach(async () => {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  const manager = () =>
    new HermesManager({
      runtimeDir,
      homeDir,
      spawn: spawn as never,
      fetch: fetchMock as unknown as typeof fetch,
      startTimeoutMs: 2000,
    });

  it('reports a missing or unsafe runtime as not bundled', async () => {
    expect(await new HermesManager({ runtimeDir: path.join(runtimeDir, 'nope'), homeDir }).getManifest()).toBeNull();
    await fs.writeFile(path.join(runtimeDir, 'manifest.json'), JSON.stringify({ tag: 'x', commit: 'y', python: '../../usr/bin/python3' }));
    expect(await manager().getManifest()).toBeNull();
  });

  it('starts Hermes on loopback with a fresh key and a clean environment', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
    try {
      const hermes = manager();
      const endpoint = await hermes.ensureRunning({ kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant' }); // pragma: allowlist secret

      expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(endpoint.apiKey).toMatch(/^[0-9a-f]{64}$/);
      expect(hermes.isRunning()).toBe(true);

      const [python, args, options] = spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(python).toBe(path.join(runtimeDir, 'python/bin/python3.13'));
      expect(args).toEqual(['-I', '-m', 'hermes_cli.main', 'gateway', 'run', '--no-supervise']);
      expect(options.env).toMatchObject({
        HERMES_HOME: homeDir,
        HOME: homeDir,
        API_SERVER_HOST: '127.0.0.1',
        API_SERVER_KEY: endpoint.apiKey,
        ANTHROPIC_API_KEY: 'sk-ant', // pragma: allowlist secret
      });
      expect(options.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(await fs.readFile(path.join(homeDir, 'config.yaml'), 'utf-8')).toContain('api_server: ["memory", "session_search", "todo"]');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reuses the running agent and restarts it when the model changes', async () => {
    const hermes = manager();
    const first = await hermes.ensureRunning({ kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'a' });
    const firstChild = child;
    expect(await hermes.ensureRunning({ kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'a' })).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1);

    await hermes.ensureRunning({ kind: 'custom', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' });
    expect(firstChild.kill).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);

    await hermes.ensureRunning({ kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'gw', baseUrl: 'https://gateway.example/llm' }); // pragma: allowlist secret
    expect(spawn).toHaveBeenCalledTimes(3);
    const env = (spawn.mock.calls[2] as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(env.SSHS3_MODEL_API_KEY).toBe('gw');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    await hermes.stop();
    expect(child.kill).toHaveBeenCalled();
    expect(hermes.isRunning()).toBe(false);
  });

  it('reports why Hermes stopped during startup', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    spawn.mockImplementation(() => {
      child = new FakeChild();
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('Traceback...\nModuleNotFoundError: No module named aiohttp\n'));
        child.exitCode = 1;
        child.emit('exit', 1);
      }, 10);
      return child;
    });
    await expect(manager().ensureRunning({ kind: 'anthropic', model: 'm', apiKey: 'k' })).rejects.toThrow(
      'Hermes stopped while starting: ModuleNotFoundError: No module named aiohttp'
    );
  });
});
