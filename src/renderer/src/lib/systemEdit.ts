import { normalizeSystem, sameSystemName } from '@shared/system';
import { groupBySystem, mostCommonFolder, systemNameOf, type SystemProfile } from './systemGrouping';
import { withGroup } from './bulkProfileEdit';

/**
 * Changes to profiles that make up systems. Like `bulkProfileEdit`, every function returns only the
 * copies that actually change, so nothing is saved for a profile that stays as it is.
 */

/** The selected ids plus every other server of the systems the selected ones belong to. */
export function expandToSystems(profiles: readonly SystemProfile[], ids: ReadonlySet<string>): Set<string> {
  const expanded = new Set(ids);
  const names = profiles.filter((p) => ids.has(p.id)).map(systemNameOf).filter((n): n is string => n !== undefined);
  for (const profile of profiles) {
    const own = systemNameOf(profile);
    if (own !== undefined && names.some((name) => sameSystemName(name, own))) expanded.add(profile.id);
  }
  return expanded;
}

/** Moves profiles to `group`, a system with them: moving one server moves all of its system. */
export function moveWithSystems<T extends SystemProfile>(profiles: readonly T[], ids: ReadonlySet<string>, group: string | undefined): T[] {
  return withGroup(profiles, expandToSystems(profiles, ids), group);
}

/** The folder to give profiles grouped into the system `name`: the system's own if it exists, else the one most of them are in. */
export function defaultSystemFolder(profiles: readonly SystemProfile[], ids: ReadonlySet<string>, name: string): string | undefined {
  const existing = groupBySystem(profiles).systems.find((s) => sameSystemName(s.name, name));
  if (existing) return existing.folder;
  const chosen = profiles.filter((p) => ids.has(p.id));
  return chosen.length > 0 ? mostCommonFolder(chosen) : undefined;
}

/**
 * The selected profiles put into the system `name` and its `folder`. A server that is already in the
 * system keeps what it contributes (start directory, tunnels); one that comes from elsewhere starts
 * clean. The system's other servers follow into the folder, so it stays in one place.
 */
export function groupAsSystem<T extends SystemProfile>(profiles: readonly T[], ids: ReadonlySet<string>, name: string, folder: string | undefined): T[] {
  const changed: T[] = [];
  for (const profile of profiles) {
    const inSystem = inSystemNamed(profile, name);
    if (!ids.has(profile.id) && !inSystem) continue;
    if (inSystem && profile.group === folder) continue;
    const system = inSystem ? profile.system! : { name };
    const { group: _old, ...rest } = profile;
    changed.push({ ...rest, ...(folder !== undefined ? { group: folder } : {}), system } as T);
  }
  return changed;
}

/** Every server of the system `name` taken out of it; the profiles stay. */
export function ungroupSystem<T extends SystemProfile>(profiles: readonly T[], name: string): T[] {
  return profiles.filter((p) => inSystemNamed(p, name)).map(stripSystem);
}

/** One server taken out of its system. */
export function removeFromSystem<T extends SystemProfile>(profiles: readonly T[], id: string): T[] {
  return profiles.filter((p) => p.id === id && p.system).map(stripSystem);
}

/** Whether another system than `from` is already called `to`: renaming onto it would silently merge the two. */
export function systemNameTaken(profiles: readonly SystemProfile[], from: string, to: string): boolean {
  return profiles.some((p) => inSystemNamed(p, to) && !inSystemNamed(p, from));
}

/**
 * Every server of the system `from` given the name `to`, keeping its other settings. Blank or unchanged
 * names change nothing, and neither does a name another system already has (see `systemNameTaken`).
 */
export function renameSystem<T extends SystemProfile>(profiles: readonly T[], from: string, to: string): T[] {
  const name = normalizeSystem({ name: to }, undefined)?.name;
  if (!name || systemNameTaken(profiles, from, name)) return [];
  return profiles
    .filter((p) => inSystemNamed(p, from) && systemNameOf(p) !== name)
    .map((p) => ({ ...p, system: { ...p.system!, name } }));
}

function inSystemNamed(profile: SystemProfile, name: string): boolean {
  const own = systemNameOf(profile);
  return own !== undefined && sameSystemName(own, name);
}

function stripSystem<T extends SystemProfile>(profile: T): T {
  const { system: _system, ...rest } = profile;
  return rest as T;
}
