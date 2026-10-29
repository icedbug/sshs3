import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { dialog as electronDialog } from 'electron';
import { importSshConfigFile } from '../services/SshConfigImporter';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { S3Config } from '../../shared/types/storage';
import type { IpcBridge } from '../IpcBridge';
import { getDemoServers, isDemoMode } from '../ai/hub/demoWorkspace';

/** The part of IpcBridge this handler group may use. */
export type ProfileHost = Pick<
  IpcBridge,
  'aiHub' | 'profileStore' | 'profileSyncService' | 'registerHandler' | 'scheduleAutoSync' | 'storageRegistry'
>;

export function registerProfileHandlers(bridge: ProfileHost): void {
  bridge.registerHandler(IPC_CHANNELS.PROFILES_GET, async () => {
    const profiles = await bridge.profileStore.getProfiles();
    if (isDemoMode()) {
      const ssh = [...profiles.ssh];
      const folderSet = new Set<string>(profiles.folders ?? []);
      for (const d of getDemoServers()) {
        if (d.folder) folderSet.add(d.folder);
        if (!ssh.some((p) => p.id === d.id)) {
          ssh.push({
            id: d.id,
            name: d.name,
            host: d.host,
            port: d.port || 22,
            username: d.username || 'root',
            authType: 'agent',
            group: d.folder || d.group,
            cluster: d.cluster,
            nodeRole: d.nodeRole,
            role: d.role,
            description: d.description,
            tags: d.tags,
            shared: d.shared,
            updatedAt: d.updatedAt,
            updatedBy: d.updatedBy,
          });
        }
      }
      return {
        ...profiles,
        ssh,
        folders: Array.from(folderSet),
      };
    }
    return profiles;
  });

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_SAVE_SSH,
    async (_event, config: SSHConnectionConfig) => {
      await bridge.profileStore.saveSSH(config);
      // The file manager caches one live provider per profile id; drop it so the next connect uses the edited settings.
      await bridge.storageRegistry.disconnect?.(`sftp-${config.id}`);
      bridge.scheduleAutoSync();
      void bridge.profileSyncService.autoSyncLocalSshConfig();
      await bridge.aiHub?.recordServerSaved(config.id);
      bridge.aiHub?.changed();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_DELETE_SSH,
    async (_event, id: string) => {
      await bridge.profileStore.deleteSSH(id);
      await bridge.storageRegistry.disconnect?.(`sftp-${id}`);
      bridge.scheduleAutoSync();
      void bridge.profileSyncService.autoSyncLocalSshConfig();
      await bridge.aiHub?.recordServerDeleted(id);
      bridge.aiHub?.changed();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_SAVE_S3,
    async (_event, config: S3Config) => {
      await bridge.profileStore.saveS3(config);
      // The file manager caches one live provider per profile id; drop it so the next connect uses the edited settings.
      await bridge.storageRegistry.disconnect?.(`s3-${config.id}`);
      bridge.scheduleAutoSync();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_DELETE_S3,
    async (_event, id: string) => {
      await bridge.profileStore.deleteS3(id);
      await bridge.storageRegistry.disconnect?.(`s3-${id}`);
      bridge.scheduleAutoSync();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_SAVE_FOLDER,
    async (_event, name: string) => {
      await bridge.profileStore.saveFolder(name);
      bridge.scheduleAutoSync();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_DELETE_FOLDER,
    async (_event, name: string, deleteProfiles?: boolean) => {
      await bridge.profileStore.deleteFolder(name, Boolean(deleteProfiles));
      bridge.scheduleAutoSync();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_RENAME_FOLDER,
    async (_event, oldName: string, newName: string) => {
      await bridge.profileStore.renameFolder(oldName, newName);
      bridge.scheduleAutoSync();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_IMPORT_SSH_CONFIG,
    async () => {
      // No caller-supplied path (H4, code review): always the real
      // ~/.ssh/config, never an arbitrary path an untrusted renderer
      // could name.
      return await importSshConfigFile();
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_EXPORT_JSON,
    async () => {
      // Always resolved via the save dialog (H4, code review) — never a
      // caller-supplied path, which would let an untrusted renderer
      // overwrite an arbitrary file on disk.
      const dateStr = new Date().toISOString().slice(0, 10);
      const result = await electronDialog.showSaveDialog({
        title: 'Export Profiles',
        defaultPath: `sshs3-profiles-${dateStr}.json`,
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return null;
      const exportPath = result.filePath;

      const profiles = await bridge.profileStore.getProfiles();
      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        folders: profiles.folders || [],
        ssh: profiles.ssh.map((p) => {
          const { password: _pw, passphrase: _pp, ...rest } = p;
          if (rest.proxy && 'password' in rest.proxy) {
            const { password: _proxyPw, ...proxyRest } = rest.proxy;
            return { ...rest, proxy: proxyRest };
          }
          return rest;
        }),
        s3: profiles.s3.map((p) => {
          const { secretAccessKey: _sec, sessionToken: _tok, ...rest } = p;
          if (rest.proxy && 'password' in rest.proxy) {
            const { password: _proxyPw, ...proxyRest } = rest.proxy;
            return { ...rest, proxy: proxyRest };
          }
          return rest;
        }),
      };

      await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');
      return { count: profiles.ssh.length + profiles.s3.length, filePath: exportPath };
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.PROFILES_IMPORT_JSON,
    async () => {
      // Always resolved via the open dialog (H4, code review) — never a
      // caller-supplied path, which would let an untrusted renderer read
      // an arbitrary file on disk and have it parsed/merged as profiles.
      const result = await electronDialog.showOpenDialog({
        title: 'Import Profiles JSON',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return { count: 0 };
      const importPath = result.filePaths[0];

      const content = await fs.readFile(importPath, 'utf-8');
      const parsed = JSON.parse(content);
      const sshList = Array.isArray(parsed.ssh) ? parsed.ssh : [];
      const s3List = Array.isArray(parsed.s3) ? parsed.s3 : [];
      const foldersList = Array.isArray(parsed.folders) ? parsed.folders : [];

      let count = 0;
      for (const f of foldersList) {
        if (typeof f === 'string' && f.trim()) {
          await bridge.profileStore.saveFolder(f.trim()).catch(() => {});
        }
      }
      for (const ssh of sshList) {
        if (ssh && typeof ssh === 'object' && ssh.host) {
          const id = ssh.id || crypto.randomUUID();
          await bridge.profileStore.saveSSH({ ...ssh, id });
          count++;
        }
      }
      for (const s3 of s3List) {
        if (s3 && typeof s3 === 'object' && s3.name) {
          const id = s3.id || crypto.randomUUID();
          await bridge.profileStore.saveS3({ ...s3, id });
          count++;
        }
      }

      bridge.scheduleAutoSync();
      if (sshList.length > 0) {
        void bridge.profileSyncService.autoSyncLocalSshConfig();
      bridge.aiHub?.changed();
      }
      return { count };
    }
  );
}
