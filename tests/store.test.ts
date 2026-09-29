import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/store.js";
import type { AgentSession } from "../src/sessions/types.js";

const fresh = (): AgentSession => ({
  id: "child-1", parentId: "host-1", agent: { name: "scout", definitionFingerprint: "abc" },
  task: { prompt: "Find X" }, status: "queued", workspace: { cwd: "/repo" },
  timestamps: { createdAt: "2026-01-01T00:00:00.000Z" },
});

describe("session store", () => {
  it("validates transitions, timestamps, result invariants and terminal immutability", () => {
    let tick = 0;
    const store = new SessionStore(() => `2026-01-01T00:00:0${++tick}.000Z`);
    store.create(fresh());
    expect(() => store.transition("child-1", "running")).toThrow(/Illegal/);
    store.transition("child-1", "starting");
    expect(store.get("child-1")?.timestamps.startedAt).toBeUndefined();
    store.transition("child-1", "running");
    expect(store.get("child-1")?.timestamps.startedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(() => store.transition("child-1", "completed", { text: "  " })).toThrow(/non-empty/);
    const terminal = store.transition("child-1", "completed", { text: "Found it" });
    expect(terminal.timestamps.endedAt).toBe("2026-01-01T00:00:02.000Z");
    expect(terminal.error).toBeUndefined();
    expect(() => store.transition("child-1", "running")).toThrow(/Illegal/);
    terminal.task.prompt = "corrupted";
    expect(store.get("child-1")?.task.prompt).toBe("Find X");
    expect(store.listByParent("host-1")).toHaveLength(1);
    expect(store.listByParent("someone-else")).toHaveLength(0);
  });

  it("allows startup failure/cancellation without a fabricated start time and validates restores", () => {
    const store = new SessionStore();
    store.create(fresh());
    store.transition("child-1", "starting");
    const cancelled = store.transition("child-1", "cancelled");
    expect(cancelled.timestamps.startedAt).toBeUndefined();
    expect(cancelled.result).toBeUndefined();
    const restored = new SessionStore();
    restored.restoreTerminal(cancelled);
    expect(restored.get("child-1")).toEqual(cancelled);
    expect(() => restored.restoreTerminal({ ...cancelled, result: { text: "bad" } })).toThrow(/Invalid restored/);
  });
});
