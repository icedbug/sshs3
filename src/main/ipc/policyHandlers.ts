import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { PolicyInfo } from '../../shared/types/policy';
import { toPolicyInfo } from '../policy/loadPolicy';
import type { IpcBridge } from '../IpcBridge';

/** The part of IpcBridge this handler group may use. */
export type PolicyHost = Pick<IpcBridge, 'policy' | 'registerHandler'>;

export function registerPolicyHandlers(bridge: PolicyHost): void {
  // Read-only and argument-free: the renderer only learns which settings are locked, never changes policy.
  bridge.registerHandler(IPC_CHANNELS.POLICY_GET, async (): Promise<PolicyInfo> => toPolicyInfo(bridge.policy));
}
