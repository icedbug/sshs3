import crypto from "node:crypto";
import type { AgentTask } from "../../../shared/types/aiHub";
import {
  DirectAgentRuntime,
  type DirectToolInvoker,
} from "./DirectAgentRuntime";

export type AgentModelConfig =
  | { kind: "anthropic"; model: string; apiKey: string; baseUrl?: string }
  | { kind: "custom"; model: string; baseUrl: string; apiKey?: string }
  | { kind: "openai-codex"; model: string; baseUrl?: string };

export interface RunEvent {
  type: string;
  delta?: string;
  text?: string;
  output?: string;
  error?: string;
  usage?: Record<string, number>;
}

export interface AgentRuntime {
  start(
    task: AgentTask,
    model: AgentModelConfig,
    onEvent: (event: RunEvent) => void,
  ): Promise<void>;
  steer(text: string): Promise<void>;
  stop(): Promise<void>;
}

export function createAgentRuntime(
  invokeTool: DirectToolInvoker,
): AgentRuntime {
  return new DirectAgentRuntime(invokeTool);
}

export const newMessageId = (): string => crypto.randomUUID();
