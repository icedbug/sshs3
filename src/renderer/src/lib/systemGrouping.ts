import { sameSystemName } from '@shared/system';
import type { SSHSystemMembership } from '@shared/types/ssh';

/** The shape the system functions need; every SSH profile (personal or shared) has it. */
export interface SystemProfile {
  id: string;
  name: string;
  group?: string;
  system?: SSHSystemMembership;
}

export interface SystemBlock<T> {
  /** The system's name, as the first of its servers (by name) spells it. */
  name: string;
  /** The servers, by name. */
  members: T[];
  /** The folder the system lives in: the one most of its servers are in (a tie goes to the first server by name). */
  folder: string | undefined;
}

const byName = (a: SystemProfile, b: SystemProfile) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
/**
 * The system a profile belongs to, trimmed, or undefined. Tolerant of a malformed membership (a sync
 * or Team Vault entry written by another version never passed `normalizeSystem`): that is a profile in no system.
 */
export const systemNameOf = (profile: SystemProfile): string | undefined => {
  const name = typeof profile.system?.name === 'string' ? profile.system.name.trim() : '';
  return name ? name : undefined;
};
const key = (name: string) => name.toLowerCase();

/** The folder most of `members` are in, counting "no folder" as one; a tie goes to the first of them. */
export function mostCommonFolder(members: readonly SystemProfile[]): string | undefined {
  const counts = new Map<string | undefined, number>();
  for (const member of members) counts.set(member.group, (counts.get(member.group) ?? 0) + 1);
  let best: string | undefined = members[0].group;
  let bestCount = 0;
  for (const member of members) {
    const count = counts.get(member.group)!;
    if (count > bestCount) {
      best = member.group;
      bestCount = count;
    }
  }
  return best;
}

/** Splits profiles into the systems they form (sorted by name) and the ones that belong to none (in their order). */
export function groupBySystem<T extends SystemProfile>(profiles: readonly T[]): { systems: SystemBlock<T>[]; loose: T[] } {
  const loose: T[] = [];
  const byKey = new Map<string, T[]>();
  for (const profile of profiles) {
    const name = systemNameOf(profile);
    if (name === undefined) {
      loose.push(profile);
      continue;
    }
    const members = byKey.get(key(name)) ?? [];
    members.push(profile);
    byKey.set(key(name), members);
  }
  const systems = [...byKey.values()]
    .map((members) => {
      const sorted = [...members].sort(byName);
      return { name: systemNameOf(sorted[0])!, members: sorted, folder: mostCommonFolder(sorted) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { systems, loose };
}

/**
 * For drawing only: every server of a system with the folder of the system, so the folder tree puts
 * the whole system in one place even if a server's own folder differs (a sync race, an older version
 * of the app). Servers already in place and loose profiles are returned as the same objects.
 */
export function alignSystemMembers<T extends SystemProfile>(profiles: readonly T[]): T[] {
  const folders = new Map(groupBySystem(profiles).systems.map((s) => [key(s.name), s.folder]));
  return profiles.map((profile) => {
    const name = systemNameOf(profile);
    if (name === undefined) return profile;
    const folder = folders.get(key(name));
    if (profile.group === folder) return profile;
    const { group: _own, ...rest } = profile;
    return (folder === undefined ? rest : { ...rest, group: folder }) as T;
  });
}

/** Each system once (as spelled by its first server), sorted: suggestions for a system name. */
export function systemNames(profiles: readonly SystemProfile[]): string[] {
  return groupBySystem(profiles).systems.map((s) => s.name);
}

/** The servers of the system called `name` (ignoring case), by name. */
export function systemMembersOf<T extends SystemProfile>(profiles: readonly T[], name: string): T[] {
  return profiles.filter((p) => sameSystemName(systemNameOf(p) ?? '', name) && systemNameOf(p) !== undefined).sort(byName);
}
