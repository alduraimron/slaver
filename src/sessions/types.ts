import type { DelegatedTask } from "../agents/types.js";

export type AgentSessionStatus = "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
export interface AgentResult { text: string }
export type AgentErrorCode = "spawn_failed" | "rpc_failed" | "agent_failed" | "timeout" | "invalid_result" | "runtime_error";
export interface AgentError { code: AgentErrorCode; message: string }

export interface AgentSession {
  id: string;
  parentId: string;
  agent: { name: string; definitionFingerprint: string };
  task: DelegatedTask;
  status: AgentSessionStatus;
  workspace: { cwd: string };
  timestamps: { createdAt: string; startedAt?: string; endedAt?: string };
  result?: AgentResult;
  error?: AgentError;
}

export type DelegationOutcome =
  | { session: AgentSession; status: "completed"; result: AgentResult }
  | { session: AgentSession; status: "failed"; error: AgentError }
  | { session: AgentSession; status: "cancelled" };
