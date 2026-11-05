import type { SSHSystemMembership } from './types/ssh';

/** Longest system name, in characters. */
export const MAX_SYSTEM_NAME_LENGTH = 64;
/** Most tunnels one server contributes to a system. */
export const MAX_SYSTEM_TUNNELS = 20;
const MAX_START_DIRECTORY_LENGTH = 1024;
const MAX_ID_LENGTH = 100;

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > maxLength || CONTROL_CHARACTERS.test(text)) return undefined;
  return text;
}

/** True when two system names are the same system: compared ignoring case and surrounding space. */
export function sameSystemName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Cleans an untrusted `system` value from the UI, an import file, a sync payload or a Team Vault:
 * only the known fields are kept and each is checked. `tunnels` are the profile's own tunnels; a
 * tunnel id that is not among them is dropped. Returns undefined when there is no usable name, so
 * callers can omit the field.
 */
export function normalizeSystem(raw: unknown, tunnels: ReadonlyArray<{ id: string }> | undefined): SSHSystemMembership | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const name = cleanText(input.name, MAX_SYSTEM_NAME_LENGTH);
  if (name === undefined) return undefined;

  const system: SSHSystemMembership = { name };
  if (input.shell === false) system.shell = false;
  const startDirectory = cleanText(input.startDirectory, MAX_START_DIRECTORY_LENGTH);
  if (startDirectory !== undefined) system.startDirectory = startDirectory;

  if (Array.isArray(input.tunnelIds) && tunnels) {
    const known = new Set(tunnels.map((t) => t.id));
    const ids: string[] = [];
    for (const id of input.tunnelIds) {
      if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !known.has(id) || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length === MAX_SYSTEM_TUNNELS) break;
    }
    if (ids.length > 0) system.tunnelIds = ids;
  }
  return system;
}

/**
 * A copy of a profile with its `system` cleaned against its own tunnels (key removed when nothing
 * valid is left). A profile without a `system` key is returned as is, so save paths that never touch
 * systems stay byte-identical.
 */
export function withNormalizedSystem<T extends { system?: SSHSystemMembership; tunnels?: ReadonlyArray<{ id: string }> }>(profile: T): T {
  if (!('system' in profile)) return profile;
  const { system, ...rest } = profile;
  const clean = normalizeSystem(system, profile.tunnels);
  return (clean ? { ...rest, system: clean } : rest) as T;
}
