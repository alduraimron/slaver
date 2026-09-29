import type { AgentError, AgentResult, AgentSession, AgentSessionStatus } from "./types.js";

const LEGAL: Record<AgentSessionStatus, AgentSessionStatus[]> = {
  queued: ["starting"],
  starting: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};
const snapshot = (session: AgentSession): AgentSession => structuredClone(session);

export class SessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  create(session: AgentSession): AgentSession {
    if (this.sessions.has(session.id)) throw new Error(`Duplicate session id ${session.id}`);
    if (session.status !== "queued" || !session.parentId || !session.id || !session.task.prompt.trim()) {
      throw new Error("Invalid new session");
    }
    this.sessions.set(session.id, snapshot(session));
    return this.get(session.id)!;
  }

  restoreTerminal(session: AgentSession): void {
    if (!(["completed", "failed", "cancelled"] as string[]).includes(session.status) ||
      !session.timestamps.endedAt || !session.id || !session.parentId || this.sessions.has(session.id) ||
      (session.status === "completed" && (!session.result?.text.trim() || session.error !== undefined)) ||
      (session.status === "failed" && (!session.error || session.result !== undefined)) ||
      (session.status === "cancelled" && (session.result !== undefined || session.error !== undefined))) {
      throw new Error("Invalid restored terminal session");
    }
    this.sessions.set(session.id, snapshot(session));
  }

  get(id: string): AgentSession | undefined {
    const session = this.sessions.get(id);
    return session ? snapshot(session) : undefined;
  }

  listByParent(parentId: string): AgentSession[] {
    return [...this.sessions.values()].filter(s => s.parentId === parentId).map(snapshot);
  }

  transition(id: string, status: AgentSessionStatus, payload?: AgentResult | AgentError): AgentSession {
    const session = this.sessions.get(id);
    if (!session || !LEGAL[session.status].includes(status)) {
      throw new Error(`Illegal session transition: ${session?.status ?? "missing"} -> ${status}`);
    }
    if (status === "completed") {
      if (!payload || !("text" in payload) || !payload.text.trim()) throw new Error("Completed session needs non-empty result");
      session.result = { text: payload.text };
    } else if (status === "failed") {
      if (!payload || !("code" in payload)) throw new Error("Failed session needs error");
      session.error = { code: payload.code, message: payload.message };
    } else if (payload !== undefined) {
      throw new Error(`${status} does not accept result/error`);
    }
    session.status = status;
    if (status === "running") session.timestamps.startedAt = this.now();
    if (status === "completed" || status === "failed" || status === "cancelled") session.timestamps.endedAt = this.now();
    return snapshot(session);
  }
}
