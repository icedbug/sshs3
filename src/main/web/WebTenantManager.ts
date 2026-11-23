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
import type {
  ChatAnsweringRequest,
  ChatAnsweringSnapshot,
  ChatServiceName,
  ChatWaitingItem,
  HubReply,
  PeerApprovalItem,
  TeamSafetyRules,
} from '../../shared/types/aiHub';
import { writeFileAtomic } from '../storage/atomicFile';
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
import { ChatBridge } from '../ai/hub/ChatBridge';
import { FileQueueStore } from '../ai/hub/FileQueueStore';
import { SnippetStore } from '../snippets/SnippetStore';
import { SettingsStore } from '../settings/SettingsStore';
import { DotfilePoolStore } from '../dotfiles/DotfilePoolStore';
import { DirectorySyncProfileStore } from '../dirsync/DirectorySyncProfileStore';
import { SyncConfigStore } from '../services/SyncConfigStore';
import { TeamVaultConfigStore } from '../services/TeamVaultConfigStore';
import { TeamVaultService } from '../services/TeamVaultService';
import { setWebServerProcess } from './tenantBoundary';
import { WEB_ALLOWED_CHANNELS, WEB_CHANNEL_REFUSED, WEB_FIXED_ANSWERS } from './webIpcChannels';
import {
  ensureKeyPairAt,
  evaluatePeerApproval,
  SERVICE_ACCOUNT_PREFIX,
  type PeerAccount,
  type PeerApprovalDecision,
  type WebUserPublic,
} from './WebAuthService';

/**
 * The chat agent: the account a conversation asked for in a chat channel runs in. The server makes it
 * itself. It has no record among the accounts, so nobody can sign in as it, invite it or remove it, and
 * it is never counted as a person: not for the two person rule, not among who is here, not in the
 * administrator's list. ":" is not allowed in a person's username, so its name cannot be taken.
 */
export const CHAT_AGENT_ID = `${SERVICE_ACCOUNT_PREFIX}chat-agent`;
export const CHAT_AGENT_USERNAME = 'svc:chat-agent';
export const CHAT_AGENT_NAME = 'Chat agent';
/**
 * The comment on the chat agent's public key, as it shows in a server's authorized_keys. A person's key
 * is "<username>@sshs3-web", and no username has a ":", so an administrator can always tell this line
 * from a person's when they remove it.
 */
export const CHAT_AGENT_KEY_COMMENT = `${CHAT_AGENT_USERNAME}@sshs3-web`;

/** What a person's answer from chat came to, in words the chat can show them. */
export type ChatAgentAnswer =
  | { outcome: 'approved'; message: string }
  | { outcome: 'denied'; message: string }
  | { outcome: 'waiting'; remaining: number; message: string }
  | { outcome: 'refused'; message: string };

/**
 * The agent bot in chat, as the server keeps it for everyone (ChatAnswering). Each account's hub is
 * given these two calls with the account's id already in them, so the server always knows who asks.
 */
export interface ChatAnsweringBackend {
  view(userId: string): Promise<ChatAnsweringSnapshot>;
  request(userId: string, request: ChatAnsweringRequest): Promise<HubReply | undefined>;
  /** Who may answer in a conversation's channel as the administrator set it now. Undefined: no rule there. */
  currentApprovers?(origin: { service: ChatServiceName; channelId: string; kind: 'channel' | 'dm' }): 'linked' | 'admins' | undefined;
}

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

  /** Every channel a handler is registered for. */
  channels(): string[] {
    return [...this.handlers.keys()];
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
  /**
   * The team's chat bot: one for the whole server, so there is one reader and
   * one index however many accounts are signed in. Each account's hub is
   * given this one; only an administrator's hub may change it.
   */
  private readonly teamChat: ChatBridge;
  /**
   * The team's board, agents and knowledge base where the team has no bucket: one folder of the
   * server's own, and one store over it that every account's hub is given (see FileQueueStore).
   */
  private readonly teamBoard: FileQueueStore;
  /**
   * The rules an administrator set for everyone on this server: in memory for every account's hub,
   * kept in the shared folder. Only an administrator's hub writes them (the hub checks who asks).
   */
  private teamRules: TeamSafetyRules = {};
  private ruleWrites: Promise<void> = Promise.resolve();
  private boardTimer?: NodeJS.Timeout;
  private boardWriters = new Set<string>();
  /**
   * The chat agent's tenant, kept apart from the accounts' so that nothing that goes through the
   * accounts (who is here, who may approve, who is running) ever finds it.
   */
  private chatAgent?: Promise<UserTenant>;
  private chatAgentResolved?: UserTenant;
  /** The chat agent's private keys already restricted in this process: Windows is asked once, not on every read. */
  private readonly chatAgentRestrictedKeys = new Set<string>();
  /** The agent bot in chat, once the server has set it up. */
  private chatAnswering?: ChatAnsweringBackend;

  constructor(
    private readonly baseDataDir: string,
    /** How many accounts the server has: with one, its administrator is alone on their own machine. */
    private readonly accountCount?: () => number,
    /** The server's accounts, as far as deciding who may approve for whom needs them. */
    private readonly accounts?: () => PeerAccount[],
  ) {
    // From here on ssh and Kubernetes work only with an account's own files, never the server's (tenantBoundary.ts).
    setWebServerProcess(true);
    this.sharedDir = path.join(baseDataDir, 'shared-workspace');
    this.teamBoard = new FileQueueStore(path.join(this.sharedDir, 'board'));
    this.teamChat = new ChatBridge(path.join(baseDataDir, 'team-chat'), {
      // The same rule as every address a member gives: a server several people sign in to does not
      // call itself, nor its private network unless its administrator said so.
      guard: () => {
        const shared = (this.accountCount?.() ?? 0) > 1;
        return { server: shared, allowPrivate: !shared || process.env.SSHS3_ALLOW_PRIVATE_ADDRESSES === '1' };
      },
    });
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
    try {
      const kept: unknown = JSON.parse(await fsp.readFile(this.getTeamRulesPath(), 'utf8'));
      if (!kept || typeof kept !== 'object' || Array.isArray(kept)) throw new Error('Invalid team rules.');
      const rules = kept as TeamSafetyRules;
      if (rules.requirePeerApprovalOnProd !== undefined && typeof rules.requirePeerApprovalOnProd !== 'boolean') throw new Error('Invalid team approval rule.');
      if (rules.freezes !== undefined && (!rules.freezes || typeof rules.freezes !== 'object' || Array.isArray(rules.freezes) ||
        Object.values(rules.freezes).some(f => !f || !Number.isFinite(f.until)))) throw new Error('Invalid team freeze.');
      this.teamRules = rules;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** The server sets up the agent bot in chat after the stores it needs are read. */
  setChatAnswering(backend: ChatAnsweringBackend | undefined): void {
    this.chatAnswering = backend;
  }

  /**
   * The team's context bot, one for the server. The agent bot only asks it to read a thread now
   * (readThreadNow); nothing writes through it.
   */
  contextBot(): ChatBridge {
    return this.teamChat;
  }

  /** The chat agent's tenant if it was started already: reading a list never starts it. */
  chatAgentIfStarted(): UserTenant | undefined {
    return this.chatAgentResolved;
  }

  /** What the agent bot shows changed: every account's windows read their snapshot again. */
  chatAnsweringChanged(exceptUserId?: string): void {
    for (const [uid, tenant] of this.resolvedTenants.entries()) if (uid !== exceptUserId) tenant.broadcast(HUB_CHANGED);
  }

  getTeamRulesPath(): string {
    return path.join(this.sharedDir, 'team-rules.json');
  }

  /** An administrator changed the rules for everyone: kept, and every other account's windows are told. */
  private saveTeamRules(userId: string, next: TeamSafetyRules, previous?: TeamSafetyRules): Promise<void> {
    const write = this.ruleWrites.then(async () => {
      if (previous && previous !== this.teamRules) throw new Error('Another administrator updated the rules. Read them again before saving.');
      const actor = this.account(userId);
      if (!actor || actor.disabled || actor.role !== 'admin') throw new Error('Only an active administrator can change team rules.');
      await writeFileAtomic(this.getTeamRulesPath(), JSON.stringify(next, null, 2));
      this.teamRules = next;
      for (const [uid, tenant] of this.resolvedTenants.entries()) if (uid !== userId) tenant.hub.teamRulesChanged();
      this.chatAgentResolved?.hub.teamRulesChanged();
    });
    this.ruleWrites = write.catch(() => undefined);
    return write;
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
    const everyone: Array<[string, UserTenant]> = [...this.resolvedTenants.entries()];
    // The chat agent reads the team's servers too; it has no window to tell.
    if (this.chatAgentResolved) everyone.push([CHAT_AGENT_ID, this.chatAgentResolved]);
    for (const [uid, tenant] of everyone) {
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

  /**
   * A person's account as it is now (a role may have changed since its hub was started). Never one of the
   * server's own: whatever looks an account up here to approve, answer or change rules finds nobody.
   */
  private account(userId: string): PeerAccount | undefined {
    if (userId.startsWith(SERVICE_ACCOUNT_PREFIX)) return undefined;
    return this.accounts ? this.accounts().find((a) => a.id === userId) : this.resolvedTenants.get(userId)?.user;
  }

  /**
   * The one a change is asked for: a person's account, or the chat agent. The chat agent asks for
   * approvals and never gives one, so it is found only here, in that role.
   */
  private requester(userId: string): PeerAccount | undefined {
    return userId === CHAT_AGENT_ID ? this.chatAgentAccount() : this.account(userId);
  }

  private chatAgentAccount(): PeerAccount {
    return { id: CHAT_AGENT_ID, username: CHAT_AGENT_USERNAME, displayName: CHAT_AGENT_NAME, role: 'member' };
  }

  /** The people who could be a second person for this account's changes: never the chat agent. */
  private people(): PeerAccount[] {
    return (this.accounts?.() ?? []).filter((a) => !a.id.startsWith(SERVICE_ACCOUNT_PREFIX));
  }

  private eligiblePeer(ownerId: string, peer: PeerAccount, tags: string[]): boolean {
    // The server's own accounts are never anybody's second person.
    if (peer.id.startsWith(SERVICE_ACCOUNT_PREFIX)) return false;
    const owner = this.requester(ownerId);
    return Boolean(owner && !owner.disabled && this.authorizePeerApproval({
      requesterUserId: ownerId, requesterUsername: owner.username, approver: peer, targetTags: tags, requiredApprovals: 2,
    }).authorized);
  }

  private hasSecondApproverFor(userId: string, tags: string[] = ['production']): boolean {
    return this.people().some((peer) => this.eligiblePeer(userId, peer, tags));
  }

  /**
   * Whether a change of the chat agent's can be put to people. The rule for an account counts its owner
   * as the first person; the chat agent is nobody, so two people who may answer are needed. In a channel
   * that takes answers from administrators only, only they are counted: otherwise a change could ask for
   * two people the channel would never let answer, and wait until it timed out.
   */
  private chatAgentHasTwoApprovers(tags: string[] = ['production'], approvers?: 'linked' | 'admins'): boolean {
    return (
      this.people().filter(
        (peer) => (approvers !== 'admins' || peer.role === 'admin') && this.eligiblePeer(CHAT_AGENT_ID, peer, tags),
      ).length >= 2
    );
  }

  /** The changes in other members' runs that wait for a second person and that this member may answer. */
  private waitingForSecondPerson(userId: string): PeerApprovalItem[] {
    const me = this.account(userId);
    if (!me) return [];
    const out: PeerApprovalItem[] = [];
    for (const [ownerId, tenant] of this.resolvedTenants.entries()) {
      if (ownerId === userId) continue;
      const owner = this.account(ownerId) ?? tenant.user;
      for (const waiting of tenant.hub.waitingForApproval()) {
        // Whoever already answered it does not get it again.
        if (waiting.approvers.some((a) => a.actorId === `user:${userId}`)) continue;
        const may = this.authorizePeerApproval({
          requesterUserId: ownerId,
          requesterUsername: owner.username,
          approver: me,
          targetTags: waiting.targetTags,
          requiredApprovals: waiting.requiredApprovals,
        });
        if (!may.authorized) continue;
        out.push({
          ownerId,
          ownerName: owner.displayName || owner.username,
          taskId: waiting.taskId,
          changeId: waiting.changeId,
          ...(waiting.agentName ? { agentName: waiting.agentName } : {}),
          description: waiting.description,
          ...(waiting.command ? { command: waiting.command } : {}),
          ...(waiting.target ? { target: waiting.target } : {}),
          ...(waiting.risk ? { risk: waiting.risk } : {}),
          requiredApprovals: waiting.requiredApprovals,
          approvedBy: waiting.approvedBy,
          at: waiting.at,
          ...(waiting.plan ? { plan: waiting.plan } : {}),
        });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /**
   * This member's answer to a change in another member's run. Checked here, where the accounts are
   * known: the change must still be waiting, and the rule must let this member answer it.
   */
  private async answerAsSecondPerson(
    userId: string,
    answer: { ownerId: string; taskId: string; changeId: string; approved: boolean; note?: string },
  ): Promise<void> {
    const me = this.account(userId);
    if (!me || me.disabled) throw new Error('Your account cannot approve here.');
    if (answer.ownerId === userId) throw new Error('A change in your own run is answered in your own inbox, and needs somebody else as well.');
    const tenant = this.resolvedTenants.get(answer.ownerId);
    const waiting = tenant?.hub.waitingForApproval().find((w) => w.taskId === answer.taskId && w.changeId === answer.changeId);
    if (!tenant || !waiting) throw new Error('That is not waiting any more: it was answered, or its run was stopped.');
    const owner = this.account(answer.ownerId) ?? tenant.user;
    const may = this.authorizePeerApproval({
      requesterUserId: answer.ownerId,
      requesterUsername: owner.username,
      approver: me,
      targetTags: waiting.targetTags,
      requiredApprovals: waiting.requiredApprovals,
    });
    if (!may.authorized)
      throw new Error(
        /production/i.test(may.reason ?? '')
          ? 'You cannot approve this. On production the second person has to be an administrator of this server, or in one of its approver groups.'
          : may.reason
            ? `You cannot approve this: ${may.reason}.`
            : 'You cannot approve this.',
      );
    // The run's own hub says so when what it waits for has changed: everybody's inbox follows from that.
    const peer = { id: userId, name: me.displayName || me.username };
    if (waiting.plan) await tenant.hub.approvePlanAsPeer(answer.taskId, answer.approved, peer, answer.note);
    else await tenant.hub.approveAsPeer(answer.taskId, answer.changeId, answer.approved, peer, answer.note);
  }

  /** A member's changes that wait for a second person are not what they were: every other member's hub is told. */
  private secondPersonWantedBy(userId: string): void {
    for (const [uid, tenant] of this.resolvedTenants.entries()) if (uid !== userId) tenant.hub.peerApprovalsChanged();
  }

  /**
   * An account wrote to the team's board: the other accounts' hubs read it now, and their windows are
   * told. Gathered for a moment, so a save that writes several items tells the others once.
   */
  private boardChangedBy(userId: string): void {
    this.boardWriters.add(userId);
    if (this.boardTimer) return;
    this.boardTimer = setTimeout(() => {
      this.boardTimer = undefined;
      const writers = this.boardWriters;
      this.boardWriters = new Set();
      for (const [uid, tenant] of this.resolvedTenants.entries()) {
        // Whoever wrote has it already. With several writers at once, each has something to read.
        if (writers.size === 1 && writers.has(uid)) continue;
        tenant.hub.teamBoardChanged();
      }
      if (this.chatAgentResolved && !(writers.size === 1 && writers.has(CHAT_AGENT_ID))) this.chatAgentResolved.hub.teamBoardChanged();
    }, 120);
    this.boardTimer.unref?.();
  }

  /** Users whose hub is running in this process. */
  runningUserIds(): string[] {
    return [...this.resolvedTenants.keys()];
  }

  async getOrCreateTenant(user: WebUserPublic): Promise<UserTenant> {
    // A service account is never anybody's: it is started by the server, under its own folder.
    if (user.id.startsWith(SERVICE_ACCOUNT_PREFIX)) throw new Error('That account belongs to the server.');
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

  private async createTenantInternal(user: WebUserPublic, service?: { userDir: string }): Promise<UserTenant> {
    await this.initialize();
    const safeId = user.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const userDir = service?.userDir ?? path.join(this.baseDataDir, 'users', safeId);
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

    const shared = {
      hubDirectory: path.join(userDir, 'ai-hub'),
      aiConfigFilePath: path.join(userDir, 'ai-config.json'),
      s3ConfigFilePath: this.getSharedS3ConfigPath(),
      alertHookOwner: user.id,
      onSharedWorkspaceChanged: () => this.notifyCrossTenantChanged(user.id),
      // One board for everyone on this server, kept in the server's shared folder when the team has no bucket.
      sharedWorkStore: this.teamBoard.forAccount(() => this.boardChangedBy(user.id)),
      peerStillEligible: (actorId: string, tags: string[]) => {
        const peer = actorId.startsWith('user:') ? this.account(actorId.slice(5)) : undefined;
        return !!peer && this.eligiblePeer(user.id, peer, tags);
      },
      peerWaitingChanged: () => this.secondPersonWantedBy(user.id),
      teamChat: this.teamChat,
    };
    const hub = createHub(
      bridge,
      // No relaunchForDemoMode: demo mode is fixed for the whole server when it starts (serverEntry.ts),
      // so a tenant's Demo-Lab toggle request is refused.
      {
        backgroundChanged: async () => {},
        show: () => {},
      },
      service
        ? {
            ...shared,
            defaultActorName: CHAT_AGENT_NAME,
            // Nobody signs in to it: it administers nothing and is never alone on the server, so what
            // is asked of it in a channel never reaches into the server itself.
            teamAdmin: () => false,
            soleUser: () => false,
            serviceAccount: true,
            // It has no owner to be the first person, so two people who may answer are needed.
            peerApproval: (tags, task) => this.chatAgentHasTwoApprovers(tags, task?.chat?.fence.approvers),
            // It reads the team's rules and never writes them.
            teamRules: {
              read: () => this.teamRules,
              write: () => Promise.reject(new Error('Only an active administrator can change team rules.')),
            },
          }
        : {
            ...shared,
            defaultActorName: user.displayName || user.username,
            teamAdmin: () => { const account = this.account(user.id); return !!account && !account.disabled && account.role === 'admin'; },
            soleUser: () => (tenantState.current?.user ?? user).role === 'admin' && this.accountCount?.() === 1,
            peerPresenceProvider: () => this.getAllLocalTenantsPresence(),
            // A change that needs two people is put to the other members, and their answer is passed back.
            peerApproval: (tags) => this.hasSecondApproverFor(user.id, tags),
            peerWaiting: () => this.waitingForSecondPerson(user.id),
            peerDecide: (answer) => this.answerAsSecondPerson(user.id, answer),
            // The rules for everyone on this server: one set, read by every account's hub.
            teamRules: { read: () => this.teamRules, write: (next, previous) => this.saveTeamRules(user.id, next, previous) },
            // The agent bot is the server's: asked with this account's id, which the request cannot change.
            chatAnswering: {
              view: async () => this.chatAnswering?.view(user.id),
              request: async (request) => {
                if (!this.chatAnswering) throw new Error('The agent bot is not set up on this server yet.');
                return this.chatAnswering.request(user.id, request);
              },
            },
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
      // Only what is on the list reaches a handler: the handlers were written for the person who owns
      // the machine, and a web client is one account among several (webIpcChannels.ts).
      if (typeof channel !== 'string') throw new Error(WEB_CHANNEL_REFUSED);
      const fixed = WEB_FIXED_ANSWERS.get(channel);
      if (fixed) return fixed();
      if (!WEB_ALLOWED_CHANNELS.has(channel)) throw new Error(WEB_CHANNEL_REFUSED);
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

  /** The chat agent's own folder: outside the accounts' folders, so no account's removal or listing reaches it. */
  getChatAgentDir(): string {
    return path.join(this.baseDataDir, 'service', 'chat-agent');
  }

  private chatAgentSshDir(): string {
    return path.join(this.getChatAgentDir(), '.ssh');
  }

  /**
   * The chat agent's tenant, started once. Its hub runs every conversation asked for in a channel, and a
   * direct message from somebody who has not linked their account.
   */
  async getChatAgentTenant(): Promise<UserTenant> {
    if (!this.chatAgent) {
      const creation = (async () => {
        const userDir = this.getChatAgentDir();
        await fsp.mkdir(userDir, { recursive: true, mode: 0o700 });
        const key = await ensureKeyPairAt(this.chatAgentSshDir(), CHAT_AGENT_KEY_COMMENT, { restricted: this.chatAgentRestrictedKeys });
        const user: WebUserPublic = {
          ...this.chatAgentAccount(),
          createdAt: 0,
          sshPublicKey: key.publicKey,
          sshPrivateKeyPath: key.privateKeyPath,
        };
        const tenant = await this.createTenantInternal(user, { userDir });
        // It proposes nothing to remember: what every channel asked is not the team's to learn from.
        // The hub holds to that whatever its preferences say (HubService.tick); this keeps them honest.
        if (tenant.hub.store.data.preferences.proposeMemories !== false) {
          tenant.hub.store.data.preferences.proposeMemories = false;
          await tenant.hub.store.save().catch(() => {});
        }
        return tenant;
      })();
      this.chatAgent = creation;
      try {
        this.chatAgentResolved = await creation;
      } catch (err) {
        this.chatAgent = undefined;
        throw err;
      }
    }
    return this.chatAgent;
  }

  /** The public half of the chat agent's SSH key: an administrator puts it only on the servers the bot may reach. */
  async chatAgentPublicKey(): Promise<string> {
    return (await ensureKeyPairAt(this.chatAgentSshDir(), CHAT_AGENT_KEY_COMMENT, { restricted: this.chatAgentRestrictedKeys })).publicKey;
  }

  /**
   * A new key for the chat agent, used for every terminal it opens from now on. The old public key stays
   * authorized on every server it was put on until an administrator removes it there (its line ends in
   * CHAT_AGENT_KEY_COMMENT). Terminals already open keep their connection until they close.
   */
  async rotateChatAgentKey(): Promise<string> {
    const key = await ensureKeyPairAt(this.chatAgentSshDir(), CHAT_AGENT_KEY_COMMENT, {
      rotate: true,
      restricted: this.chatAgentRestrictedKeys,
    });
    if (this.chatAgentResolved) this.chatAgentResolved.user = { ...this.chatAgentResolved.user, sshPublicKey: key.publicKey };
    return key.publicKey;
  }

  /**
   * A linked person's answer, from chat, to a change or a plan of the chat agent's. Checked as a second
   * person's answer in the app is: the chat agent is the one who asks, so on production the answer has
   * to come from an administrator or an approver group, never from a turned off account, and one person
   * counts once. A change to sshs3's own rules is only answered in the app. With `approvers` "admins",
   * here or in the fence the run was started with, the channel takes answers from administrators only.
   */
  async answerForChatAgent(
    approverUserId: string,
    answer: {
      taskId: string;
      id: string;
      kind: 'change' | 'plan';
      approved: boolean;
      note?: string;
      /** Where the answer was given: a chat service, or absent for the app itself. */
      via?: ChatServiceName;
      approvers?: 'linked' | 'admins';
    },
  ): Promise<ChatAgentAnswer> {
    const refused = (message: string): ChatAgentAnswer => ({ outcome: 'refused', message });
    // The server's own accounts are never found here: the chat agent never answers for itself.
    const me = this.account(approverUserId);
    if (!me) return refused('Your sshs3 account was not found. Link your chat account again.');
    if (me.disabled) return refused('Your sshs3 account is turned off, so it cannot approve.');
    const hub = (await this.getChatAgentTenant()).hub;
    let subject: ReturnType<HubService['chatApprovalSubject']>;
    try {
      subject = hub.chatApprovalSubject(answer.taskId, answer.id);
    } catch {
      return refused('That is not waiting any more: it was answered, or its run was stopped.');
    }
    if (subject.kind !== answer.kind) return refused('That is not waiting any more: it was answered, or its run was stopped.');
    // Whoever asks, in chat or in the app: the channel's rule as it is now holds too, when it is stricter.
    const no = this.chatAgentRefusal(me, subject, this.stricterApprovers(hub, answer.taskId, answer.approvers));
    if (no) return refused(no);
    const person = { id: me.id, name: me.displayName || me.username, ...(answer.via ? { via: answer.via } : {}) };
    try {
      if (answer.kind === 'plan')
        await hub.decidePlanFromChat(answer.taskId, answer.id, answer.approved, person, answer.note ? { note: answer.note } : {});
      else await hub.approveFromChat(answer.taskId, answer.id, answer.approved, person, answer.note);
    } catch (err) {
      return refused(err instanceof Error ? err.message : 'That could not be answered.');
    }
    if (!answer.approved) return { outcome: 'denied', message: `${person.name} said no. Nothing runs.` };
    let after: ReturnType<HubService['chatApprovalSubject']> | undefined;
    try {
      after = hub.chatApprovalSubject(answer.taskId, answer.id);
    } catch {
      after = undefined;
    }
    if (after?.waiting) {
      const yes = new Set(after.votes.filter((v) => v.allowed).map((v) => v.actorId ?? v.actor)).size;
      const remaining = Math.max(1, after.requiredApprovals - yes);
      return {
        outcome: 'waiting',
        remaining,
        message: `${person.name} approved. It needs ${remaining === 1 ? 'one more person' : `${remaining} more people`}.`,
      };
    }
    return { outcome: 'approved', message: `${person.name} approved.` };
  }

  /** The stricter of the approvers rule given and the one the conversation's channel has now. */
  private stricterApprovers(hub: HubService, taskId: string, given?: 'linked' | 'admins'): 'linked' | 'admins' | undefined {
    const chat = hub.store.data.tasks.find((t) => t.id === taskId)?.chat;
    const now = chat ? this.chatAnswering?.currentApprovers?.(chat) : undefined;
    return given === 'admins' || now === 'admins' ? 'admins' : (given ?? now);
  }

  /**
   * Why this person may not answer this change or plan of the chat agent's, or nothing when they may.
   * The same rules from chat and in the app: a second person's in the app, the channel's approvers rule
   * (from the request or the fence the run was started with, the stricter), and one answer per person.
   */
  private chatAgentRefusal(
    me: PeerAccount,
    subject: ReturnType<HubService['chatApprovalSubject']>,
    approvers?: 'linked' | 'admins',
  ): string | undefined {
    if (subject.setting) return 'A change to sshs3\'s own rules can only be answered in the app.';
    if (!subject.waiting) return 'That is not waiting any more: it was answered, or its run was stopped.';
    if ((approvers === 'admins' || subject.approvers === 'admins') && me.role !== 'admin') return 'In this channel only an administrator can answer.';
    const mine = `user:${me.id}`;
    if (subject.votes.some((v) => v.actorId === mine)) return 'You already answered this.';
    const may = this.authorizePeerApproval({
      requesterUserId: CHAT_AGENT_ID,
      requesterUsername: CHAT_AGENT_USERNAME,
      approver: me,
      targetTags: subject.targetTags,
      requiredApprovals: subject.requiredApprovals,
      // The votes as the rule reads them: by account id, so one person is counted once.
      existingApprovals: subject.votes.map((v) => ({
        actorId: v.actorId?.startsWith('user:') ? v.actorId.slice(5) : v.actorId,
        actor: v.actor,
        allowed: v.allowed,
      })),
    });
    if (may.authorized) return undefined;
    return /production/i.test(may.reason ?? '')
      ? 'You cannot approve this. On production it has to be an administrator of this server, or somebody in one of its approver groups.'
      : 'You cannot approve this.';
  }

  /**
   * The chat agent's changes and plans that wait for an answer this person may give, for their window.
   * A change that needs one person reaches no inbox otherwise: the chat agent has no owner to ask. Only
   * read when the chat agent runs already; a list never starts it.
   */
  chatAgentWaitingFor(userId: string): ChatWaitingItem[] {
    const me = this.account(userId);
    const hub = this.chatAgentResolved?.hub;
    if (!me || me.disabled || !hub) return [];
    const out: ChatWaitingItem[] = [];
    for (const task of hub.store.data.tasks) {
      if (!task.chat) continue;
      const asks: Array<{ id: string; kind: 'change' | 'plan' }> = [
        ...task.changes.filter((c) => c.status === 'pending').map((c) => ({ id: c.id, kind: 'change' as const })),
        ...(task.plan?.status === 'proposed' ? [{ id: task.plan.id, kind: 'plan' as const }] : []),
      ];
      for (const ask of asks) {
        let subject: ReturnType<HubService['chatApprovalSubject']>;
        try {
          subject = hub.chatApprovalSubject(task.id, ask.id);
        } catch {
          continue;
        }
        if (this.chatAgentRefusal(me, subject, this.stricterApprovers(hub, task.id))) continue;
        const change = ask.kind === 'change' ? task.changes.find((c) => c.id === ask.id) : undefined;
        out.push({
          taskId: task.id,
          id: ask.id,
          kind: ask.kind,
          service: task.chat.service,
          channelName: task.chat.channelName,
          askedBy: task.chat.askedBy.name,
          description: change ? change.description : (task.plan?.goal ?? task.title),
          ...(change?.command ? { command: change.command } : {}),
          ...(change?.target ? { target: change.target } : {}),
          ...(change?.riskLevel ? { risk: change.riskLevel } : {}),
          requiredApprovals: subject.requiredApprovals,
          approvedBy: subject.votes.filter((v) => v.allowed).map((v) => v.actor),
          at: task.updatedAt,
        });
      }
    }
    return out.sort((a, b) => a.at - b.at);
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

  /**
   * Stops what runs for an account (its hub with its schedules and runs, its terminals, its
   * connections) and keeps everything it has. For an account that was turned off: it starts again,
   * as it was, when the account is turned on and signs in.
   */
  async stopTenant(userId: string): Promise<void> {
    // The chat agent is the server's own: it is stopped with the server, never with an account.
    if (userId.startsWith(SERVICE_ACCOUNT_PREFIX)) return;
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
  }

  async disposeTenant(userId: string): Promise<void> {
    // The chat agent is the server's own: it is stopped with the server, never removed with an account.
    if (userId.startsWith(SERVICE_ACCOUNT_PREFIX)) return;
    await this.stopTenant(userId);
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
    if (this.boardTimer) {
      clearTimeout(this.boardTimer);
      this.boardTimer = undefined;
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
    const chatAgent = this.chatAgentResolved ?? (this.chatAgent ? await this.chatAgent.catch(() => undefined) : undefined);
    this.chatAgent = undefined;
    this.chatAgentResolved = undefined;
    if (chatAgent) {
      await chatAgent.hub.dispose().catch(() => {});
      await chatAgent.bridge.dispose().catch(() => {});
    }
  }
}
