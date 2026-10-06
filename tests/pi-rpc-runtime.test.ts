import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPackageDir, RpcClient, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiRpcRuntime } from "../src/runtime/pi-rpc-runtime.js";
import type { AgentRuntime } from "../src/runtime/runtime.js";

const client = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), getState: vi.fn(), prompt: vi.fn(),
  onEvent: vi.fn(), getLastAssistantText: vi.fn(), getCommands: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  RpcClient: vi.fn(function () { return client; }),
  getPackageDir: vi.fn(),
}));

const cliPath = join(tmpdir(), "fixture-pi", "dist/bundle/cli.js");
let listener: (event: JsonAgentSessionEvent) => void;
const unsubscribe = vi.fn();

function input(): Parameters<AgentRuntime["run"]>[0] {
  return {
    session: {
      id: "child-id", parentId: "host-id", agent: { name: "scout", definitionFingerprint: "fixture" },
      task: { prompt: "Find the entry point" }, status: "starting", workspace: { cwd: process.cwd() },
      timestamps: { createdAt: new Date().toISOString() },
    },
    definition: {
      name: "scout", description: "Read-only scout", instructions: "Only inspect the delegated question.",
      model: "fixture/model", thinking: "off", tools: ["read", "grep", "find", "ls"],
      canDelegate: false, fingerprint: "fixture",
    },
    signal: new AbortController().signal,
    onStarted: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  client.start.mockResolvedValue(undefined);
  client.stop.mockResolvedValue(undefined);
  client.getState.mockResolvedValue({ model: { provider: "fixture", id: "model" }, thinkingLevel: "off" });
  client.getLastAssistantText.mockResolvedValue("Found src/index.ts:1");
  client.onEvent.mockImplementation((callback: typeof listener) => { listener = callback; return unsubscribe; });
  client.prompt.mockImplementation(async () => {
    // A fast response may settle before prompt() returns its acceptance disposition.
    listener({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "Found src/index.ts:1" }],
      api: "openai-completions", provider: "fixture", model: "model", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
    listener({ type: "agent_settled" });
    return "started";
  });
});

describe("Pi RPC runtime with fake client", () => {
  it("does not resolve the CLI or start a process when the extension constructs its runtime", () => {
    new PiRpcRuntime();
    expect(getPackageDir).not.toHaveBeenCalled();
    expect(RpcClient).not.toHaveBeenCalled();
  });

  it("uses the selected host CLI, disables MCP, and accepts a fast started run", async () => {
    const run = input();
    const runtime = new PiRpcRuntime(cliPath);
    expect(await runtime.run(run)).toEqual({ text: "Found src/index.ts:1" });
    expect(RpcClient).toHaveBeenCalledWith(expect.objectContaining({
      cliPath, cwd: run.session.workspace.cwd,
      args: ["--no-session", "--no-extensions", "--no-mcp", "--no-prompt-templates",
        "--tools", "read,grep,find,ls", "--thinking", "off", "--append-system-prompt", run.definition.instructions],
    }));
    expect(run.onStarted).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    await runtime.cancel(run.session.id);
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("requires a guard readiness handshake for implementer and never sends task if absent", async () => {
    const run = input();
    run.definition = { ...run.definition, name: "implementer", tools: ["read", "grep", "find", "ls", "scoped_edit", "scoped_write"] };
    run.session.implementation = { root: process.cwd(), runPath: ".pi/stapler/runs/approved.json", runHash: "approval-hash", scope: ["entry.ts"], acceptance: ["Approved behavior"] };
    client.getCommands.mockResolvedValue([]);
    await expect(new PiRpcRuntime(cliPath, "/trusted/guard.ts").run(run)).rejects.toMatchObject({ code: "rpc_failed", message: "Implementer write guard did not become ready" });
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(RpcClient).toHaveBeenCalledWith(expect.objectContaining({
      env: { SLAVER_IMPLEMENTER_SCOPE: JSON.stringify({ approval: run.session.implementation, tools: run.definition.tools }) },
      args: expect.arrayContaining(["--no-extensions", "--no-mcp", "read,grep,find,ls,scoped_edit,scoped_write", "-e", "/trusted/guard.ts"]),
    }));
  });

  it("passes the frozen scope and acceptance after the expected guard loads", async () => {
    const run = input();
    run.definition = { ...run.definition, name: "implementer", tools: ["read", "scoped_edit", "scoped_write"] };
    run.session.implementation = { root: process.cwd(), runPath: ".pi/stapler/runs/approved.json", runHash: "approval-hash", scope: ["entry.ts"], acceptance: ["Approved behavior"] };
    client.getCommands.mockResolvedValue([{ name: "slaver-write-guard-ready", source: "extension", description: "approval-hash" }]);
    await new PiRpcRuntime(cliPath).run(run);
    expect(client.prompt).toHaveBeenCalledWith(expect.stringContaining("Exact file scope:\n- entry.ts\nAcceptance:\n- Approved behavior"));
    expect(run.onStarted).toHaveBeenCalledOnce();
  });

  it("rejects implementer without frozen approval before constructing the client", async () => {
    const run = input();
    run.definition.name = "implementer";
    await expect(new PiRpcRuntime(cliPath).run(run)).rejects.toMatchObject({ code: "runtime_error" });
    expect(RpcClient).not.toHaveBeenCalled();
  });

  it.each(["handled", "queued"])("fails a %s prompt immediately, without waiting for agent_settled", async disposition => {
    client.prompt.mockResolvedValue(disposition);
    const run = input();
    await expect(new PiRpcRuntime(cliPath).run(run)).rejects.toMatchObject({
      code: "rpc_failed", message: "Pi RPC child did not start the delegated task",
    });
    expect(run.onStarted).not.toHaveBeenCalled();
    expect(client.getLastAssistantText).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("reports an unavailable host CLI during delegation, not extension loading", async () => {
    vi.mocked(getPackageDir).mockReturnValue(join(tmpdir(), "slaver-missing-host-pi"));
    const runtime = new PiRpcRuntime();
    expect(getPackageDir).not.toHaveBeenCalled();
    await expect(runtime.run(input())).rejects.toMatchObject({ code: "spawn_failed" });
    expect(RpcClient).not.toHaveBeenCalled();
  });
});
