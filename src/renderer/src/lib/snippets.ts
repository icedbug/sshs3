import { formatDateTime } from './format';

export interface SnippetContext {
  host: string;
  user: string;
}

export interface SnippetVariable {
  /** Variable name inside `{{name}}` or `{{name=default}}`. */
  name: string;
  /** Optional default value from `{{name=default}}` (`undefined` when no `=` was given). */
  defaultValue?: string;
}

const BUILTIN_VARS = new Set(['host', 'user', 'date']);
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*=\s*([^}]*?))?\s*\}\}/g;

/**
 * Extracts parameterized placeholders (`{{var}}` and `{{var=default}}`) from a snippet command.
 * Built-in context variables (`host`, `user`, `date`) are omitted by default.
 */
export function parseSnippetVariables(
  command: string,
  options?: { includeBuiltins?: boolean }
): SnippetVariable[] {
  const includeBuiltins = options?.includeBuiltins ?? false;
  const seen = new Map<string, SnippetVariable>();
  for (const match of command.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!includeBuiltins && BUILTIN_VARS.has(name)) continue;
    const defaultValue = match[2] !== undefined ? match[2] : undefined;
    const existing = seen.get(name);
    if (!existing) {
      seen.set(name, defaultValue !== undefined ? { name, defaultValue } : { name });
    } else if (existing.defaultValue === undefined && defaultValue !== undefined) {
      existing.defaultValue = defaultValue;
    }
  }
  return Array.from(seen.values());
}

/** Returns true when the command contains at least one user-fillable `{{var}}` placeholder. */
export function hasSnippetVariables(command: string): boolean {
  return parseSnippetVariables(command).length > 0;
}

/** Returns a map of variable names to their initial values (default values or empty strings). */
export function getDefaultSnippetValues(command: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const v of parseSnippetVariables(command)) {
    values[v.name] = v.defaultValue ?? '';
  }
  return values;
}

/** Returns variable names that currently have neither a non-empty value nor a default value. */
export function getMissingSnippetVariables(
  command: string,
  values?: Record<string, string>
): string[] {
  return parseSnippetVariables(command)
    .filter((v) => {
      const provided = values?.[v.name];
      if (provided !== undefined && provided !== '') return false;
      return v.defaultValue === undefined;
    })
    .map((v) => v.name);
}

/**
 * Fills `{{host}}`, `{{user}}`, `{{date}}`, plus any supplied `values` and `{{var=default}}`
 * defaults. Variables without a value or default are left untouched.
 */
export function expandSnippet(
  command: string,
  ctx: SnippetContext,
  now: Date = new Date(),
  values?: Record<string, string>
): string {
  return command.replace(VARIABLE_PATTERN, (match, name: string, rawDefault?: string) => {
    if (name === 'host') return ctx.host || rawDefault || '';
    if (name === 'user') return ctx.user || rawDefault || '';
    if (name === 'date') return formatDateTime(now);
    const provided = values && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    if (provided !== undefined && provided !== '') return provided;
    if (rawDefault !== undefined) return rawDefault;
    return match;
  });
}
