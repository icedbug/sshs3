import { afterEach, describe, expect, it } from 'vitest';
import { getDemoMcpServers, getDemoS3Profiles, getDemoServers } from '../../src/main/ai/hub/demoWorkspace';
import { isDemoTarget, setDemoModeForTesting } from '../../src/main/demo/demoMode';
import type { McpServerConfig } from '../../src/shared/types/aiHub';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

/**
 * isDemoTarget (src/main/demo/demoMode.ts) decides whether a connection target is one of the demo
 * workspace's fake fixtures. Only an explicit demo identity counts, and only in demo mode: an address in
 * the fixtures' 10.30.x range, an acme.se endpoint or an appliance name never makes a real profile fake.
 */

/** Ids of the kind the app gives the user's own profiles and every terminal session's config (crypto.randomUUID()). */
const REAL_PROFILE_ID = '3f2b8c1e-7a4d-4e9b-9c61-5d0f2a8e7b13';
const REAL_S3_PROFILE_ID = '8d6e4b2a-1c3f-4a5e-b7d9-0e2f4a6c8b1d';
const SESSION_CONFIG_ID = 'a1c9e7f2-0b3d-4c58-8e6a-27f4d9b1c053';

/** Profiles a user saved for real machines that share the demo fixtures' addresses and names. */
const realOntap: SSHConnectionConfig = {
  id: REAL_PROFILE_ID,
  name: 'netapp-aff-a800-01a',
  host: '10.30.10.11',
  port: 22,
  username: 'admin',
  authType: 'agent',
};
const realBastion: SSHConnectionConfig = {
  id: '5b7d9f1a-3c5e-4f7a-9b1d-3e5f7a9c1e3f',
  name: 'demo-lab bastion',
  host: 'bastion.acme.se',
  username: 'ops',
  authType: 'privateKey',
};
const realStorageGrid: S3Config = {
  id: REAL_S3_PROFILE_ID,
  name: 'NetApp StorageGRID',
  endpoint: 'https://s3-dc1.storage.acme.se:10443',
  region: 'eu-north-1',
  accessKeyId: 'AKIAREALPROFILE',
  secretAccessKey: 'not-a-demo-secret', // pragma: allowlist secret
  forcePathStyle: true,
};

/** Every demo fixture a demo process offers as a target: SSH servers, S3 profiles, MCP servers. */
function demoFixtures() {
  return [...getDemoServers(), ...getDemoS3Profiles(), ...getDemoMcpServers()];
}

afterEach(() => {
  setDemoModeForTesting(undefined);
});

describe('isDemoTarget in demo mode', () => {
  it('recognises every demo fixture by its id', () => {
    setDemoModeForTesting(true);
    const fixtures = demoFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      expect(isDemoTarget(fixture.id), fixture.id).toBe(true);
      expect(isDemoTarget(fixture), fixture.id).toBe(true);
    }
  });

  it('recognises them wherever the app carries that id: provider ids, a terminal profile id, AI file tools', () => {
    setDemoModeForTesting(true);
    for (const server of getDemoServers()) {
      // StorageRegistry: the file manager's SFTP provider id wraps the profile id.
      expect(isDemoTarget(`sftp-${server.id}`), server.id).toBe(true);
      // TERMINAL_CREATE: the session config gets a random id, the saved profile id travels as profileId.
      expect(isDemoTarget(SESSION_CONFIG_ID, server.id), server.id).toBe(true);
      expect(isDemoTarget({ id: SESSION_CONFIG_ID, profileId: server.id }), server.id).toBe(true);
      // FileTools: a synthetic provider id plus the terminal's profile id.
      expect(isDemoTarget(`ai-file:${SESSION_CONFIG_ID}:1`, server.id), server.id).toBe(true);
    }
    for (const profile of getDemoS3Profiles()) {
      expect(isDemoTarget(`s3-${profile.id}`), profile.id).toBe(true);
    }
  });

  it('never takes a real profile for a demo one, even on a 10.30.x address, an acme.se endpoint or a demo-like name', () => {
    setDemoModeForTesting(true);
    expect(isDemoTarget(realOntap)).toBe(false);
    expect(isDemoTarget(realBastion)).toBe(false);
    expect(isDemoTarget(realStorageGrid)).toBe(false);
    expect(isDemoTarget(`sftp-${realOntap.id}`)).toBe(false);
    expect(isDemoTarget(`s3-${realStorageGrid.id}`)).toBe(false);
    expect(isDemoTarget(SESSION_CONFIG_ID, realOntap.id)).toBe(false);
    expect(isDemoTarget({ id: SESSION_CONFIG_ID, profileId: realOntap.id })).toBe(false);
    expect(isDemoTarget(`ai-file:${SESSION_CONFIG_ID}:1`, realBastion.id)).toBe(false);

    // A copy of each fixture that only differs in its id is real, whatever its host, endpoint or URL.
    for (const server of getDemoServers()) {
      const real: SSHConnectionConfig = {
        id: REAL_PROFILE_ID,
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: 'agent',
      };
      expect(isDemoTarget(real), server.host).toBe(false);
      expect(isDemoTarget(`sftp-${real.id}`), server.host).toBe(false);
      expect(isDemoTarget(SESSION_CONFIG_ID, real.id), server.host).toBe(false);
    }
    for (const profile of getDemoS3Profiles()) {
      const real: S3Config = { ...profile, id: REAL_S3_PROFILE_ID };
      expect(isDemoTarget(real), profile.endpoint).toBe(false);
      expect(isDemoTarget(`s3-${real.id}`), profile.endpoint).toBe(false);
    }
    for (const server of getDemoMcpServers()) {
      const real: McpServerConfig = { ...server, id: REAL_PROFILE_ID };
      expect(isDemoTarget(real), server.url ?? server.command).toBe(false);
    }
  });

  it('reads nothing into host names, addresses, endpoints or appliance names', () => {
    setDemoModeForTesting(true);
    const notIdentities = [
      '10.30.10.11',
      '10.30.99.10',
      'netapp-aff-a800-01a',
      'truenas-zfs-vault-01',
      's3-dc1.storage.acme.se',
      'https://s3-dc1.storage.acme.se:10443',
      'https://rgw.ceph.acme.se',
      'http://10.30.10.25:8890/mcp',
    ];
    for (const value of notIdentities) expect(isDemoTarget(value), value).toBe(false);
    for (const server of getDemoServers()) {
      expect(isDemoTarget(server.host), server.host).toBe(false);
      expect(isDemoTarget(server.name), server.name).toBe(false);
    }
    for (const profile of getDemoS3Profiles()) {
      expect(isDemoTarget(profile.endpoint), profile.endpoint).toBe(false);
    }
    expect(isDemoTarget()).toBe(false);
  });
});

describe('isDemoTarget outside demo mode', () => {
  it('is false for everything, the demo fixtures included', () => {
    setDemoModeForTesting(false);
    for (const fixture of demoFixtures()) {
      expect(isDemoTarget(fixture.id), fixture.id).toBe(false);
      expect(isDemoTarget(fixture), fixture.id).toBe(false);
    }
    for (const server of getDemoServers()) {
      expect(isDemoTarget(`sftp-${server.id}`), server.id).toBe(false);
      expect(isDemoTarget(SESSION_CONFIG_ID, server.id), server.id).toBe(false);
      expect(isDemoTarget({ id: SESSION_CONFIG_ID, profileId: server.id }), server.id).toBe(false);
    }
    for (const profile of getDemoS3Profiles()) {
      expect(isDemoTarget(`s3-${profile.id}`), profile.id).toBe(false);
    }
    expect(isDemoTarget(realOntap, realBastion, realStorageGrid)).toBe(false);
  });
});
