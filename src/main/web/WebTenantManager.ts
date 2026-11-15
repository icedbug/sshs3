import { setSharedServerCheck } from '../oauth/requestJson';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IpcMain, WebContents } from 'electron';
import type { Duplex } from 'node:stream';
import { IpcBridge } from '../IpcBridge';
import type { WindowRouter } from '../windows/WindowManager';
import { createHub } from '../ai/hub/createHub';
import type { HubService } from '../ai/hub/HubService';
import {
  HUB_CHANGED,
  type WorkspacePresenceEntry,
  type WorkspacePresenceTerminal,
} from '../../shared/types/aiHub';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import { ProfileStore, type ProfilesData } from '../profile/ProfileStore';
import { K8sProfileStore } from '../profile/K8sProfileStore';
import { SessionStore } from '../session/SessionStore';
import { ClipboardHistoryStore } from '../clipboard/ClipboardHistoryStore';
import { SnippetStore } from '../snippets/SnippetStore';
import { SettingsStore } from '../settings/SettingsStore';
import { DotfilePoolStore } from '../dotfiles/DotfilePoolStore';
import { DirectorySyncProfileStore } from '../dirsync/DirectorySyncProfileStore';
import { SyncConfigStore } from '../services/SyncConfigStore';
import { TeamVaultConfigStore } from '../services/TeamVaultConfigStore';
import { TeamVaultService } from '../services/TeamVaultService';
import {
  evaluatePeerApproval,
  type PeerApprovalDecision,
  type WebUserPublic,
} from './WebAuthService';

type RpcHandler = (event: unknown, ...args: unknown[]) => unknown;

/** What a web client is to IPC handlers: the `event.sender` they reply to (like a window's webContents). */
export interface WebClientSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export class VirtualIpcMain extends EventEmitter {
  private handlers = new Map<string, RpcHandler>();

  handle(channel: string, listener: RpcHandler): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return await this.invokeWithSender(null, channel, ...args);
  }

  async invokeWithSender(sender: unknown, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for IPC channel: ${channel}`);
    }
    return await handler({ sender }, ...args);
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
    const s3Map = new Map<string, import('../../shared/types/storage').S3Config>();
    // Profiles left in the server-wide list from before are shown without anybody's keys.
    for (const s of activeSharedS3) s3Map.set(s.id, { ...s, secretAccessKey: '', sessionToken: undefined });
    // One's own profiles, with their keys, win over a keyless copy in the server-wide list. (Moving a
    // profile out of that list leaves a tombstone there; it hides nothing of one's own.)
    for (const p of personal.s3 ?? []) s3Map.set(p.id, p);

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

  override async saveSSH(profile: SSHConnectionConfig, options: { keepUpdatedAt?: boolean } = {}): Promise<void> {
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
      await this.sharedStore.saveSSH(sanitizedForTeam, options);
      await super.saveSSH({ ...profile, shared: true }, options);
      this.onSharedChanged();
    } else {
      const shared = await this.sharedStore.getProfiles();
      if (shared.ssh.some((s) => s.id === profile.id)) {
        await this.sharedStore.deleteSSH(profile.id).catch(() => {});
        this.onSharedChanged();
      }
      await super.saveSSH({ ...profile, shared: false }, options);
    }
  }

  override async deleteSSH(id: string): Promise<void> {
    await Promise.all([
      super.deleteSSH(id).catch(() => {}),
      this.sharedStore.deleteSSH(id).catch(() => {}),
    ]);
    this.onSharedChanged();
  }

  /**
   * An S3 profile carries its owner's keys: it is the owner's own. It used to go to the server-wide
   * list as it was, secret key included, for every user of the server to read and use. (A bucket a
   * team shares goes through a Team Vault, or the team workspace an administrator sets up.)
   */
  override async saveS3(config: import('../../shared/types/storage').S3Config): Promise<void> {
    await super.saveS3(config);
    const shared = await this.sharedStore.getProfiles();
    if (shared.s3.some((x) => x.id === config.id)) {
      await this.sharedStore.deleteS3(config.id).catch(() => {});
      this.onSharedChanged();
    }
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
  registerClient: (socket: Duplex, send: (payload: string) => void) => number;
  unregisterClient: (clientId: number) => void;
  subscribeSession: (clientId: number, sessionId: string) => void;
  unsubscribeSession: (clientId: number, sessionId: string) => void;
  getSessionSubscribers: (sessionId: string) => number[];
  sendToSession: (sessionId: string, channel: string, ...args: unknown[]) => boolean;
  invokeFromClient: (clientId: number, channel: string, ...args: unknown[]) => Promise<unknown>;
}

export class WebTenantManager {
  private tenants = new Map<string, Promise<UserTenant>>();
  private resolvedTenants = new Map<string, UserTenant>();
  private reloadingTenants = new Set<string>();
  private readonly sharedDir: string;
  private notifyTimer?: NodeJS.Timeout;

  constructor(
    private readonly baseDataDir: string,
    /** How many accounts the server has: with one, its administrator is alone on their own machine. */
    private readonly accountCount?: () => number,
  ) {
    this.sharedDir = path.join(baseDataDir, 'shared-workspace');
  }

  async initialize(): Promise<void> {
    // A server more than one person signs in to acts for its members: a CA, an identity provider or a
    // cluster address a member gives must not make it call its own network. With one account it is that
    // person's own machine, as the desktop app is.
    setSharedServerCheck(() => (this.accountCount?.() ?? 0) > 1);
    await fsp.mkdir(this.sharedDir, { recursive: true, mode: 0o700 });
    // Temporary files of writes that never finished (a rename Windows refused, a crash): nothing else
    // writes here before the server has started, so whatever is left is left over.
    for (const name of await fsp.readdir(this.sharedDir).catch(() => [] as string[]))
      if (/\.json\.tmp-\d/.test(name) || (name.startsWith(".") && name.endsWith(".tmp")))
        await fsp.rm(path.join(this.sharedDir, name), { force: true }).catch(() => {});
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

  /** Users whose hub is running in this process. */
  runningUserIds(): string[] {
    return [...this.resolvedTenants.keys()];
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
    let nextClientId = 1;
    const clientMap = new Map<
      number,
      { send: (payload: string) => void; socket: Duplex; sender: WebClientSender }
    >();
    const sessionOwners = new Map<string, number>();
    const sessionObservers = new Map<string, Set<number>>();

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

    const getSessionSubscribers = (sessionId: string): number[] => {
      const targets = new Set<number>();
      const owner = sessionOwners.get(sessionId);
      if (owner !== undefined && clientMap.has(owner)) {
        targets.add(owner);
      }
      const observers = sessionObservers.get(sessionId);
      if (observers) {
        for (const cid of observers) {
          if (clientMap.has(cid)) targets.add(cid);
        }
      }
      return Array.from(targets);
    };

    const sendToSession = (sessionId: string, channel: string, ...args: unknown[]): boolean => {
      // A session nobody has claimed (a client that reconnected and has not subscribed again yet, a
      // terminal the AI hub opened itself) goes to every connection of this person, never nowhere.
      const targets = getSessionSubscribers(sessionId);
      if (targets.length === 0) {
        if (clientMap.size === 0) return false;
        broadcast(channel, ...args);
        return true;
      }
      const msg = JSON.stringify({
        type: 'event',
        channel,
        args,
      });
      let delivered = false;
      for (const cid of targets) {
        const entry = clientMap.get(cid);
        if (!entry) continue;
        try {
          entry.send(msg);
          delivered = true;
        } catch {
          // Ignore disconnected client socket
        }
      }
      return delivered;
    };

    const registerClient = (socket: Duplex, send: (payload: string) => void): number => {
      const id = nextClientId++;
      clients.add(send);
      sockets.add(socket);
      // The `event.sender` of this client's requests: replies (search results, progress, prompts) go back
      // to this connection only, and nothing is sent once it is gone.
      const sender: WebClientSender = {
        id,
        isDestroyed: () => !clientMap.has(id),
        send: (channel: string, ...args: unknown[]) => {
          if (!clientMap.has(id)) return;
          send(JSON.stringify({ type: 'event', channel, args }));
        },
      };
      clientMap.set(id, { send, socket, sender });
      return id;
    };

    const unregisterClient = (clientId: number): void => {
      const entry = clientMap.get(clientId);
      if (!entry) return;
      clientMap.delete(clientId);
      clients.delete(entry.send);
      sockets.delete(entry.socket);
      for (const [sid, owner] of sessionOwners.entries()) {
        if (owner === clientId) sessionOwners.delete(sid);
      }
      for (const [sid, set] of sessionObservers.entries()) {
        set.delete(clientId);
        if (set.size === 0) sessionObservers.delete(sid);
      }
    };

    const subscribeSession = (clientId: number, sessionId: string): void => {
      if (!sessionId || !clientMap.has(clientId)) return;
      let set = sessionObservers.get(sessionId);
      if (!set) {
        set = new Set();
        sessionObservers.set(sessionId, set);
      }
      set.add(clientId);
    };

    const unsubscribeSession = (clientId: number, sessionId: string): void => {
      if (!sessionId) return;
      const set = sessionObservers.get(sessionId);
      if (set) {
        set.delete(clientId);
        if (set.size === 0) sessionObservers.delete(sessionId);
      }
      if (sessionOwners.get(sessionId) === clientId) {
        sessionOwners.delete(sessionId);
      }
    };

    const clearSessionRouting = (sessionId: string): void => {
      if (!sessionId) return;
      sessionOwners.delete(sessionId);
      sessionObservers.delete(sessionId);
    };

    const windowRouter: WindowRouter = {
      sendToSession,
      broadcast,
      broadcastExcept: (windowId, channel, ...args) => {
        if (clientMap.size === 0) return;
        const msg = JSON.stringify({ type: 'event', channel, args });
        for (const [cid, entry] of clientMap.entries()) {
          if (cid === windowId) continue;
          try {
            entry.send(msg);
          } catch {
            // Ignore disconnected client socket
          }
        }
      },
      assign: (sessionId, windowId) => {
        if (sessionId && clientMap.has(windowId)) {
          sessionOwners.set(sessionId, windowId);
        }
      },
      windowIdOfSender: (sender) => {
        if (sender && typeof sender.id === 'number' && clientMap.has(sender.id)) {
          return sender.id;
        }
        return undefined;
      },
      // Every connection is this person's one main window: a connection id is new on every reload and
      // reconnect, so keying saved tabs by it would lose them each time and add a window per connection.
      keyOfSender: () => null,
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
    const k8sProfileStore = new K8sProfileStore(
      path.join(userDir, 'k8s-profiles.json'),
    );
    const syncConfigStore = new SyncConfigStore(
      path.join(userDir, 'sync-config.json'),
    );
    const teamVaultConfigStore = new TeamVaultConfigStore(
      path.join(userDir, 'team-vault-config.json'),
    );
    const teamVaultService: TeamVaultService = new TeamVaultService({
      baseDir: userDir,
      pinPrompter: {
        promptForPinDirect: (prompt, kind, context, retry) =>
          bridge.promptForPinDirect(prompt, kind, context, retry),
        makePresenceNotifier: (sessionId, message) =>
          bridge.makePresenceNotifier(sessionId, message),
        ensurePivPresent: (context) =>
          bridge.smartcard.ensureDefaultPivPresent(context),
      },
      configStore: {
        getConfig: (vaultId) => teamVaultConfigStore.getConfig(vaultId),
        setLastKnownRemoteEntry: (
          vaultId,
          entry,
          lastSyncedRevision,
          remoteFormatVersion,
        ) =>
          teamVaultConfigStore.setLastKnownRemoteEntry(
            vaultId,
            entry,
            lastSyncedRevision,
            remoteFormatVersion,
          ),
        clearSyncState: (vaultId) => teamVaultConfigStore.clearSyncState(vaultId),
      },
      onFormatUpgraded: (vaultId) => bridge.scheduleTeamVaultAutoPush(vaultId),
    });

    const bridge: IpcBridge = new IpcBridge({
      ipcMain: virtualIpcMain as unknown as IpcMain,
      windows: windowRouter,
      profileStore,
      sessionStore,
      clipboardHistoryStore,
      snippetStore,
      settingsStore,
      dotfilePoolStore,
      directorySyncProfileStore,
      k8sProfileStore,
      syncConfigStore,
      teamVaultService,
      teamVaultConfigStore,
      getWebContents: () => virtualWebContents,
      confirmQuit: async () => true,
      tenantHomeDir: userDir,
      tenantSshPrivateKeyPath: userPrivateKeyPath,
    });

    const tenantState: { current?: UserTenant } = {};

    const hub = createHub(
      bridge,
      // No relaunchForDemoMode: demo mode is fixed for the whole server when it starts (serverEntry.ts),
      // so a tenant's Demo-Lab toggle request is refused.
      {
        backgroundChanged: async () => {},
        show: () => {},
      },
      {
        hubDirectory: path.join(userDir, 'ai-hub'),
        aiConfigFilePath: path.join(userDir, 'ai-config.json'),
        s3ConfigFilePath: this.getSharedS3ConfigPath(),
        defaultActorName: user.displayName || user.username,
        alertHookOwner: user.id,
        teamAdmin: () => (tenantState.current?.user ?? user).role === 'admin',
        soleUser: () => (tenantState.current?.user ?? user).role === 'admin' && this.accountCount?.() === 1,
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

    const invokeFromClient = async (
      clientId: number,
      channel: string,
      ...args: unknown[]
    ): Promise<unknown> => {
      const sender = clientMap.get(clientId)?.sender ?? null;
      const result = await virtualIpcMain.invokeWithSender(sender, channel, ...args);
      if (
        (channel === 'terminal:create' || channel === 'k8s-terminal:create') &&
        result &&
        typeof result === 'object' &&
        typeof (result as { sessionId?: unknown }).sessionId === 'string'
      ) {
        const sid = (result as { sessionId: string }).sessionId;
        windowRouter.assign(sid, clientId);
      } else if (
        channel === 'k8s-log:start' &&
        result &&
        typeof result === 'object' &&
        typeof (result as { sessionId?: unknown }).sessionId === 'string'
      ) {
        windowRouter.assign((result as { sessionId: string }).sessionId, clientId);
      } else if (channel === 'terminal:attach' && typeof args[0] === 'string' && args[0]) {
        windowRouter.assign(args[0], clientId);
      } else if (
        (channel === 'terminal:kill' || channel === 'k8s-terminal:kill' || channel === 'k8s-log:stop') &&
        typeof args[0] === 'string' &&
        args[0]
      ) {
        clearSessionRouting(args[0]);
      }
      return result;
    };

    tenantState.current = {
      user,
      userDir,
      ipcMain: virtualIpcMain,
      bridge,
      hub,
      clients,
      sockets,
      broadcast,
      registerClient,
      unregisterClient,
      subscribeSession,
      unsubscribeSession,
      getSessionSubscribers,
      sendToSession,
      invokeFromClient,
    };
    return tenantState.current;
  }

  /**
   * Closes all active WebSocket connections for a user without deleting their tenant files
   * (e.g. on SCIM deprovision, session revocation, or password change).
   */
  disconnectUserSockets(userId: string): number {
    const tenant = this.resolvedTenants.get(userId);
    if (!tenant) return 0;
    let closed = 0;
    for (const sock of Array.from(tenant.sockets)) {
      try {
        sock.destroy();
        closed++;
      } catch {
        // Ignore socket destroy error
      }
    }
    tenant.sockets.clear();
    tenant.clients.clear();
    return closed;
  }

  isSoleUser(): boolean {
    return this.accountCount?.() === 1;
  }

  canManageSharedWorkspace(user: Pick<WebUserPublic, 'role' | 'disabled'>): boolean {
    return !user.disabled && user.role === 'admin';
  }

  canManageClusterPolicy(
    user: Pick<WebUserPublic, 'role' | 'disabled' | 'ssoGroups'>,
    approverGroups: string[] = ['sre-lead', 'platform-admin'],
  ): boolean {
    if (user.disabled) return false;
    if (user.role === 'admin') return true;
    const allowed = new Set(approverGroups.map((g) => g.trim().toLowerCase()));
    return (user.ssoGroups ?? []).some((g) => allowed.has(g.trim().toLowerCase()));
  }

  authorizePeerApproval(input: {
    requesterUserId: string;
    requesterUsername?: string;
    approver: Pick<WebUserPublic, 'id' | 'username' | 'role' | 'ssoGroups' | 'disabled'>;
    targetEnv?: string;
    targetTags?: string[];
    requireAdminForProd?: boolean;
    requiredApprovals?: number;
    existingApprovals?: Array<{ actorId?: string; actor?: string; allowed: boolean }>;
    approverGroups?: string[];
  }): PeerApprovalDecision {
    return evaluatePeerApproval({
      requesterId: input.requesterUserId,
      requesterUsername: input.requesterUsername,
      approver: input.approver,
      targetEnv: input.targetEnv,
      targetTags: input.targetTags,
      requireAdminForProd: input.requireAdminForProd,
      requiredApprovals: input.requiredApprovals,
      existingApprovals: input.existingApprovals,
      approverGroups: input.approverGroups,
    });
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
