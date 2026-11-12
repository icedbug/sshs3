import crypto from "node:crypto";
import type {
  AgentChange,
  AgentSchedule,
  AgentTask,
  InfraGraphEdge,
  MemoryEntry,
  MissionAgent,
  WorkspaceActivityEvent,
  WorkspaceLayoutEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import { DEFAULT_AI_MODELS } from "../../../shared/types/ai";
import {
  analyzeCommandSafety,
  DEFAULT_SAFETY_POLICY,
} from "./CommandSafetyService";
import {
  isDemoMode,
  MCP_MARKETPLACE_CATALOG,
} from "./demoWorkspace";
import { isDemoTarget } from "../../demo/demoMode";
import { boundedContext, safeError } from "./privacy";

import {
  requiredText,
  simulateDemoNodeCommand,
  simulateDemoStorageOps,
  simulateDemoMcpTool,
} from "./hubHelpers";
import type { AppActionHost } from "./HubService";

/**
 * The agent's sshs3 tools and MCP calls: what each `sshs3_*` tool does when a
 * model (or the demo copilot) calls it. It reaches the hub only through
 * `AppActionHost`, the list of hub members these handlers use.
 */
export async function handleAppAction(
    hub: AppActionHost,
    task: AgentTask,
    request: import("./ToolBroker").ToolRequest,
    authorize?: (change: AgentChange) => Promise<void>,
  ): Promise<unknown> {
    const p = (request.payload ?? {}) as Record<string, unknown>;
    const str = (key: string): string | undefined =>
      typeof p[key] === "string" && (p[key] as string).trim()
        ? (p[key] as string).trim()
        : undefined;
    const bool = (key: string): boolean | undefined =>
      typeof p[key] === "boolean" ? (p[key] as boolean) : undefined;
    const num = (key: string): number | undefined =>
      typeof p[key] === "number" && Number.isFinite(p[key] as number)
        ? (p[key] as number)
        : undefined;
    const tags = Array.isArray(p.tags)
      ? (p.tags as unknown[])
          .map((t) => String(t).trim())
          .filter(Boolean)
      : typeof p.tags === "string"
        ? p.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

    if (request.action.startsWith("mcp__")) {
      const resolved = hub.mcp.resolveQualifiedCall(
        hub.getMcpServersList(),
        request.action,
      );
      if (!resolved) {
        throw new Error(`Unknown or disabled MCP tool: ${request.action}`);
      }
      if (isDemoTarget(resolved.server.id)) {
        // A demo MCP fixture answers from its script; its command/URL is never started or contacted.
        return {
          ok: true,
          mcpServer: resolved.server.name,
          tool: resolved.toolName,
          output: simulateDemoMcpTool(resolved.toolName, p),
        };
      }
      const res = await hub.mcp.callTool(
        resolved.server,
        resolved.toolName,
        p,
      );
      if (!res.ok) {
        throw new Error(res.error || "MCP tool invocation failed");
      }
      return {
        ok: true,
        mcpServer: resolved.server.name,
        tool: resolved.toolName,
        output: res.output,
      };
    }

    switch (request.action) {
      case "sshs3_manage_server": {
        const op = str("operation") || "upsert";
        const query = str("serverIdOrName") || str("id") || str("name") || str("host");
        const existing = await hub.resolveServerTarget(query);

        if (op === "list_tunnels") {
          const extra = await hub.collectExtraContext();
          const allSrvs = extra.workspaceServers ?? [];
          const filtered = existing ? [existing] : allSrvs;
          const tunnelsByServer = filtered
            .filter((s) => (s.tunnels ?? []).length > 0 || existing)
            .map((s) => ({
              serverId: s.id,
              serverName: s.name,
              host: s.host,
              tunnels: s.tunnels ?? [],
            }));
          return {
            ok: true,
            operation: "list_tunnels",
            tunnelsByServer,
            activeTunnels: extra.activeTunnels ?? [],
          };
        }

        if (op === "save_tunnel" || op === "delete_tunnel") {
          if (!existing) {
            throw new Error(`Could not find server matching "${query ?? ""}" to manage SSH tunnels`);
          }
          const currentTunnels = [...(existing.tunnels ?? [])];
          const tQuery = (str("tunnelIdOrName") || str("tunnelName") || "").toLowerCase();
          if (op === "delete_tunnel") {
            const nextTunnels = currentTunnels.filter(
              (t) =>
                t.id.toLowerCase() !== tQuery &&
                t.name.toLowerCase() !== tQuery &&
                !t.name.toLowerCase().includes(tQuery),
            );
            await hub.request({
              action: "server-upsert",
              server: {
                ...existing,
                tunnels: nextTunnels,
              },
            });
            return {
              ok: true,
              operation: "delete_tunnel",
              serverId: existing.id,
              serverName: existing.name,
              tunnels: nextTunnels,
            };
          }
          // save_tunnel
          const tunnelTypeRaw = str("tunnelType") || "local";
          const tunnelType: "local" | "remote" | "dynamic" =
            tunnelTypeRaw === "remote" || tunnelTypeRaw === "dynamic"
              ? tunnelTypeRaw
              : "local";
          const localPort = num("localPort") ?? 8080;
          const existingTunnelIdx = tQuery
            ? currentTunnels.findIndex(
                (t) => t.id.toLowerCase() === tQuery || t.name.toLowerCase() === tQuery,
              )
            : -1;
          const prevTunnel = existingTunnelIdx >= 0 ? currentTunnels[existingTunnelIdx] : undefined;
          const newTunnel = {
            id: prevTunnel?.id || crypto.randomUUID(),
            name:
              str("tunnelName") ||
              str("tunnelIdOrName") ||
              prevTunnel?.name ||
              `${tunnelType.toUpperCase()} :${localPort}`,
            type: tunnelType,
            localPort,
            remoteHost:
              tunnelType === "dynamic"
                ? undefined
                : str("remoteHost") || prevTunnel?.remoteHost || "127.0.0.1",
            remotePort:
              tunnelType === "dynamic"
                ? undefined
                : num("remotePort") ?? prevTunnel?.remotePort ?? localPort,
            description: str("tunnelDescription") ?? prevTunnel?.description,
            enabled: bool("tunnelEnabled") ?? prevTunnel?.enabled ?? true,
          };
          if (existingTunnelIdx >= 0) {
            currentTunnels[existingTunnelIdx] = newTunnel;
          } else {
            currentTunnels.push(newTunnel);
          }
          await hub.request({
            action: "server-upsert",
            server: {
              ...existing,
              tunnels: currentTunnels,
            },
          });
          return {
            ok: true,
            operation: "save_tunnel",
            serverId: existing.id,
            serverName: existing.name,
            tunnel: newTunnel,
            tunnels: currentTunnels,
          };
        }

        if (op === "delete") {
          const targetId = existing?.id || str("serverIdOrName") || str("id");
          if (!targetId) {
            throw new Error(`Could not find server matching "${query ?? ""}" to delete`);
          }
          await hub.request({ action: "server-delete", profileId: targetId });
          return {
            ok: true,
            operation: "delete",
            deletedServerId: targetId,
            deletedServerName: existing?.name ?? targetId,
          };
        }

        const rawLocalAuth = str("localAuthType");
        const normalizedLocalAuth: "agent" | "privateKey" | undefined =
          rawLocalAuth === "agent"
            ? "agent"
            : rawLocalAuth === "key" || rawLocalAuth === "privateKey"
              ? "privateKey"
              : undefined;

        if (op === "set_local_override") {
          const targetId = existing?.id || str("serverIdOrName") || str("id");
          if (!targetId) {
            throw new Error(`Could not find server matching "${query ?? ""}"`);
          }
          await hub.request({
            action: "server-local-override",
            override: {
              profileId: targetId,
              username: str("localUsername") ?? str("username"),
              privateKeyPath: str("localPrivateKeyPath"),
              authType: normalizedLocalAuth,
            },
          });
          return {
            ok: true,
            operation: "set_local_override",
            profileId: targetId,
          };
        }

        if (
          op === "update_metadata" &&
          existing &&
          !str("host") &&
          !str("name") &&
          num("port") === undefined &&
          !str("username")
        ) {
          await hub.request({
            action: "server-describe",
            profileId: existing.id,
            shared: bool("shared") ?? existing.shared,
            cluster: str("cluster") ?? existing.cluster,
            nodeRole: str("nodeRole") ?? existing.nodeRole,
            role: str("role") ?? existing.role,
            description: str("description") ?? existing.description,
            tags: tags ?? existing.tags,
          });
          return {
            ok: true,
            operation: "update_metadata",
            serverId: existing.id,
            name: existing.name,
          };
        }

        // Default: upsert (handles both creating a new server and updating any field on an existing server)
        const name = str("name") || existing?.name || str("host") || str("serverIdOrName");
        const host = str("host") || existing?.host || name;
        if (!name || !host) {
          throw new Error("Server 'name' and 'host' are required to create or update a server");
        }
        const rawAuthType = str("authType");
        const authType: WorkspaceServerSummary["authType"] =
          rawAuthType === "password" ||
          rawAuthType === "privateKey" ||
          rawAuthType === "smartcard" ||
          rawAuthType === "agent" ||
          rawAuthType === "fido2"
            ? rawAuthType
            : existing?.authType;
        const rawDotfilesPolicy = str("dotfilesSyncPolicy");
        const dotfilesSyncPolicy: "ask" | "always" | undefined =
          rawDotfilesPolicy === "ask" || rawDotfilesPolicy === "always"
            ? rawDotfilesPolicy
            : rawDotfilesPolicy === "push-only" || rawDotfilesPolicy === "always-push"
              ? "always"
              : existing?.dotfilesSyncPolicy;
        const extraOptions =
          p.extraOptions && typeof p.extraOptions === "object" && !Array.isArray(p.extraOptions)
            ? (p.extraOptions as Record<string, string>)
            : existing?.extraOptions;
        let resolvedJumpProfileId = str("proxyJumpProfileId") ?? existing?.proxyJumpProfileId;
        if (str("proxyJumpProfileId")) {
          const jumpTarget = await hub.resolveServerTarget(str("proxyJumpProfileId"));
          if (jumpTarget) resolvedJumpProfileId = jumpTarget.id;
        }
        const snap = await hub.request({
          action: "server-upsert",
          server: {
            id: existing?.id || str("id"),
            name,
            host,
            port: num("port") ?? existing?.port ?? 22,
            username: str("username") || existing?.username || "root",
            authType,
            privateKeyPath: str("privateKeyPath") ?? existing?.privateKeyPath,
            pkcs11LibPath: str("pkcs11LibPath") ?? existing?.pkcs11LibPath,
            fido2Resident: bool("fido2Resident") ?? existing?.fido2Resident,
            proxyJump: str("proxyJump") ?? existing?.proxyJump,
            proxyJumpProfileId: resolvedJumpProfileId,
            forwardAgent: bool("forwardAgent") ?? existing?.forwardAgent,
            x11Forwarding: bool("x11Forwarding") ?? existing?.x11Forwarding,
            x11Display: str("x11Display") ?? existing?.x11Display,
            compression: bool("compression") ?? existing?.compression,
            serverAliveInterval: num("serverAliveInterval") ?? existing?.serverAliveInterval,
            initialPath: str("initialPath") ?? existing?.initialPath,
            poolId: str("poolId") ?? existing?.poolId,
            dotfilesSyncPolicy,
            autoReconnect: bool("autoReconnect") ?? existing?.autoReconnect,
            maxReconnectAttempts: num("maxReconnectAttempts") ?? existing?.maxReconnectAttempts,
            reconnectDelayMs: num("reconnectDelayMs") ?? existing?.reconnectDelayMs,
            extraOptions,
            tunnels: existing?.tunnels,
            folder: str("folder") ?? existing?.folder ?? str("cluster") ?? existing?.cluster,
            cluster: str("cluster") ?? existing?.cluster,
            nodeRole: str("nodeRole") ?? existing?.nodeRole,
            role: str("role") ?? existing?.role,
            description: str("description") ?? existing?.description,
            tags: tags ?? existing?.tags,
            shared: bool("shared") ?? existing?.shared ?? true,
            localUsername: str("localUsername"),
            localPrivateKeyPath: str("localPrivateKeyPath"),
            localAuthType: normalizedLocalAuth,
          },
        });
        const saved = (snap.workspaceServers ?? []).find(
          (s) =>
            (existing && s.id === existing.id) ||
            s.name.toLowerCase() === name.toLowerCase() ||
            s.host.toLowerCase() === host.toLowerCase(),
        );
        return {
          ok: true,
          operation: existing ? "updated" : "created",
          server: saved ?? { name, host },
        };
      }

      case "sshs3_manage_cluster_and_folders": {
        const op = str("operation") || "assign_cluster";
        if (op === "assign_cluster") {
          const cluster = str("cluster");
          if (!cluster) throw new Error("Cluster name is required");
          const rawTargets = Array.isArray(p.serverIdsOrNames)
            ? (p.serverIdsOrNames as unknown[]).map((x) => String(x).trim()).filter(Boolean)
            : str("serverIdOrName")
              ? [str("serverIdOrName")!]
              : [];
          const updated: string[] = [];
          for (const t of rawTargets) {
            const srv = await hub.resolveServerTarget(t);
            if (srv) {
              await hub.request({
                action: "server-describe",
                profileId: srv.id,
                shared: srv.shared,
                cluster,
                nodeRole: str("nodeRole") ?? srv.nodeRole,
                role: str("role") ?? srv.role,
                description: str("description") ?? srv.description,
                tags: tags ?? srv.tags,
              });
              updated.push(srv.name);
            }
          }
          return {
            ok: true,
            operation: "assign_cluster",
            cluster,
            updatedServers: updated,
          };
        }
        const folderName = str("folderName") || str("name") || str("cluster");
        if (!folderName) throw new Error("folderName is required");
        const res = await hub.host.manageFolders?.({
          operation: op as "create_folder" | "rename_folder" | "delete_folder",
          folderName,
          newFolderName: str("newFolderName"),
        });
        hub.changed();
        return { ok: true, operation: op, folderName, result: res };
      }

      case "sshs3_manage_memory_and_activity": {
        const op = str("operation") || "save";
        const extra = await hub.collectExtraContext();
        if (op === "list") {
          return {
            memories: extra.memories ?? [],
            recentActivity: (extra.activityLog ?? []).slice(0, 30),
          };
        }
        if (op === "delete") {
          const q = (str("idOrTitle") || str("id") || str("title") || "").toLowerCase();
          if (!q) throw new Error("idOrTitle is required to delete a memory");
          const match = (extra.memories ?? []).find(
            (m) => m.id.toLowerCase() === q || m.title.toLowerCase() === q || m.title.toLowerCase().includes(q),
          );
          const targetId = match?.id || str("idOrTitle") || str("id")!;
          await hub.request({ action: "memory-delete", id: targetId });
          return { ok: true, operation: "delete", deletedMemoryId: targetId, title: match?.title };
        }
        if (op === "feedback") {
          const q = (str("idOrTitle") || str("id") || str("title") || "").toLowerCase();
          if (!q) throw new Error("idOrTitle is required to give feedback on a memory or skill");
          const match = (extra.memories ?? []).find(
            (m) => m.id.toLowerCase() === q || m.title.toLowerCase() === q || m.title.toLowerCase().includes(q),
          );
          const targetId = match?.id || str("idOrTitle") || str("id")!;
          const delta: 1 | -1 = num("delta") === -1 ? -1 : 1;
          await hub.request({ action: "memory-feedback", id: targetId, delta });
          return { ok: true, operation: "feedback", id: targetId, delta };
        }
        if (op === "self_reflect") {
          const snap = await hub.request({
            action: "self-learn-reflect",
            targetCluster: str("cluster") || str("targetCluster"),
          });
          return {
            ok: true,
            operation: "self_reflect",
            selfLearning: snap.selfLearning,
          };
        }
        if (op === "log_activity") {
          const targetLabel = str("targetLabel") || str("title") || "Workspace";
          const summary = str("summary") || str("text") || "Team note";
          await hub.request({
            action: "activity-record",
            event: {
              actor: str("actor") || (await hub.resolveActorName()),
              targetLabel,
              kind: (str("activityKind") as WorkspaceActivityEvent["kind"]) || "note",
              summary,
              detail: str("detail"),
            },
          });
          return { ok: true, operation: "log_activity", targetLabel, summary };
        }
        // save / core_replace / core_append memory or skill
        const title = str("title") || str("idOrTitle") || "Workspace note";
        const rawText = str("text") || str("content") || "";
        const q = (str("idOrTitle") || title).toLowerCase();
        const existing = (extra.memories ?? []).find(
          (m) => m.id.toLowerCase() === q || m.title.toLowerCase() === q,
        );
        const text =
          op === "core_append" && existing
            ? `${existing.text}\n${rawText}`.trim()
            : rawText;
        const rawTier = str("tier");
        const tier: MemoryEntry["tier"] =
          op === "core_replace" || op === "core_append" || rawTier === "core"
            ? "core"
            : rawTier === "episodic"
              ? "episodic"
              : "archival";
        const entry = await hub.saveMemoryInternal({
          id: existing?.id || str("id"),
          kind: str("kind") === "skill" ? "skill" : "memory",
          tier,
          cluster: str("cluster"),
          scope: str("scope") || "workspace",
          title,
          text,
          sourceCommand: str("sourceCommand"),
        });
        await hub.store.save();
        return { ok: true, operation: op, entry };
      }

      case "sshs3_manage_schedule": {
        const op = str("operation") || "list";
        if (op === "list") {
          return { schedules: hub.store.data.schedules };
        }
        const q = (str("idOrTitle") || str("id") || str("title") || "").toLowerCase();
        const existing = hub.store.data.schedules.find(
          (s) => s.id.toLowerCase() === q || s.title.toLowerCase() === q || s.title.toLowerCase().includes(q),
        );
        if (op === "delete") {
          const targetId = existing?.id || str("idOrTitle") || str("id");
          if (!targetId) throw new Error("Schedule not found");
          await hub.request({ action: "schedule-delete", id: targetId });
          return { ok: true, operation: "delete", deletedScheduleId: targetId };
        }
        if (op === "toggle") {
          if (!existing) throw new Error(`Schedule matching "${q}" not found`);
          existing.enabled = bool("enabled") ?? !existing.enabled;
          await hub.store.save();
          hub.changed();
          return { ok: true, operation: "toggle", schedule: existing };
        }
        // save / create schedule
        const srvQuery = str("serverIdOrName") || str("profileId");
        let profileId = "local";
        if (srvQuery && srvQuery.toLowerCase() !== "local") {
          const matchedSrv = await hub.resolveServerTarget(srvQuery);
          profileId = matchedSrv?.id || srvQuery;
        } else if (existing?.profileId) {
          profileId = existing.profileId;
        }
        const cfg = await hub.config.getConfig();
        const intervalMinutes = Math.max(1, Math.min(525600, Math.round(num("intervalMinutes") ?? existing?.intervalMinutes ?? 60)));
        const defaultShell =
          profileId === "local" && process.platform === "win32" ? "powershell" : "bash";
        const schedule: AgentSchedule = {
          id: existing?.id || crypto.randomUUID(),
          title: str("title") || existing?.title || "Scheduled check",
          prompt: str("prompt") || existing?.prompt || "Check system health",
          profileId,
          shell: (str("shell") as AgentSchedule["shell"]) || existing?.shell || defaultShell,
          mode: (str("mode") as AgentSchedule["mode"]) || existing?.mode || "assisted",
          provider: cfg.provider || "openai-codex",
          model: cfg.model || DEFAULT_AI_MODELS["openai-codex"],
          baseUrl: cfg.baseUrl,
          intervalMinutes,
          maxCommands: Math.max(1, Math.min(100, Math.round(num("maxCommands") ?? existing?.maxCommands ?? 10))),
          maxMinutes: Math.max(1, Math.min(120, Math.round(num("maxMinutes") ?? existing?.maxMinutes ?? 10))),
          enabled: bool("enabled") ?? existing?.enabled ?? true,
          nextRunAt: Date.now() + intervalMinutes * 60_000,
        };
        await hub.request({ action: "schedule-save", schedule });
        return { ok: true, operation: "save", schedule };
      }

      case "sshs3_manage_s3_and_sync": {
        const op = str("operation") || "status";
        const extra = await hub.collectExtraContext();
        if (op === "status") {
          return {
            s3TeamWorkspace: hub.s3Workspace.getStatus(),
            s3Profiles: extra.s3Profiles ?? [],
            dirSyncProfiles: extra.dirSyncProfiles ?? [],
          };
        }
        if (op === "list_dir_sync_profiles") {
          return {
            ok: true,
            operation: "list_dir_sync_profiles",
            dirSyncProfiles: extra.dirSyncProfiles ?? [],
          };
        }
        if (op === "sync_now") {
          await hub.request({ action: "workspace-s3-sync-now" });
          return {
            ok: true,
            operation: "sync_now",
            s3TeamWorkspace: hub.s3Workspace.getStatus(),
          };
        }
        if (op === "configure_s3_workspace") {
          await hub.request({
            action: "workspace-s3-configure",
            config: {
              enabled: bool("enabled") ?? true,
              endpoint: str("endpoint"),
              region: str("region") || "eu-north-1",
              bucket: str("bucket") || "",
              prefix: str("prefix") || "sshs3-workspace",
              accessKeyId: str("accessKeyId") || "",
              secretAccessKey: str("secretAccessKey"),
              forcePathStyle: bool("forcePathStyle") ?? true,
              actorName: str("actorName"),
            },
            inviteCode: str("inviteCode"),
          });
          return {
            ok: true,
            operation: "configure_s3_workspace",
            s3TeamWorkspace: hub.s3Workspace.getStatus(),
          };
        }
        if (op === "disconnect_s3_workspace") {
          await hub.request({ action: "workspace-s3-disconnect" });
          return {
            ok: true,
            operation: "disconnect_s3_workspace",
            s3TeamWorkspace: hub.s3Workspace.getStatus(),
          };
        }
        const rawAuthMethod = str("authMethod");
        const authMethod: "accessKey" | "awsProfile" | "awsSso" | undefined =
          rawAuthMethod === "accessKey" ||
          rawAuthMethod === "awsProfile" ||
          rawAuthMethod === "awsSso"
            ? rawAuthMethod
            : undefined;
        const res = await hub.host.manageS3Profile?.({
          operation: op as
            | "upsert_s3_profile"
            | "delete_s3_profile"
            | "list_dir_sync_profiles"
            | "save_dir_sync_profile"
            | "delete_dir_sync_profile",
          idOrName: str("idOrName") || str("id") || str("name"),
          name: str("name"),
          endpoint: str("endpoint"),
          region: str("region"),
          bucket: str("bucket"),
          accessKeyId: str("accessKeyId"),
          secretAccessKey: str("secretAccessKey"),
          forcePathStyle: bool("forcePathStyle"),
          group: str("group") || str("folder"),
          authMethod,
          awsProfile: str("awsProfile"),
          sourceProviderId: str("sourceProviderId"),
          sourcePath: str("sourcePath"),
          targetProviderId: str("targetProviderId"),
          targetPath: str("targetPath"),
          deleteExtraneous: bool("deleteExtraneous"),
        });
        hub.changed();
        return { ok: true, operation: op, result: res };
      }

      case "sshs3_manage_app_and_settings": {
        const op = str("operation") || "get_state";
        if (op === "get_state") {
          const extra = await hub.collectExtraContext();
          const aiConfig = await hub.config.getView();
          return {
            aiConfig,
            safetyPolicy: hub.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY,
            appSettings: extra.appSettings,
            folders: extra.folders,
            s3Profiles: extra.s3Profiles,
            dirSyncProfiles: extra.dirSyncProfiles,
            dotfilesPools: extra.dotfilesPools,
            activeTunnels: extra.activeTunnels,
            s3TeamWorkspace: extra.s3TeamWorkspace,
            schedules: extra.schedules,
            snippets: extra.snippets,
            agents: extra.agents,
            mcpServers: extra.mcpServers,
            kbDocuments: extra.kbDocuments,
            workspaceServersCount: (extra.workspaceServers ?? []).length,
            workspaceServers: extra.workspaceServers,
            openTerminals: hub.terminals.list(),
          };
        }
        if (
          op === "update_settings" ||
          op === "configure_ai" ||
          op === "update_shortcuts" ||
          op === "update_safety_policy"
        ) {
          // Demo mode is decided at launch and only the user can switch it (the Demo-Lab toggle restarts
          // sshs3 after a confirmation): a `demoMode` value from the model is never applied.
          const demoModeRequested = bool("demoMode");
          const rawPolicy =
            p.safetyPolicy &&
            typeof p.safetyPolicy === "object" &&
            !Array.isArray(p.safetyPolicy)
              ? (p.safetyPolicy as Record<string, unknown>)
              : undefined;
          const nextAutoApprove =
            typeof rawPolicy?.autoApproveSafeReadOnly === "boolean"
              ? rawPolicy.autoApproveSafeReadOnly
              : bool("autoApproveSafeReadOnly");
          const nextRequireProd =
            typeof rawPolicy?.requireApprovalOnProdTags === "boolean"
              ? rawPolicy.requireApprovalOnProdTags
              : bool("requireApprovalOnProdTags");
          const nextBlockDestructive =
            typeof rawPolicy?.blockDestructiveWithoutConfirm === "boolean"
              ? rawPolicy.blockDestructiveWithoutConfirm
              : bool("blockDestructiveWithoutConfirm");
          if (
            nextAutoApprove !== undefined ||
            nextRequireProd !== undefined ||
            nextBlockDestructive !== undefined
          ) {
            const currentPolicy =
              hub.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY;
            await hub.request({
              action: "safety-policy-save",
              policy: {
                autoApproveSafeReadOnly:
                  nextAutoApprove ?? currentPolicy.autoApproveSafeReadOnly,
                requireApprovalOnProdTags:
                  nextRequireProd ?? currentPolicy.requireApprovalOnProdTags,
                blockDestructiveWithoutConfirm:
                  nextBlockDestructive ??
                  currentPolicy.blockDestructiveWithoutConfirm,
              },
            });
          }

          const aiConfigPatch: Record<string, unknown> = {};
          if (bool("aiEnabled") !== undefined) aiConfigPatch.enabled = bool("aiEnabled");
          if (str("aiProvider")) aiConfigPatch.provider = str("aiProvider");
          if (str("aiModel")) aiConfigPatch.model = str("aiModel");
          if (str("aiBaseUrl") !== undefined) aiConfigPatch.baseUrl = str("aiBaseUrl");
          if (str("actorName")) aiConfigPatch.actorName = str("actorName");
          if (num("contextWindowTokens") !== undefined) {
            aiConfigPatch.contextWindowTokens = Math.max(
              4000,
              Math.min(1_000_000, Math.round(num("contextWindowTokens")!)),
            );
          }
          if (num("terminalContextChars") !== undefined) {
            aiConfigPatch.terminalContextChars = Math.max(
              1000,
              Math.min(64_000, Math.round(num("terminalContextChars")!)),
            );
          }
          if (num("maxOutputTokens") !== undefined) {
            aiConfigPatch.maxOutputTokens = Math.max(
              512,
              Math.min(32_768, Math.round(num("maxOutputTokens")!)),
            );
          }
          if (num("maxToolTurns") !== undefined) {
            aiConfigPatch.maxToolTurns = Math.max(
              1,
              Math.min(60, Math.round(num("maxToolTurns")!)),
            );
          }
          if (
            str("reasoningEffort") === "low" ||
            str("reasoningEffort") === "medium" ||
            str("reasoningEffort") === "high"
          ) {
            aiConfigPatch.reasoningEffort = str("reasoningEffort");
          }
          if (num("temperature") !== undefined) {
            aiConfigPatch.temperature = Math.max(
              0,
              Math.min(1, Number(num("temperature"))),
            );
          }

          const hasPrefUpdates =
            bool("background") !== undefined ||
            bool("autoStart") !== undefined ||
            bool("inventory") !== undefined ||
            num("retentionDays") !== undefined;

          if (Object.keys(aiConfigPatch).length > 0 || hasPrefUpdates) {
            await hub.request({
              action: "configure",
              config: aiConfigPatch as import("../../../shared/types/ai").AiConfigUpdate,
              preferences: hasPrefUpdates
                ? {
                    background:
                      bool("background") ?? hub.store.data.preferences.background,
                    autoStart:
                      bool("autoStart") ?? hub.store.data.preferences.autoStart,
                    inventory:
                      bool("inventory") ?? hub.store.data.preferences.inventory,
                    retentionDays:
                      num("retentionDays") !== undefined
                        ? Math.max(1, Math.min(365, Math.round(num("retentionDays")!)))
                        : hub.store.data.preferences.retentionDays,
                  }
                : undefined,
            });
          }

          const appSettingsPatch: Record<string, unknown> = {};
          const directAppSettingKeys = [
            "theme",
            "defaultNewTabType",
            "terminalFontSize",
            "terminalFontFamily",
            "terminalScrollback",
            "terminalCursorStyle",
            "cursorBlink",
            "copyOnSelect",
            "rightClickPaste",
            "clipboardHistoryScope",
            "clipboardHistoryClearOnExit",
            "sessionExitAction",
            "localTerminalAgentMode",
            "autoSyncLocalSshConfig",
            "confirmBeforeQuit",
            "confirmBeforeDelete",
            "showHiddenFiles",
            "defaultConflictPolicy",
            "verifyTransferIntegrity",
            "fileManagerGitIntegration",
            "shareFoldersAcrossTypes",
            "perfMetricsEnabled",
            "perfMetricsLayout",
            "perfMetricsItems",
            "perfMetricsIntervalSec",
            "perfBarVisible",
            "perfBarLayout",
            "maxConcurrentTransfers",
            "maxBandwidthBps",
            "enableOpenShift",
            "k8sDebugImages",
            "smartcardAuthMode",
            "smartcardUnlockAtStartup",
            "smartcardLibPath",
            "x11ServerMode",
            "x11ServerPath",
            "x11ServerArgs",
            "dotfilesPoolEnabled",
            "logLevel",
            "autoCheckUpdates",
          ];
          for (const k of directAppSettingKeys) {
            if (p[k] !== undefined) appSettingsPatch[k] = p[k];
          }
          // Support friendly aliases
          if (p.scrollbackLines !== undefined && appSettingsPatch.terminalScrollback === undefined) {
            appSettingsPatch.terminalScrollback = p.scrollbackLines;
          }
          if (p.cursorStyle !== undefined && appSettingsPatch.terminalCursorStyle === undefined) {
            appSettingsPatch.terminalCursorStyle = p.cursorStyle;
          }
          if (p.perfBarVisible !== undefined && appSettingsPatch.perfMetricsEnabled === undefined) {
            appSettingsPatch.perfMetricsEnabled = p.perfBarVisible;
          }
          if (p.perfBarLayout !== undefined && appSettingsPatch.perfMetricsLayout === undefined) {
            appSettingsPatch.perfMetricsLayout = p.perfBarLayout;
          }

          const shortcutsPatch: Record<string, string> = {};
          if (p.shortcuts && typeof p.shortcuts === "object" && !Array.isArray(p.shortcuts)) {
            for (const [sk, sv] of Object.entries(p.shortcuts as Record<string, unknown>)) {
              if (typeof sv === "string" && sv.trim()) {
                shortcutsPatch[sk] = sv.trim();
              }
            }
          }
          if (str("shortcutId") && str("shortcutKeys")) {
            shortcutsPatch[str("shortcutId")!] = str("shortcutKeys")!;
          }

          let updatedAppSettings: unknown;
          if (
            Object.keys(appSettingsPatch).length > 0 ||
            Object.keys(shortcutsPatch).length > 0 ||
            bool("resetShortcuts")
          ) {
            updatedAppSettings = await hub.host.manageAppSettings?.({
              operation: op === "update_shortcuts" ? "update_shortcuts" : "update_settings",
              settings: appSettingsPatch,
              shortcuts:
                Object.keys(shortcutsPatch).length > 0 ? shortcutsPatch : undefined,
              resetShortcuts: bool("resetShortcuts"),
            });
          }
          hub.changed();
          const aiConfigView = await hub.config.getView();
          return {
            ok: true,
            operation: op,
            demoMode: isDemoMode(),
            ...(demoModeRequested !== undefined && demoModeRequested !== isDemoMode()
              ? {
                  demoModeNote:
                    "Demo mode was not changed: it is set when sshs3 starts, and only the user can switch it with the Demo-Lab toggle (which restarts sshs3).",
                }
              : {}),
            actorName: aiConfigView.actorName,
            aiConfig: aiConfigView,
            safetyPolicy: hub.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY,
            aiPreferences: hub.store.data.preferences,
            appSettings: updatedAppSettings,
          };
        }
        if (
          op === "list_dotfiles" ||
          op === "save_dotfile" ||
          op === "delete_dotfile"
        ) {
          const res = await hub.host.manageAppSettings?.({
            operation: op,
            dotfile: {
              poolId: str("poolId") || str("id"),
              poolName: str("poolName") || str("name"),
              remotePath: str("remotePath") || str("path"),
              content: typeof p.content === "string" ? p.content : str("text"),
              mode: str("mode"),
              deletePool: bool("deletePool"),
            },
          });
          hub.changed();
          return { ok: true, operation: op, result: res };
        }
        if (
          op === "list_snippets" ||
          op === "save_snippet" ||
          op === "delete_snippet" ||
          op === "open_local_terminal"
        ) {
          const res = await hub.host.manageAppSettings?.({
            operation: op,
            snippet: {
              id: str("snippetId") || str("id"),
              name: str("snippetName") || str("name"),
              command: str("snippetCommand") || str("command"),
              category: str("snippetCategory") || str("category"),
            },
          });
          hub.changed();
          return { ok: true, operation: op, result: res };
        }
        throw new Error(`Unsupported app settings operation: ${op}`);
      }

      case "sshs3_investigate": {
        const raw = Array.isArray(p.questions) ? (p.questions as unknown[]) : [];
        const questions = raw
          .map((item) => {
            const q = (item ?? {}) as Record<string, unknown>;
            return {
              question: typeof q.question === "string" ? q.question.trim() : "",
              scope:
                typeof q.scope === "string" && q.scope.trim()
                  ? q.scope.trim()
                  : undefined,
            };
          })
          .filter((q) => q.question);
        if (questions.length === 0)
          throw new Error("sshs3_investigate needs at least one question");
        const reports = await hub.investigate(task, questions);
        return {
          asked: questions.length,
          answered: reports.filter((r) => r.status === "answered").length,
          // More questions than investigators: the rest were not looked at.
          notAsked: Math.max(0, questions.length - reports.length),
          reports,
        };
      }

      case "sshs3_session_search": {
        // The user's own conversations: not the runs the hub started itself, and not this one.
        const sessions = hub.store.data.tasks.filter(
          (t) =>
            t.id !== task.id &&
            !t.workforceRunId &&
            !t.distillSourceId,
        );
        const wantedId = str("id");
        if (wantedId) {
          const found = sessions.find((t) => t.id === wantedId);
          if (!found) throw new Error(`No earlier conversation with id ${wantedId}`);
          return {
            id: found.id,
            title: found.title,
            startedAt: new Date(found.createdAt).toISOString(),
            target: found.target?.label,
            status: found.status,
            verification: found.verification,
            messages: found.messages
              .filter((m) => m.role !== "system")
              .map((m) => ({
                role: m.role,
                at: new Date(m.at).toISOString(),
                text: boundedContext(m.text, 4000),
              })),
            todos: found.todos ?? [],
            changes: found.changes.map((c) => ({
              kind: c.kind,
              target: c.target,
              command: c.command ? boundedContext(c.command, 600) : undefined,
              description: c.kind === "file" ? boundedContext(c.description, 300) : undefined,
              status: c.status,
              exitCode: c.exitCode,
              output: c.output ? boundedContext(c.output, 600) : undefined,
            })),
          };
        }
        const query = (str("query") ?? "").toLowerCase();
        const terms = query.split(/\s+/).filter((w) => w.length >= 2);
        if (terms.length === 0)
          throw new Error("sshs3_session_search needs a query or an id");
        const limit = Math.max(1, Math.min(10, Math.round(num("limit") ?? 5)));
        const scored = sessions
          .map((t) => {
            const lines = [
              t.title,
              t.target?.label ?? "",
              ...t.messages.filter((m) => m.role !== "system").map((m) => m.text),
              ...t.changes.map((c) => `${c.target} ${c.command ?? c.description}`),
            ];
            const haystack = lines.join("\n").toLowerCase();
            const hits = terms.filter((w) => haystack.includes(w)).length;
            const matching = lines
              .flatMap((l) => l.split("\n"))
              .filter((l) => terms.some((w) => l.toLowerCase().includes(w)))
              .slice(0, 3)
              .map((l) => boundedContext(l.trim(), 240));
            return { t, hits, matching };
          })
          // Every word must appear somewhere in the conversation.
          .filter((x) => x.hits === terms.length)
          .sort((a, b) => b.t.updatedAt - a.t.updatedAt);
        return {
          query,
          found: scored.length,
          conversations: scored.slice(0, limit).map(({ t, matching }) => ({
            id: t.id,
            title: t.title,
            startedAt: new Date(t.createdAt).toISOString(),
            target: t.target?.label,
            status: t.status,
            matching,
          })),
        };
      }

      case "sshs3_cluster_exec": {
        const command = str("command");
        const description =
          str("description") || "Run parallel command across cluster";
        const clusterName = str("cluster")?.replace(/^@cluster:/i, "");
        if (!command) throw new Error("command is required for sshs3_cluster_exec");

        const extra = await hub.collectExtraContext();
        const allServers = extra.workspaceServers ?? [];
        const rawList = Array.isArray(p.serverIdsOrNames)
          ? (p.serverIdsOrNames as unknown[])
              .map((x) => String(x).trim())
              .filter(Boolean)
          : [];

        const matchedServers: WorkspaceServerSummary[] = [];
        if (clusterName) {
          const clLower = clusterName.toLowerCase();
          for (const srv of allServers) {
            if (
              srv.cluster &&
              (srv.cluster.toLowerCase() === clLower ||
                srv.cluster.toLowerCase().includes(clLower))
            ) {
              matchedServers.push(srv);
            }
          }
        }
        for (const item of rawList) {
          const q = item.replace(/^@/, "").toLowerCase();
          const found = allServers.find(
            (s) =>
              s.id.toLowerCase() === q ||
              s.name.toLowerCase() === q ||
              s.host.toLowerCase() === q ||
              s.name.toLowerCase().includes(q),
          );
          if (found && !matchedServers.some((m) => m.id === found.id)) {
            matchedServers.push(found);
          }
        }
        if (matchedServers.length === 0) {
          throw new Error(
            `No servers matched cluster "${clusterName ?? ""}" or serverIdsOrNames`,
          );
        }

        const targetSummary = clusterName
          ? `Cluster ${clusterName} (${matchedServers.map((s) => s.name).join(", ")})`
          : matchedServers.map((s) => s.name).join(", ");

        const safety = analyzeCommandSafety(command);
        const change: AgentChange = {
          id: crypto.randomUUID(),
          kind: "command",
          target: targetSummary,
          description: boundedContext(
            `[Parallel Cluster Exec · ${matchedServers.length} nodes] ${description}`,
          ),
          command: boundedContext(command, 8000),
          status: "pending",
          riskLevel: safety.riskLevel,
          riskReason: safety.riskReason,
          parsedSubcommands: safety.parsedSubcommands,
          at: Date.now(),
        };
        task.changes.push(change);
        if (authorize) {
          await authorize(change);
        }
        change.status = "running";
        hub.changed();

        const perNodeResults = await Promise.all(
          matchedServers.map(async (srv) => {
            const openSession = hub.terminals
              .list()
              .find(
                (t) =>
                  t.state !== "disconnected" &&
                  (t.profileId === srv.id ||
                    t.label.toLowerCase() === srv.name.toLowerCase() ||
                    t.label.toLowerCase().includes(srv.name.toLowerCase())),
              );
            if (openSession) {
              try {
                const ready = await hub.terminals.ensureReady(openSession.id);
                hub.terminals.claim(ready.id, ready.generation, task.id);
                const res = await hub.terminals.execute(
                  ready.id,
                  ready.generation,
                  task.id,
                  command,
                );
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: res.exitCode,
                  output: res.output,
                  source: `terminal:${ready.id}`,
                };
              } catch (err) {
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: 1,
                  output: safeError(err),
                  source: `terminal:${openSession.id}`,
                };
              }
            }
            if (isDemoTarget(srv.id)) {
              return {
                node: srv.name,
                host: srv.host,
                nodeRole: srv.nodeRole,
                exitCode: 0,
                output: simulateDemoNodeCommand(srv, command),
                source: `demo-cluster:${srv.id}`,
              };
            }
            if (hub.host.openServerTerminal) {
              try {
                const sessionId = await hub.host.openServerTerminal(srv.id);
                const ready = await hub.terminals.ensureReady(sessionId);
                hub.terminals.claim(ready.id, ready.generation, task.id);
                const res = await hub.terminals.execute(
                  ready.id,
                  ready.generation,
                  task.id,
                  command,
                );
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: res.exitCode,
                  output: res.output,
                  source: `terminal:${ready.id}`,
                };
              } catch (err) {
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: 1,
                  output: safeError(err),
                  source: `ssh:${srv.id}`,
                };
              }
            }
            return {
              node: srv.name,
              host: srv.host,
              nodeRole: srv.nodeRole,
              exitCode: 1,
              output: "No open terminal for this node",
              source: `unconnected:${srv.id}`,
            };
          }),
        );

        const allOk = perNodeResults.every((r) => r.exitCode === 0);
        change.status = allOk ? "completed" : "failed";
        change.exitCode = allOk ? 0 : 1;
        change.output = perNodeResults
          .map(
            (r) =>
              `=== ${r.node} (${r.host}${r.nodeRole ? ` · ${r.nodeRole}` : ""}) [exit ${r.exitCode}] ===\n${r.output}`,
          )
          .join("\n\n");
        void hub.recordAgentChangeActivity(task, change);
        hub.changed();
        return {
          ok: allOk,
          cluster: clusterName,
          nodeCount: perNodeResults.length,
          results: perNodeResults,
        };
      }

      case "sshs3_workspace_layout": {
        const op = (str("operation") ||
          "open_cluster_split") as WorkspaceLayoutEvent["operation"];
        const clusterName = str("cluster")?.replace(/^@cluster:/i, "");
        const extra = await hub.collectExtraContext();
        const allServers = extra.workspaceServers ?? [];
        const rawList = Array.isArray(p.serverIdsOrNames)
          ? (p.serverIdsOrNames as unknown[])
              .map((x) => String(x).trim())
              .filter(Boolean)
          : str("serverIdOrName")
            ? [str("serverIdOrName")!]
            : [];

        const matchedServers: WorkspaceServerSummary[] = [];
        if (clusterName) {
          const clLower = clusterName.toLowerCase();
          for (const srv of allServers) {
            if (
              srv.cluster &&
              (srv.cluster.toLowerCase() === clLower ||
                srv.cluster.toLowerCase().includes(clLower))
            ) {
              matchedServers.push(srv);
            }
          }
        }
        for (const item of rawList) {
          const q = item.replace(/^@/, "").toLowerCase();
          const found = allServers.find(
            (s) =>
              s.id.toLowerCase() === q ||
              s.name.toLowerCase() === q ||
              s.host.toLowerCase() === q ||
              s.name.toLowerCase().includes(q),
          );
          if (found && !matchedServers.some((m) => m.id === found.id)) {
            matchedServers.push(found);
          }
        }

        const layoutRaw = str("layout");
        const layout: "grid" | "horizontal" | "vertical" =
          layoutRaw === "horizontal" || layoutRaw === "vertical"
            ? layoutRaw
            : "grid";

        const event: WorkspaceLayoutEvent = {
          id: crypto.randomUUID(),
          operation: op,
          cluster: clusterName,
          serverIds: matchedServers.map((s) => s.id),
          layout,
          leftTargetId: str("leftTargetId") || matchedServers[0]?.id,
          rightTargetId: str("rightTargetId") || matchedServers[1]?.id,
          createdAt: Date.now(),
        };
        hub.pendingLayoutEvent = event;
        hub.changed();
        return {
          ok: true,
          operation: op,
          layoutEvent: event,
          matchedNodes: matchedServers.map((s) => ({
            id: s.id,
            name: s.name,
            host: s.host,
          })),
        };
      }

      case "sshs3_storage_ops": {
        const op = (str("operation") || "list_files") as
          | "list_files"
          | "read_remote_file"
          | "diff_paths";
        const targetA = str("targetA") || str("serverIdOrName") || str("s3ProfileId") || "local";
        const pathA = str("pathA") || str("path") || "/";
        const targetB = str("targetB");
        const pathB = str("pathB") || pathA;

        // Scripted results only for the demo workspace's own fixtures (by identity, isDemoTargetRef):
        // in demo mode a real target still takes the real path.
        if ((await hub.isDemoTargetRef(targetA)) || (await hub.isDemoTargetRef(targetB))) {
          return simulateDemoStorageOps(op, targetA, pathA, targetB, pathB);
        }

        if (hub.host.storageOps) {
          return await hub.host.storageOps({
            operation: op,
            targetA,
            pathA,
            targetB,
            pathB,
          });
        }
        return simulateDemoStorageOps(op, targetA, pathA, targetB, pathB);
      }

      case "sshs3_kb_search": {
        const query = str("query") || "";
        const cluster = str("cluster");
        const limit = num("limit") ?? 6;
        const docs = hub.getKbDocumentsList();
        const found = await hub.kb.searchHybrid(
          docs,
          { query, cluster, limit },
          await hub.kbEmbedder(),
          hub.embeddings,
        );
        return {
          query,
          cluster,
          totalDocuments: docs.length,
          // "hybrid": ranked by terms and by meaning; "lexical": by terms only.
          retrieval: found.retrieval,
          ...(found.embeddingError
            ? { embeddingError: found.embeddingError }
            : {}),
          matches: found.matches,
        };
      }

      case "sshs3_kb_manage": {
        const op = str("operation") || "list";
        if (op === "list") {
          return {
            documents: hub.getKbDocumentsList().map((d) => ({
              id: d.id,
              title: d.title,
              sourceType: d.sourceType,
              sourceRef: d.sourceRef,
              cluster: d.cluster,
              tags: d.tags,
              chunkCount: d.chunks.length,
              updatedAt: d.updatedAt,
            })),
          };
        }
        if (op === "delete_document") {
          const q = (str("idOrTitle") || str("id") || str("title") || "").toLowerCase();
          const existing = hub.getKbDocumentsList().find(
            (d) =>
              d.id.toLowerCase() === q ||
              d.title.toLowerCase() === q ||
              d.title.toLowerCase().includes(q),
          );
          if (!existing) throw new Error(`KB document "${q}" not found`);
          await hub.request({ action: "kb-delete", id: existing.id });
          return { ok: true, deletedId: existing.id, title: existing.title };
        }
        if (op === "ingest_local_folder") {
          const folderPath = requiredText(str("folderPath") || str("path"));
          await hub.request({
            action: "kb-ingest-folder",
            folderPath,
            cluster: str("cluster"),
            tags,
          });
          return {
            ok: true,
            operation: "ingest_local_folder",
            folderPath,
            totalDocuments: hub.getKbDocumentsList().length,
          };
        }
        if (op === "ingest_s3_prefix") {
          const s3ProfileId = requiredText(str("s3ProfileId") || str("idOrName") || str("profileId"));
          const prefix = str("prefix") || "";
          await hub.request({
            action: "kb-ingest-s3",
            s3ProfileId,
            prefix,
            cluster: str("cluster"),
          });
          return {
            ok: true,
            operation: "ingest_s3_prefix",
            s3ProfileId,
            prefix,
            totalDocuments: hub.getKbDocumentsList().length,
          };
        }
        // add_document
        const title = requiredText(str("title") || "Runbook / KB Document");
        const content = requiredText(str("content") || str("text") || "");
        await hub.request({
          action: "kb-save",
          doc: {
            id: str("id"),
            title,
            sourceType: "note",
            cluster: str("cluster"),
            tags,
            content,
            shared: bool("shared") ?? true,
          },
        });
        return {
          ok: true,
          operation: "add_document",
          title,
        };
      }

      case "sshs3_agent_and_mcp_manage": {
        const op = str("operation") || "list";
        if (op === "list") {
          return {
            agents: hub.getAgentsList(),
            mcpServers: hub.getMcpServersList(),
            mcpCatalog: MCP_MARKETPLACE_CATALOG,
            workforceRuns: hub.getWorkforceRunsList(),
            infraEdges: hub.getInfraEdgesList(),
          };
        }
        if (op === "run_workforce" || op === "delegate_to_agent") {
          const wfPrompt =
            str("prompt") ||
            str("mission") ||
            str("description") ||
            "Genomför parallell kluster- och infrastrukturanalys.";
          const rawIds = Array.isArray(p.agentIds)
            ? (p.agentIds as unknown[]).map(String)
            : str("idOrName")
              ? [str("idOrName")!]
              : undefined;
          // The calling agent waits for the specialists' reports.
          const run = await (
            await hub.beginWorkforceRun({
              prompt: wfPrompt,
              agentIds: rawIds,
              targetCluster: str("targetCluster") || str("cluster"),
              createTask: false,
            })
          ).done;
          hub.changed();
          return {
            ok: true,
            operation: op,
            workforceRun: run,
          };
        }
        if (op === "handoff_agent") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = hub.getAgentsList().find(
            (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`Agent "${q}" not found for handoff`);
          await hub.request({
            action: "agent-handoff",
            taskId: task.id,
            toAgentId: match.id,
            reason: str("reason") || str("prompt"),
          });
          return {
            ok: true,
            operation: "handoff_agent",
            handedOffTo: match.name,
            agentId: match.id,
          };
        }
        if (op === "install_mcp_preset") {
          const presetId =
            str("presetId") || str("idOrName") || str("id") || str("name");
          if (!presetId) throw new Error("presetId is required");
          await hub.request({
            action: "mcp-install-preset",
            presetId,
          });
          return {
            ok: true,
            operation: "install_mcp_preset",
            presetId,
            mcpServers: hub.getMcpServersList(),
          };
        }
        if (op === "save_infra_edge") {
          const fromNode = requiredText(str("fromNode") || str("from"));
          const toNode = requiredText(str("toNode") || str("to"));
          const relation =
            (str("relation") as InfraGraphEdge["relation"]) || "depends_on";
          await hub.request({
            action: "infra-edge-save",
            edge: {
              id: str("id"),
              from: fromNode,
              to: toNode,
              relation,
              label: str("edgeLabel") || str("label"),
            },
          });
          return {
            ok: true,
            operation: "save_infra_edge",
            from: fromNode,
            to: toNode,
            relation,
          };
        }
        if (op === "delete_infra_edge") {
          const edgeId = requiredText(str("idOrName") || str("id"));
          await hub.request({
            action: "infra-edge-delete",
            id: edgeId,
          });
          return { ok: true, operation: "delete_infra_edge", deletedId: edgeId };
        }
        if (op === "save_agent") {
          const name = requiredText(str("name"));
          const mission = requiredText(str("mission") || str("description"));
          await hub.request({
            action: "agent-save",
            agent: {
              id: str("id"),
              name,
              role: str("role") || "Infrastructure Mission Agent",
              icon: str("icon") || "🤖",
              mission,
              systemPrompt: str("systemPrompt") || mission,
              targetCluster: str("targetCluster") || str("cluster"),
              defaultMode: (str("defaultMode") as MissionAgent["defaultMode"]) || "assisted",
              allowedTools: Array.isArray(p.allowedTools)
                ? (p.allowedTools as string[])
                : ["all"],
              kbDocIds: Array.isArray(p.kbDocIds)
                ? (p.kbDocIds as string[])
                : undefined,
              mcpServerIds: Array.isArray(p.mcpServerIds)
                ? (p.mcpServerIds as string[])
                : undefined,
              scheduleMinutes: num("scheduleMinutes"),
            },
          });
          return { ok: true, operation: "save_agent", name };
        }
        if (op === "delete_agent") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = hub.getAgentsList().find(
            (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`Agent "${q}" not found`);
          await hub.request({ action: "agent-delete", id: match.id });
          return { ok: true, deletedAgentId: match.id, name: match.name };
        }
        if (op === "run_agent_mission") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = hub.getAgentsList().find(
            (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`Agent "${q}" not found`);
          await hub.request({
            action: "agent-run-mission",
            agentId: match.id,
            promptOverride: str("promptOverride"),
          });
          return { ok: true, startedAgent: match.name };
        }
        if (op === "save_mcp_server") {
          const name = requiredText(str("name"));
          const transport = str("transport") === "http" ? "http" : "stdio";
          await hub.request({
            action: "mcp-save",
            server: {
              id: str("id"),
              name,
              transport,
              command: str("command"),
              args: Array.isArray(p.args)
                ? (p.args as unknown[]).map(String)
                : undefined,
              url: str("url"),
              enabled: bool("enabled") ?? true,
            },
          });
          return { ok: true, operation: "save_mcp_server", name, transport };
        }
        if (op === "delete_mcp_server") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = hub.getMcpServersList().find(
            (s) => s.id.toLowerCase() === q || s.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`MCP server "${q}" not found`);
          await hub.request({ action: "mcp-delete", id: match.id });
          return { ok: true, deletedMcpServerId: match.id };
        }
        if (op === "test_mcp_server") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = hub.getMcpServersList().find(
            (s) => s.id.toLowerCase() === q || s.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`MCP server "${q}" not found`);
          await hub.request({ action: "mcp-test", id: match.id });
          const updated = hub.getMcpServersList().find((s) => s.id === match.id);
          return { ok: true, server: updated };
        }
        throw new Error(`Unsupported agent/MCP operation: ${op}`);
      }

      default:
        throw new Error(`Unknown sshs3 action: ${request.action}`);
    }
  }
