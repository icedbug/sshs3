import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProfileStore } from '../../src/main/profile/ProfileStore';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

describe('ProfileStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-profiles-test-'));
    storePath = path.join(tempDir, 'subfolder', 'profiles.json');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('returns empty profiles when file does not exist', async () => {
    const store = new ProfileStore(storePath);
    const profiles = await store.getProfiles();
    expect(profiles).toEqual({ ssh: [], s3: [] });
  });

  it('saves and retrieves SSH profiles', async () => {
    const store = new ProfileStore(storePath);
    const sshConfig: SSHConnectionConfig = {
      id: 'ssh-1',
      name: 'Production Server',
      host: 'prod.example.com',
      port: 22,
      username: 'admin',
      authType: 'password',
      password: 'secret',
    };

    await store.saveSSH(sshConfig);
    const profiles = await store.getProfiles();
    expect(profiles.ssh).toHaveLength(1);
    expect(profiles.ssh[0]).toEqual({ ...sshConfig, updatedAt: expect.any(String) });

    // Verify persistence across new store instance
    const store2 = new ProfileStore(storePath);
    const profiles2 = await store2.getProfiles();
    expect(profiles2.ssh[0]).toEqual({ ...sshConfig, updatedAt: expect.any(String) });
  });

  it('updates an existing SSH profile with the same ID', async () => {
    const store = new ProfileStore(storePath);
    const sshConfig: SSHConnectionConfig = {
      id: 'ssh-1',
      name: 'Old Server',
      host: 'old.example.com',
      username: 'admin',
      authType: 'password',
    };
    await store.saveSSH(sshConfig);

    const updatedConfig: SSHConnectionConfig = {
      ...sshConfig,
      name: 'Updated Server',
      port: 2222,
    };
    await store.saveSSH(updatedConfig);

    const profiles = await store.getProfiles();
    expect(profiles.ssh).toHaveLength(1);
    expect(profiles.ssh[0].name).toBe('Updated Server');
    expect(profiles.ssh[0].port).toBe(2222);
  });

  it('deletes an SSH profile by ID', async () => {
    const store = new ProfileStore(storePath);
    await store.saveSSH({
      id: 'ssh-1',
      name: 'Server 1',
      host: 's1.example.com',
      username: 'root',
      authType: 'password',
    });
    await store.saveSSH({
      id: 'ssh-2',
      name: 'Server 2',
      host: 's2.example.com',
      username: 'root',
      authType: 'password',
    });

    await store.deleteSSH('ssh-1');
    const profiles = await store.getProfiles();
    expect(profiles.ssh).toHaveLength(1);
    expect(profiles.ssh[0].id).toBe('ssh-2');
  });

  it('deleting non-existent SSH profile does not fail', async () => {
    const store = new ProfileStore(storePath);
    await store.deleteSSH('non-existent');
    const profiles = await store.getProfiles();
    expect(profiles.ssh).toHaveLength(0);
  });

  it('saves and retrieves S3 profiles', async () => {
    const store = new ProfileStore(storePath);
    const s3Config: S3Config = {
      id: 's3-1',
      name: 'MinIO Backup',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'miniopass',
    };

    await store.saveS3(s3Config);
    const profiles = await store.getProfiles();
    expect(profiles.s3).toHaveLength(1);
    expect(profiles.s3[0]).toEqual({ ...s3Config, updatedAt: expect.any(String) });
  });

  it('updates an existing S3 profile with the same ID', async () => {
    const store = new ProfileStore(storePath);
    const s3Config: S3Config = {
      id: 's3-1',
      name: 'Original S3',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    };
    await store.saveS3(s3Config);

    const updatedConfig: S3Config = {
      ...s3Config,
      name: 'Updated S3',
      endpoint: 'https://s3.eu-central-1.amazonaws.com',
    };
    await store.saveS3(updatedConfig);

    const profiles = await store.getProfiles();
    expect(profiles.s3).toHaveLength(1);
    expect(profiles.s3[0].name).toBe('Updated S3');
    expect(profiles.s3[0].endpoint).toBe('https://s3.eu-central-1.amazonaws.com');
  });

  it('deletes an S3 profile by ID', async () => {
    const store = new ProfileStore(storePath);
    await store.saveS3({
      id: 's3-1',
      name: 'S3 1',
      region: 'us-east-1',
      accessKeyId: 'k1',
      secretAccessKey: 's1',
    });
    await store.deleteS3('s3-1');

    const profiles = await store.getProfiles();
    expect(profiles.s3).toHaveLength(0);
  });

  it('handles corrupted JSON file gracefully', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, '{ corrupted json: true !!!', 'utf-8');

    const store = new ProfileStore(storePath);
    const profiles = await store.getProfiles();
    expect(profiles).toEqual({ ssh: [], s3: [] });
  });

  it('throws error when saving configuration without ID', async () => {
    const store = new ProfileStore(storePath);
    await expect(
      store.saveSSH({
        id: '',
        name: 'Invalid',
        host: 'example.com',
        username: 'user',
        authType: 'password',
      })
    ).rejects.toThrow('Profile ID is required');

    await expect(
      store.saveS3({
        id: '',
        name: 'Invalid',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
      })
    ).rejects.toThrow('Profile ID is required');
  });

  it('serializes concurrent write mutations without race conditions', async () => {
    const store = new ProfileStore(storePath);
    // Fire multiple concurrent saves
    await Promise.all([
      store.saveSSH({ id: 'ssh-1', name: 'S1', host: 'h1', username: 'u', authType: 'password' }),
      store.saveSSH({ id: 'ssh-2', name: 'S2', host: 'h2', username: 'u', authType: 'password' }),
      store.saveS3({ id: 's3-1', name: 'S3-1', region: 'r1', accessKeyId: 'k1', secretAccessKey: 's1' }),
      store.saveS3({ id: 's3-2', name: 'S3-2', region: 'r2', accessKeyId: 'k2', secretAccessKey: 's2' }),
    ]);

    const profiles = await store.getProfiles();
    expect(profiles.ssh).toHaveLength(2);
    expect(profiles.s3).toHaveLength(2);
  });

  it('preserves initialPath for both SSH and S3 profiles', async () => {
    const store = new ProfileStore(storePath);
    await store.saveSSH({
      id: 'ssh-custom-path',
      name: 'Server with custom start dir',
      host: 'example.com',
      username: 'user',
      authType: 'password',
      initialPath: '/var/www/html',
    });

    await store.saveS3({
      id: 's3-custom-path',
      name: 'Bucket with prefix',
      region: 'eu-west-1',
      accessKeyId: 'key',
      secretAccessKey: 'sec',
      initialPath: 'my-bucket/backups/2026',
    });

    const profiles = await store.getProfiles();
    expect(profiles.ssh.find((p) => p.id === 'ssh-custom-path')?.initialPath).toBe('/var/www/html');
    expect(profiles.s3.find((p) => p.id === 's3-custom-path')?.initialPath).toBe('my-bucket/backups/2026');
  });

  it('saves, renames, and deletes folders while updating profile groups', async () => {
    const store = new ProfileStore(storePath);
    await store.saveFolder('Production');
    await store.saveFolder('Staging');

    let profiles = await store.getProfiles();
    expect(profiles.folders).toEqual(['Production', 'Staging']);

    await store.saveSSH({
      id: 'ssh-1',
      name: 'Prod DB',
      host: 'db.prod.com',
      username: 'root',
      authType: 'password',
      group: 'Production',
    });

    // Rename folder
    await store.renameFolder('Production', 'Prod-EU');
    profiles = await store.getProfiles();
    expect(profiles.folders).toEqual(['Prod-EU', 'Staging']);
    expect(profiles.ssh[0].group).toBe('Prod-EU');

    // Delete folder without deleting profile (ungroup)
    await store.deleteFolder('Prod-EU', false);
    profiles = await store.getProfiles();
    expect(profiles.folders).toEqual(['Staging']);
    expect(profiles.ssh[0].group).toBeUndefined();
  });

  describe('tags', () => {
    const ssh: SSHConnectionConfig = {
      id: 'ssh-1',
      name: 'Web',
      host: 'web.example.com',
      username: 'deploy',
      authType: 'password',
    };
    const s3: S3Config = {
      id: 's3-1',
      name: 'Assets',
      region: 'eu-north-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    };

    it('stores normalized tags on SSH profiles and keeps them across a reload', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH({ ...ssh, tags: ['#web', 'Prod', 'prod', 'bad tag'] });

      const reloaded = await new ProfileStore(storePath).getProfiles();
      expect(reloaded.ssh[0].tags).toEqual(['Prod', 'web']);
    });

    it('stores normalized tags on S3 profiles', async () => {
      const store = new ProfileStore(storePath);
      await store.saveS3({ ...s3, tags: ['b', 'A'] });

      const profiles = await store.getProfiles();
      expect(profiles.s3[0].tags).toEqual(['A', 'b']);
    });

    it('drops the field when no valid tag is left, so the stored record has no tags key', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH({ ...ssh, tags: ['', 5 as unknown as string] });
      await store.saveS3({ ...s3, tags: [] });

      const profiles = await store.getProfiles();
      expect('tags' in profiles.ssh[0]).toBe(false);
      expect('tags' in profiles.s3[0]).toBe(false);
    });

    it('ignores a tags value of the wrong type instead of persisting it', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH({ ...ssh, tags: 'prod' as unknown as string[] });

      const profiles = await store.getProfiles();
      expect('tags' in profiles.ssh[0]).toBe(false);
    });

    it('leaves profiles without tags untouched', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH(ssh);

      const profiles = await store.getProfiles();
      expect(profiles.ssh[0]).toEqual({ ...ssh, updatedAt: expect.any(String) });
    });
  });

  describe('system', () => {
    const ssh: SSHConnectionConfig = {
      id: 'ssh-1',
      name: 'Web',
      host: 'web.example.com',
      username: 'deploy',
      authType: 'password',
      tunnels: [
        { id: 't1', name: 'db', type: 'local', localPort: 5432, remoteHost: 'localhost', remotePort: 5432 },
        { id: 't2', name: 'cache', type: 'local', localPort: 6379, remoteHost: 'localhost', remotePort: 6379 },
      ],
    };

    it('stores a cleaned system membership and keeps it across a reload', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH({ ...ssh, system: { name: '  shop  ', startDirectory: ' /srv ', tunnelIds: ['t2', 'gone', 't2'] } });

      const reloaded = await new ProfileStore(storePath).getProfiles();
      expect(reloaded.ssh[0].system).toEqual({ name: 'shop', startDirectory: '/srv', tunnelIds: ['t2'] });
    });

    it('drops a membership that has no usable name', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH({ ...ssh, system: { name: '   ' } });
      await store.saveSSH({ ...ssh, id: 'ssh-2', system: 'shop' as never });

      const profiles = await store.getProfiles();
      expect(profiles.ssh.every((p) => !('system' in p))).toBe(true);
    });

    it('forgets a tunnel that was removed from the profile the next time it is saved', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH({ ...ssh, system: { name: 'shop', tunnelIds: ['t1', 't2'] } });

      const [saved] = (await store.getProfiles()).ssh;
      await store.saveSSH({ ...saved, tunnels: [saved.tunnels![0]] });

      expect((await store.getProfiles()).ssh[0].system).toEqual({ name: 'shop', tunnelIds: ['t1'] });
    });

    it('leaves profiles without a system untouched', async () => {
      const store = new ProfileStore(storePath);
      await store.saveSSH(ssh);
      const [saved] = (await store.getProfiles()).ssh;
      expect('system' in saved).toBe(false);
    });
  });
});
