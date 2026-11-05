import type { WinAttributes } from '../../shared/types/storage';

/** The path column of `attrib` output starts at a drive letter or a UNC prefix. */
const ATTRIB_LINE_RE = /^([A-Z ]*?)\s*(?:[A-Za-z]:\\|\\\\)/;

/**
 * Reads the R/H/S/A flags from `attrib <path>` output (`A  SH        C:\dir\file`). Only the flag columns in front of
 * the path are read, never the path itself: `attrib` writes in the OEM code page, so a path with å/ä/ö does not
 * round-trip through UTF-8. Throws when no such line exists (`File not found - ...`, a message in the user's
 * language), so a failure is never shown as "no attributes set".
 */
export function parseAttribOutput(stdout: string): WinAttributes {
  for (const line of stdout.split(/\r?\n/)) {
    const match = ATTRIB_LINE_RE.exec(line);
    if (!match) continue;
    const flags = match[1];
    return {
      readOnly: flags.includes('R'),
      hidden: flags.includes('H'),
      system: flags.includes('S'),
      archive: flags.includes('A'),
    };
  }
  throw new Error('Could not read the file attributes');
}

/**
 * `attrib` flags (`+R -H ...`) for the given changes. `attrib` refuses to touch a hidden or system file ("Not
 * resetting hidden file", exit 0) unless H/S are named in the same call, so when the current attributes are known
 * the unchanged H and S are repeated with their current value.
 */
export function buildAttribFlags(changes: Partial<WinAttributes>, current?: WinAttributes): string[] {
  const merged: Partial<WinAttributes> = { ...changes };
  if (current && Object.keys(changes).length > 0) {
    merged.hidden ??= current.hidden;
    merged.system ??= current.system;
  }
  const flag = (on: boolean | undefined, letter: string): string[] => (on === undefined ? [] : [`${on ? '+' : '-'}${letter}`]);
  return [
    ...flag(merged.readOnly, 'R'),
    ...flag(merged.hidden, 'H'),
    ...flag(merged.system, 'S'),
    ...flag(merged.archive, 'A'),
  ];
}

/** The attributes that differ from what was asked for (empty when the change took effect). */
export function unappliedAttributes(requested: Partial<WinAttributes>, actual: WinAttributes): Array<keyof WinAttributes> {
  return (Object.keys(requested) as Array<keyof WinAttributes>).filter(
    (key) => requested[key] !== undefined && requested[key] !== actual[key]
  );
}
