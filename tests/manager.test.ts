import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedRun } from "./implementation-fixture.js";
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

  it("validates implementer approval before creating a child, and never grants runPath to readers", async () => {
    const { manager, runtime, store } = setup();
    await expect(manager.delegate({ ...request(), agent: "implementer" })).rejects.toThrow(/requires an approved runPath/);
    await expect(manager.delegate({ ...request(), task: { prompt: "Inspect", runPath: "x.json" } })).rejects.toThrow(/only valid for implementer/);
    expect(runtime.calls).toHaveLength(0);
    expect(store.listByParent("host-id")).toHaveLength(0);
    const root = mkdtempSync(join(tmpdir(), "slaver-manager-scope-"));
    try {
      const runPath = approvedRun(root);
      const outcome = await manager.delegate({ ...request(), agent: "implementer", cwd: root, task: { prompt: "Approved change", runPath } });
      expect(outcome.status).toBe("completed");
      expect(runtime.calls[0].session.implementation?.scope).toEqual(["entry.ts", "src/new.ts"]);
      expect(runtime.calls[0].definition.tools).toContain("scoped_edit");
      expect(runtime.calls[0].definition.tools).not.toContain("write");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("selects a bound target workspace without changing parent identity or widening writes", async () => {
    const { manager, runtime, store } = setup();
    const root = mkdtempSync(join(tmpdir(), "slaver-target-"));
    try {
      const runPath = approvedRun(root);
      const cross = { ...request(), agent: "implementer", workspacePath: root, task: { prompt: "Approved change", runPath } };
      await expect(manager.delegate(cross)).rejects.toThrow(/workspaceRoot/);
      expect(runtime.calls).toHaveLength(0);
      expect(store.listByParent("host-id")).toHaveLength(0);
      approvedRun(root, { workspaceRoot: root });
      const result = await manager.delegate(cross);
      expect(result.session.workspace.cwd).toBe(root);
      expect(result.session.parentId).toBe("host-id");
      expect(runtime.calls[0].session.implementation?.root).toBe(root);
      expect(store.listByParent("host-id")).toHaveLength(1);
      const reader = await manager.delegate({ ...request(), workspacePath: root });
      expect(reader.session.workspace.cwd).toBe(root);
      expect(reader.session.implementation).toBeUndefined();
      expect(runtime.calls[1].definition.tools).toEqual(["read", "grep", "find", "ls"]);
    } finally { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reports lifecycle progress without persisting callbacks or allowing observer errors to fail execution", async () => {
    const { manager, store } = setup();
    const updates: Array<{ id: string; status: string; elapsedMs: number }> = [];
    const result = await manager.delegate({ ...request(), onProgress: (update) => {
      updates.push(update);
      if (update.status === "running") throw new Error("UI unavailable");
    } });
    expect(result.status).toBe("completed");
    expect(updates.some(u => u.status === "running")).toBe(true);
    expect(updates.at(-1)?.status).toBe("completed");
    expect(updates.every(u => u.id === result.session.id && u.elapsedMs >= 0)).toBe(true);
    expect(JSON.stringify(store.get(result.session.id))).not.toContain("onProgress");
    expect((await manager.delegate({ ...request(), onProgress: async () => { throw new Error("async UI unavailable"); } })).status).toBe("completed");
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
