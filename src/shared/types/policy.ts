import type { AppSettings } from './settings';

/**
 * Enterprise policy: values an administrator sets once per machine (Windows registry / GPO, or a root-owned
 * policy.conf) that override and lock the matching user setting. This table is the single source of truth:
 * parsing, registry reading, the settings UI and the ADMX/ADML templates all derive from it, so adding a policy
 * is one entry here plus its ADMX/ADML entry and its enforcement point.
 */

export type PolicySettingId =
  | 'autoCheckUpdates'
  | 'smartcardAuthMode'
  | 'localTerminalAgentMode'
  | 'x11ServerMode'
  | 'x11ServerArgs'
  | 'enableOpenShift';

/** Policy-only switches with no user setting behind them. Allowed unless the policy says `false`. */
export type PolicyFeatureId = 'gitKeyFetch' | 'dotfileGitImport';

export type PolicyValueType =
  | { type: 'boolean' }
  | { type: 'string' }
  | { type: 'enum'; values: readonly string[] };

export type PolicyDefinition = PolicyValueType & {
  id: PolicySettingId | PolicyFeatureId;
  /** 'setting' overrides and locks an AppSettings key of the same name; 'feature' is a policy-only on/off. */
  target: 'setting' | 'feature';
  /** English description, also used for the ADML template. */
  description: string;
};

export const POLICY_DEFINITIONS: readonly PolicyDefinition[] = [
  {
    id: 'autoCheckUpdates',
    target: 'setting',
    type: 'boolean',
    description: 'Check GitHub Releases for new versions. Set to false to stop all update traffic.',
  },
  {
    id: 'smartcardAuthMode',
    target: 'setting',
    type: 'enum',
    values: ['always-prompt', 'agent-per-session', 'agent-global'],
    description: 'Smartcard / FIDO2 PIN caching mode.',
  },
  {
    id: 'localTerminalAgentMode',
    target: 'setting',
    type: 'enum',
    values: ['auto', 'system', 'app-managed', 'disabled'],
    description: 'Which SSH agent local shell tabs inherit.',
  },
  {
    id: 'x11ServerMode',
    target: 'setting',
    type: 'enum',
    values: ['manual', 'auto', 'always'],
    description: 'Windows only: when the bundled X server starts.',
  },
  {
    id: 'x11ServerArgs',
    target: 'setting',
    type: 'string',
    description: 'Windows only: command-line arguments for the X server.',
  },
  {
    id: 'enableOpenShift',
    target: 'setting',
    type: 'boolean',
    description: 'Enable OpenShift support and tools.',
  },
  {
    id: 'gitKeyFetch',
    target: 'feature',
    type: 'boolean',
    description: 'Allow fetching public SSH keys from GitHub, GitLab or a custom Git host.',
  },
  {
    id: 'dotfileGitImport',
    target: 'feature',
    type: 'boolean',
    description: 'Allow importing dotfiles from a Git repository.',
  },
];

export interface PolicyDocument {
  /** `Pick` fails to compile if a PolicySettingId is not an AppSettings key. */
  settings: Partial<Pick<AppSettings, PolicySettingId>>;
  features: Partial<Record<PolicyFeatureId, boolean>>;
}

export const EMPTY_POLICY: PolicyDocument = { settings: {}, features: {} };

/** What the renderer is told: which settings are locked, which features are decided, and why a policy was not applied. */
export interface PolicyInfo {
  managed: PolicySettingId[];
  features: PolicyDocument['features'];
  warnings: string[];
}

/** The registry value name for a policy id: the id with its first letter upper-cased (`AutoCheckUpdates`). */
export function policyRegistryName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
