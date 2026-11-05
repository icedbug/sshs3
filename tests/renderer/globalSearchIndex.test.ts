import { describe, it, expect } from 'vitest';
import { buildProfileEntries, buildTabEntries } from '../../src/renderer/src/lib/globalSearchIndex';
import type { AppTab } from '../../src/renderer/src/lib/tabs';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

const ssh = (id: string, over: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig =>
  ({ id, name: id, host: `${id}.example.com`, username: 'deploy', authType: 'password', ...over }) as SSHConnectionConfig;
const s3 = (id: string, over: Partial<S3Config> = {}): S3Config =>
  ({ id, name: id, region: 'eu-north-1', accessKeyId: 'AKIA', secretAccessKey: 'shh', ...over }) as S3Config; // pragma: allowlist secret

describe('buildProfileEntries', () => {
  it('describes an SSH profile by name, user@host and folder, with its tags', () => {
    const [entry] = buildProfileEntries([
      { source: 'personal', ssh: [ssh('web', { group: 'Prod/Web', tags: ['prod'], port: 2222, lastUsedAt: '2026-10-29 10:00' })], s3: [] },
    ]);
    expect(entry).toMatchObject({
      id: 'ssh:personal:web',
      kind: 'ssh',
      title: 'web',
      subtitle: 'deploy@web.example.com:2222',
      group: 'Prod/Web',
      tags: ['prod'],
      source: 'personal',
      ref: 'web',
      sftp: true,
      lastUsedAt: '2026-10-29 10:00',
    });
  });

  it('leaves the default SSH port out of the subtitle', () => {
    const [entry] = buildProfileEntries([{ source: 'personal', ssh: [ssh('a', { port: 22 })], s3: [] }]);
    expect(entry.subtitle).toBe('deploy@a.example.com');
  });

  it('describes an S3 profile by endpoint and region', () => {
    const entries = buildProfileEntries([
      { source: 'personal', ssh: [], s3: [s3('assets', { endpoint: 'minio.local' }), s3('aws')] },
    ]);
    expect(entries.map((e) => e.subtitle)).toEqual(['minio.local · eu-north-1', 'AWS S3 · eu-north-1']);
    expect(entries[0]).toMatchObject({ id: 's3:personal:assets', kind: 's3', sftp: false });
  });

  it('keeps profiles of different sources apart and labels the Team Vault ones', () => {
    const entries = buildProfileEntries([
      { source: 'personal', ssh: [ssh('a')], s3: [] },
      { source: 'vault-1', label: 'Prod - Team', ssh: [ssh('a')], s3: [] },
    ]);
    expect(entries.map((e) => e.id)).toEqual(['ssh:personal:a', 'ssh:vault-1:a']);
    expect(entries[1]).toMatchObject({ source: 'vault-1', sourceLabel: 'Prod - Team' });
    expect(entries[0].sourceLabel).toBeUndefined();
  });

  it('never carries a secret, whatever the profile holds', () => {
    const entries = buildProfileEntries([
      {
        source: 'personal',
        ssh: [ssh('a', { password: 'pw', passphrase: 'pp', pin: '1234', privateKeyPath: '/k' })], // pragma: allowlist secret
        s3: [s3('b', { sessionToken: 'tok' })],
      },
    ]);
    const text = JSON.stringify(entries);
    for (const secret of ['pw', 'pp', '1234', '/k', 'shh', 'tok', 'AKIA']) expect(text).not.toContain(secret);
  });
});

describe('buildProfileEntries: systems', () => {
  const sources = [
    {
      source: 'personal',
      ssh: [
        ssh('web', { group: 'Prod', system: { name: 'Shop' } }),
        ssh('db', { group: 'Prod', system: { name: 'shop' } }),
        ssh('blog'),
      ],
      s3: [],
    },
  ];

  it('adds one row per system, in its folder, counting its servers', () => {
    const rows = buildProfileEntries(sources).filter((e) => e.kind === 'system');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'system:personal:shop',
      subtitle: 'System · 2 servers',
      group: 'Prod',
      source: 'personal',
      sftp: false,
      tags: [],
    });
    // Spelled as its first server by name ('db') spells it.
    expect(rows[0].title).toBe('shop');
    expect(rows[0].ref).toBe('shop');
  });

  it('says "1 server" for a system of one', () => {
    const [row] = buildProfileEntries([{ source: 'personal', ssh: [ssh('a', { system: { name: 'Solo' } })], s3: [] }]).filter((e) => e.kind === 'system');
    expect(row.subtitle).toBe('System · 1 server');
  });

  it('gives each server the name of its system so it is found by it, and none to a loose server', () => {
    const servers = buildProfileEntries(sources).filter((e) => e.kind === 'ssh');
    expect(servers.map((e) => [e.ref, e.system])).toEqual([['web', 'Shop'], ['db', 'shop'], ['blog', undefined]]);
  });

  it('keeps systems of the same name in different sources apart', () => {
    const rows = buildProfileEntries([
      { source: 'personal', ssh: [ssh('a', { system: { name: 'Shop' } })], s3: [] },
      { source: 'v1', label: 'Team', ssh: [ssh('b', { system: { name: 'Shop' } })], s3: [] },
    ]).filter((e) => e.kind === 'system');
    expect(rows.map((r) => r.id)).toEqual(['system:personal:shop', 'system:v1:shop']);
    expect(rows[1].sourceLabel).toBe('Team');
  });

  it('adds nothing when no profile is in a system', () => {
    expect(buildProfileEntries([{ source: 'personal', ssh: [ssh('a')], s3: [] }]).some((e) => e.kind === 'system')).toBe(false);
  });
});

describe('buildTabEntries', () => {
  const terminal = (id: string, title: string, leaf: object): AppTab =>
    ({ id, type: 'terminal', title, paneTree: { type: 'leaf', id: `${id}-root`, ...leaf } }) as AppTab;

  it('lists each open tab with its title and the host it is connected to', () => {
    const entries = buildTabEntries([
      terminal('t1', 'Web One', { config: { host: 'web1.example.com', password: 'pw' }, baseHost: 'web1.example.com' }), // pragma: allowlist secret
      terminal('t2', 'Terminal 2', {}),
      { id: 'f1', type: 'filemanager', title: 'Files' } as AppTab,
      { id: 'e1', type: 'editor', title: 'notes.md' } as AppTab,
    ]);
    expect(entries.map((e) => [e.id, e.kind, e.title, e.subtitle, e.ref])).toEqual([
      ['tab:t1', 'tab', 'Web One', 'Terminal · web1.example.com', 't1'],
      ['tab:t2', 'tab', 'Terminal 2', 'Terminal', 't2'],
      ['tab:f1', 'tab', 'Files', 'File manager', 'f1'],
      ['tab:e1', 'tab', 'notes.md', 'Editor', 'e1'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('pw');
  });

  it('prefers the host the user has since hopped to over the original one', () => {
    const [entry] = buildTabEntries([terminal('t1', 'x', { baseHost: 'a.example.com', dynamicHost: 'b.example.com' })]);
    expect(entry.subtitle).toBe('Terminal · b.example.com');
  });
});
