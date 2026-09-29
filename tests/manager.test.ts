import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentManager } from "../src/manager.js";
import { CleanupFailure, RuntimeFailure, type AgentRuntime } from "../src/runtime/runtime.js";
import { SessionStore } from "../src/sessions/store.js";

const request = (signal?: AbortSignal) => ({
  agent: "scout", task: { prompt: "Find the entry point" }, parentId: "host-id",
  cwd: process.cwd(), model: "openai/example", thinking: "off" as const, signal,
});

class FakeRuntime implements AgentRuntime {
  mode: "success" | "fail" | "wait" = "success";
  calls: Parameters<AgentRuntime["run"]>[0][] = [];
  cancelled: string[] = [];
  async run(input: Parameters<AgentRuntime["run"]>[0]) {
    this.calls.push(input);
    if (this.mode === "fail") throw new RuntimeFailure("spawn_failed", "Could not start child");
    input.onStarted();
    if (this.mode === "wait") {
      await new Promise<never>((_, reject) => {
        if (input.signal.aborted) reject(new Error("aborted"));
        else input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return { text: "Found src/index.ts:1" };
  }
  async cancel(id: string) { this.cancelled.push(id); }
}

function setup(runtime = new FakeRuntime()) {
  const store = new SessionStore();
  const saved: string[] = [];
  const manager = new AgentManager(new AgentRegistry(), store, runtime, s => saved.push(s.status));
  return { manager, runtime, store, saved };
}

describe("manager with fake runtime", () => {
  it("creates a unique child with one parent, passes exact tools/model and stores only final result", async () => {
    const { manager, runtime, store, saved } = setup();
    const a = await manager.delegate(request());
    const b = await manager.delegate(request());
    expect(a.status).toBe("completed");
    expect(a.session.id).not.toBe(b.session.id);
    expect(store.listByParent("host-id")).toHaveLength(2);
    expect(runtime.calls[0].definition.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(runtime.calls[0].definition.model).toBe("openai/example");
    expect(a.session).toMatchObject({ parentId: "host-id", result: { text: "Found src/index.ts:1" } });
    expect(a.session.timestamps.startedAt).toBeDefined();
    expect(saved).toEqual(["completed", "completed"]);
    await manager.shutdown();
    await expect(manager.delegate(request())).rejects.toThrow(/shutting down/);
  });

  it("returns typed failure without killing the manager", async () => {
    const { manager, runtime } = setup();
    runtime.mode = "fail";
    const bad = await manager.delegate(request());
    expect(bad.status).toBe("failed");
    expect(bad.session.timestamps.startedAt).toBeUndefined();
    if (bad.status === "failed") expect(bad.error.code).toBe("spawn_failed");
    runtime.mode = "success";
    expect((await manager.delegate(request())).status).toBe("completed");
  });

  it("rejects parallel delegation and records timeout as failure", async () => {
    const { manager, runtime } = setup();
    runtime.mode = "wait";
    const pending = manager.delegate(request());
    await expect(manager.delegate(request())).rejects.toThrow(/only one active/);
    await manager.shutdown();
    expect((await pending).status).toBe("cancelled");

    vi.useFakeTimers();
    try {
      const short = new AgentRegistry();
      // A registry override supplies a short timeout without changing package definitions.
      const resolve = short.resolve.bind(short);
      short.resolve = (name, model, thinking) => ({ ...resolve(name, model, thinking), timeoutMs: 20 });
      const store = new SessionStore();
      const timed = new AgentManager(short, store, runtime);
      const running = timed.delegate(request());
      await vi.advanceTimersByTimeAsync(21);
      const outcome = await running;
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") expect(outcome.error.code).toBe("timeout");
    } finally { vi.useRealTimers(); }
  });

  it("does not report cancellation as successful cleanup when process termination fails", async () => {
    const runtime: AgentRuntime = {
      async run({ signal, onStarted }) {
        onStarted();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new CleanupFailure();
      },
      async cancel() {},
    };
    const manager = new AgentManager(new AgentRegistry(), new SessionStore(), runtime);
    const controller = new AbortController();
    const pending = manager.delegate(request(controller.signal));
    controller.abort();
    const outcome = await pending;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.message).toMatch(/cleanup failed/);
  });

  it("propagates explicit and host cancellation and makes shutdown idempotent", async () => {
    const { manager, runtime, store } = setup();
    runtime.mode = "wait";
    const pending = manager.delegate(request());
    const id = store.listByParent("host-id")[0].id;
    expect(await manager.cancel(id)).toBe(true);
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(runtime.cancelled).toEqual([id]);
    expect(await manager.cancel(id)).toBe(false);
    const host = new AbortController();
    const other = manager.delegate(request(host.signal));
    host.abort();
    expect((await other).status).toBe("cancelled");
    await manager.shutdown();
    await manager.shutdown();
  });
});
