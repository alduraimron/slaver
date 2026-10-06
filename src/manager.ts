import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { AgentRegistry } from "./agents/registry.js";
import type { DelegatedTask } from "./agents/types.js";
import { CleanupFailure, RuntimeFailure, type AgentRuntime } from "./runtime/runtime.js";
import { SessionStore } from "./sessions/store.js";
import type { AgentError, AgentSession, DelegationOutcome } from "./sessions/types.js";
import { prepareImplementation, ScopeError } from "./runtime/implementation-scope.js";

interface ActiveRun {
  abort: () => void;
  done: Promise<DelegationOutcome>;
}

export class AgentManager {
  private readonly active = new Map<string, ActiveRun>();
  private shuttingDown = false;

  constructor(
    private readonly registry: AgentRegistry,
    readonly store: SessionStore,
    private readonly runtime: AgentRuntime,
    private readonly onTerminal?: (session: AgentSession) => void,
  ) {}

  async delegate(input: {
    agent: string;
    task: DelegatedTask;
    parentId: string;
    cwd: string;
    model: string;
    thinking: ThinkingLevel;
    signal?: AbortSignal;
  }): Promise<DelegationOutcome> {
    if (this.shuttingDown) throw new Error("Agent manager is shutting down");
    if (this.active.size > 0) throw new Error("Slaver allows only one active delegation at a time");
    if (!input.task.prompt.trim()) throw new Error("Delegated task must be non-empty");
    if (!input.parentId || !input.cwd) throw new Error("Parent session ID and cwd are required");
    const definition = this.registry.resolve(input.agent, input.model, input.thinking);
    if (definition.name === "implementer" && !input.task.runPath) throw new ScopeError("Implementer requires an approved runPath");
    if (definition.name !== "implementer" && input.task.runPath !== undefined) throw new ScopeError("runPath is only valid for implementer");
    const implementation = definition.name === "implementer" ? prepareImplementation(input.cwd, input.task.runPath!) : undefined;
    const session = this.store.create({
      id: randomUUID(), parentId: input.parentId,
      agent: { name: definition.name, definitionFingerprint: definition.fingerprint },
      task: structuredClone(input.task), status: "queued", workspace: { cwd: input.cwd },
      ...(implementation ? { implementation } : {}),
      timestamps: { createdAt: new Date().toISOString() },
    });
    this.store.transition(session.id, "starting");
    const controller = new AbortController();
    let expired = false;
    const abort = () => controller.abort();
    if (input.signal?.aborted) abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = definition.timeoutMs === undefined ? undefined : setTimeout(() => {
      if (!controller.signal.aborted) { expired = true; abort(); }
    }, definition.timeoutMs);

    const done = (async (): Promise<DelegationOutcome> => {
      let result: { text: string } | undefined;
      let failure: AgentError | undefined;
      let cleanupFailed = false;
      try {
        if (!controller.signal.aborted) {
          result = await this.runtime.run({
            session, definition, signal: controller.signal,
            onStarted: () => {
              if (!controller.signal.aborted) this.store.transition(session.id, "running");
            },
          });
        }
      } catch (error) {
        cleanupFailed = error instanceof CleanupFailure;
        failure = error instanceof RuntimeFailure
          ? { code: error.code, message: error.message }
          : { code: "runtime_error", message: "Child runtime failed" };
      } finally {
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }
      let terminal: AgentSession;
      if (cleanupFailed) {
        terminal = this.store.transition(session.id, "failed", failure);
      } else if (expired) {
        terminal = this.store.transition(session.id, "failed", { code: "timeout", message: "Child agent timed out" });
      } else if (controller.signal.aborted) {
        terminal = this.store.transition(session.id, "cancelled");
      } else if (failure) {
        terminal = this.store.transition(session.id, "failed", failure);
      } else if (this.store.get(session.id)?.status !== "running" || !result?.text.trim()) {
        terminal = this.store.transition(session.id, "failed", { code: "invalid_result", message: "Child returned no final answer" });
      } else {
        terminal = this.store.transition(session.id, "completed", result);
      }
      try {
        this.onTerminal?.(terminal);
      } catch {
        // Metadata persistence is diagnostic; it must not turn a finished child into a host crash.
        process.stderr.write(`[slaver] Could not persist session ${terminal.id}\n`);
      }
      if (terminal.status === "completed") return { session: terminal, status: "completed", result: terminal.result! };
      if (terminal.status === "failed") return { session: terminal, status: "failed", error: terminal.error! };
      return { session: terminal, status: "cancelled" };
    })();
    this.active.set(session.id, { abort, done });
    try {
      return await done;
    } finally {
      this.active.delete(session.id);
    }
  }

  async cancel(sessionId: string): Promise<boolean> {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.abort();
    await this.runtime.cancel(sessionId);
    return true;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const ids = [...this.active.keys()];
    const cancelled = await Promise.allSettled(ids.map(id => this.cancel(id)));
    await Promise.allSettled(ids.map(id => this.active.get(id)?.done));
    const errors = cancelled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(e => e.reason), "Unable to stop every child");
  }
}
