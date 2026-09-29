import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type AgentName = "scout" | "reviewer";

export interface AgentDefinition {
  name: AgentName;
  description: string;
  instructions: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: string[];
  canDelegate: false;
  timeoutMs?: number;
}

export interface ResolvedAgentDefinition extends AgentDefinition {
  model: string;
  thinking: ThinkingLevel;
  fingerprint: string;
}

export interface DelegatedTask {
  prompt: string;
  context?: string;
  constraints?: string[];
  expectedOutput?: string;
}
