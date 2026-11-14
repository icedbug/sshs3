import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createTwoFilesPatch } from "diff";
import { nativeEvents } from '../desktop/nativeEvents';
import { FileTools } from "./FileTools";
import { SmartcardDetector } from "../../smartcard/SmartcardDetector";
import type { IpcBridge } from "../../IpcBridge";
import { HubService, type HubHost } from "./HubService";
import {
  HUB_CHANGED,
  type WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import { DEFAULT_SHORTCUTS } from "../../../shared/types/settings";
import type {
  IStorageProvider,
  S3Config,
  SFTPConfig,
} from "../../../shared/types/storage";
import type { TeamVaultPayload } from "../../../shared/types/teamVault";
import type { InventoryTarget } from "./ContextService";
import { boundedContext, clip, maskContext, safeError } from "./privacy";
import {
  appendDemoActivity,
  deleteDemoMemory,
  deleteDemoServer,
  getBuiltinSnippets,
  getDemoActivityLog,
  getDemoMemories,
  getDemoS3Profiles,
  getDemoServers,
  getDemoSnippets,
  isDemoMode,
  saveDemoMemory,
  updateDemoServer,
  upsertDemoServer,
} from "./demoWorkspace";

export interface CreateHubOptions {
  hubDirectory?: string;
  aiConfigFilePath?: string;
  s3ConfigFilePath?: string;
  defaultActorName?: string;
  /** On the web server: the user id in the alert hook's address. */
  alertHookOwner?: string;
  /** On the web server: whether this user administers it (sets up the team's bucket). */
  teamAdmin?: () => boolean;
  peerPresenceProvider?: HubHost["peerPresenceProvider"];
  onSharedWorkspaceChanged?: () => void;
}

export function createHub(
  bridge: IpcBridge,
  // relaunchForDemoMode is optional: only the desktop app can restart itself into/out of demo mode.
  lifecycle: Pick<HubHost, "backgroundChanged" | "show" | "relaunchForDemoMode">,
  options?: CreateHubOptions,
): HubService {
  // Team Vault keeps one vault per team (every call takes a vaultId); the hooks below use each vault unlocked here.
  const unlockedVaultIds = async (): Promise<string[]> => {
    const vaultIds = await bridge.teamVaultService
      .listVaultIds()
      .catch((): string[] => []);
    return vaultIds.filter((vaultId) =>
      bridge.teamVaultService.isUnlocked(vaultId),
    );
  };
  /** The first unlocked Team Vault holding SSH profile `profileId`, with that profile. */
  const findTeamVaultProfile = async (profileId: string) => {
    for (const vaultId of await unlockedVaultIds()) {
      const profile = (
        await bridge.teamVaultService.getPayload(vaultId)
      ).ssh.find((p) => p.id === profileId);
      if (profile) return { vaultId, profile };
    }
    return undefined;
  };
  const resolveTargetStorageProvider = async (
    targetRef: string,
  ): Promise<IStorageProvider> => {
    const raw = (targetRef || "local").trim();
    const q = raw.replace(/^@/, "").toLowerCase();
    if (q === "local") {
      return await bridge.storageRegistry.getOrCreate({
        id: "ai-hub-local",
        name: "Local Storage",
        type: "local",
      });
    }
    const existingProvider = bridge.storageRegistry.get(raw);
    if (existingProvider) return existingProvider;

    const termSession = hub.terminals
      .list()
      .find(
        (t) =>
          t.id.toLowerCase() === q ||
          (t.profileId && t.profileId.toLowerCase() === q) ||
          t.label.toLowerCase() === q,
      );
    if (termSession) {
      if (termSession.kind === "local") {
        return await bridge.storageRegistry.getOrCreate({
          id: "ai-hub-local",
          name: termSession.label || "Local Storage",
          type: "local",
        });
      }
      if (termSession.kind === "ssh") {
        const live = bridge.sshPtyManager?.getSession?.(termSession.id);
        if (live) {
          const providerId = `ai-storage-ssh:${termSession.id}`;
          let sftpConfig: SFTPConfig = {
            ...live.config,
            id: providerId,
            port: live.config.port ?? 22,
          };
          if (bridge.smartcard) {
            sftpConfig = await bridge.smartcard.prepareSftpSmartcardConfig(
              sftpConfig,
              providerId,
            );
            sftpConfig = await bridge.smartcard.prepareFido2SftpConfig(
              sftpConfig,
              providerId,
            );
          }
          return await bridge.storageRegistry.getOrCreate(
            {
              id: providerId,
              name: termSession.label,
              type: "sftp",
              sftpConfig,
            },
            { profileId: termSession.profileId },
          );
        }
      }
    }

    const profiles = await bridge.profileStore
      .getProfiles()
      .catch(() => ({ ssh: [], s3: [], folders: [] }));
    const s3Candidates: S3Config[] = [...(profiles.s3 ?? [])];
    const sshCandidates = [...(profiles.ssh ?? [])];

    for (const vaultId of await unlockedVaultIds()) {
      try {
        const payload = await bridge.teamVaultService.getPayload(vaultId);
        for (const s3p of payload.s3 ?? []) {
          if (!s3Candidates.some((x) => x.id === s3p.id)) {
            s3Candidates.push(s3p);
          }
        }
        for (const sshp of payload.ssh ?? []) {
          if (!sshCandidates.some((x) => x.id === sshp.id)) {
            sshCandidates.push(sshp);
          }
        }
      } catch {
        // Ignore locked/unreadable vault
      }
    }
    for (const syncedSrv of hub.store.data.s3SyncedServers ?? []) {
      if (!sshCandidates.some((x) => x.id === syncedSrv.id)) {
        sshCandidates.push({
          ...syncedSrv,
          authType: syncedSrv.authType ?? "agent",
        });
      }
    }
    if (isDemoMode()) {
      for (const ds3 of getDemoS3Profiles()) {
        if (!s3Candidates.some((x) => x.id === ds3.id)) s3Candidates.push(ds3);
      }
      for (const dsrv of getDemoServers()) {
        if (!sshCandidates.some((x) => x.id === dsrv.id)) {
          sshCandidates.push({
            ...dsrv,
            authType: dsrv.authType ?? "agent",
          });
        }
      }
    }

    const matchedS3 =
      s3Candidates.find(
        (s) =>
          s.id.toLowerCase() === q ||
          `s3-${s.id.toLowerCase()}` === q ||
          s.name.toLowerCase() === q ||
          (s.initialPath && s.initialPath.toLowerCase() === q),
      ) ||
      s3Candidates.find(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.initialPath && s.initialPath.toLowerCase().includes(q)),
      );
    if (matchedS3) {
      const providerId = `s3-${matchedS3.id}`;
      return await bridge.storageRegistry.getOrCreate(
        {
          id: providerId,
          name: matchedS3.name,
          type: "s3",
          s3Config: { ...matchedS3, id: matchedS3.id },
        },
        { profileId: matchedS3.id },
      );
    }

    const matchedSsh =
      sshCandidates.find(
        (s) =>
          s.id.toLowerCase() === q ||
          `sftp-${s.id.toLowerCase()}` === q ||
          s.name.toLowerCase() === q ||
          s.host.toLowerCase() === q,
      ) ||
      sshCandidates.find(
        (s) =>
          s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q),
      );
    if (matchedSsh) {
      const providerId = `sftp-${matchedSsh.id}`;
      let sftpConfig: SFTPConfig = {
        ...matchedSsh,
        id: providerId,
        port: matchedSsh.port ?? 22,
      };
      if (bridge.resolveProxyJumpConfig) {
        sftpConfig = await bridge.resolveProxyJumpConfig(sftpConfig);
      }
      if (bridge.smartcard) {
        sftpConfig = await bridge.smartcard.prepareSftpSmartcardConfig(
          sftpConfig,
          providerId,
        );
        sftpConfig = await bridge.smartcard.prepareFido2SftpConfig(
          sftpConfig,
          providerId,
        );
        sftpConfig = await bridge.smartcard.prepareSftpSshCaConfig(sftpConfig);
      }
      return await bridge.storageRegistry.getOrCreate(
        {
          id: providerId,
          name: matchedSsh.name || matchedSsh.host,
          type: "sftp",
          sftpConfig,
        },
        { profileId: matchedSsh.id },
      );
    }

    throw new Error(`Storage target "${targetRef}" not found`);
  };

  const readProviderTextFile = async (
    provider: IStorageProvider,
    remotePath: string,
  ): Promise<string> => {
    if (bridge.fileEditorService?.readFile && bridge.storageRegistry.has(provider.id)) {
      const res = await bridge.fileEditorService.readFile(
        bridge.storageRegistry,
        provider.id,
        remotePath,
        64_000,
      );
      if (res.isBinary || res.notUtf8) {
        throw new Error(`File "${remotePath}" is binary or non-UTF8`);
      }
      return clip(maskContext(res.content), 64_000);
    }
    if (typeof provider.readFile === "function") {
      const buf = await provider.readFile(remotePath);
      return clip(maskContext(buf.toString("utf-8")), 64_000);
    }
    const stream = await provider.createReadStream(remotePath);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return boundedContext(
      maskContext(Buffer.concat(chunks).toString("utf-8")),
      64_000,
    );
  };

  /**
   * The saved profile of a server, as it can be used with nobody there to
   * answer a prompt. A profile that needs a password, a smartcard or a touch
   * is refused: its terminal has to be opened by a person first.
   */
  const resolveUnattendedProfile = async (profileId: string) => {
    const profiles = await bridge.profileStore.getProfiles();
    let profile = profiles.ssh.find((p) => p.id === profileId);
    if (!profile) {
      const team = await findTeamVaultProfile(profileId);
      if (team) profile = team.profile;
    }
    if (!profile) {
      const synced = (hub.store.data.s3SyncedServers ?? []).find(
        (s) => s.id === profileId,
      );
      if (synced) {
        profile = {
          ...synced,
          authType: synced.authType ?? "agent",
        };
      }
    }
    if (!profile) throw new Error(`Saved SSH profile "${profileId}" not found`);
    const localOv = hub.store.data.localOverrides?.[profileId];
    const effectiveProfile = {
      ...profile,
      ...(localOv?.username ? { username: localOv.username } : {}),
      ...(localOv?.privateKeyPath ? { privateKeyPath: localOv.privateKeyPath } : {}),
      ...(localOv?.authType ? { authType: localOv.authType } : {}),
    };
    if (["password", "smartcard", "fido2"].includes(effectiveProfile.authType)) {
      throw new Error(
        `Node "${effectiveProfile.name || effectiveProfile.host}" requires interactive auth; open its terminal tab first.`,
      );
    }
    return effectiveProfile;
  };

  /** Runs a script on stdin of a process and collects what it prints. Nothing is typed into a terminal. */
  const runWithStdin = (
    file: string,
    args: string[],
    script: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<{ ok: boolean; stdout: string; error?: string }> =>
    new Promise((resolve) => {
      const child = spawn(file, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (result: { ok: boolean; stdout: string; error?: string }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, stdout, error: "No answer in time" });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 8_000_000) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => finish({ ok: false, stdout, error: safeError(error) }));
      child.on("close", (code) =>
        // ssh answers 255 when it could not connect or sign in; anything else is the script's own business.
        finish(code === 255 ? { ok: false, stdout, error: boundedContext(stderr.trim() || "Could not connect", 300) } : { ok: true, stdout }),
      );
      child.stdin.on("error", () => undefined);
      child.stdin.end(script);
    });

  const hub: HubService = new HubService({
    ...lifecycle,
    aiConfigFilePath: options?.aiConfigFilePath,
    s3ConfigFilePath: options?.s3ConfigFilePath,
    defaultActorName: options?.defaultActorName,
    alertHookOwner: options?.alertHookOwner,
    teamAdmin: options?.teamAdmin,
    peerPresenceProvider: options?.peerPresenceProvider,
    onSharedWorkspaceChanged: options?.onSharedWorkspaceChanged,
    file: (...args) => files.invoke(...args),
    changed: () => {
      bridge.broadcast(HUB_CHANGED);
      if (process.env.SSHS3_NATIVE_HERMES === '1') nativeEvents.emit('toolsChanged');
      options?.onSharedWorkspaceChanged?.();
    },
    workspaceServers: async (): Promise<WorkspaceServerSummary[]> => {
      const servers: WorkspaceServerSummary[] = [];
      for (const vaultId of await unlockedVaultIds()) {
        try {
          const teamPayload =
            await bridge.teamVaultService.getPayloadForRenderer(vaultId);
          for (const p of teamPayload.ssh ?? []) {
            if (servers.some((s) => s.id === p.id)) continue;
            servers.push({
              id: p.id,
              name: p.name || p.host,
              host: p.host,
              port: p.port || 22,
              username: p.username,
              authType: p.authType,
              privateKeyPath: p.privateKeyPath,
              pkcs11LibPath: p.pkcs11LibPath,
              fido2Resident: p.fido2Resident,
              proxyJump: p.proxyJump,
              proxyJumpProfileId: p.proxyJumpProfileId,
              forwardAgent: p.forwardAgent,
              x11Forwarding: p.x11Forwarding,
              x11Display: p.x11Display,
              compression: p.compression,
              serverAliveInterval: p.serverAliveInterval,
              initialPath: p.initialPath,
              poolId: p.poolId,
              dotfilesSyncPolicy: p.dotfilesSyncPolicy,
              autoReconnect: p.autoReconnect,
              maxReconnectAttempts: p.maxReconnectAttempts,
              reconnectDelayMs: p.reconnectDelayMs,
              extraOptions: p.extraOptions,
              tunnels: p.tunnels,
              folder: p.group,
              group: p.group,
              cluster: p.cluster,
              nodeRole: p.nodeRole,
              description: p.description,
              role: p.role,
              tags: p.tags,
              shared: true,
              // Its members get it through the vault, encrypted; it is not copied into the plain team bucket.
              fromVault: true,
              updatedAt: p.updatedAt,
              updatedBy: p.updatedBy,
            });
          }
        } catch {
          // Ignore if team vault is locked or unconfigured
        }
      }
      try {
        const profiles = await bridge.profileStore.getProfiles();
        for (const p of profiles.ssh ?? []) {
          if (servers.some((s) => s.id === p.id)) continue;
          servers.push({
            id: p.id,
            name: p.name || p.host,
            host: p.host,
            port: p.port || 22,
            username: p.username,
            authType: p.authType,
            privateKeyPath: p.privateKeyPath,
            pkcs11LibPath: p.pkcs11LibPath,
            fido2Resident: p.fido2Resident,
            proxyJump: p.proxyJump,
            proxyJumpProfileId: p.proxyJumpProfileId,
            forwardAgent: p.forwardAgent,
            x11Forwarding: p.x11Forwarding,
            x11Display: p.x11Display,
            compression: p.compression,
            serverAliveInterval: p.serverAliveInterval,
            initialPath: p.initialPath,
            poolId: p.poolId,
            dotfilesSyncPolicy: p.dotfilesSyncPolicy,
            autoReconnect: p.autoReconnect,
            maxReconnectAttempts: p.maxReconnectAttempts,
            reconnectDelayMs: p.reconnectDelayMs,
            extraOptions: p.extraOptions,
            tunnels: p.tunnels,
            folder: p.group,
            group: p.group,
            cluster: p.cluster,
            nodeRole: p.nodeRole,
            description: p.description,
            role: p.role,
            tags: p.tags,
            shared: p.shared !== false,
            updatedAt: p.updatedAt,
            updatedBy: p.updatedBy,
          });
        }
      } catch {
        // Ignore profile read errors
      }
      if (isDemoMode()) {
        for (const demoSrv of getDemoServers()) {
          if (!servers.some((s) => s.id === demoSrv.id)) {
            servers.push(demoSrv);
          }
        }
      }
      return servers;
    },
    getTeamWorkspaceData: async () => {
      const vaultIds = await unlockedVaultIds();
      const payloads: TeamVaultPayload[] = [];
      for (const vaultId of vaultIds) {
        try {
          payloads.push(
            await bridge.teamVaultService.getPayloadForRenderer(vaultId),
          );
        } catch {
          // Non-fatal
        }
      }
      if (payloads.length > 0) {
        return {
          memories: [
            ...payloads.flatMap((payload) =>
              (payload.workspaceMemories ?? []).map((m) => ({
                ...m,
                id: m.id,
                kind: (m.kind === "skill" ? "skill" : "memory") as "memory" | "skill",
                scope: m.scope,
                title: m.title,
                text: m.text,
                author: m.author,
                updatedAt: m.updatedAt,
              })),
            ),
            ...(isDemoMode() ? getDemoMemories() : []),
          ],
          activityLog: [
            ...payloads.flatMap((payload) => payload.activityLog ?? []),
            ...(isDemoMode() ? getDemoActivityLog() : []),
          ],
          actor:
            bridge.teamVaultService.getUnlockedRecipientId(vaultIds[0]) ??
            undefined,
        };
      }
      if (isDemoMode()) {
        return {
          memories: getDemoMemories(),
          activityLog: getDemoActivityLog(),
          actor: "jacob",
        };
      }
      return { memories: [], activityLog: [] };
    },
    recordWorkspaceActivity: async (event) => {
      if (isDemoMode()) {
        appendDemoActivity(event);
      }
      for (const vaultId of await unlockedVaultIds()) {
        await bridge.teamVaultService.recordWorkspaceActivity(vaultId, event);
        bridge.scheduleTeamVaultAutoPush?.(vaultId);
      }
      bridge.scheduleAutoSync?.();
    },
    saveWorkspaceMemory: async (entry) => {
      if (isDemoMode()) {
        saveDemoMemory(entry);
      }
      for (const vaultId of await unlockedVaultIds()) {
        await bridge.teamVaultService.saveWorkspaceMemory(vaultId, entry);
        bridge.scheduleTeamVaultAutoPush?.(vaultId);
      }
      bridge.scheduleAutoSync?.();
    },
    deleteWorkspaceMemory: async (id) => {
      if (isDemoMode()) {
        deleteDemoMemory(id);
      }
      for (const vaultId of await unlockedVaultIds()) {
        await bridge.teamVaultService.deleteWorkspaceMemory(vaultId, id);
        bridge.scheduleTeamVaultAutoPush?.(vaultId);
      }
      bridge.scheduleAutoSync?.();
    },
    describeServer: async (input) => {
      const cleanTags = input.tags
        ?.map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 16);
      if (
        isDemoMode() &&
        updateDemoServer({
          profileId: input.profileId,
          cluster: input.cluster,
          nodeRole: input.nodeRole,
          description: input.description,
          role: input.role,
          tags: cleanTags,
        })
      ) {
        return;
      }
      if (input.shared) {
        const team = await findTeamVaultProfile(input.profileId);
        if (team) {
          const existing = team.profile;
          await bridge.teamVaultService.saveSSHProfile(team.vaultId, {
            ...existing,
            cluster:
              input.cluster !== undefined
                ? input.cluster.trim() || undefined
                : existing.cluster,
            nodeRole:
              input.nodeRole !== undefined
                ? input.nodeRole.trim() || undefined
                : existing.nodeRole,
            description: input.description?.trim() || undefined,
            role: input.role?.trim() || undefined,
            tags: cleanTags?.length ? cleanTags : undefined,
            updatedAt: new Date().toISOString(),
            updatedBy:
              bridge.teamVaultService.getUnlockedRecipientId(team.vaultId) ??
              existing.updatedBy,
          });
          bridge.scheduleTeamVaultAutoPush?.(team.vaultId);
          return;
        }
      }
      const profiles = await bridge.profileStore.getProfiles();
      const existing = profiles.ssh.find((p) => p.id === input.profileId);
      if (!existing) return;
      await bridge.profileStore.saveSSH({
        ...existing,
        shared: input.shared ?? existing.shared,
        cluster:
          input.cluster !== undefined
            ? input.cluster.trim() || undefined
            : existing.cluster,
        nodeRole:
          input.nodeRole !== undefined
            ? input.nodeRole.trim() || undefined
            : existing.nodeRole,
        description: input.description?.trim() || undefined,
        role: input.role?.trim() || undefined,
        tags: cleanTags?.length ? cleanTags : undefined,
        updatedAt: new Date().toISOString(),
      });
      bridge.scheduleAutoSync?.();
    },
    upsertServer: async (input) => {
      const id = input.id?.trim() || crypto.randomUUID();
      const cleanTags = input.tags
        ?.map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 16);
      const isShared = input.shared ?? true;
      const nowIso = new Date().toISOString();
      if (isDemoMode()) {
        upsertDemoServer({
          ...input,
          id,
          tags: cleanTags,
        });
      }
      const team = isShared ? await findTeamVaultProfile(id) : undefined;
      // A server not yet in any Team Vault goes to the first unlocked one.
      const teamVaultId =
        team?.vaultId ?? (isShared ? (await unlockedVaultIds())[0] : undefined);
      if (teamVaultId) {
        const existing = team?.profile;
        const actor =
          bridge.teamVaultService.getUnlockedRecipientId(teamVaultId) ??
          "team-member";
        await bridge.teamVaultService.saveSSHProfile(teamVaultId, {
          ...existing,
          id,
          name: input.name.trim(),
          host: input.host.trim(),
          port: input.port || existing?.port || 22,
          username: input.username.trim() || existing?.username || "root",
          authType: input.authType ?? existing?.authType ?? "agent",
          privateKeyPath: input.privateKeyPath ?? existing?.privateKeyPath,
          pkcs11LibPath: input.pkcs11LibPath ?? existing?.pkcs11LibPath,
          fido2Resident: input.fido2Resident ?? existing?.fido2Resident,
          proxyJump: input.proxyJump ?? existing?.proxyJump,
          proxyJumpProfileId: input.proxyJumpProfileId ?? existing?.proxyJumpProfileId,
          forwardAgent: input.forwardAgent ?? existing?.forwardAgent,
          x11Forwarding: input.x11Forwarding ?? existing?.x11Forwarding,
          x11Display: input.x11Display ?? existing?.x11Display,
          compression: input.compression ?? existing?.compression,
          serverAliveInterval: input.serverAliveInterval ?? existing?.serverAliveInterval,
          initialPath: input.initialPath ?? existing?.initialPath,
          poolId: input.poolId ?? existing?.poolId,
          dotfilesSyncPolicy: input.dotfilesSyncPolicy ?? existing?.dotfilesSyncPolicy,
          autoReconnect: input.autoReconnect ?? existing?.autoReconnect,
          maxReconnectAttempts: input.maxReconnectAttempts ?? existing?.maxReconnectAttempts,
          reconnectDelayMs: input.reconnectDelayMs ?? existing?.reconnectDelayMs,
          extraOptions: input.extraOptions ?? existing?.extraOptions,
          tunnels: input.tunnels ?? existing?.tunnels,
          group:
            input.folder?.trim() || input.cluster?.trim() || existing?.group,
          cluster: input.cluster?.trim() || existing?.cluster,
          nodeRole: input.nodeRole?.trim() || existing?.nodeRole,
          role: input.role?.trim() || existing?.role,
          description: input.description?.trim() || existing?.description,
          tags: cleanTags?.length ? cleanTags : existing?.tags,
          shared: true,
          updatedAt: nowIso,
          updatedBy: actor,
        });
        bridge.scheduleTeamVaultAutoPush?.(teamVaultId);
      }
      const profiles = await bridge.profileStore.getProfiles();
      const existing = profiles.ssh.find((p) => p.id === id);
      const savedProfile = {
        ...existing,
        id,
        name: input.name.trim(),
        host: input.host.trim(),
        port: input.port || existing?.port || 22,
        username: input.username.trim() || existing?.username || "root",
        authType: input.authType ?? existing?.authType ?? "agent",
        privateKeyPath: input.privateKeyPath ?? existing?.privateKeyPath,
        pkcs11LibPath: input.pkcs11LibPath ?? existing?.pkcs11LibPath,
        fido2Resident: input.fido2Resident ?? existing?.fido2Resident,
        proxyJump: input.proxyJump ?? existing?.proxyJump,
        proxyJumpProfileId: input.proxyJumpProfileId ?? existing?.proxyJumpProfileId,
        forwardAgent: input.forwardAgent ?? existing?.forwardAgent,
        x11Forwarding: input.x11Forwarding ?? existing?.x11Forwarding,
        x11Display: input.x11Display ?? existing?.x11Display,
        compression: input.compression ?? existing?.compression,
        serverAliveInterval: input.serverAliveInterval ?? existing?.serverAliveInterval,
        initialPath: input.initialPath ?? existing?.initialPath,
        poolId: input.poolId ?? existing?.poolId,
        dotfilesSyncPolicy: input.dotfilesSyncPolicy ?? existing?.dotfilesSyncPolicy,
        autoReconnect: input.autoReconnect ?? existing?.autoReconnect,
        maxReconnectAttempts: input.maxReconnectAttempts ?? existing?.maxReconnectAttempts,
        reconnectDelayMs: input.reconnectDelayMs ?? existing?.reconnectDelayMs,
        extraOptions: input.extraOptions ?? existing?.extraOptions,
        tunnels: input.tunnels ?? existing?.tunnels,
        group:
          input.folder?.trim() || input.cluster?.trim() || existing?.group,
        cluster: input.cluster?.trim() || existing?.cluster,
        nodeRole: input.nodeRole?.trim() || existing?.nodeRole,
        role: input.role?.trim() || existing?.role,
        description: input.description?.trim() || existing?.description,
        tags: cleanTags?.length ? cleanTags : existing?.tags,
        shared: isShared,
        updatedAt: nowIso,
      };
      await bridge.profileStore.saveSSH(savedProfile);
      bridge.scheduleAutoSync?.();
      return {
        id,
        name: savedProfile.name,
        host: savedProfile.host,
        port: savedProfile.port,
        username: savedProfile.username,
        authType: savedProfile.authType,
        privateKeyPath: savedProfile.privateKeyPath,
        pkcs11LibPath: savedProfile.pkcs11LibPath,
        fido2Resident: savedProfile.fido2Resident,
        proxyJump: savedProfile.proxyJump,
        proxyJumpProfileId: savedProfile.proxyJumpProfileId,
        forwardAgent: savedProfile.forwardAgent,
        x11Forwarding: savedProfile.x11Forwarding,
        x11Display: savedProfile.x11Display,
        compression: savedProfile.compression,
        serverAliveInterval: savedProfile.serverAliveInterval,
        initialPath: savedProfile.initialPath,
        poolId: savedProfile.poolId,
        dotfilesSyncPolicy: savedProfile.dotfilesSyncPolicy,
        autoReconnect: savedProfile.autoReconnect,
        maxReconnectAttempts: savedProfile.maxReconnectAttempts,
        reconnectDelayMs: savedProfile.reconnectDelayMs,
        extraOptions: savedProfile.extraOptions,
        tunnels: savedProfile.tunnels,
        folder: savedProfile.group,
        group: savedProfile.group,
        cluster: savedProfile.cluster,
        nodeRole: savedProfile.nodeRole,
        role: savedProfile.role,
        description: savedProfile.description,
        tags: savedProfile.tags,
        shared: isShared,
        updatedAt: nowIso,
      };
    },
    deleteServer: async (profileId) => {
      if (isDemoMode()) {
        deleteDemoServer(profileId);
      }
      try {
        for (const vaultId of await unlockedVaultIds()) {
          await bridge.teamVaultService
            .deleteSSHProfile(vaultId, profileId)
            .catch(() => {});
          bridge.scheduleTeamVaultAutoPush?.(vaultId);
        }
      } catch {
        // Ignore
      }
      await bridge.profileStore.deleteSSH(profileId).catch(() => {});
      bridge.scheduleAutoSync?.();
    },
    syncSharedServersFromS3: async (servers, deletedServerIds) => {
      try {
        const profiles = await bridge.profileStore.getProfiles();
        const byId = new Map(profiles.ssh.map((p) => [p.id, p]));
        for (const [delId, delIso] of Object.entries(deletedServerIds ?? {})) {
          const existing = byId.get(delId);
          // A team deletion removes the team's copy, never a profile a person here keeps as their own.
          if (!existing || existing.shared === false) continue;
          const delMs =
            typeof delIso === "number"
              ? delIso
              : Date.parse(String(delIso)) || Number(delIso) || 0;
          const updMs = Date.parse(existing.updatedAt || "") || 0;
          if (delMs >= updMs) {
            await bridge.profileStore.deleteSSH(delId).catch(() => {});
            byId.delete(delId);
          }
        }
        for (const s of servers) {
          if (!s?.id || !s.host) continue;
          const existing = byId.get(s.id);
          const tRemote = Date.parse(s.updatedAt || "") || 0;
          const tLocal = Date.parse(existing?.updatedAt || "") || 0;
          // A profile a person here made personal stays personal: the team's copy does not take it back.
          if (existing?.shared === false) continue;
          if (!existing || tRemote > tLocal) {
            await bridge.profileStore.saveSSH({
              ...existing,
              id: s.id,
              name: s.name || s.host,
              host: s.host,
              port: s.port || 22,
              username: s.username || existing?.username || "root",
              authType: existing?.authType || "agent",
              group: s.folder || s.group || s.cluster || existing?.group,
              cluster: s.cluster,
              nodeRole: s.nodeRole,
              role: s.role,
              description: s.description,
              tags: s.tags,
              shared: true,
              updatedAt: s.updatedAt || new Date().toISOString(),
              updatedBy: s.updatedBy,
            });
          }
        }
      } catch {
        // Ignore profileStore sync errors
      }
    },
    inventoryTargets: async () => {
      const profiles = await bridge.profileStore.getProfiles();
      const targets: InventoryTarget[] = profiles.ssh.map((p) => ({
        id: p.id,
        kind: "ssh",
        label: p.name || p.host,
        address: p.host,
        port: p.port || 22,
        blocked:
          p.proxyJump || p.proxyJumpProfileId || p.proxy
            ? "Reachable only through a configured proxy; not probed directly."
            : undefined,
      }));
      for (const p of profiles.s3) {
        const endpoint =
          p.endpoint || `https://s3.${p.region || "us-east-1"}.amazonaws.com`;
        try {
          const url = new URL(endpoint);
          targets.push({
            id: p.id,
            kind: "s3",
            label: p.name,
            address: url.hostname,
            port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
          });
        } catch {
          /* invalid endpoint stays unprobed */
        }
      }
      try {
        for (const c of await bridge.k8sDiscoveryService.listContexts()) {
          const url = new URL(c.server);
          targets.push({
            id: `k8s:${c.contextName}`,
            kind: "k8s",
            label: c.contextName,
            address: url.hostname,
            port: Number(url.port) || 443,
          });
        }
      } catch {
        /* kubeconfig may be absent */
      }
      return targets;
    },
    closeSession: (sessionId) => {
      try {
        bridge.sshPtyManager.kill(sessionId);
      } catch {
        // Already gone.
      }
    },
    openSchedule: async (schedule, label) => {
      let id: string;
      if (schedule.profileId === "local") {
        // On a shared server a local shell is a shell on the server itself, as its own user: there is none.
        if (bridge.tenantHomeDir) throw new Error("This is a shared sshs3 server: a schedule runs on one of your servers, not on the server itself.");
        const session = await bridge.sshPtyManager.createShellSession({
          cols: 100,
          rows: 30,
          shellBinary:
            process.platform === "win32" &&
            !["powershell", "pwsh", "cmd"].includes(schedule.shell)
              ? "wsl.exe"
              : process.platform === "win32"
                ? schedule.shell + ".exe"
                : schedule.shell,
          shellArgs:
            process.platform === "win32" &&
            !["powershell", "pwsh", "cmd"].includes(schedule.shell)
              ? ["--exec", schedule.shell]
              : undefined,
        });
        id = session.sessionId;
      } else {
        const profile = (await bridge.profileStore.getProfiles()).ssh.find(
          (p) => p.id === schedule.profileId,
        );
        if (!profile) throw new Error("Saved target missing");
        if (["password", "smartcard", "fido2"].includes(profile.authType))
          throw new Error(
            "This target requires interactive authentication. Open a terminal and start an assisted task.",
          );
        const config = await bridge.resolveProxyJumpConfig({
          ...profile,
          id: crypto.randomUUID(),
          autoReconnect: false,
          extraOptions: {
            ...profile.extraOptions,
            BatchMode: "yes",
            ConnectTimeout: "10",
          },
        });
        const session = await bridge.sshPtyManager.createSession(config, {
          cols: 100,
          rows: 30,
          // config.id is per session; the profile id identifies a demo target.
          profileId: profile.id,
        });
        id = session.sessionId;
      }
      hub.terminals.register(
        {
          id,
          label,
          kind: schedule.profileId === "local" ? "local" : "ssh",
          profileId: schedule.profileId,
        },
        (data) => bridge.sshPtyManager.write(id, data),
      );
      return id;
    },
    execOnServer: async (profileId, script, timeoutMs = 60_000) => {
      if (profileId === "local") return { ...(await runWithStdin("sh", ["-s"], script, process.env, timeoutMs)), via: "local" as const };
      const sshBinary = process.platform === "win32" ? "ssh.exe" : "ssh";
      // An open tab to this server already has a connection: the script goes over it, beside the terminal, not into it.
      const open = hub.terminals.list().find((t) => t.kind === "ssh" && t.profileId === profileId && t.state !== "disconnected");
      const live = open ? bridge.sshPtyManager.getSession(open.id) : undefined;
      if (live?.controlPath && process.platform !== "win32" && fs.existsSync(live.controlPath) && !live.config.host.startsWith("-") && !live.controlPath.startsWith("-")) {
        const viaTab = await runWithStdin(
          sshBinary,
          ["-S", live.controlPath, "-T", "-o", "ControlMaster=no", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "-o", "RemoteCommand=none", "--", live.config.host, "sh -s"],
          script,
          process.env,
          timeoutMs,
        );
        if (viaTab.ok) return { ...viaTab, via: "open-tab" as const };
      }
      // Otherwise a connection of the hub's own, for as long as the script takes. BatchMode: no prompt is ever shown.
      const profile = await resolveUnattendedProfile(profileId);
      const config = await bridge.resolveProxyJumpConfig({ ...profile, id: crypto.randomUUID(), autoReconnect: false });
      const env: NodeJS.ProcessEnv = { ...process.env, ...SmartcardDetector.buildProxyEnv(config) };
      if (config.agentPath) env.SSH_AUTH_SOCK = config.agentPath;
      const own = await runWithStdin(
        sshBinary,
        ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes", "-o", "RemoteCommand=none", ...SmartcardDetector.buildSSHArguments({ ...config, tunnels: [], x11Forwarding: false }), "sh -s"],
        script,
        env,
        timeoutMs,
      );
      return { ...own, via: "own-connection" as const };
    },
    openServerTerminal: async (profileId) => {
      const effectiveProfile = await resolveUnattendedProfile(profileId);
      const config = await bridge.resolveProxyJumpConfig({
        ...effectiveProfile,
        id: crypto.randomUUID(),
        autoReconnect: false,
        extraOptions: {
          ...effectiveProfile.extraOptions,
          BatchMode: "yes",
          ConnectTimeout: "10",
        },
      });
      const session = await bridge.sshPtyManager.createSession(config, {
        cols: 100,
        rows: 30,
        // config.id is per session; the profile id identifies a demo target.
        profileId: effectiveProfile.id,
      });
      hub.terminals.register(
        {
          id: session.sessionId,
          label: effectiveProfile.name || effectiveProfile.host,
          kind: "ssh",
          profileId: effectiveProfile.id,
        },
        (data) => bridge.sshPtyManager.write(session.sessionId, data),
      );
      // Connected to at its prompt, or not at all: a terminal that never gets ready is closed again
      // and the caller is told why, instead of being handed a session nothing can run in.
      try {
        await hub.terminals.armAtPrompt(session.sessionId, "bash");
      } catch (error) {
        try {
          bridge.sshPtyManager.kill(session.sessionId);
        } catch {
          // Already gone.
        }
        throw new Error(
          `No terminal could be opened on ${effectiveProfile.name || effectiveProfile.host}, so nothing was run there: ${safeError(error)}`,
          { cause: error },
        );
      }
      return session.sessionId;
    },
    extraAppContext: async () => {
      const usedListWithBuiltins =
        typeof bridge.snippetStore?.listWithBuiltins === "function";
      const [profiles, settings, snippets, dotfilesPools, dirSyncProfiles] = await Promise.all([
        bridge.profileStore.getProfiles().catch(() => ({ ssh: [], s3: [], folders: [] })),
        bridge.settingsStore?.getSettings?.().catch(() => ({})) ?? Promise.resolve({}),
        (usedListWithBuiltins
          ? bridge.snippetStore.listWithBuiltins(getBuiltinSnippets())
          : bridge.snippetStore?.list?.()
        )?.catch(() => []) ?? Promise.resolve([]),
        bridge.dotfilePoolStore?.getPools?.().catch(() => []) ?? Promise.resolve([]),
        bridge.directorySyncProfileStore?.list?.().catch(() => []) ?? Promise.resolve([]),
      ]);
      const folderSet = new Set<string>(profiles.folders ?? []);
      const s3List = [...(profiles.s3 ?? [])];
      const snippetList = [...(snippets ?? [])];
      if (!usedListWithBuiltins) {
        const dismissed = new Set(
          hub.store.data.preferences.dismissedBuiltinIds ?? [],
        );
        for (const bs of getBuiltinSnippets()) {
          if (
            !dismissed.has(bs.id) &&
            !snippetList.some((s) => s.id === bs.id)
          ) {
            snippetList.push(bs);
          }
        }
      }
      if (isDemoMode()) {
        for (const d of getDemoServers()) {
          if (d.folder) folderSet.add(d.folder);
        }
        for (const ds3 of getDemoS3Profiles()) {
          if (ds3.group) folderSet.add(ds3.group);
          if (!s3List.some((s) => s.id === ds3.id)) s3List.push(ds3);
        }
        if (!usedListWithBuiltins) {
          for (const ds of getDemoSnippets()) {
            if (!snippetList.some((s) => s.id === ds.id)) snippetList.push(ds);
          }
        }
      }
      const activeTunnels = (bridge.sshTunnelManager?.listActive?.() ?? []).map((t) => ({
        id: t.id,
        connectionId: t.connectionId,
        connectionName: t.connectionName,
        type: t.tunnel.type,
        localPort: t.tunnel.localPort,
        remoteHost: t.tunnel.remoteHost,
        remotePort: t.tunnel.remotePort,
        status: t.status,
      }));
      return {
        folders: Array.from(folderSet),
        s3Profiles: s3List.map((s) => ({
          id: s.id,
          name: s.name,
          endpoint: s.endpoint,
          region: s.region,
          bucket: s.initialPath,
          group: s.group,
        })),
        snippets: snippetList,
        appSettings: (settings ?? {}) as unknown as Record<string, unknown>,
        dotfilesPools: (dotfilesPools ?? []).map((pool) => ({
          id: pool.id,
          name: pool.name,
          files: (pool.files ?? []).map((f) => ({
            id: f.id,
            remotePath: f.remotePath,
            mode: f.mode,
            updatedAt: f.updatedAt,
          })),
        })),
        dirSyncProfiles: (dirSyncProfiles ?? []).map((dp) => ({
          id: dp.id,
          name: dp.name,
          sourceRef: dp.source.providerConfigRef,
          sourcePath: dp.source.path,
          targetRef: dp.target.providerConfigRef,
          targetPath: dp.target.path,
          deleteExtraneous: dp.deleteExtraneous,
        })),
        activeTunnels,
      };
    },
    manageFolders: async (input) => {
      if (input.operation === "create_folder") {
        await bridge.profileStore.saveFolder(input.folderName);
        bridge.scheduleAutoSync?.();
        return { created: input.folderName };
      }
      if (input.operation === "rename_folder") {
        if (!input.newFolderName) throw new Error("newFolderName is required");
        await bridge.profileStore.renameFolder(input.folderName, input.newFolderName);
        bridge.scheduleAutoSync?.();
        return { renamedFrom: input.folderName, renamedTo: input.newFolderName };
      }
      if (input.operation === "delete_folder") {
        await bridge.profileStore.deleteFolder(input.folderName);
        bridge.scheduleAutoSync?.();
        return { deleted: input.folderName };
      }
      throw new Error(`Unsupported folder operation: ${input.operation}`);
    },
    manageS3Profile: async (input) => {
      if (input.operation === "list_dir_sync_profiles") {
        const list = (await bridge.directorySyncProfileStore?.list?.().catch(() => [])) ?? [];
        return { dirSyncProfiles: list };
      }
      if (input.operation === "save_dir_sync_profile") {
        const list = (await bridge.directorySyncProfileStore?.list?.().catch(() => [])) ?? [];
        const q = (input.idOrName || input.name || "").trim().toLowerCase();
        const existing = list.find(
          (p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q,
        );
        const now = new Date().toISOString();
        const saved = await bridge.directorySyncProfileStore.save({
          id: existing?.id || crypto.randomUUID(),
          name: input.name?.trim() || existing?.name || "Directory Sync Profile",
          source: {
            providerConfigRef:
              input.sourceProviderId?.trim() ||
              existing?.source.providerConfigRef ||
              "local",
            path: input.sourcePath?.trim() || existing?.source.path || "/",
          },
          target: {
            providerConfigRef:
              input.targetProviderId?.trim() ||
              existing?.target.providerConfigRef ||
              "local",
            path: input.targetPath?.trim() || existing?.target.path || "/",
          },
          deleteExtraneous: input.deleteExtraneous ?? existing?.deleteExtraneous ?? false,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        });
        bridge.scheduleAutoSync?.();
        return { savedDirSyncProfile: saved };
      }
      if (input.operation === "delete_dir_sync_profile") {
        const list = (await bridge.directorySyncProfileStore?.list?.().catch(() => [])) ?? [];
        const q = (input.idOrName || input.name || "").trim().toLowerCase();
        const existing = list.find(
          (p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q || (q && p.name.toLowerCase().includes(q)),
        );
        const targetId = existing?.id || input.idOrName;
        if (!targetId) throw new Error("Directory Sync profile not found");
        await bridge.directorySyncProfileStore.delete(targetId);
        bridge.scheduleAutoSync?.();
        return { deletedDirSyncProfileId: targetId, name: existing?.name };
      }
      const profiles = await bridge.profileStore.getProfiles();
      const q = (input.idOrName || input.name || "").trim().toLowerCase();
      const existing = (profiles.s3 ?? []).find(
        (s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q || (q && s.name.toLowerCase().includes(q)),
      );
      if (input.operation === "delete_s3_profile") {
        const targetId = existing?.id || input.idOrName;
        if (!targetId) throw new Error("S3 profile not found");
        await bridge.profileStore.deleteS3(targetId);
        bridge.scheduleAutoSync?.();
        return { deletedS3ProfileId: targetId, name: existing?.name };
      }
      const id = existing?.id || crypto.randomUUID();
      const name = input.name?.trim() || existing?.name || input.bucket || "S3 Bucket";
      await bridge.profileStore.saveS3({
        ...existing,
        id,
        name,
        endpoint: input.endpoint ?? existing?.endpoint ?? "",
        region: input.region ?? existing?.region ?? "us-east-1",
        initialPath: input.bucket ?? existing?.initialPath,
        authMode: input.authMethod === "awsSso" ? "sso" : existing?.authMode ?? "static",
        accessKeyId: input.accessKeyId ?? existing?.accessKeyId ?? "",
        secretAccessKey: input.secretAccessKey ?? existing?.secretAccessKey ?? "",
        forcePathStyle: input.forcePathStyle ?? existing?.forcePathStyle ?? false,
        group: input.group ?? existing?.group,
        updatedAt: new Date().toISOString(),
      });
      bridge.scheduleAutoSync?.();
      return { savedS3ProfileId: id, name };
    },
    manageAppSettings: async (input) => {
      if (input.operation === "update_settings" && input.settings) {
        const current = await bridge.settingsStore.getSettings();
        const merged = { ...current, ...input.settings };
        await bridge.settingsStore.saveSettings(merged);
        bridge.scheduleAutoSync?.();
        return merged;
      }
      if (input.operation === "update_shortcuts") {
        const current = await bridge.settingsStore.getSettings();
        const baseShortcuts = input.resetShortcuts
          ? { ...DEFAULT_SHORTCUTS }
          : { ...DEFAULT_SHORTCUTS, ...(current.shortcuts ?? {}) };
        const mergedShortcuts = {
          ...baseShortcuts,
          ...(input.shortcuts ?? {}),
        };
        const updated = await bridge.settingsStore.saveSettings({
          ...current,
          shortcuts: mergedShortcuts,
        });
        bridge.scheduleAutoSync?.();
        return { shortcuts: updated.shortcuts };
      }
      if (input.operation === "list_dotfiles") {
        const pools = (await bridge.dotfilePoolStore?.getPools?.().catch(() => [])) ?? [];
        const settings = await bridge.settingsStore.getSettings().catch(() => ({ dotfilesPoolEnabled: false }));
        return {
          dotfilesPoolEnabled: Boolean(settings.dotfilesPoolEnabled),
          pools,
        };
      }
      if (input.operation === "save_dotfile" && input.dotfile) {
        const poolId = input.dotfile.poolId?.trim() || "default";
        const pools = (await bridge.dotfilePoolStore?.getPools?.().catch(() => [])) ?? [];
        let pool = pools.find((p) => p.id === poolId);
        if (!pool) {
          pool = {
            id: poolId,
            name: input.dotfile.poolName?.trim() || "Default Pool",
            files: [],
          };
          await bridge.dotfilePoolStore.savePool(pool);
        } else if (input.dotfile.poolName?.trim() && input.dotfile.poolName.trim() !== pool.name) {
          pool.name = input.dotfile.poolName.trim();
          await bridge.dotfilePoolStore.savePool(pool);
        }
        let updatedPool = pool;
        if (input.dotfile.remotePath) {
          updatedPool = await bridge.dotfilePoolStore.addFileToPool(poolId, {
            remotePath: input.dotfile.remotePath.trim(),
            content: input.dotfile.content ?? "",
            mode: input.dotfile.mode?.trim() || "644",
          });
        }
        const currentSettings = await bridge.settingsStore.getSettings();
        if (!currentSettings.dotfilesPoolEnabled) {
          await bridge.settingsStore.saveSettings({
            ...currentSettings,
            dotfilesPoolEnabled: true,
          });
        }
        bridge.scheduleAutoSync?.();
        return { pool: updatedPool, dotfilesPoolEnabled: true };
      }
      if (input.operation === "delete_dotfile" && input.dotfile) {
        const poolId = input.dotfile.poolId?.trim() || "default";
        if (input.dotfile.deletePool || !input.dotfile.remotePath) {
          await bridge.dotfilePoolStore.deletePool(poolId);
          bridge.scheduleAutoSync?.();
          return { deletedPoolId: poolId };
        }
        const pool = await bridge.dotfilePoolStore.getPool(poolId);
        if (!pool) throw new Error(`Dotfile pool "${poolId}" not found`);
        const now = new Date().toISOString();
        for (const f of pool.files) {
          if (f.remotePath === input.dotfile.remotePath) {
            f.deletedAt = now;
          }
        }
        await bridge.dotfilePoolStore.savePool(pool);
        bridge.scheduleAutoSync?.();
        return {
          poolId,
          deletedRemotePath: input.dotfile.remotePath,
        };
      }
      const listAllSnippets = async () => {
        if (typeof bridge.snippetStore?.listWithBuiltins === "function") {
          return (
            (await bridge.snippetStore
              .listWithBuiltins(getBuiltinSnippets())
              .catch(() => [])) ?? []
          );
        }
        const raw = (await bridge.snippetStore?.list?.().catch(() => [])) ?? [];
        const dismissed = new Set(
          hub.store.data.preferences.dismissedBuiltinIds ?? [],
        );
        return [
          ...raw,
          ...getBuiltinSnippets().filter(
            (bs) => !dismissed.has(bs.id) && !raw.some((r) => r.id === bs.id),
          ),
        ];
      };
      const isBuiltinSnippetId = (id: string | undefined): boolean =>
        typeof id === "string" && getBuiltinSnippets().some((b) => b.id === id);
      if (input.operation === "list_snippets") {
        const snippets = await listAllSnippets();
        return { snippets };
      }
      if (input.operation === "save_snippet" && input.snippet) {
        const snippets = await listAllSnippets();
        const q = (input.snippet.id || input.snippet.name || "").trim().toLowerCase();
        const existing = snippets.find(
          (s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q,
        );
        const targetId = existing?.id || input.snippet.id;
        const saved = await bridge.snippetStore.save(
          {
            id: targetId,
            name: input.snippet.name || existing?.name || "Snippet",
            command: input.snippet.command || existing?.command || "",
          },
          { replacesBuiltin: isBuiltinSnippetId(targetId) },
        );
        return saved;
      }
      if (input.operation === "delete_snippet" && input.snippet) {
        const snippets = await listAllSnippets();
        const q = (input.snippet.id || input.snippet.name || "").trim().toLowerCase();
        const existing = snippets.find(
          (s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q,
        );
        const targetId = existing?.id || input.snippet.id;
        if (!targetId) throw new Error("Snippet not found");
        if (
          isBuiltinSnippetId(targetId) &&
          typeof bridge.snippetStore?.hideBuiltin === "function"
        ) {
          await bridge.snippetStore.hideBuiltin(targetId);
        } else {
          await bridge.snippetStore.delete(targetId);
        }
        return { deletedSnippetId: targetId };
      }
      if (input.operation === "open_local_terminal") {
        if (bridge.tenantHomeDir) throw new Error("This is a shared sshs3 server: there is no local terminal here.");
        const shell = process.platform === "win32" ? "powershell" : "bash";
        const session = await bridge.sshPtyManager.createShellSession({
          cols: 100,
          rows: 30,
          shellBinary: process.platform === "win32" ? "powershell.exe" : "bash",
        });
        hub.terminals.register(
          {
            id: session.sessionId,
            label: "Local Shell (AI)",
            kind: "local",
            profileId: "local",
          },
          (data) => bridge.sshPtyManager.write(session.sessionId, data),
        );
        // A shell that is not at its prompt yet would lose the handshake: wait for it. A local shell
        // that cannot be connected to stays open for the person; the next command connects again.
        await hub.terminals.armAtPrompt(session.sessionId, shell).catch(() => {});
        return { sessionId: session.sessionId };
      }
      return {};
    },
    resolveStorageProvider: async (targetRef) => {
      return await resolveTargetStorageProvider(targetRef);
    },
    storageOps: async ({ operation, targetA, pathA, targetB, pathB }) => {
      const providerA = await resolveTargetStorageProvider(targetA);
      if (operation === "list_files") {
        const entries = await providerA.list(pathA || "/");
        return {
          ok: true,
          operation: "list_files",
          target: targetA,
          path: pathA,
          entries: entries.map((e) => ({
            name: e.name,
            path: e.path,
            type: e.isDirectory ? "directory" : "file",
            size: e.size,
            modifiedAt: e.mtime
              ? e.mtime
              : e.mtimeMs
                ? new Date(e.mtimeMs).toISOString()
                : undefined,
          })),
        };
      }
      if (operation === "read_remote_file") {
        const content = await readProviderTextFile(providerA, pathA);
        return {
          ok: true,
          operation: "read_remote_file",
          target: targetA,
          path: pathA,
          content,
        };
      }
      const bTarget = targetB || targetA;
      const bPath = pathB || pathA;
      const providerB =
        bTarget === targetA
          ? providerA
          : await resolveTargetStorageProvider(bTarget);
      const [leftContent, rightContent] = await Promise.all([
        readProviderTextFile(providerA, pathA),
        readProviderTextFile(providerB, bPath),
      ]);
      const unifiedDiff = createTwoFilesPatch(
        `${targetA}:${pathA}`,
        `${bTarget}:${bPath}`,
        leftContent,
        rightContent,
        "baseline",
        leftContent === rightContent ? "identical" : "drift-detected",
        { context: 3 },
      );
      return {
        ok: true,
        operation: "diff_paths",
        engine: "diff/Myers-O(ND)",
        left: { target: targetA, path: pathA },
        right: { target: bTarget, path: bPath },
        identical: leftContent === rightContent,
        unifiedDiff,
        diff: unifiedDiff,
      };
    },
  }, options?.hubDirectory);
  const files = new FileTools(bridge, hub.terminals, () => hub.changed());
  if (bridge.profileSyncService) {
    bridge.profileSyncService.workspaceStateProvider = {
      getState: async () => {
        await hub.initialize();
        return {
          workspaceMemories: hub.store.data.memories.filter(
            (m) => m.scope !== "personal",
          ),
          activityLog: hub.store.data.activityLog ?? [],
        };
      },
      applyRemoteState: async (remote) => {
        await hub.initialize();
        let changed = false;
        const memMap = new Map(hub.store.data.memories.map((m) => [m.id, m]));
        for (const rm of remote.workspaceMemories ?? []) {
          const prev = memMap.get(rm.id);
          if (!prev || rm.updatedAt > prev.updatedAt) {
            memMap.set(rm.id, prev ? { ...prev, ...rm } : rm);
            changed = true;
          }
        }
        if (changed) {
          hub.store.data.memories = Array.from(memMap.values());
        }
        const actMap = new Map(
          (hub.store.data.activityLog ?? []).map((a) => [a.id, a]),
        );
        let actChanged = false;
        for (const ra of remote.activityLog ?? []) {
          if (!actMap.has(ra.id)) {
            actMap.set(ra.id, ra);
            actChanged = true;
          }
        }
        if (actChanged) {
          hub.store.data.activityLog = Array.from(actMap.values())
            .sort((a, b) => a.at - b.at)
            .slice(-500);
          changed = true;
        }
        if (changed) {
          await hub.store.save();
          hub.changed();
        }
        return changed;
      },
    };
  }
  return hub;
}
