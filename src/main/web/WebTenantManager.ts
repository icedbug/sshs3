import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IpcMain, WebContents } from 'electron';
import { IpcBridge } from '../IpcBridge';
import { createHub } from '../ai/hub/createHub';
import type { HubService } from '../ai/hub/HubService';
import {
  HUB_CHANGED,
  type WorkspacePresenceEntry,
  type WorkspacePresenceTerminal,
} from '../../shared/types/aiHub';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import { ProfileStore, type ProfilesData } from '../profile/ProfileStore';
import { SessionStore } from '../session/SessionStore';
import { ClipboardHistoryStore } from '../clipboard/ClipboardHistoryStore';
import { SnippetStore } from '../snippets/SnippetStore';
import { SettingsStore } from '../settings/SettingsStore';
import { DotfilePoolStore } from '../dotfiles/DotfilePoolStore';
import { DirectorySyncProfileStore } from '../dirsync/DirectorySyncProfileStore';
import { SyncConfigStore } from '../services/SyncConfigStore';
import { TeamVaultConfigStore } from '../services/TeamVaultConfigStore';
import type { WebUserPublic } from './WebAuthService';

type RpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export class VirtualIpcMain extends EventEmitter {
  private handlers = new Map<string, RpcHandler>();

  handle(channel: string, listener: RpcHandler): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for IPC channel: ${channel}`);
    }
    return await handler({ sender: null }, ...args);
  }
}

/**
 * Hybrid ProfileStore that merges server-wide shared SSH profiles
 * (`<sharedDir>/shared-profiles.json`) with the user's personal profiles
 * (`<userDir>/profiles.json`), while keeping each user's SSH private key local to their tenant.
 */
export class HybridTenantProfileStore extends ProfileStore {
  private sharedStore: ProfileStore;

  constructor(
    personalFilePath: string,
    sharedFilePath: string,
    private readonly userPrivateKeyPath: string,
    private readonly onSharedChanged: () => void,
  ) {
    super(personalFilePath);
    this.sharedStore = new ProfileStore(sharedFilePath);
  }

  private withUserDefaultKey(profile: SSHConnectionConfig): SSHConnectionConfig {
    if (
      !profile.privateKeyPath &&
      (profile.authType === 'agent' ||
        profile.authType === 'privateKey' ||
        (profile.authType as string) === 'key' ||
        !profile.authType) &&
      fs.existsSync(this.userPrivateKeyPath)
    ) {
      return {
        ...profile,
        authType: 'privateKey',
        privateKeyPath: this.userPrivateKeyPath,
      };
    }
    return profile;
  }

  override async getProfiles(): Promise<ProfilesData> {
    const [personal, sharedWithTombstones] = await Promise.all([
      super.getProfiles(),
      this.sharedStore.getProfilesIncludingTombstones(),
    ]);

    const activeSharedSsh = (sharedWithTombstones.ssh ?? []).filter((s) => !s.deletedAt);
    const deletedSharedSshIds = new Set(
      (sharedWithTombstones.ssh ?? []).filter((s) => Boolean(s.deletedAt)).map((s) => s.id),
    );

    const sshMap = new Map<string, SSHConnectionConfig>();
    for (const s of activeSharedSsh) {
      sshMap.set(
        s.id,
        this.withUserDefaultKey({
          ...s,
          shared: true,
        }),
      );
    }
    for (const p of personal.ssh ?? []) {
      const existingShared = sshMap.get(p.id);
      if (existingShared && p.shared !== false) {
        // Merge personal auth/state fields onto shared topology (shared topology fields win)
        sshMap.set(
          p.id,
          this.withUserDefaultKey({
            ...p,
            ...existingShared,
            shared: true,
            password: p.password,
            passphrase: p.passphrase,
            privateKeyPath: p.privateKeyPath || existingShared.privateKeyPath,
            authType: p.privateKeyPath
              ? 'privateKey'
              : p.password
                ? 'password'
                : p.authType || existingShared.authType,
            lastUsedAt: p.lastUsedAt || existingShared.lastUsedAt,
          }),
        );
      } else if (p.shared === false) {
        sshMap.set(p.id, this.withUserDefaultKey(p));
      } else if (p.shared !== true && !deletedSharedSshIds.has(p.id)) {
        sshMap.set(p.id, this.withUserDefaultKey(p));
      }
    }

    const activeSharedS3 = (sharedWithTombstones.s3 ?? []).filter((s) => !s.deletedAt);
    const deletedSharedS3Ids = new Set(
      (sharedWithTombstones.s3 ?? []).filter((s) => Boolean(s.deletedAt)).map((s) => s.id),
    );
    const s3Map = new Map<string, import('../../shared/types/storage').S3Config>();
    for (const s of activeSharedS3) s3Map.set(s.id, s);
    for (const p of personal.s3 ?? []) {
      if (!s3Map.has(p.id) && !deletedSharedS3Ids.has(p.id)) {
        s3Map.set(p.id, p);
      }
    }

    const folders = Array.from(
      new Set([...(sharedWithTombstones.folders ?? []), ...(personal.folders ?? [])]),
    );

    return {
      ssh: Array.from(sshMap.values()),
      s3: Array.from(s3Map.values()),
      ...(folders.length > 0 ? { folders } : {}),
    };
  }

  async getSSHProfiles(): Promise<SSHConnectionConfig[]> {
    const data = await this.getProfiles();
    return data.ssh;
  }

  override async saveSSH(profile: SSHConnectionConfig): Promise<void> {
    if (profile.shared !== false) {
      // Strip personal key paths/passwords before saving to shared team profile store
      const sanitizedForTeam: SSHConnectionConfig = {
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port || 22,
        username: profile.username || 'root',
        authType: 'agent',
        group: profile.group,
        cluster: profile.cluster,
        nodeRole: profile.nodeRole,
        role: profile.role,
        description: profile.description,
        tags: profile.tags,
        shared: true,
        updatedAt: profile.updatedAt || new Date().toISOString(),
        updatedBy: profile.updatedBy,
      };
      await this.sharedStore.saveSSH(sanitizedForTeam);
      await super.saveSSH({ ...profile, shared: true });
      this.onSharedChanged();
    } else {
      const shared = await this.sharedStore.getProfiles();
      if (shared.ssh.some((s) => s.id === profile.id)) {
        await this.sharedStore.deleteSSH(profile.id).catch(() => {});
        this.onSharedChanged();
      }
      await super.saveSSH({ ...profile, shared: false });
    }
  }

  override async deleteSSH(id: string): Promise<void> {
    await Promise.all([
      super.deleteSSH(id).catch(() => {}),
      this.sharedStore.deleteSSH(id).catch(() => {}),
    ]);
    this.onSharedChanged();
  }

  override async saveS3(config: import('../../shared/types/storage').S3Config): Promise<void> {
    await this.sharedStore.saveS3(config);
    this.onSharedChanged();
  }

  override async deleteS3(id: string): Promise<void> {
    await Promise.all([
      super.deleteS3(id).catch(() => {}),
      this.sharedStore.deleteS3(id).catch(() => {}),
    ]);
    this.onSharedChanged();
  }

  override async saveFolder(name: string): Promise<void> {
    await this.sharedStore.saveFolder(name);
    this.onSharedChanged();
  }

  override async deleteFolder(name: string, deleteProfiles = false): Promise<void> {
    await Promise.all([
      super.deleteFolder(name, deleteProfiles).catch(() => {}),
      this.sharedStore.deleteFolder(name, deleteProfiles).catch(() => {}),
    ]);
    this.onSharedChanged();
  }

  override async renameFolder(oldName: string, newName: string): Promise<void> {
    await Promise.all([
      super.renameFolder(oldName, newName).catch(() => {}),
      this.sharedStore.renameFolder(oldName, newName).catch(() => {}),
    ]);
    this.onSharedChanged();
  }
}

export interface UserTenant {
  user: WebUserPublic;
  userDir: string;
  ipcMain: VirtualIpcMain;
  bridge: IpcBridge;
  hub: HubService;
  clients: Set<(payload: string) => void>;
  sockets: Set<import('node:stream').Duplex>;
  broadcast: (channel: string, ...args: unknown[]) => void;
}

export class WebTenantManager {
  private tenants = new Map<string, Promise<UserTenant>>();
  private resolvedTenants = new Map<string, UserTenant>();
  private reloadingTenants = new Set<string>();
  private readonly sharedDir: string;
  private notifyTimer?: NodeJS.Timeout;

  constructor(private readonly baseDataDir: string) {
    this.sharedDir = path.join(baseDataDir, 'shared-workspace');
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.sharedDir, { recursive: true, mode: 0o700 });
  }

  getSharedWorkspaceFilePath(): string {
    return path.join(this.sharedDir, 'shared-workspace.json');
  }

  getSharedS3ConfigPath(): string {
    return path.join(this.sharedDir, 's3-workspace.json');
  }

  getSharedProfilesPath(): string {
    return path.join(this.sharedDir, 'shared-profiles.json');
  }

  /**
   * Returns live presence across all active user tenants on this VM web server.
   */
  getAllLocalTenantsPresence(): WorkspacePresenceEntry[] {
    const entries: WorkspacePresenceEntry[] = [];
    const now = Date.now();
    for (const tenant of this.resolvedTenants.values()) {
      const actor = tenant.user.displayName || tenant.user.username;
      const activeTerminals: WorkspacePresenceTerminal[] = tenant.hub.terminals
        .list()
        .filter((t) => t.state !== 'disconnected' && t.kind === 'ssh')
        .map((t) => ({
          profileId: t.profileId,
          targetLabel: t.label,
          state: t.owner ? 'ai-working' : 'connected',
          since: t.updatedAt,
        }));
      if (tenant.clients.size > 0 || activeTerminals.length > 0) {
        entries.push({
          actor,
          updatedAt: now,
          activeTerminals,
        });
      }
    }
    return entries;
  }

  private notifyCrossTenantChanged(excludeUserId?: string): void {
    if (excludeUserId && this.reloadingTenants.has(excludeUserId)) return;
    for (const [uid, tenant] of this.resolvedTenants.entries()) {
      if (uid !== excludeUserId && !this.reloadingTenants.has(uid)) {
        this.reloadingTenants.add(uid);
        void tenant.hub.s3Workspace
          .reloadFromDisk()
          .catch(() => {})
          .finally(() => {
            this.reloadingTenants.delete(uid);
          });
      }
    }
    this.scheduleCrossTenantBroadcast(excludeUserId);
  }

  private scheduleCrossTenantBroadcast(excludeUserId?: string): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      for (const [uid, tenant] of this.resolvedTenants.entries()) {
        if (uid !== excludeUserId) {
          tenant.broadcast(HUB_CHANGED);
        }
      }
    }, 80);
    this.notifyTimer.unref?.();
  }

  async getOrCreateTenant(user: WebUserPublic): Promise<UserTenant> {
    const existing = this.tenants.get(user.id);
    if (existing) {
      const resolved = await existing;
      resolved.user = user;
      return resolved;
    }

    const creation = this.createTenantInternal(user);
    this.tenants.set(user.id, creation);
    try {
      const tenant = await creation;
      this.resolvedTenants.set(user.id, tenant);
      return tenant;
    } catch (err) {
      this.tenants.delete(user.id);
      throw err;
    }
  }

  private async createTenantInternal(user: WebUserPublic): Promise<UserTenant> {
    await this.initialize();
    const safeId = user.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const userDir = path.join(this.baseDataDir, 'users', safeId);
    await fsp.mkdir(userDir, { recursive: true, mode: 0o700 });

    const virtualIpcMain = new VirtualIpcMain();
    const clients = new Set<(payload: string) => void>();
    const sockets = new Set<import('node:stream').Duplex>();

    const broadcast = (channel: string, ...args: unknown[]): void => {
      if (clients.size === 0) return;
      const msg = JSON.stringify({
        type: 'event',
        channel,
        args,
      });
      for (const send of clients) {
        try {
          send(msg);
        } catch {
          // Ignore disconnected client socket
        }
      }
    };

    const virtualWebContents = {
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        broadcast(channel, ...args);
      },
    } as unknown as WebContents;

    const userPrivateKeyPath =
      user.sshPrivateKeyPath || path.join(userDir, '.ssh', 'id_ed25519');

    const profileStore = new HybridTenantProfileStore(
      path.join(userDir, 'profiles.json'),
      this.getSharedProfilesPath(),
      userPrivateKeyPath,
      () => this.notifyCrossTenantChanged(user.id),
    );
    const sessionStore = new SessionStore(path.join(userDir, 'sessions.json'));
    const clipboardHistoryStore = new ClipboardHistoryStore(
      path.join(userDir, 'clipboard-history.json'),
    );
    const snippetStore = new SnippetStore(path.join(userDir, 'snippets.json'));
    const settingsStore = new SettingsStore(path.join(userDir, 'settings.json'));
    const dotfilePoolStore = new DotfilePoolStore(
      path.join(userDir, 'dotfiles-pool'),
    );
    const directorySyncProfileStore = new DirectorySyncProfileStore(
      path.join(userDir, 'dirsync-profiles.json'),
    );
    const syncConfigStore = new SyncConfigStore(
      path.join(userDir, 'sync-config.json'),
    );
    const teamVaultConfigStore = new TeamVaultConfigStore(
      path.join(userDir, 'team-vault-config.json'),
    );

    const bridge = new IpcBridge({
      ipcMain: virtualIpcMain as unknown as IpcMain,
      profileStore,
      sessionStore,
      clipboardHistoryStore,
      snippetStore,
      settingsStore,
      dotfilePoolStore,
      directorySyncProfileStore,
      syncConfigStore,
      teamVaultConfigStore,
      getWebContents: () => virtualWebContents,
      confirmQuit: async () => true,
      tenantHomeDir: userDir,
      tenantSshPrivateKeyPath: userPrivateKeyPath,
    });

    const hub = createHub(
      bridge,
      {
        backgroundChanged: async () => {},
        show: () => {},
      },
      {
        hubDirectory: path.join(userDir, 'ai-hub'),
        aiConfigFilePath: path.join(userDir, 'ai-config.json'),
        s3ConfigFilePath: this.getSharedS3ConfigPath(),
        defaultActorName: user.displayName || user.username,
        peerPresenceProvider: () => this.getAllLocalTenantsPresence(),
        onSharedWorkspaceChanged: () =>
          this.notifyCrossTenantChanged(user.id),
      },
    );

    bridge.aiHub = hub;
    bridge.register();
    await hub.initialize();

    // Point this tenant's sharedWorkspacePath to the server's shared workspace file
    // so all users on the VM automatically share workspace servers, memories, and activityLog!
    const sharedFile = this.getSharedWorkspaceFilePath();
    if (hub.store.data.preferences.sharedWorkspacePath !== sharedFile) {
      hub.store.data.preferences.sharedWorkspacePath = sharedFile;
      await hub.store.save().catch(() => {});
    }

    return {
      user,
      userDir,
      ipcMain: virtualIpcMain,
      bridge,
      hub,
      clients,
      sockets,
      broadcast,
    };
  }

  async disposeTenant(userId: string): Promise<void> {
    const pending = this.tenants.get(userId);
    const resolved =
      this.resolvedTenants.get(userId) ??
      (pending ? await pending.catch(() => undefined) : undefined);
    this.tenants.delete(userId);
    this.resolvedTenants.delete(userId);
    if (resolved) {
      for (const sock of Array.from(resolved.sockets)) {
        try {
          sock.destroy();
        } catch {
          // Ignore socket destroy error
        }
      }
      resolved.sockets.clear();
      resolved.clients.clear();
      await resolved.hub.dispose().catch(() => {});
      await resolved.bridge.dispose().catch(() => {});
    }
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (safeId) {
      const userDir = path.join(this.baseDataDir, 'users', safeId);
      await fsp.rm(userDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async disposeAll(): Promise<void> {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    for (const tenant of this.resolvedTenants.values()) {
      for (const sock of Array.from(tenant.sockets)) {
        try {
          sock.destroy();
        } catch {
          // Ignore
        }
      }
      tenant.sockets.clear();
      await tenant.hub.dispose().catch(() => {});
      await tenant.bridge.dispose().catch(() => {});
    }
    this.resolvedTenants.clear();
    this.tenants.clear();
  }
}
