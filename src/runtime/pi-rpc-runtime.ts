import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime } from "./runtime.js";
import { CleanupFailure, RuntimeFailure } from "./runtime.js";

interface Handle { client: RpcClient; stopping?: Promise<void> }
const cliPath = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const MAX_RESULT_CHARS = 8_000;

export class PiRpcRuntime implements AgentRuntime {
  private readonly handles = new Map<string, Handle>();

  async run({ session, definition, signal, onStarted }: Parameters<AgentRuntime["run"]>[0]) {
    if (signal.aborted) throw new RuntimeFailure("runtime_error", "Child cancelled before startup");
    const client = new RpcClient({
      cliPath, cwd: session.workspace.cwd, model: definition.model,
      args: ["--no-session", "--no-extensions", "--no-prompt-templates",
        "--tools", definition.tools.join(","), "--thinking", definition.thinking,
        "--append-system-prompt", definition.instructions],
    });
    const handle: Handle = { client };
    this.handles.set(session.id, handle);
    let interrupt!: (error: RuntimeFailure) => void;
    const stopped = new Promise<RuntimeFailure>(resolve => { interrupt = resolve; });
    const guard = async <T>(work: Promise<T>): Promise<T> => {
      const outcome = await Promise.race([
        work.then(value => ({ kind: "ok" as const, value })),
        stopped.then(error => ({ kind: "stopped" as const, error })),
      ]);
      if (outcome.kind === "stopped") throw outcome.error;
      return outcome.value;
    };
    const onAbort = () => {
      interrupt(new RuntimeFailure("runtime_error", "Child cancelled"));
      void this.stop(session.id).catch(() => interrupt(new RuntimeFailure("runtime_error", "Child cleanup failed")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let lastStopReason: string | undefined;
    let settled!: () => void;
    const complete = new Promise<void>(resolve => { settled = resolve; });
    const unsubscribe = client.onEvent(event => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        lastStopReason = event.message.stopReason;
      }
      if (event.type === "agent_settled") settled();
    });
    // RpcClient does not emit an exit event to subscribers. Poll health so a crashed
    // child fails promptly rather than waiting for the task timeout.
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      try {
        await guard(client.start());
      } catch {
        throw new RuntimeFailure("spawn_failed", "Could not start Pi RPC child");
      }
      if (signal.aborted) throw new RuntimeFailure("runtime_error", "Child cancelled during startup");
      let state;
      try {
        state = await guard(client.getState());
      } catch {
        throw new RuntimeFailure("rpc_failed", "Pi RPC child did not become ready");
      }
      if (state.model?.provider !== definition.model.split("/")[0] ||
        state.model?.id !== definition.model.slice(definition.model.indexOf("/") + 1) ||
        state.thinkingLevel !== definition.thinking) {
        throw new RuntimeFailure("rpc_failed", "Pi RPC child did not apply the resolved model/thinking configuration");
      }
      if (signal.aborted) throw new RuntimeFailure("runtime_error", "Child cancelled before prompt");
      const prompt = ["Task:", session.task.prompt,
        session.task.context ? `Context:\n${session.task.context}` : "",
        session.task.constraints?.length ? `Constraints:\n${session.task.constraints.map(c => `- ${c}`).join("\n")}` : "",
        session.task.expectedOutput ? `Expected output:\n${session.task.expectedOutput}` : "",
      ].filter(Boolean).join("\n\n");
      try {
        await guard(client.prompt(prompt));
      } catch {
        throw new RuntimeFailure("rpc_failed", "Pi RPC child rejected the task");
      }
      onStarted();
      poll = setInterval(() => {
        void client.getState().catch(() => interrupt(new RuntimeFailure("rpc_failed", "Pi RPC child disconnected")));
      }, 1000);
      await guard(complete);
      if (lastStopReason === "error") throw new RuntimeFailure("agent_failed", "Child model request failed");
      if (lastStopReason !== "stop") throw new RuntimeFailure("invalid_result", "Child did not finish with a final answer");
      let text: string | null;
      try { text = await client.getLastAssistantText(); }
      catch { throw new RuntimeFailure("rpc_failed", "Could not read the child answer"); }
      if (!text?.trim()) throw new RuntimeFailure("invalid_result", "Child returned no final answer");
      return { text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[Result truncated]` : text };
    } finally {
      if (poll) clearInterval(poll);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      await this.stop(session.id);
    }
  }

  async cancel(sessionId: string): Promise<void> { await this.stop(sessionId); }

  private async stop(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    if (!handle.stopping) {
      handle.stopping = handle.client.stop().then(
        () => { this.handles.delete(sessionId); },
        () => { throw new CleanupFailure(); },
      );
    }
    await handle.stopping;
  }
}
