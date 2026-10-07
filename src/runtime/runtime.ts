import type { ResolvedAgentDefinition } from "../agents/types.js";
import type { AgentErrorCode, AgentResult, AgentSession } from "../sessions/types.js";

export class RuntimeFailure extends Error {
  constructor(public readonly code: AgentErrorCode, message: string) {
    super(message);
    this.name = "RuntimeFailure";
  }
}

export class CleanupFailure extends RuntimeFailure {
  constructor() {
    super("runtime_error", "Pi RPC child cleanup failed");
    this.name = "CleanupFailure";
  }
}

export interface RuntimeProgress {
  toolCalls: number;
  lastTool?: string;
}

export interface AgentRuntime {
  run(input: {
    session: AgentSession;
    definition: ResolvedAgentDefinition;
    signal: AbortSignal;
    onStarted: () => void;
    onProgress?: (progress: RuntimeProgress) => void;
  }): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
