import type { AppSettings } from '../../shared/types/settings';
import type { PolicyDocument, PolicyFeatureId, PolicySettingId } from '../../shared/types/policy';

export function managedSettingIds(policy: PolicyDocument): PolicySettingId[] {
  return Object.keys(policy.settings) as PolicySettingId[];
}

/** `settings` with every value the policy sets taken from the policy instead. */
export function applyPolicy(settings: AppSettings, policy: PolicyDocument): AppSettings {
  return managedSettingIds(policy).length === 0 ? settings : { ...settings, ...policy.settings };
}

/** `partial` without the keys the policy locks, so a managed value is never written to the user's own settings. */
export function stripLockedKeys(partial: Partial<AppSettings>, policy: PolicyDocument): Partial<AppSettings> {
  const locked = new Set<string>(managedSettingIds(policy));
  if (locked.size === 0) return partial;
  return Object.fromEntries(Object.entries(partial).filter(([key]) => !locked.has(key))) as Partial<AppSettings>;
}

/** Policy-only features are allowed unless the policy explicitly says no. */
export function isFeatureAllowed(policy: PolicyDocument, feature: PolicyFeatureId): boolean {
  return policy.features[feature] !== false;
}

/** The administrator switch for update traffic: the SSHS3_DISABLE_UPDATES env var or `autoCheckUpdates=false` in policy. */
export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv, policy: PolicyDocument): boolean {
  return env.SSHS3_DISABLE_UPDATES === '1' || policy.settings.autoCheckUpdates === false;
}
