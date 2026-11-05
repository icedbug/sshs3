import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { TEAM_VAULT_PENDING_VAULT_ID } from '../../src/shared/types/teamVault';

const { mockReadSmartcardCertificates } = vi.hoisted(() => ({ mockReadSmartcardCertificates: vi.fn() }));
vi.mock('../../src/main/smartcard/SmartcardCertificateReader', () => ({
  readSmartcardCertificates: mockReadSmartcardCertificates,
}));

const { mockTestS3ConnectionConfig } = vi.hoisted(() => ({ mockTestS3ConnectionConfig: vi.fn() }));
vi.mock('../../src/main/ipc/connectionTestHandlers', () => ({
  testS3ConnectionConfig: mockTestS3ConnectionConfig,
}));

import { registerTeamVaultHandlers, type TeamVaultHost } from '../../src/main/ipc/teamVaultHandlers';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const VAULT_ID = 'vlt_test-vault';

describe('Team Vault IPC handlers', () => {
  const handlers = new Map<string, Handler>();
  const teamVaultService = {
    getStatus: vi.fn(),
    listVaultIds: vi.fn(),
    listStatuses: vi.fn(),
    enrollOwnPivRecipient: vi.fn(),
    createVault: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    setRole: vi.fn(),
    renameVault: vi.fn(),
    setDescription: vi.fn(),
    buildInvite: vi.fn(),
    decodeInvite: vi.fn(),
    unlock: vi.fn(),
    unlockWithRecoveryText: vi.fn(),
    lock: vi.fn(),
    deleteVault: vi.fn(),
    forgetLocalVault: vi.fn(),
    resetRemoteState: vi.fn(),
    pushToRemote: vi.fn(),
    pullFromRemote: vi.fn(),
    hasRemoteVault: vi.fn(),
    getSyncPreview: vi.fn(),
    isUnlocked: vi.fn().mockReturnValue(false),
    getPayload: vi.fn(),
    getPayloadForRenderer: vi.fn(),
    saveSSHProfile: vi.fn(),
    deleteSSHProfile: vi.fn(),
    saveS3Profile: vi.fn(),
    deleteS3Profile: vi.fn(),
    saveK8sProfile: vi.fn(),
    deleteK8sProfile: vi.fn(),
    saveTeamFolder: vi.fn(),
    renameTeamFolder: vi.fn(),
    deleteTeamFolder: vi.fn(),
    setTeamFolderIcon: vi.fn(),
  };
  const startTeamVaultAutoPollTimer = vi.fn();
  const stopTeamVaultAutoPollTimer = vi.fn();
  const scheduleTeamVaultAutoPush = vi.fn();
  const teamVaultConfigStore = {
    getConfig: vi.fn().mockResolvedValue({}),
    getAllConfigs: vi.fn().mockResolvedValue({}),
    setTarget: vi.fn(),
    setLastSyncAt: vi.fn(),
    setSelfIdentity: vi.fn(),
    clearSelfIdentity: vi.fn(),
    clear: vi.fn(),
    promotePendingConfig: vi.fn(),
  };
  const syncConfigStore = {
    getConfig: vi.fn().mockResolvedValue({}),
  };
  const storageRegistry = {
    getOrCreate: vi.fn().mockResolvedValue({}),
    disconnect: vi.fn(),
  };
  const buildTeamVaultStatus = vi.fn().mockResolvedValue({ exists: false, unlocked: false, filePath: '/x' });
  const buildAllTeamVaultStatuses = vi.fn().mockResolvedValue([]);

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    teamVaultService.getStatus.mockResolvedValue({ exists: false, unlocked: false, filePath: '/x' });
    teamVaultConfigStore.getConfig.mockResolvedValue({});
    teamVaultConfigStore.getAllConfigs.mockResolvedValue({});
    syncConfigStore.getConfig.mockResolvedValue({});
    mockReadSmartcardCertificates.mockResolvedValue(new Map());
    mockTestS3ConnectionConfig.mockResolvedValue({ success: true });
    storageRegistry.getOrCreate.mockResolvedValue({});
    buildTeamVaultStatus.mockResolvedValue({ exists: false, unlocked: false, filePath: '/x' });
    buildAllTeamVaultStatuses.mockResolvedValue([]);
    registerTeamVaultHandlers({
      registerHandler: (channel: string, h: Handler) => void handlers.set(channel, h),
      teamVaultService,
      teamVaultConfigStore,
      syncConfigStore,
      storageRegistry,
      buildTeamVaultStatus,
      buildAllTeamVaultStatuses,
      startTeamVaultAutoPollTimer,
      stopTeamVaultAutoPollTimer,
      scheduleTeamVaultAutoPush,
    } as unknown as TeamVaultHost);
  });

  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

  const VALID_RECIPIENT = `age1${'a'.repeat(30)}`;

  describe('requireVaultId', () => {
    it('rejects an invalid vaultId shape on an arbitrary channel', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_GET_STATUS, 'not valid! shape')).rejects.toThrow(
        'A valid vaultId is required'
      );
    });

    it('rejects a missing vaultId', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_LOCK)).rejects.toThrow('A valid vaultId is required');
    });
  });

  describe('TEAM_VAULT_CREATE', () => {
    it('rejects a flag-like age recipient (argument-injection guard)', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice', '-o/etc/passwd')).rejects.toThrow(
        'Age recipient must be a valid age recipient string'
      );
      expect(teamVaultService.createVault).not.toHaveBeenCalled();
    });

    it('rejects a missing recipient id', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_CREATE, '  ', VALID_RECIPIENT)).rejects.toThrow(
        'Recipient id is required'
      );
    });

    it('accepts a well-formed call — no leading vaultId (createVault mints one itself)', async () => {
      teamVaultService.createVault.mockResolvedValue({ vaultId: VAULT_ID, recoveryIdentity: 'AGE-SECRET-KEY-X' });
      await call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice@piv:abc', VALID_RECIPIENT, 'Acme Team');
      expect(teamVaultService.createVault).toHaveBeenCalledWith('alice@piv:abc', VALID_RECIPIENT, 'Acme Team');
    });

    it('rejects an overlong vault name', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice@piv:abc', VALID_RECIPIENT, 'x'.repeat(201))
      ).rejects.toThrow('Vault name must be a string of at most 200 characters');
    });

    it('rejects a vault name containing a header-MAC canonicalization delimiter (\\u0001/\\u0002/\\u0003) — crafting one could otherwise let a bucket-write-access attacker reinterpret the vaultName/vaultDescription field boundary under a stale but still-valid MAC', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice@piv:abc', VALID_RECIPIENT, 'Acme\u0002Team')
      ).rejects.toThrow('Vault name must be a string of at most 200 characters');
      expect(teamVaultService.createVault).not.toHaveBeenCalled();
    });

    it('rejects a recipient id containing a header-MAC canonicalization delimiter', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice\u0001@piv:abc', VALID_RECIPIENT)
      ).rejects.toThrow('Recipient id is required');
      expect(teamVaultService.createVault).not.toHaveBeenCalled();
    });

    it('starts the background auto-poll for the minted vaultId once creation succeeds', async () => {
      teamVaultService.createVault.mockResolvedValue({ vaultId: VAULT_ID, recoveryIdentity: 'AGE-SECRET-KEY-X' });
      await call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice@piv:abc', VALID_RECIPIENT);
      expect(startTeamVaultAutoPollTimer).toHaveBeenCalledWith(VAULT_ID);
    });

    it('remembers the chosen recipient id for unlock-form prefill under the minted vaultId, once creation succeeds', async () => {
      teamVaultService.createVault.mockResolvedValue({ vaultId: VAULT_ID, recoveryIdentity: 'AGE-SECRET-KEY-X' });
      await call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice@piv:abc', VALID_RECIPIENT);
      expect(teamVaultConfigStore.setSelfIdentity).toHaveBeenCalledWith(VAULT_ID, 'alice@piv:abc', undefined);
    });

    it('also remembers the identity file path from the preceding enroll call, so the one-click unlock shortcut is available immediately — not just the recipient id', async () => {
      teamVaultService.createVault.mockResolvedValue({ vaultId: VAULT_ID, recoveryIdentity: 'AGE-SECRET-KEY-X' });
      await call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice@piv:abc', VALID_RECIPIENT, 'Acme Team', '/tmp/x');
      expect(teamVaultConfigStore.setSelfIdentity).toHaveBeenCalledWith(VAULT_ID, 'alice@piv:abc', '/tmp/x');
    });

    it('rejects a flag-like identity file path (argument-injection guard)', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_CREATE, 'alice@piv:abc', VALID_RECIPIENT, 'Acme Team', '-o/etc/passwd')
      ).rejects.toThrow('Identity file path must be an absolute path');
      expect(teamVaultService.createVault).not.toHaveBeenCalled();
    });
  });

  describe('TEAM_VAULT_LIST', () => {
    it('delegates to buildAllTeamVaultStatuses', async () => {
      buildAllTeamVaultStatuses.mockResolvedValue([{ exists: true, unlocked: false, filePath: '/x', vaultId: VAULT_ID }]);
      const result = await call(IPC_CHANNELS.TEAM_VAULT_LIST);
      expect(buildAllTeamVaultStatuses).toHaveBeenCalled();
      expect(result).toEqual([{ exists: true, unlocked: false, filePath: '/x', vaultId: VAULT_ID }]);
    });
  });

  describe('TEAM_VAULT_ENROLL_RECIPIENT', () => {
    it('has no leading vaultId requirement — vaultId is unknown before a vault is created/joined', async () => {
      teamVaultService.enrollOwnPivRecipient.mockResolvedValue({
        recipient: VALID_RECIPIENT,
        identityFilePath: '/tmp/x',
      });
      await expect(call(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT)).resolves.toMatchObject({
        recipient: VALID_RECIPIENT,
      });
      expect(teamVaultService.enrollOwnPivRecipient).toHaveBeenCalledWith(undefined);
    });

    it('remembers the generated identity file path for unlock-form prefill when a vaultId is given and no local vault exists yet', async () => {
      teamVaultService.getStatus.mockResolvedValue({ exists: false, unlocked: false, filePath: '/x' });
      teamVaultService.enrollOwnPivRecipient.mockResolvedValue({
        recipient: VALID_RECIPIENT,
        identityFilePath: '/home/alice/.config/sshs3/team-vault-identities/abc.txt',
      });
      await call(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT, VAULT_ID);
      expect(teamVaultConfigStore.setSelfIdentity).toHaveBeenCalledWith(
        VAULT_ID,
        undefined,
        '/home/alice/.config/sshs3/team-vault-identities/abc.txt'
      );
    });

    it("never overwrites the remembered identity for an EXISTING vault — \"Generate my recipient\" is now always visible (for a future second team), and must not clobber what unlock() needs for the current one", async () => {
      // Regression found via real-world use: generating an extra recipient while a vault already
      // exists silently overwrote the identity file unlock() needed for that existing vault,
      // producing "no identity matched any of the recipients" on the next unlock attempt.
      teamVaultService.getStatus.mockResolvedValue({ exists: true, unlocked: true, filePath: '/x' });
      teamVaultService.enrollOwnPivRecipient.mockResolvedValue({
        recipient: VALID_RECIPIENT,
        identityFilePath: '/tmp/a-fresh-identity-for-some-other-team.txt',
      });

      await call(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT, VAULT_ID);
      expect(teamVaultConfigStore.setSelfIdentity).not.toHaveBeenCalled();
    });

    it('suggests the UPN from the auth-capable smartcard certificate as a default label', async () => {
      teamVaultService.enrollOwnPivRecipient.mockResolvedValue({
        recipient: VALID_RECIPIENT,
        identityFilePath: '/tmp/identity.txt',
      });
      syncConfigStore.getConfig.mockResolvedValue({ smartcardSync: { pkcs11LibPath: '/usr/lib/opensc-pkcs11.so' } });
      mockReadSmartcardCertificates.mockResolvedValue(
        new Map([
          ['fp1', { authCapable: false, upn: 'not-this-one@example.com' }],
          ['fp2', { authCapable: true, upn: 'alice@example.com' }],
        ])
      );

      const result = await call(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT);
      expect(mockReadSmartcardCertificates).toHaveBeenCalledWith('/usr/lib/opensc-pkcs11.so');
      expect(result).toMatchObject({ suggestedLabel: 'alice@example.com' });
    });

    it('never blocks enroll when no pkcs11 path is configured', async () => {
      teamVaultService.enrollOwnPivRecipient.mockResolvedValue({ recipient: VALID_RECIPIENT, identityFilePath: '/tmp/x' });
      syncConfigStore.getConfig.mockResolvedValue({});

      const result = await call(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT);
      expect(mockReadSmartcardCertificates).not.toHaveBeenCalled();
      expect((result as any).suggestedLabel).toBeUndefined();
    });

    it('never blocks enroll when cert reading fails (best-effort only)', async () => {
      teamVaultService.enrollOwnPivRecipient.mockResolvedValue({ recipient: VALID_RECIPIENT, identityFilePath: '/tmp/x' });
      syncConfigStore.getConfig.mockResolvedValue({ smartcardSync: { pkcs11LibPath: '/bad/path.so' } });
      mockReadSmartcardCertificates.mockRejectedValue(new Error('no card reader found'));

      const result = await call(IPC_CHANNELS.TEAM_VAULT_ENROLL_RECIPIENT);
      expect((result as any).recipient).toBe(VALID_RECIPIENT);
      expect((result as any).suggestedLabel).toBeUndefined();
    });
  });

  describe('TEAM_VAULT_DELETE', () => {
    it('deletes the vault and forgets the remembered self-identity', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_DELETE, VAULT_ID);
      expect(teamVaultService.deleteVault).toHaveBeenCalledWith(VAULT_ID);
      expect(teamVaultConfigStore.clearSelfIdentity).toHaveBeenCalledWith(VAULT_ID);
    });

    it('stops the background auto-poll for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_DELETE, VAULT_ID);
      expect(stopTeamVaultAutoPollTimer).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_FORGET', () => {
    it('removes the local file/identity and clears the config entry for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_FORGET, VAULT_ID);
      expect(teamVaultService.forgetLocalVault).toHaveBeenCalledWith(VAULT_ID);
      expect(teamVaultConfigStore.clear).toHaveBeenCalledWith(VAULT_ID);
      expect(stopTeamVaultAutoPollTimer).toHaveBeenCalledWith(VAULT_ID);
    });

    it('propagates the service refusal when the vault is still unlocked', async () => {
      teamVaultService.forgetLocalVault.mockRejectedValue(new Error('Lock this Team Vault before forgetting it'));
      await expect(call(IPC_CHANNELS.TEAM_VAULT_FORGET, VAULT_ID)).rejects.toThrow('Lock this Team Vault');
      expect(teamVaultConfigStore.clear).not.toHaveBeenCalled();
    });
  });

  describe('TEAM_VAULT_ADD_MEMBER', () => {
    it('rejects an invalid role', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_ADD_MEMBER, VAULT_ID, 'bob', VALID_RECIPIENT, 'superadmin')
      ).rejects.toThrow('Invalid role');
    });

    it('rejects a non-age-shaped recipient string', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_ADD_MEMBER, VAULT_ID, 'bob', 'not-a-recipient', 'member')
      ).rejects.toThrow('must be a valid age recipient string');
    });

    it('never accepts an addedBy argument — attribution comes only from the unlocked session', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_ADD_MEMBER, VAULT_ID, 'bob', VALID_RECIPIENT, 'member');
      expect(teamVaultService.addMember).toHaveBeenCalledWith(VAULT_ID, 'bob', VALID_RECIPIENT, 'member');
    });
  });

  describe('TEAM_VAULT_UNLOCK', () => {
    it('rejects a relative identity file path', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_UNLOCK, VAULT_ID, 'alice', 'identity.txt')).rejects.toThrow(
        'must be an absolute path'
      );
    });

    it('rejects a flag-like identity file path', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_UNLOCK, VAULT_ID, 'alice', '--output=/etc/passwd')
      ).rejects.toThrow('must be an absolute path');
    });

    it('accepts a well-formed absolute path', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_UNLOCK, VAULT_ID, 'alice', '/tmp/identity.txt');
      expect(teamVaultService.unlock).toHaveBeenCalledWith(VAULT_ID, 'alice', '/tmp/identity.txt');
    });

    it('remembers both the recipient id and identity file path for next time, once unlock succeeds', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_UNLOCK, VAULT_ID, 'alice', '/tmp/identity.txt');
      expect(teamVaultConfigStore.setSelfIdentity).toHaveBeenCalledWith(VAULT_ID, 'alice', '/tmp/identity.txt');
    });

    it('starts the background auto-poll for that vaultId once unlock succeeds', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_UNLOCK, VAULT_ID, 'alice', '/tmp/identity.txt');
      expect(startTeamVaultAutoPollTimer).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_UNLOCK_WITH_RECOVERY_TEXT', () => {
    it('rejects empty text', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_UNLOCK_WITH_RECOVERY_TEXT, VAULT_ID, '   ')).rejects.toThrow(
        'Recovery key text is required'
      );
      expect(teamVaultService.unlockWithRecoveryText).not.toHaveBeenCalled();
    });

    it('forwards the text and starts the background auto-poll once it succeeds', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_UNLOCK_WITH_RECOVERY_TEXT, VAULT_ID, 'AGE-SECRET-KEY-1FAKE');
      expect(teamVaultService.unlockWithRecoveryText).toHaveBeenCalledWith(VAULT_ID, 'AGE-SECRET-KEY-1FAKE');
      expect(startTeamVaultAutoPollTimer).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_SET_ROLE', () => {
    it('rejects an invalid role', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SET_ROLE, VAULT_ID, 'bob', 'owner')).rejects.toThrow('Invalid role');
    });

    it('never accepts an updatedBy argument — attribution comes only from the unlocked session', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SET_ROLE, VAULT_ID, 'bob', 'admin');
      expect(teamVaultService.setRole).toHaveBeenCalledWith(VAULT_ID, 'bob', 'admin');
    });
  });

  describe('TEAM_VAULT_RENAME', () => {
    it('rejects an overlong vault name', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_RENAME, VAULT_ID, 'x'.repeat(201))).rejects.toThrow(
        'Vault name must be a string of at most 200 characters'
      );
    });

    it('renames and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_RENAME, VAULT_ID, 'Acme Team');
      expect(teamVaultService.renameVault).toHaveBeenCalledWith(VAULT_ID, 'Acme Team');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_REMOVE_MEMBER', () => {
    it('never accepts a removedBy argument — attribution comes only from the unlocked session', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_REMOVE_MEMBER, VAULT_ID, 'bob');
      expect(teamVaultService.removeMember).toHaveBeenCalledWith(VAULT_ID, 'bob');
    });
  });

  describe('TEAM_VAULT_SET_DESCRIPTION', () => {
    it('rejects an overlong description', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SET_DESCRIPTION, VAULT_ID, 'x'.repeat(501))).rejects.toThrow(
        'Vault description must be a string of at most 500 characters'
      );
      expect(teamVaultService.setDescription).not.toHaveBeenCalled();
    });

    it('rejects a description containing a header-MAC canonicalization delimiter', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_SET_DESCRIPTION, VAULT_ID, 'Internal infra\u0003team')
      ).rejects.toThrow('Vault description must be a string of at most 500 characters');
      expect(teamVaultService.setDescription).not.toHaveBeenCalled();
    });

    it('rejects an invalid vaultId before ever calling the service (admin-gating happens inside TeamVaultService itself)', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SET_DESCRIPTION, '../../etc/passwd', 'x')).rejects.toThrow(
        'A valid vaultId is required'
      );
      expect(teamVaultService.setDescription).not.toHaveBeenCalled();
    });

    it('delegates to the service and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SET_DESCRIPTION, VAULT_ID, 'Acme Infra team');
      expect(teamVaultService.setDescription).toHaveBeenCalledWith(VAULT_ID, 'Acme Infra team');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_BUILD_INVITE', () => {
    it('requires a valid vaultId and recipientId before calling the service', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_BUILD_INVITE, '../x', 'bob')).rejects.toThrow(
        'A valid vaultId is required'
      );
      await expect(call(IPC_CHANNELS.TEAM_VAULT_BUILD_INVITE, VAULT_ID, '')).rejects.toThrow('Recipient id is required');
      expect(teamVaultService.buildInvite).not.toHaveBeenCalled();
    });

    it('delegates to the service and returns its result — admin-gating is TeamVaultService.buildInvite\'s job, not this handler\'s', async () => {
      teamVaultService.buildInvite.mockResolvedValue('sshs3 Team Vault invite for bob\narmored-blob');
      const result = await call(IPC_CHANNELS.TEAM_VAULT_BUILD_INVITE, VAULT_ID, 'bob');
      expect(teamVaultService.buildInvite).toHaveBeenCalledWith(VAULT_ID, 'bob');
      expect(result).toBe('sshs3 Team Vault invite for bob\narmored-blob');
    });

    it('propagates the service\'s admin-gating rejection as-is', async () => {
      teamVaultService.buildInvite.mockRejectedValue(new Error('Only a Team Vault admin can do this'));
      await expect(call(IPC_CHANNELS.TEAM_VAULT_BUILD_INVITE, VAULT_ID, 'bob')).rejects.toThrow(
        'Only a Team Vault admin can do this'
      );
    });
  });

  describe('TEAM_VAULT_DECODE_INVITE', () => {
    it('is not vaultId-led — rejects a missing/empty invite text and a non-absolute identity path', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_DECODE_INVITE, '', '/tmp/identity.txt')).rejects.toThrow(
        'A valid invite is required'
      );
      await expect(call(IPC_CHANNELS.TEAM_VAULT_DECODE_INVITE, 'invite text', 'relative/path.txt')).rejects.toThrow(
        'Identity file path must be an absolute path'
      );
      expect(teamVaultService.decodeInvite).not.toHaveBeenCalled();
    });

    it('rejects an oversized invite text before ever calling the service', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_DECODE_INVITE, 'x'.repeat(65 * 1024 + 1), '/tmp/identity.txt')
      ).rejects.toThrow('A valid invite is required');
      expect(teamVaultService.decodeInvite).not.toHaveBeenCalled();
    });

    it('delegates to the service and returns its decoded result', async () => {
      const decoded = { vaultId: VAULT_ID, target: { id: 't', name: 'n', type: 's3' }, remoteBasePath: 'bucket' };
      teamVaultService.decodeInvite.mockResolvedValue(decoded);
      const result = await call(IPC_CHANNELS.TEAM_VAULT_DECODE_INVITE, 'invite text', '/tmp/identity.txt');
      expect(teamVaultService.decodeInvite).toHaveBeenCalledWith('invite text', '/tmp/identity.txt');
      expect(result).toEqual(decoded);
    });
  });

  describe('TEAM_VAULT_GET_STATUS / TEAM_VAULT_LOCK', () => {
    it('delegate straight through with the vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_GET_STATUS, VAULT_ID);
      expect(buildTeamVaultStatus).toHaveBeenCalledWith(VAULT_ID);
      await call(IPC_CHANNELS.TEAM_VAULT_LOCK, VAULT_ID);
      expect(teamVaultService.lock).toHaveBeenCalledWith(VAULT_ID);
    });

    it('stops the background auto-poll for that vaultId on lock', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_LOCK, VAULT_ID);
      expect(stopTeamVaultAutoPollTimer).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_SET_TARGET', () => {
    const s3Target = { id: 't1', name: 'Team bucket', type: 's3' as const };

    it('rejects a non-S3 target', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, { id: 't1', name: 'x', type: 'sftp' }, 'bucket')
      ).rejects.toThrow('only supports an S3-compatible target');
    });

    it('rejects a missing bucket/remoteBasePath', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, s3Target, '')).rejects.toThrow(
        'requires a bucket'
      );
    });

    it('persists the target under that vaultId and resets the remote-state cache', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, s3Target, 'team-bucket');
      expect(teamVaultConfigStore.setTarget).toHaveBeenCalledWith(VAULT_ID, s3Target, 'team-bucket');
      expect(teamVaultService.resetRemoteState).toHaveBeenCalledWith(VAULT_ID);
    });

    it('keeps the remembered remote state when the same location is saved again with other credentials, and drops it when the location changes', async () => {
      const saved = { id: 't1', name: 'Team bucket', type: 's3' as const, s3Config: { id: 't1', name: 'n', region: 'eu-north-1', accessKeyId: 'old', secretAccessKey: 'old' } }; // pragma: allowlist secret
      teamVaultConfigStore.getConfig.mockResolvedValue({ target: saved, remoteBasePath: 'team-bucket' });
      const rotated = { ...saved, s3Config: { ...saved.s3Config, accessKeyId: 'new', secretAccessKey: 'new' } }; // pragma: allowlist secret
      teamVaultService.resetRemoteState.mockClear();

      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, rotated, 'team-bucket/');
      expect(teamVaultService.resetRemoteState).not.toHaveBeenCalled();

      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, rotated, 'another-bucket');
      expect(teamVaultService.resetRemoteState).toHaveBeenCalledWith(VAULT_ID);
      teamVaultConfigStore.getConfig.mockResolvedValue({});
    });

    it('restarts the auto-poll for that vaultId when the vault is already unlocked', async () => {
      teamVaultService.isUnlocked.mockReturnValue(true);
      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, s3Target, 'team-bucket');
      expect(startTeamVaultAutoPollTimer).toHaveBeenCalledWith(VAULT_ID);
    });

    it('does not start the auto-poll when the vault is locked', async () => {
      teamVaultService.isUnlocked.mockReturnValue(false);
      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, s3Target, 'team-bucket');
      expect(startTeamVaultAutoPollTimer).not.toHaveBeenCalled();
    });

    it('also accepts the pending sentinel vaultId (first-time join before the real vaultId is known)', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, TEAM_VAULT_PENDING_VAULT_ID, s3Target, 'team-bucket');
      expect(teamVaultConfigStore.setTarget).toHaveBeenCalledWith(TEAM_VAULT_PENDING_VAULT_ID, s3Target, 'team-bucket');
    });

    it('preserves the existing secret when the same target is re-saved with a blank one (accidental-clobber guard)', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({
        target: { id: 't1', name: 'Team bucket', type: 's3', s3Config: { region: 'eu-north-1', secretAccessKey: 'real-secret' } }, // pragma: allowlist secret
      });
      const resubmitted = { id: 't1', name: 'Team bucket', type: 's3' as const, s3Config: { region: 'eu-north-1', secretAccessKey: '' } };

      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, resubmitted, 'team-bucket');

      expect(teamVaultConfigStore.setTarget).toHaveBeenCalledWith(
        VAULT_ID,
        expect.objectContaining({ s3Config: expect.objectContaining({ secretAccessKey: 'real-secret' }) }), // pragma: allowlist secret
        'team-bucket'
      );
    });

    it('does not borrow a secret from a DIFFERENT target id (switching providers with a blank secret stays blank)', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({
        target: { id: 'old-target', name: 'Old', type: 's3', s3Config: { region: 'eu-north-1', secretAccessKey: 'real-secret' } }, // pragma: allowlist secret
      });
      const newTarget = { id: 'new-target', name: 'New', type: 's3' as const, s3Config: { region: 'eu-north-1', secretAccessKey: '' } };

      await call(IPC_CHANNELS.TEAM_VAULT_SET_TARGET, VAULT_ID, newTarget, 'team-bucket');

      expect(teamVaultConfigStore.setTarget).toHaveBeenCalledWith(
        VAULT_ID,
        expect.objectContaining({ s3Config: expect.objectContaining({ secretAccessKey: '' }) }),
        'team-bucket'
      );
    });
  });

  describe('TEAM_VAULT_TEST_TARGET', () => {
    it('passes the submitted config through untouched when a secret is present', async () => {
      const config = { region: 'eu-north-1', accessKeyId: 'ak', secretAccessKey: 'typed-secret' }; // pragma: allowlist secret
      await call(IPC_CHANNELS.TEAM_VAULT_TEST_TARGET, VAULT_ID, config);
      expect(mockTestS3ConnectionConfig).toHaveBeenCalledWith(config);
    });

    it('borrows the saved secret when the submitted config has a blank one (matches the redacted-form design)', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({
        target: { id: 't1', name: 'Team bucket', type: 's3', s3Config: { region: 'eu-north-1', secretAccessKey: 'real-secret' } }, // pragma: allowlist secret
      });
      const config = { region: 'eu-north-1', accessKeyId: 'ak', secretAccessKey: '' };

      await call(IPC_CHANNELS.TEAM_VAULT_TEST_TARGET, VAULT_ID, config);

      expect(mockTestS3ConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({ secretAccessKey: 'real-secret' }) // pragma: allowlist secret
      );
    });

    it('leaves the secret blank when there is no saved S3 target to borrow from', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({ target: undefined });
      const config = { region: 'eu-north-1', accessKeyId: 'ak', secretAccessKey: '' };

      await call(IPC_CHANNELS.TEAM_VAULT_TEST_TARGET, VAULT_ID, config);

      expect(mockTestS3ConnectionConfig).toHaveBeenCalledWith(expect.objectContaining({ secretAccessKey: '' }));
    });

    it('returns whatever testS3ConnectionConfig reports', async () => {
      mockTestS3ConnectionConfig.mockResolvedValue({ success: false, error: 'boom' });
      const result = await call(IPC_CHANNELS.TEAM_VAULT_TEST_TARGET, VAULT_ID, {
        region: 'eu-north-1',
        accessKeyId: 'ak',
        secretAccessKey: 'x',
      });
      expect(result).toEqual({ success: false, error: 'boom' });
    });
  });

  describe('TEAM_VAULT_GET_PAYLOAD / SAVE / DELETE (shared SSH & S3 profiles)', () => {
    it('returns null without calling the service when the vault is locked', async () => {
      teamVaultService.isUnlocked.mockReturnValue(false);
      await expect(call(IPC_CHANNELS.TEAM_VAULT_GET_PAYLOAD, VAULT_ID)).resolves.toBeNull();
      expect(teamVaultService.getPayloadForRenderer).not.toHaveBeenCalled();
    });

    it('returns the (renderer-redacted) payload when unlocked', async () => {
      teamVaultService.isUnlocked.mockReturnValue(true);
      const payload = { ssh: [], s3: [] };
      teamVaultService.getPayloadForRenderer.mockResolvedValue(payload);
      await expect(call(IPC_CHANNELS.TEAM_VAULT_GET_PAYLOAD, VAULT_ID)).resolves.toBe(payload);
      expect(teamVaultService.getPayloadForRenderer).toHaveBeenCalledWith(VAULT_ID);
    });

    it('returns null (rather than throwing) if getPayloadForRenderer itself fails unexpectedly', async () => {
      teamVaultService.isUnlocked.mockReturnValue(true);
      teamVaultService.getPayloadForRenderer.mockRejectedValue(new Error('boom'));
      await expect(call(IPC_CHANNELS.TEAM_VAULT_GET_PAYLOAD, VAULT_ID)).resolves.toBeNull();
    });

    it('rejects an SSH profile with no id', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, { name: 'x' })).rejects.toThrow(
        'SSH profile is required'
      );
      expect(teamVaultService.saveSSHProfile).not.toHaveBeenCalled();
    });

    it('saves a well-formed SSH profile and schedules an auto-push for that vaultId', async () => {
      const profile = { id: 'p1', name: 'x', host: 'h', username: 'u', authType: 'password' };
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, profile);
      expect(teamVaultService.saveSSHProfile).toHaveBeenCalledWith(VAULT_ID, profile);
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('normalizes the tags of a saved SSH profile and leaves the rest of it untouched', async () => {
      const profile = { id: 'p1', name: 'x', host: 'h', username: 'u', authType: 'password', tags: ['#web', 'Prod', 'prod'] };
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, profile);
      expect(teamVaultService.saveSSHProfile).toHaveBeenCalledWith(VAULT_ID, { ...profile, tags: ['Prod', 'web'] });
    });

    it('does not persist an invalid tags value on a saved SSH profile', async () => {
      const profile = { id: 'p1', name: 'x', host: 'h', username: 'u', authType: 'password', tags: 'prod' };
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, profile);
      const saved = teamVaultService.saveSSHProfile.mock.calls[0][1];
      expect(saved.tags).toBeUndefined();
    });

    it('cleans the system membership of a saved SSH profile against its own tunnels', async () => {
      const profile = {
        id: 'p1',
        name: 'x',
        host: 'h',
        username: 'u',
        authType: 'password',
        tunnels: [{ id: 't1', name: 'db', type: 'local', localPort: 1, remoteHost: 'h', remotePort: 2 }],
        system: { name: ' shop ', tunnelIds: ['t1', 'gone'], password: 'x' }, // pragma: allowlist secret
      };
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, profile);
      const saved = teamVaultService.saveSSHProfile.mock.calls[0][1];
      expect(saved.system).toEqual({ name: 'shop', tunnelIds: ['t1'] });
    });

    it('does not persist an invalid system value on a saved SSH profile', async () => {
      const profile = { id: 'p1', name: 'x', host: 'h', username: 'u', authType: 'password', system: 'shop' };
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, profile);
      expect('system' in teamVaultService.saveSSHProfile.mock.calls[0][1]).toBe(false);
    });

    it('rejects an SSH profile whose serialized size exceeds the cap', async () => {
      const profile = { id: 'p1', name: 'x', host: 'h', username: 'u', authType: 'password', group: 'x'.repeat(300_000) };
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, profile)).rejects.toThrow('is too large');
      expect(teamVaultService.saveSSHProfile).not.toHaveBeenCalled();
    });

    it('does not schedule an auto-push when the save itself is rejected', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_SSH_PROFILE, VAULT_ID, { name: 'x' })).rejects.toThrow();
      expect(scheduleTeamVaultAutoPush).not.toHaveBeenCalled();
    });

    it('deletes an SSH profile by id and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_DELETE_SSH_PROFILE, VAULT_ID, 'p1');
      expect(teamVaultService.deleteSSHProfile).toHaveBeenCalledWith(VAULT_ID, 'p1');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('rejects an S3 profile with no id', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_S3_PROFILE, VAULT_ID, { name: 'x' })).rejects.toThrow(
        'S3 profile is required'
      );
      expect(teamVaultService.saveS3Profile).not.toHaveBeenCalled();
    });

    it('saves a well-formed S3 profile and schedules an auto-push for that vaultId', async () => {
      const profile = { id: 'p1', name: 'x', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b' };
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_S3_PROFILE, VAULT_ID, profile);
      expect(teamVaultService.saveS3Profile).toHaveBeenCalledWith(VAULT_ID, profile);
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('normalizes the tags of a saved S3 profile', async () => {
      const profile = { id: 'p1', name: 'x', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b', tags: ['b', 'A'] };
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_S3_PROFILE, VAULT_ID, profile);
      expect(teamVaultService.saveS3Profile).toHaveBeenCalledWith(VAULT_ID, { ...profile, tags: ['A', 'b'] });
    });

    it('rejects an S3 profile whose serialized size exceeds the cap', async () => {
      const profile = { id: 'p1', name: 'x', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b', group: 'x'.repeat(300_000) };
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_S3_PROFILE, VAULT_ID, profile)).rejects.toThrow('is too large');
      expect(teamVaultService.saveS3Profile).not.toHaveBeenCalled();
    });

    it('deletes an S3 profile by id and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_DELETE_S3_PROFILE, VAULT_ID, 'p1');
      expect(teamVaultService.deleteS3Profile).toHaveBeenCalledWith(VAULT_ID, 'p1');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_SAVE_K8S_PROFILE / TEAM_VAULT_DELETE_K8S_PROFILE', () => {
    const template = { id: 'k1', name: 'Prod', server: 'https://api.example.com:6443', namespace: 'team-a' };

    it('rejects a missing, malformed or oversized template before touching the vault', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_K8S_PROFILE, VAULT_ID, { name: 'x' })).rejects.toThrow(
        'K8s profile is required'
      );
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_SAVE_K8S_PROFILE, VAULT_ID, { ...template, server: '' })
      ).rejects.toThrow(/Server URL/);
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_SAVE_K8S_PROFILE, VAULT_ID, { ...template, name: 'x'.repeat(300_000) })
      ).rejects.toThrow('is too large');
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_K8S_PROFILE, 'bad id', template)).rejects.toThrow('valid vaultId');
      expect(teamVaultService.saveK8sProfile).not.toHaveBeenCalled();
    });

    it('saves only the validated fields and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_K8S_PROFILE, VAULT_ID, { ...template, token: 'sha256~x', contextName: 'c' });
      expect(teamVaultService.saveK8sProfile).toHaveBeenCalledWith(VAULT_ID, template);
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('deletes a template by id and schedules an auto-push', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_DELETE_K8S_PROFILE, VAULT_ID, 'k1');
      expect(teamVaultService.deleteK8sProfile).toHaveBeenCalledWith(VAULT_ID, 'k1');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });
  });

  describe('TEAM_VAULT_SAVE_FOLDER / TEAM_VAULT_RENAME_FOLDER / TEAM_VAULT_DELETE_FOLDER', () => {
    it('rejects an overlong folder path', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_FOLDER, VAULT_ID, 'x'.repeat(1001))).rejects.toThrow(
        'Folder path must be a string of at most 1000 characters'
      );
      expect(teamVaultService.saveTeamFolder).not.toHaveBeenCalled();
    });

    it('rejects a folder path nested too deeply', async () => {
      const deep = Array.from({ length: 51 }, (_, i) => `seg${i}`).join('/');
      await expect(call(IPC_CHANNELS.TEAM_VAULT_SAVE_FOLDER, VAULT_ID, deep)).rejects.toThrow('nested too deeply');
      expect(teamVaultService.saveTeamFolder).not.toHaveBeenCalled();
    });

    it('rejects an overlong path on rename (either side) and delete', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_RENAME_FOLDER, VAULT_ID, 'x'.repeat(1001), 'ok')
      ).rejects.toThrow('Folder path must be a string');
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_RENAME_FOLDER, VAULT_ID, 'ok', 'x'.repeat(1001))
      ).rejects.toThrow('New folder path must be a string');
      await expect(call(IPC_CHANNELS.TEAM_VAULT_DELETE_FOLDER, VAULT_ID, 'x'.repeat(1001))).rejects.toThrow(
        'Folder path must be a string'
      );
      expect(teamVaultService.renameTeamFolder).not.toHaveBeenCalled();
      expect(teamVaultService.deleteTeamFolder).not.toHaveBeenCalled();
    });

    it('saves a folder and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SAVE_FOLDER, VAULT_ID, 'Acme Infra/Cluster A');
      expect(teamVaultService.saveTeamFolder).toHaveBeenCalledWith(VAULT_ID, 'Acme Infra/Cluster A');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('renames a folder and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_RENAME_FOLDER, VAULT_ID, 'Acme Infra', 'Acme Co');
      expect(teamVaultService.renameTeamFolder).toHaveBeenCalledWith(VAULT_ID, 'Acme Infra', 'Acme Co');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('deletes a folder, forwarding the deleteProfiles flag, and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_DELETE_FOLDER, VAULT_ID, 'Acme Infra', true);
      expect(teamVaultService.deleteTeamFolder).toHaveBeenCalledWith(VAULT_ID, 'Acme Infra', true);
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('defaults deleteProfiles to false when omitted', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_DELETE_FOLDER, VAULT_ID, 'Acme Infra');
      expect(teamVaultService.deleteTeamFolder).toHaveBeenCalledWith(VAULT_ID, 'Acme Infra', false);
    });
  });

  describe('TEAM_VAULT_SET_FOLDER_ICON', () => {
    it('rejects an overlong folder path', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_SET_FOLDER_ICON, VAULT_ID, 'x'.repeat(1001), 'server')
      ).rejects.toThrow('Folder path must be a string');
      expect(teamVaultService.setTeamFolderIcon).not.toHaveBeenCalled();
    });

    it('rejects an icon not in the known allowlist', async () => {
      await expect(
        call(IPC_CHANNELS.TEAM_VAULT_SET_FOLDER_ICON, VAULT_ID, 'Acme Infra', 'not-a-real-icon')
      ).rejects.toThrow('Unknown folder icon');
      expect(teamVaultService.setTeamFolderIcon).not.toHaveBeenCalled();
    });

    it('sets a known icon and schedules an auto-push for that vaultId', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SET_FOLDER_ICON, VAULT_ID, 'Acme Infra', 'server');
      expect(teamVaultService.setTeamFolderIcon).toHaveBeenCalledWith(VAULT_ID, 'Acme Infra', 'server');
      expect(scheduleTeamVaultAutoPush).toHaveBeenCalledWith(VAULT_ID);
    });

    it('clears the icon when called with undefined', async () => {
      await call(IPC_CHANNELS.TEAM_VAULT_SET_FOLDER_ICON, VAULT_ID, 'Acme Infra', undefined);
      expect(teamVaultService.setTeamFolderIcon).toHaveBeenCalledWith(VAULT_ID, 'Acme Infra', undefined);
    });
  });

  describe('TEAM_VAULT_PUSH / TEAM_VAULT_PULL / TEAM_VAULT_HAS_REMOTE_VAULT', () => {
    it('rejects push/pull when no target is configured', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_PUSH, VAULT_ID)).rejects.toThrow('Configure a Team Vault target first');
      await expect(call(IPC_CHANNELS.TEAM_VAULT_PULL, VAULT_ID)).rejects.toThrow('Configure a Team Vault target first');
    });

    it('pushes via the configured target and records the sync timestamp for that vaultId', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({ target: { id: 't1', type: 's3' }, remoteBasePath: 'b' });
      await call(IPC_CHANNELS.TEAM_VAULT_PUSH, VAULT_ID);
      expect(teamVaultService.pushToRemote).toHaveBeenCalledWith(VAULT_ID, {}, 'b');
      expect(teamVaultConfigStore.setLastSyncAt).toHaveBeenCalledWith(VAULT_ID, expect.any(String));
    });

    it('pulls via the configured target, records the sync timestamp, and promotes any pending config for that vaultId', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({ target: { id: 't1', type: 's3' }, remoteBasePath: 'b' });
      await call(IPC_CHANNELS.TEAM_VAULT_PULL, VAULT_ID);
      expect(teamVaultService.pullFromRemote).toHaveBeenCalledWith(VAULT_ID, {}, 'b', undefined);
      expect(teamVaultConfigStore.setLastSyncAt).toHaveBeenCalledWith(VAULT_ID, expect.any(String));
      expect(teamVaultConfigStore.promotePendingConfig).toHaveBeenCalledWith(VAULT_ID);
    });

    it('passes a force option through to pullFromRemote', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({ target: { id: 't1', type: 's3' }, remoteBasePath: 'b' });
      await call(IPC_CHANNELS.TEAM_VAULT_PULL, VAULT_ID, { force: true });
      expect(teamVaultService.pullFromRemote).toHaveBeenCalledWith(VAULT_ID, {}, 'b', { force: true });
    });

    it('hasRemoteVault returns false with no target configured, without touching the provider', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_HAS_REMOTE_VAULT, VAULT_ID)).resolves.toBe(false);
      expect(storageRegistry.getOrCreate).not.toHaveBeenCalled();
    });
  });

  describe('TEAM_VAULT_GET_SYNC_PREVIEW (§14)', () => {
    it('reports nothing to sync with no target configured, without touching the provider', async () => {
      await expect(call(IPC_CHANNELS.TEAM_VAULT_GET_SYNC_PREVIEW, VAULT_ID)).resolves.toEqual({
        hasUnpushedLocalChanges: false,
        remoteChanged: false,
      });
      expect(storageRegistry.getOrCreate).not.toHaveBeenCalled();
    });

    it('delegates to the service via the configured target', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({ target: { id: 't1', type: 's3' }, remoteBasePath: 'b' });
      teamVaultService.getSyncPreview.mockResolvedValue({ hasUnpushedLocalChanges: true, remoteChanged: false });

      await expect(call(IPC_CHANNELS.TEAM_VAULT_GET_SYNC_PREVIEW, VAULT_ID)).resolves.toEqual({
        hasUnpushedLocalChanges: true,
        remoteChanged: false,
      });
      expect(teamVaultService.getSyncPreview).toHaveBeenCalledWith(VAULT_ID, {}, 'b');
    });

    it('reports nothing to sync if the preview check itself fails (best-effort)', async () => {
      teamVaultConfigStore.getConfig.mockResolvedValue({ target: { id: 't1', type: 's3' }, remoteBasePath: 'b' });
      teamVaultService.getSyncPreview.mockRejectedValue(new Error('network blip'));

      await expect(call(IPC_CHANNELS.TEAM_VAULT_GET_SYNC_PREVIEW, VAULT_ID)).resolves.toEqual({
        hasUnpushedLocalChanges: false,
        remoteChanged: false,
      });
    });
  });
});
