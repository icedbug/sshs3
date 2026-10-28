import { NativeToolBridge } from './NativeToolBridge';
import type { HubService } from '../hub/HubService';
import { nativeEvents } from './nativeEvents';

let hub: HubService | undefined;
export function setNativeHub(value: HubService): void { hub = value; }
export const nativeTools = new NativeToolBridge(() => {
  if (!hub) throw new Error('sshs3 terminal services are starting');
  return hub;
}, () => { nativeEvents.emit('toolsChanged'); });
