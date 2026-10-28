import crypto from "node:crypto";
import { nativeEvents } from '../desktop/nativeEvents';
import { FileTools } from "./FileTools";
import type { IpcBridge } from "../../IpcBridge";
import { HubService, type HubHost } from "./HubService";
import {
  HUB_CHANGED,
  type WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import type { InventoryTarget } from "./ContextService";
import {
  appendDemoActivity,
  deleteDemoMemory,
  getDemoActivityLog,
  getDemoMemories,
  getDemoServers,
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
      if (isDemoMode()) {
        return upsertDemoServer({
          ...input,
          id,
          tags: cleanTags,
        });
      }
      const isShared = input.shared ?? true;
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
          port: input.port || 22,
          username: input.username.trim() || "root",
          authType: existing?.authType || "agent",
          group:
            input.folder?.trim() || input.cluster?.trim() || existing?.group,
          cluster: input.cluster?.trim() || undefined,
          nodeRole: input.nodeRole?.trim() || undefined,
          role: input.role?.trim() || undefined,
          description: input.description?.trim() || undefined,
          tags: cleanTags?.length ? cleanTags : undefined,
          shared: true,
          updatedAt: new Date().toISOString(),
          updatedBy: actor,
        });
        bridge.scheduleTeamVaultAutoPush?.();
      }
      const profiles = await bridge.profileStore.getProfiles();
      const existing = profiles.ssh.find((p) => p.id === id);
      const nowIso = new Date().toISOString();
      await bridge.profileStore.saveSSH({
        ...existing,
        id,
        name: input.name.trim(),
        host: input.host.trim(),
        port: input.port || 22,
        username: input.username.trim() || "root",
        authType: existing?.authType || "agent",
        group:
          input.folder?.trim() || input.cluster?.trim() || existing?.group,
        cluster: input.cluster?.trim() || undefined,
        nodeRole: input.nodeRole?.trim() || undefined,
        role: input.role?.trim() || undefined,
        description: input.description?.trim() || undefined,
        tags: cleanTags?.length ? cleanTags : undefined,
        shared: isShared,
        updatedAt: nowIso,
      });
      bridge.scheduleAutoSync?.();
      return {
        id,
        name: input.name.trim(),
        host: input.host.trim(),
        port: input.port || 22,
        username: input.username.trim() || "root",
        folder: input.folder?.trim() || input.cluster?.trim(),
        group: input.folder?.trim() || input.cluster?.trim(),
        cluster: input.cluster?.trim() || undefined,
        nodeRole: input.nodeRole?.trim() || undefined,
        role: input.role?.trim() || undefined,
        description: input.description?.trim() || undefined,
        tags: cleanTags,
        shared: isShared,
        updatedAt: nowIso,
      };
    },
    deleteServer: async (profileId) => {
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
