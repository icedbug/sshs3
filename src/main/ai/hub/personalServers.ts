import type { WorkspaceServerSummary } from "../../../shared/types/aiHub";
import type { WorkspaceActivityEvent } from "../../../shared/types/teamVault";

export interface PersonalServers {
  /** Whether any server is marked personal at all. */
  any: boolean;
  /** A server's id (a terminal's profile) that is a personal server. */
  id(profileId: string | undefined): boolean;
  /** A label that is a personal server's name, address or user@address, in any case. */
  named(label: string | undefined): boolean;
  /**
   * Whether an activity event is of a personal server. Its server's id decides while that server is
   * known, so a team server that happens to share a personal one's name is not taken for it. Without a
   * known id only its label is left to tell by.
   */
  activity(event: Pick<WorkspaceActivityEvent, "profileId" | "targetLabel">): boolean;
}

/**
 * Tells what was done on a server a person keeps to themselves (`shared: false`). What is done there is
 * not the team's: it is not learned from, and it is not put in the team's activity log.
 */
export function personalServers(servers: ReadonlyArray<WorkspaceServerSummary>): PersonalServers {
  const personal = servers.filter((s) => s.shared === false);
  const known = new Map(servers.map((s) => [s.id, s.shared === false]));
  const ids = new Set(personal.map((s) => s.id));
  const names = new Set(
    personal
      .flatMap((s) => [s.name, s.host, s.username && s.host ? `${s.username}@${s.host}` : ""])
      .filter(Boolean)
      .map((v) => v.trim().toLowerCase()),
  );
  const named = (label: string | undefined): boolean => Boolean(label && names.has(label.trim().toLowerCase()));
  return {
    any: personal.length > 0,
    id: (profileId) => Boolean(profileId && ids.has(profileId)),
    named,
    activity: (event) => {
      if (!personal.length) return false;
      const byId = event.profileId ? known.get(event.profileId) : undefined;
      return byId ?? named(event.targetLabel);
    },
  };
}

/** The activity a team may see: what was done on a personal server is left out. */
export function teamActivity<T extends Pick<WorkspaceActivityEvent, "profileId" | "targetLabel">>(
  events: ReadonlyArray<T>,
  servers: ReadonlyArray<WorkspaceServerSummary>,
): T[] {
  const personal = personalServers(servers);
  return personal.any ? events.filter((e) => !personal.activity(e)) : [...events];
}
