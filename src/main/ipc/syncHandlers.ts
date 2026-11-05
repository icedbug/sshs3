import crypto from 'node:crypto';
import { AgentLifecycleManager } from '../ssh/AgentLifecycleManager';
import type { AskpassPromptRetryContext } from '../smartcard/AskpassServer';
import { getAgentIdentities, signChallengeWithAgent, verifyAgentSignature, getKeyAlgorithm } from '../smartcard/SmartcardSyncService';
import { encryptSecretValue, isEncryptedSecret } from '../crypto/SecretFieldCrypto';
import { IPC_CHANNELS, type StorageConnectConfig } from '../../shared/types/ipc';
import type { ProfileSyncStatus, ProfileSyncPullResult, SyncComparisonResult } from '../../shared/types/sync';
import type { IpcBridge } from '../IpcBridge';
import { isSyncTargetChanged } from '../services/syncTargetIdentity';
import type { SmartcardCoordinator } from '../smartcard/SmartcardCoordinator';

/** The part of IpcBridge this handler group may use. */
export type SyncHost = Pick<
  IpcBridge,
  'buildSyncStatus' | 'getSyncProvider' | 'profileSyncService' | 'promptForPinDirect' | 'registerHandler' | 'scheduleAutoSync' | 'settingsStore' | 'startAutoPullTimer' | 'stopAutoPullTimer' | 'storageRegistry' | 'syncConfigStore' | 'syncCryptoService' | 'unlockSyncInternal' | 'unlockWithSmartcardInternal'
> & {
  smartcard: Pick<
    SmartcardCoordinator,
    'forgetGlobalCardAfterFailure' | 'getOrLoadGlobalSmartcardAgent' | 'getUnlockedCardSocket' | 'identitiesForLibrary' | 'loadSmartcardIntoPrivateAgentWithPresence'
  >;
};

export function registerSyncHandlers(bridge: SyncHost): void {
  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_SETUP,
    async (_event, payload: { target: StorageConnectConfig; remoteBasePath?: string }) => {
      const target = payload?.target;
      if (!target || !target.id || !target.name) {
        throw new Error('A sync target with an id and name is required');
      }
      if (target.type !== 'sftp' && target.type !== 's3') {
        throw new Error('Remote profile sync only supports an SFTP or S3 target');
      }
      if (target.type === 's3' && !payload.remoteBasePath?.trim()) {
        throw new Error('An S3 target requires a bucket (optionally "bucket/prefix") to sync to');
      }
      const previous = await bridge.syncConfigStore.getConfig();
      if (isSyncTargetChanged(previous, { target, remoteBasePath: payload.remoteBasePath })) {
        // The cached key and salts belong to the data on the old target. Left in place, the next auto-push would
        // encrypt with them and overwrite whatever another device stored on the new one. Lock first, so nothing
        // can push in the gap, then drop salts and switch auto-sync off; unlocking again goes through a pull.
        bridge.syncCryptoService.lock();
        bridge.stopAutoPullTimer();
        await bridge.syncConfigStore.replaceTarget(target, payload.remoteBasePath ?? '');
      } else {
        await bridge.syncConfigStore.setTarget(target, payload.remoteBasePath ?? '');
      }
      await bridge.storageRegistry.disconnect?.(target.id);
      await bridge.storageRegistry.disconnect?.('sshs3-remote-profile-sync');
      // The (app-lifetime) ProfileSyncService instance otherwise keeps comparing
      // against whatever remote state it last observed on the *previous* target.
      bridge.profileSyncService.resetRemoteState();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_ENABLE,
    async (
      _event,
      passwords: { topologyPassword: string; credentialsPassword: string }
    ): Promise<ProfileSyncStatus> => {
      if (!passwords?.topologyPassword || !passwords?.credentialsPassword) {
        throw new Error('Both the topology and credentials master passwords are required');
      }
      return await bridge.unlockSyncInternal(passwords);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.PROFILE_SYNC_PUSH, async (): Promise<ProfileSyncStatus> => {
    const config = await bridge.syncConfigStore.getConfig();
    if (!config.target) {
      throw new Error('Configure a sync target first (profile-sync:setup)');
    }
    const provider = await bridge.getSyncProvider(config.target);
    await bridge.profileSyncService.pushToRemote(provider, config.remoteBasePath ?? '');
    await bridge.syncConfigStore.setLastSyncAt(new Date().toISOString());
    return await bridge.buildSyncStatus();
  });

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_PULL,
    async (
      _event,
      passwords?: { topologyPassword?: string; credentialsPassword?: string }
    ): Promise<ProfileSyncPullResult & ProfileSyncStatus> => {
      const config = await bridge.syncConfigStore.getConfig();
      if (!config.target) {
        throw new Error('Configure a sync target first (profile-sync:setup)');
      }
      const provider = await bridge.getSyncProvider(config.target);

      const result = await bridge.profileSyncService.pullFromRemote(provider, config.remoteBasePath ?? '', {
        topology: passwords?.topologyPassword,
        credentials: passwords?.credentialsPassword,
      });

      // Bootstrap on a fresh machine: persist whichever salt(s) this pull
      // just learned from the downloaded files, without touching a salt
      // that was already known (e.g. only one of the two passwords was
      // supplied this time).
      const topologySalt = bridge.syncCryptoService.getSalt('topology');
      const credentialsSalt = bridge.syncCryptoService.getSalt('credentials');
      if ((topologySalt && !config.topologySaltBase64) || (credentialsSalt && !config.credentialsSaltBase64)) {
        await bridge.syncConfigStore.setSalts({
          topologySalt: !config.topologySaltBase64 ? topologySalt : undefined,
          credentialsSalt: !config.credentialsSaltBase64 ? credentialsSalt : undefined,
        });
      }

      await bridge.syncConfigStore.setLastSyncAt(new Date().toISOString());
      const status = await bridge.buildSyncStatus();
      return { ...result, ...status };
    }
  );

  bridge.registerHandler(IPC_CHANNELS.PROFILE_SYNC_STATUS, async (): Promise<ProfileSyncStatus> => {
    return await bridge.buildSyncStatus();
  });

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_COMPARE,
    async (): Promise<SyncComparisonResult> => {
      const config = await bridge.syncConfigStore.getConfig();
      if (!config.target) {
        throw new Error('Configure a sync target first (profile-sync:setup)');
      }
      const provider = await bridge.getSyncProvider(config.target);
      return await bridge.profileSyncService.compareWithRemote(provider, config.remoteBasePath ?? '');
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_SET_AUTO_SYNC,
    async (_event, enabled: boolean): Promise<ProfileSyncStatus> => {
      await bridge.syncConfigStore.setAutoSync(Boolean(enabled));
      if (enabled) {
        bridge.scheduleAutoSync(500);
        bridge.startAutoPullTimer();
      } else {
        bridge.stopAutoPullTimer();
      }
      return await bridge.buildSyncStatus();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_UNLOCK_SMARTCARD,
    async (_event, options?: { pkcs11LibPath?: string; pin?: string }): Promise<ProfileSyncStatus> => {
      return await bridge.unlockWithSmartcardInternal(options);
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_LINK_SMARTCARD,
    async (
      _event,
      options: {
        pkcs11LibPath: string;
        pin?: string;
        passwords?: { topologyPassword: string; credentialsPassword: string };
      }
    ): Promise<ProfileSyncStatus> => {
      const pinHandler = async (_prompt: string, retry?: AskpassPromptRetryContext) => {
        if (options.pin && !retry) return options.pin;
        return await bridge.promptForPinDirect(
          'Enter your smartcard PIN to link this card to Remote Profile Sync:',
          'smartcard',
          undefined,
          retry
        );
      };

      const settings = await bridge.settingsStore.getSettings();
      const mode = settings.smartcardAuthMode ?? 'always-prompt';

      let socketPath: string;
      let privateAgentPid: number | undefined;

      const unlockedSocket = await bridge.smartcard.getUnlockedCardSocket(options.pkcs11LibPath);
      if (unlockedSocket) {
        socketPath = unlockedSocket;
      } else if (mode === 'agent-global') {
        socketPath = await bridge.smartcard.getOrLoadGlobalSmartcardAgent(options.pkcs11LibPath, pinHandler, 'Remote Profile Sync');
      } else {
        const agent = await bridge.smartcard.loadSmartcardIntoPrivateAgentWithPresence(
          options.pkcs11LibPath,
          pinHandler,
          undefined,
          'Remote Profile Sync'
        );
        socketPath = agent.socketPath;
        privateAgentPid = agent.pid;
      }

      try {
        const identities = bridge.smartcard.identitiesForLibrary(
          await getAgentIdentities(socketPath),
          options.pkcs11LibPath,
          privateAgentPid === undefined
        );
        if (identities.length === 0) {
          throw new Error('No smartcard identities/certificates found on the card');
        }
        const chosen = identities[0];
        const challenge = crypto.randomBytes(32);
        const sig = await signChallengeWithAgent(socketPath, chosen.keyBlob, challenge);
        const verified = verifyAgentSignature(chosen.keyBlob, challenge, sig);
        if (!verified) {
          throw new Error('Failed to verify cryptographic signature from smartcard');
        }

        const hasExplicitPasswords = Boolean(
          options.passwords?.topologyPassword && options.passwords?.credentialsPassword
        );
        if (!hasExplicitPasswords && getKeyAlgorithm(chosen.keyBlob).startsWith('ecdsa-sha2-')) {
          // No saved passwords to fall back on, so unlocking would have to
          // derive a "stable" secret straight from a fresh card signature
          // every time — but ECDSA signing is non-deterministic on most
          // PKCS#11 tokens (a fresh hardware nonce per signature), so that
          // derived secret would differ on every unlock and could never
          // decrypt data pushed under an earlier one. Refuse rather than
          // risk silently locking the user out of their own synced data.
          throw new Error(
            'This smartcard uses an ECDSA key, which most PKCS#11 modules sign non-deterministically — sshs3 cannot derive a stable sync key from it alone. Unlock Remote Profile Sync with your master passwords first (Settings > Sync), then link this smartcard to save them.'
          );
        }

        let wrappedPasswordsEncrypted: string | undefined;
        if (options.passwords?.topologyPassword && options.passwords?.credentialsPassword) {
          wrappedPasswordsEncrypted = encryptSecretValue(JSON.stringify(options.passwords));
          // encryptSecretValue falls back to plaintext without an OS keyring; the master passwords must never reach disk that way.
          if (!isEncryptedSecret(wrappedPasswordsEncrypted)) {
            throw new Error(
              'The OS keyring is unavailable, so the master passwords cannot be stored securely. Unlock your keyring (or install libsecret/kwallet) and try again.'
            );
          }
          if (!bridge.syncCryptoService.isUnlocked('topology') || !bridge.syncCryptoService.isUnlocked('credentials')) {
            await bridge.unlockSyncInternal(options.passwords);
          }
        }

        await bridge.syncConfigStore.setSmartcardSync({
          pkcs11LibPath: options.pkcs11LibPath,
          keyComment: chosen.comment,
          keyBlobBase64: chosen.keyBlob.toString('base64'),
          keyFingerprint: crypto.createHash('sha256').update(chosen.keyBlob).digest('hex'),
          wrappedPasswordsEncrypted,
        });

        return await bridge.buildSyncStatus();
      } catch (err) {
        bridge.smartcard.forgetGlobalCardAfterFailure(options.pkcs11LibPath, privateAgentPid);
        throw err;
      } finally {
        if (privateAgentPid !== undefined) {
          void AgentLifecycleManager.unloadCard(socketPath, options.pkcs11LibPath);
          AgentLifecycleManager.killPrivateAgent(privateAgentPid);
        }
      }
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_UNLINK_SMARTCARD,
    async (): Promise<ProfileSyncStatus> => {
      await bridge.syncConfigStore.setSmartcardSync(undefined);
      return await bridge.buildSyncStatus();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILE_SYNC_WIPE,
    async (): Promise<ProfileSyncStatus & { remoteWipeErrors: string[] }> => {
      const config = await bridge.syncConfigStore.getConfig();
      const remoteWipeErrors: string[] = [];

      if (config.target) {
        try {
          const provider = await bridge.getSyncProvider(config.target);
          const result = await bridge.profileSyncService.wipeRemote(provider, config.remoteBasePath ?? '');
          remoteWipeErrors.push(...result.errors);
        } catch (err: any) {
          // The remote may simply be unreachable (e.g. the user wants to reset
          // sync from a machine that can no longer connect) — local config is
          // still cleared below regardless, and the error is surfaced instead
          // of blocking the reset entirely.
          remoteWipeErrors.push(err?.message || String(err));
        }
        await bridge.storageRegistry.disconnect?.(config.target.id);
      }
      await bridge.storageRegistry.disconnect?.('sshs3-remote-profile-sync');

      bridge.syncCryptoService.lock();
      await bridge.syncConfigStore.clear();
      bridge.profileSyncService.resetRemoteState();
      bridge.stopAutoPullTimer();

      const status = await bridge.buildSyncStatus();
      return { ...status, remoteWipeErrors };
    }
  );
}
