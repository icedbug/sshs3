import { describe, it, expect } from 'vitest';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import { searchLandingProfiles } from './landingSearch';

const p = (id: string, name: string, host: string, extra: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig => ({
  id,
  name,
  host,
  port: 22,
  username: 'alun',
  authType: 'password',
  ...extra,
});

const profiles = [
  p('1', 'gnarg ssh-ca', 'gnarg'),
  p('2', 'build-box', 'ci.example.com', { tags: ['ci'] }),
  p('3', 'prod web', 'web1.example.com', { tags: ['prod'] }),
];

describe('searchLandingProfiles', () => {
  it('returns nothing for an empty query', () => {
    expect(searchLandingProfiles(profiles, '  ', 8)).toEqual([]);
  });

  it('matches fuzzily, with highlight positions in the name', () => {
    const [hit] = searchLandingProfiles(profiles, 'gnca', 8);
    expect(hit.profile.id).toBe('1');
    expect(hit.titleIndices.length).toBe(4);
  });

  it('requires every word and honours #tag filters', () => {
    expect(searchLandingProfiles(profiles, 'prod web', 8).map((m) => m.profile.id)).toEqual(['3']);
    expect(searchLandingProfiles(profiles, '#ci', 8).map((m) => m.profile.id)).toEqual(['2']);
    expect(searchLandingProfiles(profiles, 'build #prod', 8)).toEqual([]);
  });

  it('caps the number of results', () => {
    expect(searchLandingProfiles(profiles, 'e', 1)).toHaveLength(1);
  });
});
