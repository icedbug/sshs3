import { EMPTY_POLICY, type PolicyDocument, type PolicyInfo } from '../../shared/types/policy';
import { managedSettingIds } from './policyApply';
import { parsePolicyObject } from './policyParse';
import { getPolicySources, type PolicySource } from './policySources';

export interface LoadedPolicy {
  policy: PolicyDocument;
  /** Dropped keys and unreadable sources, for the log and the Settings dialog. */
  warnings: string[];
}

export const NO_POLICY: LoadedPolicy = { policy: EMPTY_POLICY, warnings: [] };

/**
 * Reads the machine policy once. The first source that has one wins entirely. A source that errors means a
 * policy may exist but cannot be trusted: nothing is applied, the problem is reported instead of staying silent.
 * Never throws.
 */
export async function loadPolicy(
  sources: PolicySource[] = getPolicySources(process.platform)
): Promise<LoadedPolicy> {
  const warnings: string[] = [];
  for (const source of sources) {
    const result = await source.read();
    if (result.status === 'absent') continue;
    if (result.status === 'error') {
      warnings.push(`Policy could not be read: ${result.message}`);
      continue;
    }
    const parsed = parsePolicyObject(result.raw);
    return { policy: parsed.policy, warnings: [...warnings, ...(result.warnings ?? []), ...parsed.warnings] };
  }
  return { policy: EMPTY_POLICY, warnings };
}

export function toPolicyInfo(loaded: LoadedPolicy): PolicyInfo {
  return {
    managed: managedSettingIds(loaded.policy),
    features: loaded.policy.features,
    warnings: loaded.warnings,
  };
}
