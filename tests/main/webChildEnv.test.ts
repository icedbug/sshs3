import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { accountChildEnv, setWebServerProcess } from '../../src/main/web/tenantBoundary';
import { safeGitEnv } from '../../src/main/git/gitSafety';

/**
 * On a web server a child that is started for an account (ssh, sftp, git, a shell) must not get the
 * server's own environment: its administrator password, its credential key, its ssh agent. Several
 * places handed the whole of `process.env` to such a child.
 */

const SERVER_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/srv/sshs3',
  LANG: 'en_US.UTF-8',
  SSHS3_MASTER_KEY: 'the-credential-key', // pragma: allowlist secret
  SSHS3_ADMIN_PASSWORD: 'admin-password', // pragma: allowlist secret
  SSH_AUTH_SOCK: '/run/server-agent.sock',
  SSH_AGENT_PID: '4711',
  AWS_SECRET_ACCESS_KEY: 'cloud-secret', // pragma: allowlist secret
  GITHUB_TOKEN: 'a-token', // pragma: allowlist secret
};

afterEach(() => setWebServerProcess(false));

describe('the environment a child started for an account inherits', () => {
  it('is all of it on the desktop: the environment is the person own', () => {
    expect(accountChildEnv(SERVER_ENV)).toEqual(SERVER_ENV);
  });

  it('is only what a program needs to run on a web server', () => {
    setWebServerProcess(true);
    expect(accountChildEnv(SERVER_ENV)).toEqual({ PATH: '/usr/bin', HOME: '/srv/sshs3', LANG: 'en_US.UTF-8' });
  });

  it('holds for git too, with git own settings added', () => {
    const before = { ...process.env };
    Object.assign(process.env, { SSHS3_MASTER_KEY: 'the-credential-key', SSH_AUTH_SOCK: '/run/server-agent.sock' }); // pragma: allowlist secret
    try {
      expect(safeGitEnv().SSH_AUTH_SOCK).toBe('/run/server-agent.sock');
      setWebServerProcess(true);
      const env = safeGitEnv();
      expect(env.SSHS3_MASTER_KEY).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  });
});

/**
 * Files that start a program and are not held to the rule below, each with why. A new file that starts a
 * program has to be put here or follow the rule: until then this test fails.
 */
const NOT_FOR_AN_ACCOUNT: Record<string, string> = {
  'ai/HermesManager.ts': 'the local agent runtime, started with a short list of variables of its own (hermesBaseEnvironment)',
  'ai/hub/AcpRuntime.ts': 'an agent program, started with a filtered environment of its own (childEnv)',
  'ai/hub/McpClientManager.ts': 'an MCP program, started with PATH, HOME and what the server entry names',
  'archive/ArchiveService.ts': 'tar and zip on files of the account own folder: no ssh, git or shell',
  'crypto/SystemTrustStore.ts': 'reads the Windows certificate store of the desktop',
  'demo/DemoVirtualPty.ts': 'starts nothing: the demo terminal is scripted',
  'git/GitConfigService.ts': 'the git settings of the person at the desktop: its channels are refused on a web server',
  'ipc/generalHandlers.ts': 'looks for PowerShell and WSL on a Windows desktop',
  'policy/policySources.ts': 'reads the Windows registry of the desktop',
  'services/AgePtyPinRelay.ts': 'age, the bundled encryption program',
  'services/TeamVaultCryptoService.ts': 'age, the bundled encryption program',
  'smartcard/SmartcardAgentLoader.ts': 'card readers: there is none on a web server',
  'smartcard/SmartcardCertificateReader.ts': 'card readers: there is none on a web server',
  'smartcard/WindowsAgentPath.ts': 'card readers: there is none on a web server',
  'smartcard/YkmanFido.ts': 'card readers: there is none on a web server',
  'ssh/AgentLifecycleManager.ts': 'the ssh agent of the person at the desktop; its one ssh call is skipped on a web server',
  'ssh/AppAgent.ts': 'the app own agent for cards and security keys: desktop',
  'ssh/LoginShellEnv.ts': 'reads the login shell of the person when the desktop app starts',
  'storage/LocalStorageProvider.ts': 'asks Windows for its drives, with node itself',
  'update/linuxRelaunch.ts': 'restarts the desktop app after an update',
  'web/WebAuthService.ts': 'the server own ssh-keygen when it makes an account key: nothing the account names runs',
  'x11/XServerManager.ts': 'the X server of a Windows desktop',
};

const MAIN = path.resolve(__dirname, '../../src/main');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** The text of a source file without its comments: a comment may name `spawn()` or `process.env` freely. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');
}

/** Every call that starts a program, as written, from its name to its closing parenthesis. */
function childStarts(text: string): string[] {
  const calls: string[] = [];
  const start = /(?<![\w.'"`])(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|nodeSpawn)\(/g;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    calls.push(text.slice(m.index, end + 1));
  }
  return calls;
}

describe('every place that starts a program for an account', () => {
  const starters = sources(MAIN)
    .filter((file) => /from\s+['"](?:node:)?child_process['"]|from\s+['"]node-pty['"]/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(MAIN, file).split(path.sep).join('/'))
    .sort();
  const held = starters.filter((file) => !(file in NOT_FOR_AN_ACCOUNT));

  it('is known: a file that starts a program follows the rule or says why not', () => {
    // The files this test was written for. One that goes away has to leave the list too.
    expect(Object.keys(NOT_FOR_AN_ACCOUNT).filter((file) => !starters.includes(file))).toEqual([]);
    expect(held).toEqual([
      'ai/hub/createHub.ts',
      'dotfiles/DotfileCliTransport.ts',
      'dotfiles/DotfileGitImporter.ts',
      'git/GitStatusService.ts',
      'git/RemoteGitService.ts',
      'services/PerfMetricsService.ts',
      'services/SSHTunnelManager.ts',
      'ssh/KeyInstallService.ts',
      'ssh/PublicKeyDiscovery.ts',
      'ssh/SSHPtyManager.ts',
      'ssh/hostKeyChanged.ts',
      'storage/sftp/OpenSshSftpProcess.ts',
    ]);
  });

  it.each(held)('%s never hands the whole process environment to a child', (file) => {
    // The two helpers are the only places the whole environment may go through.
    const text = code(path.join(MAIN, file)).replace(/(?:serverEnvForAccountChild|accountChildEnv)\(process\.env\)/g, '');
    const whole = text.match(/\.\.\.\s*\(?\s*process\.env\b[^.[]|\benv:\s*process\.env\b[^.[]|[(,]\s*process\.env\s*[,)]/g) ?? [];
    expect(whole).toEqual([]);
  });

  it.each(held)('%s gives every child an environment of its own choosing', (file) => {
    const calls = childStarts(code(path.join(MAIN, file)));
    expect(calls.length).toBeGreaterThan(0);
    // A call without `env` inherits everything the server has.
    expect(calls.filter((call) => !/\benv\b/.test(call))).toEqual([]);
  });

  it('gets that environment from the filter', () => {
    // Where the environment is built in each of these files, it starts from the filtered one.
    const usesFilter = (file: string): boolean => /accountChildEnv\(|safeGitEnv\(|sshChildEnv\(/.test(code(path.join(MAIN, file)));
    expect(held.filter((file) => !usesFilter(file))).toEqual([]);
    expect(code(path.join(MAIN, 'git/gitSafety.ts'))).toContain('...accountChildEnv()');
  });
});
