import crypto from "node:crypto";
import type {
  InfraGraphEdge,
  LocalServerAuthOverride,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../../shared/types/aiHub";
import { type ProviderProfile } from "../../../../shared/types/ai";
import { isProdTag } from "../CommandSafetyService";
import { guardUrl } from "../Notifier";
import { deleteDemoInfraEdge, getDemoInfraEdges, getDemoServers, isDemoMode, saveDemoInfraEdge } from "../demoWorkspace";
import { isDemoTarget } from "../../../demo/demoMode";
import { boundedContext, clip } from "../privacy";
import { removedMessage } from "../WorkBoard";
import { requiredText } from "../hubHelpers";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * The servers the workspace knows, how they depend on each other, and saved profiles.
 *
 * Describing, adding, changing and removing a server (and who may, on a server several people share),
 * the links between servers, and what a server target the model named leads to.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class ServersPart {
  getInfraEdgesList(this: HubService): InfraGraphEdge[] {
    const stored = this.store.data.infraEdges ?? [];
    if (!isDemoMode()) return stored;
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    return [
      ...stored,
      ...getDemoInfraEdges().filter(
        (de) => !dismissed.has(de.id) && !stored.some((e) => e.id === de.id),
      ),
    ];
  }

  /**
   * On a shared server, a storage target whose address a user typed is checked like a link they
   * typed: reading a bucket into the knowledge base must not be a way to make the server call
   * its own loopback or the network around it.
   */
  async assertStorageReach(this: HubService, targetRef: string): Promise<void> {
    if (!this.sharedServer()) return;
    const q = targetRef.trim().replace(/^@/, "").toLowerCase();
    const profiles = (await this.host.extraAppContext?.().catch(() => undefined))?.s3Profiles ?? [];
    // Every profile the name could stand for: the storage is resolved by id, by name and by part of a name.
    const meant = profiles.filter((s) => {
      const id = s.id.toLowerCase();
      return id === q || `s3-${id}` === q || s.name.toLowerCase().includes(q);
    });
    for (const profile of meant) {
      const endpoint = profile.endpoint?.trim();
      if (!endpoint) continue;
      await guardUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`, {
        ...this.outboundGuard(),
        allowPlainHttp: true,
        lookup: this.kbNetwork?.lookup,
      });
    }
  }

  /** The server as the team shares it, when it is one: not a person's own server, and not a vault's (the vault has its own roles). */
  async teamServerCopy(this: HubService, profileId: string | undefined): Promise<WorkspaceServerSummary | undefined> {
    if (!profileId) return undefined;
    const found = await this.knownServer(profileId);
    return found && found.shared !== false && !found.fromVault ? found : undefined;
  }

  async knownServer(this: HubService, profileId: string): Promise<WorkspaceServerSummary | undefined> {
    const extra = await this.collectExtraContext().catch(() => undefined);
    return (extra?.workspaceServers ?? []).find((s) => s.id === profileId);
  }

  /**
   * On a shared server, where a server the team shares leads is the administrator's to decide:
   * a member who points it somewhere else, renames it, takes it out of the team or lifts its
   * "prod" tag changes what every teammate and every teammate's agent connects to and is asked about.
   * A member still describes it, tags it, and sets their own user name and key for it.
   */
  assertMayChangeTeamServer(this: HubService,
    known: WorkspaceServerSummary | undefined,
    next: { name?: string; host?: string; port?: number; username?: string; shared?: boolean; tags?: string[] },
  ): void {
    if (!known || !this.sharedServer() || this.host.teamAdmin?.()) return;
    const who = "Only an administrator of this server";
    if (next.shared === false) throw new Error(`${who} takes a server out of the team's list.`);
    const moved =
      (next.name !== undefined && next.name.trim() !== known.name) ||
      (next.host !== undefined && next.host.trim() !== known.host) ||
      (next.port !== undefined && next.port !== (known.port || 22)) ||
      (next.username !== undefined && next.username !== (known.username || "root"));
    if (moved)
      throw new Error(
        `${who} changes the name, address, port or user name of a server the team shares. Your own user name and key for it are set under "only for me".`,
      );
    const lifted = (known.tags ?? []).filter(isProdTag).filter((t) => !(next.tags ?? known.tags ?? []).some((x) => x.trim().toLowerCase() === t.toLowerCase()));
    if (lifted.length) throw new Error(`${who} takes the tag "${lifted[0]}" off a server the team shares: it is what makes changes there wait for a person.`);
  }

  assertMayRemoveTeamServer(this: HubService, known: WorkspaceServerSummary | undefined): void {
    if (known && this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("Only an administrator of this server removes a server the team shares.");
  }

  /**
   * The ordinary connection editor (`profiles:save-ssh`, `profiles:delete-ssh`, a folder removed with
   * its servers) is held to the same rule as the hub's own server actions: one rule for both doors.
   */
  async assertMayChangeServerProfile(this: HubService, next: { id: string; name?: string; host?: string; port?: number; username?: string; shared?: boolean; tags?: string[] }): Promise<void> {
    // A server a teammate removed is not brought back by the connection editor's view of it either.
    if (next.id?.trim() && next.shared !== false) {
      await this.pullTeamWorkspace();
      const removed = await this.serverRemovedMessage(next.id.trim());
      if (removed) throw new Error(removed);
    }
    const teamCopy = await this.teamServerCopy(next.id);
    // The save follows this check: the version it starts from is noted now (see noteServerEditBase).
    if (next.id?.trim()) this.noteServerEditBase(next.id.trim(), teamCopy);
    if (!this.sharedServer() || this.host.teamAdmin?.()) return;
    this.assertMayChangeTeamServer(teamCopy, { ...next, port: next.port || 22, username: next.username?.trim() || "root", tags: next.tags ?? [] });
  }

  /** Remembers which version of the team's copy of a server an edit here started from (see WorkspaceServerSummary.baseAt). */
  noteServerEditBase(this: HubService, id: string, teamCopy: WorkspaceServerSummary | undefined): void {
    const base = { ...this.store.data.serverEditBase };
    if (teamCopy?.updatedAt) base[id] = teamCopy.updatedAt;
    else delete base[id];
    this.store.data.serverEditBase = base;
  }

  /** What to tell somebody who saves a team server that was removed (and not added again since), or undefined. */
  async serverRemovedMessage(this: HubService, id: string): Promise<string | undefined> {
    const raw = this.store.data.deletedServerIds?.[id];
    const at = typeof raw === "number" ? raw : Date.parse(String(raw ?? "")) || Number(raw) || 0;
    if (!at) return undefined;
    const known = await this.knownServer(id);
    if (known && (Date.parse(known.updatedAt ?? "") || 0) > at) return undefined;
    return removedMessage("This server", this.store.data.deletedServerBy?.[id], at, "so the change was not saved. Add it as a new server to keep it.");
  }

  async assertMayRemoveServerProfile(this: HubService, id: string): Promise<void> {
    if (!this.sharedServer() || this.host.teamAdmin?.()) return;
    this.assertMayRemoveTeamServer(await this.teamServerCopy(id));
  }

  applyLocalOverride(this: HubService, override: LocalServerAuthOverride): void {
    this.store.data.localOverrides ??= {};
    const username = override.username?.trim() || undefined;
    const privateKeyPath = override.privateKeyPath?.trim() || undefined;
    const authType = override.authType;
    if (!username && !privateKeyPath && !authType) {
      delete this.store.data.localOverrides[override.profileId];
    } else {
      this.store.data.localOverrides[override.profileId] = {
        profileId: override.profileId,
        ...(username ? { username } : {}),
        ...(privateKeyPath ? { privateKeyPath } : {}),
        ...(authType ? { authType } : {}),
      };
    }
  }

  upsertLocalS3ServerCache(this: HubService, server: WorkspaceServerSummary): void {
    this.store.data.s3SyncedServers ??= [];
    this.store.data.deletedServerIds ??= {};
    delete this.store.data.deletedServerIds[server.id];
    const clean: WorkspaceServerSummary = {
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port || 22,
      username: server.username || "root",
      authType: server.authType,
      privateKeyPath: server.privateKeyPath,
      pkcs11LibPath: server.pkcs11LibPath,
      fido2Resident: server.fido2Resident,
      proxyJump: server.proxyJump,
      proxyJumpProfileId: server.proxyJumpProfileId,
      forwardAgent: server.forwardAgent,
      x11Forwarding: server.x11Forwarding,
      x11Display: server.x11Display,
      compression: server.compression,
      serverAliveInterval: server.serverAliveInterval,
      initialPath: server.initialPath,
      poolId: server.poolId,
      dotfilesSyncPolicy: server.dotfilesSyncPolicy,
      autoReconnect: server.autoReconnect,
      maxReconnectAttempts: server.maxReconnectAttempts,
      reconnectDelayMs: server.reconnectDelayMs,
      extraOptions: server.extraOptions,
      tunnels: server.tunnels,
      folder: server.folder,
      group: server.group,
      cluster: server.cluster,
      nodeRole: server.nodeRole,
      description: server.description,
      role: server.role,
      tags: server.tags,
      shared: true,
      updatedAt: server.updatedAt || new Date().toISOString(),
      updatedBy: server.updatedBy,
    };
    this.store.data.s3SyncedServers = [
      ...this.store.data.s3SyncedServers.filter((s) => s.id !== server.id),
      clean,
    ];
  }

  getKnownServers(this: HubService): WorkspaceServerSummary[] {
    const map = new Map<string, WorkspaceServerSummary>();
    for (const s of isDemoMode() ? getDemoServers() : []) {
      if (s?.id) map.set(s.id, s);
    }
    for (const s of this.store.data.s3SyncedServers ?? []) {
      if (s?.id) map.set(s.id, s);
    }
    for (const s of this.cachedWorkspaceServers) {
      if (s?.id) map.set(s.id, s);
    }
    return Array.from(map.values());
  }

  async resolveServerTarget(this: HubService,
    query?: string,
  ): Promise<WorkspaceServerSummary | undefined> {
    if (!query || !query.trim()) return undefined;
    const q = query.trim().toLowerCase();
    const extra = await this.collectExtraContext();
    const servers = extra.workspaceServers ?? [];
    return (
      servers.find((s) => s.id.toLowerCase() === q) ||
      servers.find((s) => s.name.toLowerCase() === q) ||
      servers.find((s) => s.host.toLowerCase() === q) ||
      servers.find(
        (s) =>
          s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q),
      )
    );
  }

  /**
   * Whether a tool's target reference (an id, or the server name or host the model gave instead) is one
   * of the demo workspace's fixtures. Identity decides (isDemoTarget): a name or host only counts through
   * the server it resolves to.
   */
  async isDemoTargetRef(this: HubService, ref: string | undefined): Promise<boolean> {
    if (!ref || !isDemoMode()) return false;
    return isDemoTarget(ref) || isDemoTarget((await this.resolveServerTarget(ref))?.id);
  }

  async recordServerDeleted(this: HubService, id: string): Promise<void> {
    const trimmed = id?.trim();
    if (!trimmed) return;
    await this.initialize().catch(() => {});
    const nowIso = new Date().toISOString();
    this.store.data.deletedServerIds = {
      ...(this.store.data.deletedServerIds ?? {}),
      [trimmed]: nowIso,
    };
    this.store.data.deletedServerBy = { ...this.store.data.deletedServerBy, [trimmed]: await this.resolveActorName() };
    this.store.data.s3SyncedServers = (
      this.store.data.s3SyncedServers ?? []
    ).filter((s) => s.id !== trimmed);
    const rawWorkspaceServers =
      (await this.host.workspaceServers?.().catch(() => [])) ?? [];
    await this.syncSharedWorkspaceFile(rawWorkspaceServers).catch(() => {});
    await this.store.save().catch(() => {});
    this.s3Workspace.schedulePush(400);
    this.changed();
  }

  async recordServerSaved(this: HubService, id: string, shared?: boolean): Promise<void> {
    const trimmed = id?.trim();
    if (!trimmed) return;
    await this.initialize().catch(() => {});
    // Made personal: it is no longer pushed as the team's (it used to come straight back as shared).
    if (shared === false)
      this.store.data.s3SyncedServers = (this.store.data.s3SyncedServers ?? []).filter((s) => s.id !== trimmed);
    if (this.store.data.deletedServerIds?.[trimmed]) {
      const next = { ...this.store.data.deletedServerIds };
      delete next[trimmed];
      this.store.data.deletedServerIds = next;
    }
    const rawWorkspaceServers =
      (await this.host.workspaceServers?.().catch(() => [])) ?? [];
    await this.syncSharedWorkspaceFile(rawWorkspaceServers).catch(() => {});
    await this.store.save().catch(() => {});
    this.s3Workspace.schedulePush(400);
    this.changed();
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleServers(this: HubService, request: RequestsOf<"servers">): Promise<Handled> {
    switch (request.action) {
      case "server-describe": {
        const pid = requiredText(request.profileId);
        // An id nobody here has describes nothing (and writes nothing into the team's activity).
        if (this.sharedServer() && !(await this.knownServer(pid))) throw new Error("Server not found");
        this.assertMayChangeTeamServer(await this.teamServerCopy(pid), { shared: request.shared, tags: request.tags });
        if (
          request.localUsername !== undefined ||
          request.localPrivateKeyPath !== undefined ||
          request.localAuthType !== undefined
        ) {
          this.applyLocalOverride({
            profileId: pid,
            username: request.localUsername,
            privateKeyPath: request.localPrivateKeyPath,
            authType: request.localAuthType,
          });
        }
        await this.host.describeServer?.({
          profileId: pid,
          shared: request.shared,
          cluster: request.cluster,
          nodeRole: request.nodeRole,
          description: request.description,
          role: request.role,
          tags: request.tags,
          updatedBy: await this.resolveActorName(),
        });
        const actor = await this.resolveActorName();
        const nowIso = new Date().toISOString();
        const allServers =
          (await this.host.workspaceServers?.().catch(() => [])) ?? [];
        const matchedServer =
          allServers.find((s) => s.id === pid) ||
          (this.store.data.s3SyncedServers ?? []).find((s) => s.id === pid);
        if (matchedServer) {
          const updatedSrv: WorkspaceServerSummary = {
            ...matchedServer,
            shared: request.shared ?? matchedServer.shared,
            cluster:
              request.cluster !== undefined
                ? request.cluster.trim() || undefined
                : matchedServer.cluster,
            nodeRole:
              request.nodeRole !== undefined
                ? request.nodeRole.trim() || undefined
                : matchedServer.nodeRole,
            description:
              request.description !== undefined
                ? request.description.trim() || undefined
                : matchedServer.description,
            role:
              request.role !== undefined
                ? request.role.trim() || undefined
                : matchedServer.role,
            tags: request.tags ?? matchedServer.tags,
            updatedAt: nowIso,
            updatedBy: actor,
          };
          if (updatedSrv.shared !== false) {
            this.upsertLocalS3ServerCache(updatedSrv);
          } else {
            this.store.data.s3SyncedServers = (
              this.store.data.s3SyncedServers ?? []
            ).filter((s) => s.id !== pid);
          }
        }
        const humanLabel = matchedServer?.name || pid;
        const roleInfo = [request.cluster, request.nodeRole, request.role]
          .filter(Boolean)
          .join(" / ");
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor,
          profileId: pid,
          targetLabel: humanLabel,
          kind: "note",
          summary: `Updated node metadata on ${humanLabel}${roleInfo ? ` (${roleInfo})` : ""}`,
          detail: request.description
            ? boundedContext(request.description, 400)
            : undefined,
        };
        // The activity log is the team's. A server a person keeps to themselves is not written into it.
        if ((request.shared ?? matchedServer?.shared) !== false) {
          this.appendActivityEvent(event);
          await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        }
        await this.syncAutoMemoryForTarget(pid, humanLabel);
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "server-upsert": {
        const s = request.server;
        const name = requiredText(s.name);
        const host = requiredText(s.host);
        const actor = await this.resolveActorName();
        const nowIso = new Date().toISOString();
        // On a shared server an id names a server this person has, or none: a teammate's own server
        // is not taken over by sending its id (nobody is shown it, but an id can be learnt elsewhere).
        if (s.id?.trim() && this.sharedServer() && !this.host.teamAdmin?.() && !(await this.knownServer(s.id.trim())))
          throw new Error("Server not found. Leave the id out to add a new server.");
        // A server a teammate removed is not brought back by a save from a view that still showed it.
        if (s.id?.trim() && s.shared !== false) {
          await this.pullTeamWorkspace();
          const removed = await this.serverRemovedMessage(s.id.trim());
          if (removed) throw new Error(removed);
        }
        const teamCopy = await this.teamServerCopy(s.id);
        // What the request leaves out is saved as its default (port 22, root, no tags), so that is what is compared.
        this.assertMayChangeTeamServer(teamCopy, {
          name,
          host,
          port: s.port || 22,
          username: s.username?.trim() || "root",
          shared: s.shared,
          tags: s.tags ?? [],
        });
        const saved = await this.host.upsertServer?.({
          id: s.id,
          name,
          host,
          port: s.port,
          username: s.username?.trim() || "root",
          authType: s.authType,
          privateKeyPath: s.privateKeyPath,
          pkcs11LibPath: s.pkcs11LibPath,
          fido2Resident: s.fido2Resident,
          proxyJump: s.proxyJump,
          proxyJumpProfileId: s.proxyJumpProfileId,
          forwardAgent: s.forwardAgent,
          x11Forwarding: s.x11Forwarding,
          x11Display: s.x11Display,
          compression: s.compression,
          serverAliveInterval: s.serverAliveInterval,
          initialPath: s.initialPath,
          poolId: s.poolId,
          dotfilesSyncPolicy: s.dotfilesSyncPolicy,
          autoReconnect: s.autoReconnect,
          maxReconnectAttempts: s.maxReconnectAttempts,
          reconnectDelayMs: s.reconnectDelayMs,
          extraOptions: s.extraOptions,
          tunnels: s.tunnels,
          folder: s.folder,
          cluster: s.cluster,
          nodeRole: s.nodeRole,
          role: s.role,
          description: s.description,
          tags: s.tags,
          shared: s.shared ?? true,
          updatedBy: actor,
        });
        const targetId = saved?.id ?? s.id ?? crypto.randomUUID();
        this.noteServerEditBase(targetId, teamCopy);
        if (this.store.data.deletedServerIds?.[targetId]) {
          const nextDeleted = { ...this.store.data.deletedServerIds };
          delete nextDeleted[targetId];
          this.store.data.deletedServerIds = nextDeleted;
        }
        if (
          s.localUsername !== undefined ||
          s.localPrivateKeyPath !== undefined ||
          s.localAuthType !== undefined
        ) {
          this.applyLocalOverride({
            profileId: targetId,
            username: s.localUsername,
            privateKeyPath: s.localPrivateKeyPath,
            authType: s.localAuthType,
          });
        }
        const summary: WorkspaceServerSummary = {
          id: targetId,
          name: name.trim(),
          host: host.trim(),
          port: s.port || 22,
          username: s.username?.trim() || "root",
          authType: s.authType ?? saved?.authType,
          privateKeyPath: s.privateKeyPath ?? saved?.privateKeyPath,
          pkcs11LibPath: s.pkcs11LibPath ?? saved?.pkcs11LibPath,
          fido2Resident: s.fido2Resident ?? saved?.fido2Resident,
          proxyJump: s.proxyJump ?? saved?.proxyJump,
          proxyJumpProfileId: s.proxyJumpProfileId ?? saved?.proxyJumpProfileId,
          forwardAgent: s.forwardAgent ?? saved?.forwardAgent,
          x11Forwarding: s.x11Forwarding ?? saved?.x11Forwarding,
          x11Display: s.x11Display ?? saved?.x11Display,
          compression: s.compression ?? saved?.compression,
          serverAliveInterval: s.serverAliveInterval ?? saved?.serverAliveInterval,
          initialPath: s.initialPath ?? saved?.initialPath,
          poolId: s.poolId ?? saved?.poolId,
          dotfilesSyncPolicy: s.dotfilesSyncPolicy ?? saved?.dotfilesSyncPolicy,
          autoReconnect: s.autoReconnect ?? saved?.autoReconnect,
          maxReconnectAttempts: s.maxReconnectAttempts ?? saved?.maxReconnectAttempts,
          reconnectDelayMs: s.reconnectDelayMs ?? saved?.reconnectDelayMs,
          extraOptions: s.extraOptions ?? saved?.extraOptions,
          tunnels: s.tunnels ?? saved?.tunnels,
          folder: s.folder?.trim() || s.cluster?.trim() || undefined,
          group: s.folder?.trim() || s.cluster?.trim() || undefined,
          cluster: s.cluster?.trim() || undefined,
          nodeRole: s.nodeRole?.trim() || undefined,
          role: s.role?.trim() || undefined,
          description: s.description?.trim() || undefined,
          tags: s.tags?.map((t) => t.trim()).filter(Boolean),
          shared: s.shared ?? true,
          updatedAt: nowIso,
          updatedBy: actor,
        };
        if (summary.shared) {
          this.upsertLocalS3ServerCache(summary);
        } else {
          this.store.data.s3SyncedServers = (
            this.store.data.s3SyncedServers ?? []
          ).filter((srv) => srv.id !== targetId);
        }
        const clusterBadge = s.cluster?.trim()
          ? ` in cluster ${s.cluster.trim()}`
          : "";
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor,
          profileId: targetId,
          targetLabel: name,
          kind: "note",
          summary: `Added/updated node ${name} (${host})${clusterBadge}${s.nodeRole ? ` [${s.nodeRole}]` : ""}`,
          detail: s.description
            ? boundedContext(s.description, 400)
            : undefined,
        };
        // The activity log is the team's. A server a person keeps to themselves is not written into it.
        if (summary.shared) {
          this.appendActivityEvent(event);
          await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        }
        await this.syncAutoMemoryForTarget(targetId, name);
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "server-local-override": {
        const pid = requiredText(request.override.profileId);
        if (this.sharedServer() && !(await this.knownServer(pid))) throw new Error("Server not found");
        this.applyLocalOverride({
          profileId: pid,
          username: request.override.username,
          privateKeyPath: request.override.privateKeyPath,
          authType: request.override.authType,
        });
        break;
      }
      case "server-delete": {
        const pid = requiredText(request.profileId);
        const actor = await this.resolveActorName();
        // Only a server this person has can be removed by them: an id alone (a teammate's own server, a guess) removes nothing.
        const mine = await this.knownServer(pid);
        if (!mine) throw new Error("Server not found");
        this.assertMayRemoveTeamServer(await this.teamServerCopy(pid));
        if (mine.shared === false) {
          // A person's own server: gone here, and nothing about it goes to the team (no removal mark, no log entry).
          await this.host.deleteServer?.(pid).catch(() => {});
          break;
        }
        const existing = (this.store.data.s3SyncedServers ?? []).find(
          (s) => s.id === pid,
        ) ?? mine;
        const delIso = new Date().toISOString();
        this.store.data.deletedServerIds ??= {};
        this.store.data.deletedServerIds[pid] = delIso;
        this.store.data.deletedServerBy = { ...this.store.data.deletedServerBy, [pid]: actor };
        this.store.data.s3SyncedServers = (
          this.store.data.s3SyncedServers ?? []
        ).filter((s) => s.id !== pid);
        await this.host.deleteServer?.(pid).catch(() => {});
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor,
          profileId: pid,
          targetLabel: existing?.name || pid,
          kind: "profile-update",
          summary: `Removed node ${existing?.name || pid} from workspace`,
        };
        this.appendActivityEvent(event);
        await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "infra-edge-save": {
        const e = request.edge;
        const savedEdge: InfraGraphEdge = {
          id: e.id?.trim() || crypto.randomUUID(),
          from: boundedContext(requiredText(e.from), 120),
          to: boundedContext(requiredText(e.to), 120),
          relation: e.relation || "depends_on",
          label: e.label ? boundedContext(e.label, 240) : undefined,
          ...(e.proposed
            ? {
                proposed: true,
                evidence: e.evidence ? boundedContext(e.evidence, 300) : undefined,
                proposedBy: e.proposedBy ? boundedContext(e.proposedBy, 80) : undefined,
              }
            : {}),
          updatedAt: Date.now(),
        };
        // A link a person already has is not turned back into a suggestion.
        const known = (this.store.data.infraEdges ?? []).find(
          (x) => !x.proposed && x.from === savedEdge.from && x.to === savedEdge.to && x.relation === savedEdge.relation,
        );
        if (known && savedEdge.proposed) break;
        this.store.data.infraEdges = [
          savedEdge,
          ...(this.store.data.infraEdges ?? []).filter((x) => x.id !== savedEdge.id),
        ];
        if (isDemoMode()) saveDemoInfraEdge(savedEdge);
        break;
      }
      case "infra-edge-confirm": {
        const edge = (this.store.data.infraEdges ?? []).find((x) => x.id === request.id);
        if (!edge) throw new Error("Link not found");
        edge.proposed = undefined;
        edge.updatedAt = Date.now();
        this.lastWorkSync = 0;
        break;
      }
      case "infra-edge-delete": {
        this.store.data.infraEdges = (this.store.data.infraEdges ?? []).filter(
          (x) => x.id !== request.id,
        );
        this.markSharedRemoved("edges", request.id);
        if (isDemoMode()) {
          this.markBuiltinDismissed(request.id, getDemoInfraEdges());
          deleteDemoInfraEdge(request.id);
        }
        break;
      }
      case "inventory-refresh":
        await this.context.inventory(true);
        break;
      case "profile-save": {
        if (!request.profile || typeof request.profile !== "object") throw new Error("A model profile to save is missing");
        const { hasApiKey: _hasApiKey, keyStorage: _keyStorage, ...profileInput } = request.profile;
        // The same rule as the model's address in the settings: on a shared server not the server itself or its network.
        if (profileInput.baseUrl?.trim()) await this.assertModelEndpointReach(profileInput.baseUrl.trim());
        const id = profileInput.id?.trim() || crypto.randomUUID();
        const profilePayload: Omit<ProviderProfile, "hasApiKey" | "keyStorage"> & { apiKey?: string | null } = {
          ...profileInput,
          id,
          name: clip(requiredText(profileInput.name), 120),
          provider: profileInput.provider,
          model: requiredText(profileInput.model),
          updatedAt: Date.now(),
          ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
        };
        await this.config.upsertProfile(profilePayload);
        if (request.activeRole) {
          await this.config.setActiveProfileForRole(request.activeRole, id);
        }
        break;
      }
      case "profile-delete": {
        await this.config.deleteProfile(requiredText(request.id));
        break;
      }
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return {};
  }
}
