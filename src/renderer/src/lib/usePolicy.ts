import { useEffect, useState } from 'react';
import type { PolicyFeatureId, PolicyInfo } from '@shared/types/policy';

/** Whether an administrator's policy blocks this feature. Unknown (policy not loaded yet) counts as allowed; the main process enforces it either way. */
export function isFeatureBlocked(policy: PolicyInfo | null, feature: PolicyFeatureId): boolean {
  return policy?.features[feature] === false;
}

/** The machine policy as the main process reports it (null until it arrives). It only changes with an app restart. */
export function usePolicy(): PolicyInfo | null {
  const [policy, setPolicy] = useState<PolicyInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.multissh
      ?.policyGet?.()
      .then((info) => {
        if (!cancelled) setPolicy(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return policy;
}
