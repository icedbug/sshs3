import crypto from 'node:crypto';

/**
 * How an imported profile meets the ones already saved.
 *
 * An export leaves out passwords and keys, so importing it again must not wipe
 * the ones saved here: a field the file does not carry keeps its saved value.
 * Fields that only mean something on the machine they were written on (a key
 * file path, a PKCS#11 library, an agent socket) are never taken from a file,
 * the same as profile sync. A profile with the same id but another host, user
 * or port is a different server: it is added as a new profile instead of
 * quietly re-pointing the saved one.
 */
export interface ImportPlan<T> {
  save: T[];
  added: number;
  updated: number;
}

export function planProfileImport<T extends { id?: string }>(
  incoming: unknown[],
  existing: T[],
  opts: {
    valid: (p: Record<string, unknown>) => boolean;
    /** Fields that hold secrets: a missing one keeps the saved value. */
    secretFields: string[];
    /** Fields never taken from a file. */
    localOnlyFields: string[];
    /** Fields that say which server this is. */
    identityFields: string[];
  },
): ImportPlan<T> {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const out: ImportPlan<T> = { save: [], added: 0, updated: 0 };
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = { ...(raw as Record<string, unknown>) };
    if (!opts.valid(item)) continue;
    for (const f of opts.localOnlyFields) delete item[f];
    const id = typeof item.id === 'string' && item.id ? item.id : undefined;
    const saved = id ? (byId.get(id) as Record<string, unknown> | undefined) : undefined;
    const same =
      saved && opts.identityFields.every((f) => String(saved[f] ?? '') === String(item[f] ?? saved[f] ?? ''));
    if (saved && same) {
      const merged: Record<string, unknown> = { ...saved, ...item };
      for (const f of opts.secretFields) if (item[f] === undefined || item[f] === '') merged[f] = saved[f];
      for (const f of opts.localOnlyFields) merged[f] = saved[f];
      // The proxy's password is a secret too.
      const savedProxy = saved.proxy as Record<string, unknown> | undefined;
      const newProxy = item.proxy as Record<string, unknown> | undefined;
      if (savedProxy && newProxy && newProxy.password === undefined && savedProxy.password !== undefined)
        merged.proxy = { ...newProxy, password: savedProxy.password };
      for (const f of Object.keys(merged)) if (merged[f] === undefined) delete merged[f];
      out.save.push(merged as T);
      out.updated++;
    } else {
      out.save.push({ ...item, id: saved || !id ? crypto.randomUUID() : id } as T);
      out.added++;
    }
  }
  return out;
}
