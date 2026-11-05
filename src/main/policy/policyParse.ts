import {
  POLICY_DEFINITIONS,
  policyRegistryName,
  type PolicyDefinition,
  type PolicyDocument,
} from '../../shared/types/policy';

export interface ParsedPolicy {
  policy: PolicyDocument;
  /** One line per dropped key or value; the rest of the policy still applies. */
  warnings: string[];
}

const MAX_STRING_LENGTH = 1024;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const DEFINITIONS_BY_ID = new Map<string, PolicyDefinition>(POLICY_DEFINITIONS.map((def) => [def.id, def]));
const IDS_BY_REGISTRY_NAME = new Map<string, string>(
  POLICY_DEFINITIONS.map((def) => [policyRegistryName(def.id).toLowerCase(), def.id])
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value if it is valid for `def`, otherwise a reason it was rejected. */
function validate(def: PolicyDefinition, value: unknown): { ok: true; value: boolean | string } | { ok: false; reason: string } {
  if (def.type === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'expected true or false' };
  }
  if (typeof value !== 'string') return { ok: false, reason: 'expected a string' };
  if (def.type === 'enum') {
    return def.values.includes(value)
      ? { ok: true, value }
      : { ok: false, reason: `expected one of ${def.values.join(', ')}` };
  }
  if (value.length > MAX_STRING_LENGTH || CONTROL_CHARS.test(value)) {
    return { ok: false, reason: `expected up to ${MAX_STRING_LENGTH} characters without control characters` };
  }
  return { ok: true, value };
}

/** Turns an untrusted object (the output of `parsePolicyConf`, or registry values mapped by `registryValuesToRaw`) into a policy. */
export function parsePolicyObject(raw: unknown): ParsedPolicy {
  if (!isPlainObject(raw)) {
    return { policy: { settings: {}, features: {} }, warnings: ['Policy must be an object of policy names and values.'] };
  }
  const settings: Record<string, boolean | string> = {};
  const features: Record<string, boolean> = {};
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const def = DEFINITIONS_BY_ID.get(key);
    if (!def) {
      warnings.push(`Unknown policy "${key}" ignored.`);
      continue;
    }
    const result = validate(def, value);
    if (!result.ok) {
      warnings.push(`Policy "${key}" ignored: ${result.reason}.`);
    } else if (def.target === 'setting') {
      settings[def.id] = result.value;
    } else {
      features[def.id] = result.value as boolean;
    }
  }
  return { policy: { settings, features } as PolicyDocument, warnings };
}

/**
 * Reads the values under a registry key from `reg query <key>` output. REG_DWORD becomes a number, REG_SZ and
 * REG_EXPAND_SZ stay strings; other types are skipped. Value names with spaces are not supported (ours have none).
 */
export function parseRegQueryOutput(stdout: string): Record<string, number | string> {
  const values: Record<string, number | string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_DWORD|REG_SZ|REG_EXPAND_SZ)\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, type, data] = match;
    if (type === 'REG_DWORD') {
      const parsed = /^0x[0-9a-f]+$/i.test(data.trim()) ? Number.parseInt(data.trim(), 16) : Number.NaN;
      if (!Number.isNaN(parsed)) values[name] = parsed;
    } else {
      values[name] = data.trim();
    }
  }
  return values;
}

/** Maps registry value names to the canonical raw object (policy ids as keys, booleans as booleans). */
export function registryValuesToRaw(values: Record<string, number | string>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const id = IDS_BY_REGISTRY_NAME.get(name.toLowerCase());
    if (!id) {
      raw[name] = value; // unknown: let parsePolicyObject report it
      continue;
    }
    const def = DEFINITIONS_BY_ID.get(id);
    raw[id] = def?.type === 'boolean' && typeof value === 'number' ? value !== 0 : value;
  }
  return raw;
}

const TRUE_WORDS = new Set(['true', '1']);
const FALSE_WORDS = new Set(['false', '0']);

/**
 * Reads a `policy.conf`: one `name = value` per line, names case-insensitive (so `AutoCheckUpdates`, as in the
 * registry, works too). A line starting with `#` or `;` is a comment; there are no inline comments, quotes or
 * escapes, so a value is the rest of the line, trimmed. An optional `[sshs3]` header is accepted. Booleans are exactly
 * `true`, `false`, `1` or `0`. The first of a repeated name wins. Returns the same raw shape as the registry source,
 * to be validated by `parsePolicyObject`.
 */
export function parsePolicyConf(text: string): { raw: Record<string, unknown>; warnings: string[] } {
  // No prototype, so a line like `__proto__ = x` is just an unknown name.
  const raw: Record<string, unknown> = Object.create(null);
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((original, index) => {
    const line = original.trim();
    const where = `Line ${index + 1}`;
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    if (/^\[.*\]$/.test(line)) {
      if (!/^\[\s*sshs3\s*\]$/i.test(line)) warnings.push(`${where} ignored: only a [sshs3] section is supported.`);
      return;
    }
    const eq = line.indexOf('=');
    if (eq < 1) {
      warnings.push(`${where} ignored: expected "name = value".`);
      return;
    }
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const id = IDS_BY_REGISTRY_NAME.get(name.toLowerCase()) ?? name;
    if (id in raw) {
      warnings.push(`${where}: policy "${id}" is given more than once; the first value is used.`);
      return;
    }
    const def = DEFINITIONS_BY_ID.get(id);
    if (def?.type === 'boolean') {
      const word = value.toLowerCase();
      raw[id] = TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : value;
    } else {
      raw[id] = value;
    }
  });
  return { raw, warnings };
}
