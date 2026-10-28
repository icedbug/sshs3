export type NativeHermesMode = 'closed' | 'panel' | 'full';

export interface NativeHermesState {
  mode: NativeHermesMode;
  width: number;
}

export interface NativeHermesApi {
  get(): Promise<NativeHermesState>;
  set(update: Partial<NativeHermesState>): Promise<NativeHermesState>;
  onChange(listener: (state: NativeHermesState) => void): () => void;
  tools(): Promise<NativeToolState>;
  onToolsChanged(listener: (state: NativeToolState) => void): () => void;
  selectTerminal(sessionId?: string): Promise<void>;
  arm(shell: ShellKind): Promise<void>;
  approve(taskId: string, changeId: string, allowed: boolean): Promise<void>;
  takeover(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
}

export interface NativeToolState {
  selected?: TerminalSession;
  bindings: { owner: { profileHome: string; sessionId: string }; task: AgentTask }[];
}

export const NATIVE_HERMES_CHANNELS = {
  get: 'sshs3:hermes:state',
  set: 'sshs3:hermes:layout',
  changed: 'sshs3:hermes:changed',
  tools: 'sshs3:hermes:tools:state',
  toolsChanged: 'sshs3:hermes:tools:changed',
  select: 'sshs3:hermes:tools:select',
  arm: 'sshs3:hermes:tools:arm',
  approve: 'sshs3:hermes:tools:approve',
  takeover: 'sshs3:hermes:tools:takeover',
  resume: 'sshs3:hermes:tools:resume',
} as const;
import type { AgentTask, ShellKind, TerminalSession } from './aiHub';

