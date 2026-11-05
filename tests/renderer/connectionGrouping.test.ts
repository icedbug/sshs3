import { describe, it, expect } from 'vitest';
import {
  collectFolderNames,
  filterS3Profiles,
  filterSshProfiles,
  folderNamesForTab,
  groupProfiles,
  mostRecentlyUsed,
  parseAdHocTarget,
} from '../../src/renderer/src/components/ConnectionModal/connectionGrouping';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

const ssh = (id: string, over: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig =>
  ({ id, name: id, host: `${id}.example.com`, username: 'root', authType: 'password', ...over }) as SSHConnectionConfig;
const s3 = (id: string, over: Partial<S3Config> = {}): S3Config =>
  ({ id, name: id, region: 'eu-north-1', ...over }) as S3Config;

describe('connectionGrouping', () => {
  it('parses user@host and user@host:port as an ad-hoc target, and nothing else', () => {
    expect(parseAdHocTarget(' alice@web1 ')).toEqual({ username: 'alice', host: 'web1', port: undefined });
    expect(parseAdHocTarget('alice@web1:2222')).toEqual({ username: 'alice', host: 'web1', port: 2222 });
    expect(parseAdHocTarget('web1')).toBeNull();
    expect(parseAdHocTarget('a b@web1')).toBeNull();
  });

  it('filters SSH profiles on name, host, user and group, and S3 on endpoint/region/path/group', () => {
    const profiles = [ssh('prod', { group: 'Work' }), ssh('home', { username: 'pi' })];
    expect(filterSshProfiles(profiles, '').length).toBe(2);
    expect(filterSshProfiles(profiles, 'work').map((p) => p.id)).toEqual(['prod']);
    expect(filterSshProfiles(profiles, 'pi').map((p) => p.id)).toEqual(['home']);

    const buckets = [s3('a', { endpoint: 'minio.local' }), s3('b', { region: 'us-east-1' })];
    expect(filterS3Profiles(buckets, 'minio').map((p) => p.id)).toEqual(['a']);
    expect(filterS3Profiles(buckets, 'us-east').map((p) => p.id)).toEqual(['b']);
  });

  it('matches tags in the SSH and S3 filters, with or without a leading #, and keeps the input order', () => {
    const profiles = [ssh('a', { tags: ['Prod', 'web'] }), ssh('b'), ssh('c', { tags: ['db', 'prod-eu'] })];
    expect(filterSshProfiles(profiles, 'prod').map((p) => p.id)).toEqual(['a', 'c']);
    expect(filterSshProfiles(profiles, '#prod').map((p) => p.id)).toEqual(['a', 'c']);
    expect(filterSshProfiles(profiles, '#db').map((p) => p.id)).toEqual(['c']);
    expect(filterSshProfiles(profiles, '#').map((p) => p.id)).toEqual([]);

    const buckets = [s3('x', { tags: ['assets'] }), s3('y')];
    expect(filterS3Profiles(buckets, '#assets').map((p) => p.id)).toEqual(['x']);
    expect(filterS3Profiles(buckets, 'asset').map((p) => p.id)).toEqual(['x']);
  });

  it('matches the name of the system a profile belongs to, so a search for the system shows all its servers', () => {
    const profiles = [ssh('a', { system: { name: 'Shop' } }), ssh('b', { system: { name: 'shop checkout' } }), ssh('c')];
    expect(filterSshProfiles(profiles, 'shop').map((p) => p.id)).toEqual(['a', 'b']);
    expect(filterSshProfiles(profiles, 'checkout').map((p) => p.id)).toEqual(['b']);
    expect(filterSshProfiles(profiles, 'nope')).toEqual([]);
  });

  it('collects saved folders and profile groups, sorted and trimmed', () => {
    expect(collectFolderNames(['Zeta'], [ssh('a', { group: ' Alpha ' })], [s3('b', { group: 'Mid' })])).toEqual([
      'Alpha',
      'Mid',
      'Zeta',
    ]);
  });

  describe('folderNamesForTab', () => {
    const all = ['SshOnly', 'S3Only', 'Empty'];
    const sshProfiles = [ssh('a', { group: 'SshOnly' })];
    const s3Profiles = [s3('b', { group: 'S3Only' })];

    it('scopes folders to the tab whose profiles they hold; an empty folder shows in both', () => {
      expect(folderNamesForTab('ssh', all, sshProfiles, s3Profiles, false)).toEqual(['SshOnly', 'Empty']);
      expect(folderNamesForTab('s3', all, sshProfiles, s3Profiles, false)).toEqual(['S3Only', 'Empty']);
    });

    it('shows every folder in every tab when sharing is on', () => {
      expect(folderNamesForTab('ssh', all, sshProfiles, s3Profiles, true)).toEqual(all);
    });
  });

  describe('groupProfiles', () => {
    it('puts Ungrouped last, hides it when empty, and keeps empty folders', () => {
      const grouped = groupProfiles(['B', 'A'], [ssh('x', { group: 'A' })], '');
      expect(grouped.map(([name]) => name)).toEqual(['A', 'B']);
      const withUngrouped = groupProfiles(['A'], [ssh('x', { group: 'A' }), ssh('y')], '');
      expect(withUngrouped.map(([name]) => name)).toEqual(['A', 'Ungrouped']);
    });

    it('with a query keeps only non-empty groups and folders whose name matches', () => {
      const grouped = groupProfiles(['Work', 'Home'], [ssh('x', { group: 'Work' })], 'work');
      expect(grouped.map(([name]) => name)).toEqual(['Work']);
    });
  });

  it('returns the most recently used profiles first and ignores never-used ones', () => {
    const recent = mostRecentlyUsed(
      [
        ssh('old', { lastUsedAt: '2026-01-01 10:00' }),
        ssh('never'),
        ssh('new', { lastUsedAt: '2026-03-01 10:00' }),
        ssh('mid', { lastUsedAt: '2026-02-01 10:00' }),
      ],
      2
    );
    expect(recent.map((p) => p.id)).toEqual(['new', 'mid']);
  });
});
