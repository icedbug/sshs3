import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

/** Every ssh process a terminal would start: what was asked for instead of the process itself. */
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; env: Record<string, string>; cwd?: string }>);

vi.mock('node-pty', () => {
  const spawn = (file: string, args: string[], options: { env: Record<string, string>; cwd?: string }) => {
    spawned.push({ file, args: [...args], env: { ...options.env }, cwd: options.cwd });
    const none = { dispose: () => {} };
    return { pid: 4242, cols: 80, rows: 24, process: file, onData: () => none, onExit: () => none, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {}, clear: () => {} };
  };
  return { default: { spawn }, spawn };
});

import { SmartcardDetector } from '../../src/main/smartcard/SmartcardDetector';
import { buildKeyInstallArgs } from '../../src/main/ssh/KeyInstallService';
import { handleHostKeyChanged } from '../../src/main/ssh/hostKeyChanged';
import {
  clientTerminalEnv,
  confineSshConfig,
  ensureAccountSshFiles,
  isWebServerProcess,
  setWebServerProcess,
  sshClientFilesOf,
} from '../../src/main/web/tenantBoundary';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import { startWebServer, type WebClient, type WebServerKit } from '../helpers/webServerKit';

const server = (over: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig =>
  ({ id: `t-${Math.random().toString(36).slice(2)}`, name: 'db', host: 'db01.corp.example', port: 22, username: 'ops', authType: 'password', password: 'pw-for-db', ...over }) as SSHConnectionConfig; // pragma: allowlist secret

/**
 * W3 and W4: every account's ssh ran with the server user's ~/.ssh (one config and one known hosts file
 * for everybody, the last writer winning), and a web client set any environment variable on the ssh process.
 */
describe('web server: ssh for an account uses the account\'s own files', () => {
  let kit: WebServerKit;
  let maria: WebClient;
  let omar: WebClient;
  let mariaDir: string;
  let omarDir: string;
  const envBefore = { ...process.env };

  beforeEach(async () => {
    spawned.length = 0;
    // What the server's own user has: an ssh agent, and the passphrase of the credential key.
    process.env.SSH_AUTH_SOCK = '/run/server-operator-agent.sock';
    process.env.SSHS3_MASTER_KEY = 'the-servers-own-passphrase'; // pragma: allowlist secret
    kit = await startWebServer();
    const team = await kit.team();
    maria = await kit.connect(team.adminCookie);
    omar = await kit.connect(team.memberCookie);
    mariaDir = path.join(kit.dataDir, 'users', team.adminId);
    omarDir = path.join(kit.dataDir, 'users', team.memberId);
  });

  afterEach(async () => {
    maria.close();
    omar.close();
    await kit.stop();
    process.env = { ...envBefore };
  });

  it('starts each account\'s ssh with that account\'s config file', async () => {
    await maria.invoke('terminal:create', { config: server() });
    await omar.invoke('terminal:create', { config: server() });
    expect(spawned).toHaveLength(2);
    const [forMaria, forOmar] = spawned;
    expect(forMaria!.args.slice(0, 2)).toEqual(['-F', path.join(mariaDir, '.ssh', 'sshs3_config')]);
    expect(forOmar!.args.slice(0, 2)).toEqual(['-F', path.join(omarDir, '.ssh', 'sshs3_config')]);

    // That file sends host keys to the account's own known hosts, offers only its own key and asks no agent.
    const text = await fs.readFile(path.join(omarDir, '.ssh', 'sshs3_config'), 'utf8');
    expect(text).toContain(`UserKnownHostsFile "${path.join(omarDir, '.ssh', 'known_hosts')}"`);
    expect(text).toContain(`IdentityFile "${path.join(omarDir, '.ssh', 'id_ed25519')}"`);
    expect(text).toContain('IdentityAgent none');
    expect(text).not.toContain(mariaDir);
    // It is the whole of what ssh reads beside its command line: three settings for every host, and no other file.
    expect(text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.trim().split(' ')[0])).toEqual(['Host', 'UserKnownHostsFile', 'IdentityAgent', 'IdentityFile']);
    expect(text).not.toMatch(/Include/i);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(omarDir, '.ssh', 'sshs3_config'))).mode & 0o077).toBe(0);

    // The server's own agent and credential passphrase are not handed to the ssh process.
    for (const child of spawned) {
      expect(child.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(child.env.SSHS3_MASTER_KEY).toBeUndefined();
    }
  });

  it('keeps each account\'s saved hosts in its own ssh config, never in the server user\'s', async () => {
    await maria.invoke('profiles:save-ssh', { id: 'maria-db', name: 'maria-db', host: '10.0.0.5', port: 22, username: 'maria', authType: 'privateKey', shared: false });
    // A personal server whose name is a host name other people connect to.
    await omar.invoke('profiles:save-ssh', { id: 'omar-1', name: 'db01.corp.example', host: '203.0.113.9', port: 22, username: 'root', authType: 'privateKey', shared: false });
    const read = (file: string): Promise<string> => fs.readFile(file, 'utf8').catch(() => '');
    await vi.waitFor(async () => {
      expect(await read(path.join(omarDir, '.ssh', 'config'))).toContain('HostName 203.0.113.9');
      expect(await read(path.join(mariaDir, '.ssh', 'config'))).toContain('HostName 10.0.0.5');
    });
    expect(await read(path.join(mariaDir, '.ssh', 'config'))).not.toContain('203.0.113.9');
    expect(await read(path.join(omarDir, '.ssh', 'config'))).not.toContain('maria-db');
    // What a member saved under a host name other people connect to is read by nobody's ssh, his own included:
    // the file ssh is started with does not read the saved hosts.
    expect(await read(path.join(mariaDir, '.ssh', 'sshs3_config'))).not.toMatch(/Include|203\.0\.113\.9/);
    expect(await read(path.join(omarDir, '.ssh', 'sshs3_config'))).not.toMatch(/Include|203\.0\.113\.9/);
    // HOME is this test file's own folder (tests/setup/isolateHome.ts): the server user's ~/.ssh stays untouched.
    await expect(fs.stat(path.join(os.homedir(), '.ssh', 'config'))).rejects.toThrow();
    await expect(fs.stat(path.join(os.homedir(), '.ssh', 'known_hosts'))).rejects.toThrow();
  });

  it('takes only display and language variables from the client, and its own variables last', async () => {
    await omar.invoke('terminal:create', {
      config: server(),
      ptyOptions: {
        cols: 100,
        rows: 30,
        cwd: kit.dataDir,
        env: {
          SSH_ASKPASS: '/tmp/chosen-by-the-client',
          SSH_ASKPASS_REQUIRE: 'never',
          SSH_AUTH_SOCK: '/tmp/somebody-elses-agent.sock',
          LD_PRELOAD: '/tmp/evil.so',
          PATH: '/tmp/evil-bin',
          DISPLAY: ':77',
          TERM: 'xterm-kitty',
          COLORTERM: 'truecolor',
          LANG: 'sv_SE.UTF-8',
          LC_TIME: 'en_GB.UTF-8',
          LC_ALL: 'C\nSSH_ASKPASS=/tmp/x',
          LC_PAPER: 'x'.repeat(500),
          lc_time: 'lowercase is not a locale variable',
        },
      },
    });
    const child = spawned[0]!;
    expect(child.env.TERM).toBe('xterm-kitty');
    expect(child.env.COLORTERM).toBe('truecolor');
    expect(child.env.LANG).toBe('sv_SE.UTF-8');
    expect(child.env.LC_TIME).toBe('en_GB.UTF-8');
    // Not printable, or too long: dropped.
    expect(child.env.LC_ALL).toBe(process.env.LC_ALL);
    expect(child.env.LC_PAPER).toBe(process.env.LC_PAPER);
    expect(child.env.lc_time).toBeUndefined();
    // The app's own askpass helper, which answers with the saved password: the client cannot replace it.
    expect(child.env.SSH_ASKPASS).toBeTruthy();
    expect(child.env.SSH_ASKPASS).not.toBe('/tmp/chosen-by-the-client');
    expect(child.env.SSH_ASKPASS_REQUIRE).not.toBe('never');
    expect(child.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(child.env.LD_PRELOAD).toBe(process.env.LD_PRELOAD);
    expect(child.env.PATH).toBe(process.env.PATH);
    // The askpass helper sets a display of its own; the client's is not it.
    expect(child.env.DISPLAY).not.toBe(':77');
    // Nor does the client choose the folder the process starts in.
    expect(child.cwd).not.toBe(kit.dataDir);
  });

  it('refuses a key file that is not the account\'s own', async () => {
    const others = [
      path.join(mariaDir, '.ssh', 'id_ed25519'), // another account's key
      path.join(kit.dataDir, 'server-master.key'),
      '/etc/ssh/ssh_host_ed25519_key',
      '~/.ssh/id_ed25519', // ssh would read this as the server user's home
      '.ssh/id_ed25519',
    ];
    for (const privateKeyPath of others) {
      await expect(omar.invoke('terminal:create', { config: server({ authType: 'privateKey', password: undefined, privateKeyPath }) }), privateKeyPath).rejects.toThrow(
        /not in your own folder/,
      );
      expect(await omar.invoke('connection:test-ssh', server({ authType: 'privateKey', password: undefined, privateKeyPath }))).toMatchObject({
        success: false,
        error: expect.stringMatching(/not in your own folder/),
      });
    }
    await expect(omar.invoke('terminal:create', { config: server({ certificateFile: path.join(mariaDir, '.ssh', 'id_ed25519') } as never) })).rejects.toThrow(/not in your own folder/);
    expect(spawned).toHaveLength(0);

    // The account's own key is fine, also through a saved profile.
    const own = path.join(omarDir, '.ssh', 'id_ed25519');
    await omar.invoke('terminal:create', { config: server({ authType: 'privateKey', password: undefined, privateKeyPath: own }) });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toContain(own);

    // A link in the account's own files that points at somebody else's key is that key.
    if (process.platform !== 'win32') {
      await fs.mkdir(path.join(omarDir, 'files'), { recursive: true });
      await fs.symlink(path.join(mariaDir, '.ssh', 'id_ed25519'), path.join(omarDir, 'files', 'my-key'));
      await expect(omar.invoke('terminal:create', { config: server({ authType: 'privateKey', password: undefined, privateKeyPath: path.join(omarDir, 'files', 'my-key') }) })).rejects.toThrow(
        /not in your own folder/,
      );
    }
  });

  it('never loads a PKCS#11 library or uses an agent socket a client names', async () => {
    await expect(omar.invoke('terminal:create', { config: server({ authType: 'smartcard', pkcs11LibPath: path.join(omarDir, 'files', 'uploaded.so') }) })).rejects.toThrow(
      /smartcard or security key cannot be used/,
    );
    await expect(omar.invoke('terminal:create', { config: server({ authType: 'fido2', fido2Resident: true } as never) })).rejects.toThrow(/smartcard or security key cannot be used/);
    expect(await omar.invoke('connection:test-ssh', server({ authType: 'smartcard', pkcs11LibPath: '/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so' }))).toMatchObject({ success: false });
    expect(spawned).toHaveLength(0);

    await omar.invoke('terminal:create', {
      config: server({ authType: 'agent', password: undefined, agentPath: '/tmp/somebody-elses-agent.sock', pkcs11LibPath: '/tmp/uploaded.so', x11Forwarding: true, x11Display: ':0' }),
    });
    const child = spawned[0]!;
    // Tunnels a connection carries are dropped too: one would listen on the server, or lead into its network.
    const user = (await kit.server.auth.listUsers()).find((u) => u.username === 'omar')!;
    const tenant = await kit.server.tenants.getOrCreateTenant(user);
    const withTunnels = await tenant.bridge.resolveProxyJumpConfig(
      server({ tunnels: [{ id: 't1', type: 'remote', localPort: 8080, remoteHost: '169.254.169.254', remotePort: 80 }, { id: 't2', type: 'local', localPort: 2222, remoteHost: 'localhost', remotePort: 22 }] } as never),
    );
    const tunnelArgs = SmartcardDetector.buildSSHArguments(withTunnels);
    for (const flag of ['-L', '-R', '-D']) expect(tunnelArgs).not.toContain(flag);
    expect(child.args.join(' ')).not.toContain('somebody-elses-agent');
    expect(child.args.join(' ')).not.toContain('uploaded.so');
    expect(child.args).not.toContain('-I');
    expect(child.args).not.toContain('-Y');
    expect(child.env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('gives the account\'s files to every other way ssh is started for it', async () => {
    const user = (await kit.server.auth.listUsers()).find((u) => u.username === 'omar')!;
    const tenant = await kit.server.tenants.getOrCreateTenant(user);
    const own = ['-F', path.join(omarDir, '.ssh', 'sshs3_config')];

    // File connections (SFTP), however they are asked for: the registry itself makes them the account's own.
    const sftp = await tenant.bridge.storageRegistry.getOrCreate({ id: 'sftp-x', name: 'x', type: 'sftp', sftpConfig: server({ agentPath: '/tmp/somebody-elses-agent.sock' }) as never });
    const sftpConfig = (sftp as unknown as { config: SSHConnectionConfig }).config;
    expect(SmartcardDetector.buildSSHArguments(sftpConfig).slice(0, 2)).toEqual(own);
    expect(sftpConfig.agentPath).toBeUndefined();
    await expect(
      tenant.bridge.storageRegistry.getOrCreate({ id: 'sftp-y', name: 'y', type: 'sftp', sftpConfig: server({ authType: 'privateKey', privateKeyPath: path.join(mariaDir, '.ssh', 'id_ed25519') }) as never }),
    ).rejects.toThrow(/not in your own folder/);

    // What the handlers and the AI hub connect with goes through here first.
    const resolved = await tenant.bridge.resolveProxyJumpConfig(server());
    expect(buildKeyInstallArgs(resolved).slice(0, 2)).toEqual(own);
    expect(SmartcardDetector.buildSSHArguments({ ...resolved, tunnels: [], x11Forwarding: false }).slice(0, 2)).toEqual(own);
    // What the app adds afterwards (its own agent) is kept: the config was already made the account's own.
    const withAppAgent = { ...resolved, agentPath: '/run/app-agent.sock' };
    expect(tenant.bridge.confineSshConfig(withAppAgent)).toBe(withAppAgent);

    // An AWS SSO sign-in is one for the whole server, and a certificate file has to be the account's own.
    await expect(tenant.bridge.storageRegistry.getOrCreate({ id: 's3-a', name: 'a', type: 's3', s3Config: { id: 'a', name: 'a', region: 'eu-north-1', authMode: 'sso' } as never })).rejects.toThrow(
      /AWS SSO sign-in cannot be used/,
    );
    await expect(
      tenant.bridge.storageRegistry.getOrCreate({ id: 's3-b', name: 'b', type: 's3', s3Config: { id: 'b', name: 'b', region: 'eu-north-1', accessKeyId: 'k', secretAccessKey: 's', customCaPath: '/etc/passwd' } as never }),
    ).rejects.toThrow(/certificate file of this connection is not in your own folder/);
    expect(await omar.invoke('connection:test-s3', { region: 'eu-north-1', authMode: 'sso', sso: { startUrl: 'https://x.example.invalid', accountId: '1', roleName: 'r' } })).toMatchObject({
      success: false,
      error: expect.stringMatching(/AWS SSO sign-in cannot be used/),
    });
  });

  it('on a web server, ssh without an account\'s files is not started at all', async () => {
    expect(isWebServerProcess()).toBe(true);
    expect(() => SmartcardDetector.buildSSHArguments(server())).toThrow(/not set up for an account of this server/);
    // A client cannot bring the files along: the mark is not something JSON can carry.
    const forged = JSON.parse(JSON.stringify({ ...server(), 'Symbol(sshs3.sshClientFiles)': { configPath: '/tmp/evil_config' } }));
    expect(sshClientFilesOf(forged)).toBeUndefined();
    expect(() => SmartcardDetector.buildSSHArguments(forged)).toThrow(/not set up for an account of this server/);
  });
});

describe('ssh files of an account', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'account-ssh-')));
  });

  afterEach(async () => {
    setWebServerProcess(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('the desktop app starts ssh as before: no config file is named', () => {
    setWebServerProcess(false);
    const args = SmartcardDetector.buildSSHArguments(server());
    expect(args).not.toContain('-F');
    expect(args.slice(-2)).toEqual(['--', 'ops@db01.corp.example']);
  });

  it('writes the config ssh is started with, and keeps what sshs3 saved in the account\'s own config', async () => {
    const home = path.join(dir, 'u1');
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host kept\n  HostName 10.1.1.1\n');
    const files = ensureAccountSshFiles(home, path.join(home, '.ssh', 'id_ed25519'));
    expect(files).toEqual({
      configPath: path.join(home, '.ssh', 'sshs3_config'),
      managedConfigPath: path.join(home, '.ssh', 'config'),
      knownHostsPath: path.join(home, '.ssh', 'known_hosts'),
    });
    expect(await fs.readFile(files.managedConfigPath, 'utf8')).toBe('Host kept\n  HostName 10.1.1.1\n');
    // An account starts with no known host: the file is made by ssh when the first key is accepted.
    await expect(fs.stat(files.knownHostsPath)).rejects.toThrow();
    // Without a key of its own, no key at all is offered (never the server user's).
    const none = ensureAccountSshFiles(path.join(dir, 'u2'));
    expect(await fs.readFile(none.configPath, 'utf8')).toContain('IdentityFile none');
    expect(await fs.readFile(none.managedConfigPath, 'utf8')).toBe('');
  });

  it('a config is made an account\'s own once, and a second account\'s files do not pass for the first\'s', async () => {
    const a = { homeDir: path.join(dir, 'a'), files: ensureAccountSshFiles(path.join(dir, 'a')) };
    const b = { homeDir: path.join(dir, 'b'), files: ensureAccountSshFiles(path.join(dir, 'b')) };
    const forA = confineSshConfig(server({ agentPath: '/x.sock' }), a);
    expect(sshClientFilesOf(forA)).toBe(a.files);
    expect(confineSshConfig(forA, a)).toBe(forA);
    // Carried over to another account (it cannot happen through the handlers): checked again, and its files replaced.
    const forB = confineSshConfig({ ...forA, agentPath: '/a-agent.sock' }, b);
    expect(sshClientFilesOf(forB)).toBe(b.files);
    expect(forB.agentPath).toBeUndefined();
  });

  it('keeps what a client may set on a terminal short, printable and about display or language', () => {
    expect(clientTerminalEnv({ TERM: 'xterm', LANG: 'C.UTF-8', LC_CTYPE: 'sv_SE.UTF-8', COLORTERM: 'truecolor' })).toEqual({ TERM: 'xterm', LANG: 'C.UTF-8', LC_CTYPE: 'sv_SE.UTF-8', COLORTERM: 'truecolor' });
    expect(clientTerminalEnv({ SSH_ASKPASS: '/x', LD_PRELOAD: '/x', PATH: '/x', HOME: '/x', LC_: 'x', LC_x: 'y', TERM: '', LANG: 'a\nb', LC_ALL: 7, LC_TIME: 'é' })).toEqual({});
    expect(clientTerminalEnv(null)).toEqual({});
    expect(clientTerminalEnv(['TERM=x'])).toEqual({});
  });

  it('a changed host key is looked up in, and removed from, the account\'s own known hosts', async () => {
    const calls: unknown[][] = [];
    const replaced = await handleHostKeyChanged(
      { host: 'db01.corp.example', port: 22 },
      {
        knownHostsFile: '/data/users/u1/.ssh/known_hosts',
        promptHostKeyTrust: async () => true,
        notify: () => {},
        probeChangedHostKey: async (...args) => {
          calls.push(['probe', ...args]);
          return { keyType: 'ED25519', fingerprint: 'SHA256:new' };
        },
        removeKnownHost: async (...args) => {
          calls.push(['remove', ...args]);
        },
      },
    );
    expect(replaced).toBe(true);
    expect(calls).toEqual([
      ['probe', 'db01.corp.example', 22, '/data/users/u1/.ssh/known_hosts'],
      ['remove', 'db01.corp.example', 22, '/data/users/u1/.ssh/known_hosts'],
    ]);
  });
});
