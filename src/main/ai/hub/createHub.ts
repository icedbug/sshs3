import crypto from "node:crypto";
import { nativeEvents } from '../desktop/nativeEvents';
import { FileTools } from "./FileTools";
import type { IpcBridge } from "../../IpcBridge";
import { HubService, type HubHost } from "./HubService";
import {
  HUB_CHANGED,
  type WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import { DEFAULT_SHORTCUTS } from "../../../shared/types/settings";
import type { InventoryTarget } from "./ContextService";
import {
  appendDemoActivity,
  deleteDemoMemory,
  deleteDemoServer,
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
  peerPresenceProvider?: HubHost["peerPresenceProvider"];
  onSharedWorkspaceChanged?: () => void;
}

export function createHub(
  bridge: IpcBridge,
  lifecycle: Pick<HubHost, "backgroundChanged" | "show">,
  options?: CreateHubOptions,
): HubService {
  const hub: HubService = new HubService({
    ...lifecycle,
    aiConfigFilePath: options?.aiConfigFilePath,
    s3ConfigFilePath: options?.s3ConfigFilePath,
    defaultActorName: options?.defaultActorName,
    peerPresenceProvider: options?.peerPresenceProvider,
    onSharedWorkspaceChanged: options?.onSharedWorkspaceChanged,
    file: (...args) => files.invoke(...args),
    changed: () => {
      const contents = bridge.getWebContents();
      if (contents && !contents.isDestroyed()) contents.send(HUB_CHANGED);
      if (process.env.SSHS3_NATIVE_HERMES === '1') nativeEvents.emit('toolsChanged');
      options?.onSharedWorkspaceChanged?.();
    },
    workspaceServers: async (): Promise<WorkspaceServerSummary[]> => {
      const servers: WorkspaceServerSummary[] = [];
      try {
        if (bridge.teamVaultService?.isUnlocked?.()) {
          const teamPayload =
            await bridge.teamVaultService.getPayloadForRenderer();
          for (const p of teamPayload.ssh ?? []) {
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
              updatedAt: p.updatedAt,
              updatedBy: p.updatedBy,
            });
          }
        }
      } catch {
        // Ignore if team vault is locked or unconfigured
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
      try {
        if (bridge.teamVaultService?.isUnlocked?.()) {
          const payload =
            await bridge.teamVaultService.getPayloadForRenderer();
          return {
            memories: [
              ...(payload.workspaceMemories ?? []).map((m) => ({
                id: m.id,
                kind: m.kind,
                scope: m.scope,
                title: m.title,
                text: m.text,
                author: m.author,
                updatedAt: m.updatedAt,
              })),
              ...(isDemoMode() ? getDemoMemories() : []),
            ],
            activityLog: [
              ...(payload.activityLog ?? []),
              ...(isDemoMode() ? getDemoActivityLog() : []),
            ],
            actor:
              bridge.teamVaultService.getUnlockedRecipientId?.() ?? undefined,
          };
        }
      } catch {
        // Non-fatal
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
      if (bridge.teamVaultService?.isUnlocked?.()) {
        await bridge.teamVaultService.recordWorkspaceActivity(event);
        bridge.scheduleTeamVaultAutoPush?.();
      }
      bridge.scheduleAutoSync?.();
    },
    saveWorkspaceMemory: async (entry) => {
      if (isDemoMode()) {
        saveDemoMemory(entry);
      }
      if (bridge.teamVaultService?.isUnlocked?.()) {
        await bridge.teamVaultService.saveWorkspaceMemory(entry);
        bridge.scheduleTeamVaultAutoPush?.();
      }
      bridge.scheduleAutoSync?.();
    },
    deleteWorkspaceMemory: async (id) => {
      if (isDemoMode()) {
        deleteDemoMemory(id);
      }
      if (bridge.teamVaultService?.isUnlocked?.()) {
        await bridge.teamVaultService.deleteWorkspaceMemory(id);
        bridge.scheduleTeamVaultAutoPush?.();
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
      if (input.shared && bridge.teamVaultService?.isUnlocked?.()) {
        const payload = await bridge.teamVaultService.getPayload();
        const existing = payload.ssh.find((p) => p.id === input.profileId);
        if (existing) {
          await bridge.teamVaultService.saveSSHProfile({
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
              bridge.teamVaultService.getUnlockedRecipientId?.() ??
              existing.updatedBy,
          });
          bridge.scheduleTeamVaultAutoPush?.();
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
      if (isShared && bridge.teamVaultService?.isUnlocked?.()) {
        const payload = await bridge.teamVaultService.getPayload();
        const existing = payload.ssh.find((p) => p.id === id);
        const actor =
          bridge.teamVaultService.getUnlockedRecipientId?.() ?? "team-member";
        await bridge.teamVaultService.saveSSHProfile({
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
        bridge.scheduleTeamVaultAutoPush?.();
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
        if (bridge.teamVaultService?.isUnlocked?.()) {
          await bridge.teamVaultService
            .deleteSSHProfile(profileId)
            .catch(() => {});
          bridge.scheduleTeamVaultAutoPush?.();
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
          if (!existing) continue;
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
          if (!existing || tRemote > tLocal || !existing.shared) {
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
    openSchedule: async (schedule) => {
      let id: string;
      if (schedule.profileId === "local") {
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
        });
        id = session.sessionId;
      }
      hub.terminals.register(
        {
          id,
          label: `Schedule: ${schedule.title}`,
          kind: schedule.profileId === "local" ? "local" : "ssh",
          profileId: schedule.profileId,
        },
        (data) => bridge.sshPtyManager.write(id, data),
      );
      return id;
    },
    openServerTerminal: async (profileId) => {
      const profile = (await bridge.profileStore.getProfiles()).ssh.find(
        (p) => p.id === profileId,
      );
      if (!profile) throw new Error(`Saved SSH profile "${profileId}" not found`);
      if (["password", "smartcard", "fido2"].includes(profile.authType)) {
        throw new Error(
          `Node "${profile.name || profile.host}" requires interactive auth; open its terminal tab first.`,
        );
      }
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
      });
      hub.terminals.register(
        {
          id: session.sessionId,
          label: profile.name || profile.host,
          kind: "ssh",
          profileId: profile.id,
        },
        (data) => bridge.sshPtyManager.write(session.sessionId, data),
      );
      return session.sessionId;
    },
    extraAppContext: async () => {
      const [profiles, settings, snippets, dotfilesPools, dirSyncProfiles] = await Promise.all([
        bridge.profileStore.getProfiles().catch(() => ({ ssh: [], s3: [], folders: [] })),
        bridge.settingsStore?.getSettings?.().catch(() => ({})) ?? Promise.resolve({}),
        bridge.snippetStore?.list?.().catch(() => []) ?? Promise.resolve([]),
        bridge.dotfilePoolStore?.getPools?.().catch(() => []) ?? Promise.resolve([]),
        bridge.directorySyncProfileStore?.list?.().catch(() => []) ?? Promise.resolve([]),
      ]);
      const folderSet = new Set<string>(profiles.folders ?? []);
      const s3List = [...(profiles.s3 ?? [])];
      const snippetList = [...(snippets ?? [])];
      if (isDemoMode()) {
        for (const d of getDemoServers()) {
          if (d.folder) folderSet.add(d.folder);
        }
        for (const ds3 of getDemoS3Profiles()) {
          if (ds3.group) folderSet.add(ds3.group);
          if (!s3List.some((s) => s.id === ds3.id)) s3List.push(ds3);
        }
        for (const ds of getDemoSnippets()) {
          if (!snippetList.some((s) => s.id === ds.id)) snippetList.push(ds);
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
      if (input.operation === "list_snippets") {
        const snippets = (await bridge.snippetStore?.list?.().catch(() => [])) ?? [];
        return { snippets };
      }
      if (input.operation === "save_snippet" && input.snippet) {
        const snippets = (await bridge.snippetStore?.list?.().catch(() => [])) ?? [];
        const q = (input.snippet.id || input.snippet.name || "").trim().toLowerCase();
        const existing = snippets.find(
          (s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q,
        );
        const saved = await bridge.snippetStore.save({
          id: existing?.id || input.snippet.id,
          name: input.snippet.name || existing?.name || "Snippet",
          command: input.snippet.command || existing?.command || "",
        });
        return saved;
      }
      if (input.operation === "delete_snippet" && input.snippet) {
        const snippets = (await bridge.snippetStore?.list?.().catch(() => [])) ?? [];
        const q = (input.snippet.id || input.snippet.name || "").trim().toLowerCase();
        const existing = snippets.find(
          (s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q,
        );
        const targetId = existing?.id || input.snippet.id;
        if (!targetId) throw new Error("Snippet not found");
        await bridge.snippetStore.delete(targetId);
        return { deletedSnippetId: targetId };
      }
      if (input.operation === "open_local_terminal") {
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
        await hub.terminals.arm(session.sessionId, shell).catch(() => {});
        return { sessionId: session.sessionId };
      }
      return {};
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
            memMap.set(rm.id, rm);
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
