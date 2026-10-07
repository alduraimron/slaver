import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentManager } from "../src/manager.js";
import { PiRpcRuntime } from "../src/runtime/pi-rpc-runtime.js";
import { resolvePiCliPath } from "../src/runtime/pi-cli.js";
import { SessionStore } from "../src/sessions/store.js";
import { approvedRun, APPROVED_RUN } from "./implementation-fixture.js";

const cliPath = process.env.SLAVER_TEST_CLI_PATH ? resolve(process.env.SLAVER_TEST_CLI_PATH) : resolvePiCliPath();
const extensionPath = process.env.SLAVER_TEST_EXTENSION_PATH ?? resolve("src/index.ts");
const folders: string[] = [];
const servers: Server[] = [];
const previousDir = process.env.PI_CODING_AGENT_DIR;
const previousOffline = process.env.PI_OFFLINE;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
});

type Mode = "success" | "failure" | "hang" | "implement" | "deny-writes" | "implement-hang";
async function fixture(mode: Mode, workspacePath?: string) {
  const requests: Array<{ messages: Array<{ role: string; content?: string }>; tools?: Array<{ function: { name: string } }> }> = [];
  let mutationFinished!: () => void;
  const afterMutation = new Promise<void>(resolve => { mutationFinished = resolve; });
  let childRequested!: () => void;
  const childCall = new Promise<void>(resolve => { childRequested = resolve; });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: Array<{ role: string; content?: string }>;
      tools?: Array<{ function: { name: string } }>;
    };
    requests.push(body);
    const isHost = body.tools?.some(t => t.function.name === "delegate");
    if (!isHost) childRequested();
    if (!isHost && mode === "hang") return;
    if (!isHost && mode === "implement-hang" && body.messages.some(m => m.role === "tool")) {
      mutationFinished();
      return;
    }
    if (!isHost && mode === "failure") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture failure", type: "invalid_request_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: object, finish_reason: string | null = null) => {
      res.write(`data: ${JSON.stringify({ id: "test-1", object: "chat.completion.chunk", created: 1,
        model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    };
    const toolResult = body.messages.find(m => m.role === "tool");
    const latestUser = body.messages.filter(m => m.role === "user").at(-1);
    if (isHost && JSON.stringify(latestUser).includes("Continue and say ready")) {
      send({ role: "assistant" });
      send({ content: "HOST_READY" });
      send({}, "stop");
    } else if (isHost && !toolResult) {
      send({ role: "assistant" });
      const userText = JSON.stringify(latestUser);
      const role = userText.includes("Use implementer") ? "implementer" : userText.includes("reviewer") ? "reviewer" : "scout";
      send({ tool_calls: [{ index: 0, id: "call-1", type: "function",
        function: { name: "delegate", arguments: JSON.stringify({ agent: role, task: "Perform the approved task",
          ...(role === "implementer" ? { runPath: APPROVED_RUN } : {}), ...(workspacePath ? { workspacePath } : {}) }) } }] });
      send({}, "tool_calls");
    } else if (!isHost && ["implement", "deny-writes", "implement-hang"].includes(mode) && !toolResult) {
      send({ role: "assistant" });
      const calls = mode === "deny-writes" ? [
        { name: "scoped_write", args: { path: "outside.ts", content: "forbidden" } },
        { name: "scoped_write", args: { path: APPROVED_RUN, content: "forbidden" } },
        { name: "scoped_write", args: { path: "../escape.ts", content: "forbidden" } },
        { name: "write", args: { path: "native-escape.ts", content: "forbidden" } },
        { name: "bash", args: { command: "echo forbidden" } },
      ] : [
        { name: "scoped_edit", args: { path: "entry.ts", edits: [{ oldText: "export const entry = true;", newText: "export const entry = false;" }] } },
        { name: "scoped_write", args: { path: "src/new.ts", content: "export const added = true;\n" } },
      ];
      send({ tool_calls: calls.map((call, index) => ({ index, id: `write-${index}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant" });
      send({ content: isHost ? `HOST:${toolResult?.content}` : "SCOUT: src/index.ts:1" });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const config = mkdtempSync(join(tmpdir(), "slaver-config-"));
  const workspace = mkdtempSync(join(tmpdir(), "slaver-workspace-"));
  folders.push(config, workspace);
  writeFileSync(join(config, "models.json"), JSON.stringify({ providers: {
    "slaver-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-key",
      models: [{ id: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 256 }],
    },
  } }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  writeFileSync(join(workspace, "entry.ts"), "export const entry = true;\n");
  approvedRun(workspace);
  process.env.PI_CODING_AGENT_DIR = config;
  process.env.PI_OFFLINE = "1";
  return { requests, childCall, afterMutation, workspace, config };
}

function packageCopy(stalePeer: boolean) {
  const root = mkdtempSync(join(tmpdir(), "slaver-package-"));
  folders.push(root);
  for (const path of ["src", "agents", "package.json"]) cpSync(resolve(path), join(root, path), { recursive: true });
  expect(existsSync(join(root, "node_modules"))).toBe(false);
  const staleMarker = join(root, "stale-cli-started");
  if (stalePeer) {
    const peer = join(root, "node_modules/@earendil-works/pi-coding-agent");
    mkdirSync(join(peer, "dist"), { recursive: true });
    writeFileSync(join(peer, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent",
      version: "0.86.0", type: "module", exports: { ".": "./dist/index.js" } }));
    writeFileSync(join(peer, "dist/index.js"), 'throw new Error("Stale peer must not be imported");\n');
    writeFileSync(join(peer, "dist/cli.js"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(staleMarker)}, "started");
process.exit(1);\n`);
  }
  return { root, staleMarker };
}

describe("real Pi RPC process", () => {
  it.each([
    { scenario: "without local Pi peers", stalePeer: false },
    { scenario: "with a stale Pi peer", stalePeer: true },
  ])("loads a managed package $scenario and delegates using host Pi", async ({ stalePeer }) => {
    const { requests, workspace, config } = await fixture("success");
    const { root, staleMarker } = packageCopy(stalePeer);
    const mcpMarker = join(config, "mcp-started");
    writeFileSync(join(config, "mcp.json"), JSON.stringify({ mcpServers: {
      forbidden: { command: process.execPath, args: ["-e",
        `require("node:fs").writeFileSync(${JSON.stringify(mcpMarker)}, "started")`], exposure: "direct" },
    } }));
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture",
      env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", root, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      expect((await client.getCommands()).some(c => c.name === "subagents")).toBe(true);
      await client.promptAndWait("Use scout to find the entry point", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain('"status":"completed"');
      const child = requests.find(r => r.tools?.some(t => t.function.name === "read"));
      expect(child?.tools?.map(t => t.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);
      expect(existsSync(staleMarker)).toBe(false);
      expect(existsSync(mcpMarker)).toBe(false);
      await client.promptAndWait("Continue and say ready", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain("HOST_READY");
    } finally { await client.stop(); }
  }, 40_000);

  it("runs host extension -> restricted RPC child -> concise result and lets host continue", async () => {
    const { requests, workspace, config } = await fixture("success");
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      const events = await client.promptAndWait("Use scout to find the entry point", undefined, 30_000);
      expect(events.some(e => e.type === "agent_settled")).toBe(true);
      const updates = events.filter(e => e.type === "tool_execution_update" && e.toolName === "delegate");
      expect(updates.length).toBeGreaterThan(0);
      expect(JSON.stringify(updates)).toContain("elapsedMs");
      expect(JSON.stringify(updates)).not.toContain("SCOUT: src/index.ts:1");
      const answer = await client.getLastAssistantText();
      expect(answer).toContain('"status":"completed"');
      expect(answer).toContain("SCOUT: src/index.ts:1");
      const child = requests.find(r => r.tools?.some(t => t.function.name === "read"));
      expect(child?.tools?.map(t => t.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);
      expect(JSON.stringify(child)).not.toContain("Use scout to find the entry point");
      expect(requests.some(r => r.tools?.some(t => t.function.name === "delegate"))).toBe(true);
    } finally { await client.stop(); }
  }, 40_000);

  it("persists terminal metadata and restores inspection after restarting the host", async () => {
    const { workspace, config } = await fixture("success");
    const options = { cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" } };
    const initial = new RpcClient({ ...options, args: ["--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    let sessionFile: string | undefined;
    let id: string | undefined;
    try {
      await initial.start();
      await initial.promptAndWait("Use scout to find the entry point", undefined, 30_000);
      const state = await initial.getState();
      sessionFile = state.sessionFile ?? undefined;
      const entries = await initial.getEntries();
      const metadata = entries.entries.find(e => e.type === "custom" && e.customType === "slaver.session");
      if (metadata?.type === "custom") id = (metadata.data as { id: string }).id;
      expect(id).toBeTruthy();
      expect(sessionFile).toBeTruthy();
    } finally { await initial.stop(); }
    const resumed = new RpcClient({ ...options, args: ["--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off", "--session", sessionFile!] });
    const notifications: string[] = [];
    const unsubscribe = resumed.onEvent(e => {
      const event = e as unknown as { type: string; method?: string; message?: string };
      if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event.message ?? "");
    });
    try {
      await resumed.start();
      await resumed.prompt(`/subagents ${id}`);
      expect(notifications.join(" ")).toContain(`"id": "${id}"`);
      expect(notifications.join(" ")).toContain('"status": "completed"');
    } finally { unsubscribe(); await resumed.stop(); }
  }, 40_000);

  it("runs the reviewer definition through the same read-only boundary", async () => {
    const { requests, workspace, config } = await fixture("success");
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      await client.promptAndWait("Use reviewer to inspect the entry point", undefined, 30_000);
      const answer = await client.getLastAssistantText();
      expect(answer).toContain('"agent":"reviewer"');
      expect(answer).toContain('"status":"completed"');
      const child = requests.find(r => r.tools?.some(t => t.function.name === "read"));
      expect(child?.tools?.map(t => t.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);
    } finally { await client.stop(); }
  }, 40_000);

  it.each(["implement", "deny-writes"] as const)("runs guarded implementer through a managed package: %s", async mode => {
    const { requests, workspace, config } = await fixture(mode);
    const { root } = packageCopy(false);
    const originalRun = readFileSync(join(workspace, APPROVED_RUN), "utf8");
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", root, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      await client.promptAndWait("Use implementer for the approved task", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain('"agent":"implementer"');
      expect(await client.getLastAssistantText()).toContain('"status":"completed"');
      const child = requests.find(r => r.tools?.some(t => t.function.name === "scoped_write"));
      expect(child?.tools?.map(t => t.function.name).sort()).toEqual(["find", "grep", "ls", "read", "scoped_edit", "scoped_write"]);
      expect(readFileSync(join(workspace, APPROVED_RUN), "utf8")).toBe(originalRun);
      if (mode === "implement") {
        expect(readFileSync(join(workspace, "entry.ts"), "utf8")).toContain("entry = false");
        expect(readFileSync(join(workspace, "src/new.ts"), "utf8")).toContain("added = true");
      } else {
        expect(readFileSync(join(workspace, "entry.ts"), "utf8")).toContain("entry = true");
        expect(existsSync(join(workspace, "outside.ts"))).toBe(false);
        expect(existsSync(join(workspace, "native-escape.ts"))).toBe(false);
        expect(existsSync(join(workspace, "src/new.ts"))).toBe(false);
        expect(JSON.stringify(requests)).toContain("outside approved file scope");
        expect(JSON.stringify(requests)).toContain("traversal");
      }
      await client.promptAndWait("Continue and say ready", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain("HOST_READY");
    } finally { await client.stop(); }
  }, 40_000);

  it.each(["valid", "missing", "wrong"])("cross-workspace writes retain original host inspection and require %s root binding", async binding => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), "slaver-selected-workspace-")));
    folders.push(target);
    writeFileSync(join(target, "entry.ts"), "export const entry = true;\n");
    approvedRun(target, binding === "missing" ? {} : { workspaceRoot: binding === "valid" ? target : join(target, "wrong") });
    const { requests, workspace, config } = await fixture("implement", target);
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      const hostId = (await client.getState()).sessionId;
      const events = await client.promptAndWait("Use implementer for the selected workspace", undefined, 30_000);
      const answer = await client.getLastAssistantText();
      expect(readFileSync(join(workspace, "entry.ts"), "utf8")).toContain("entry = true");
      const entries = (await client.getEntries()).entries;
      const metadata = entries.find(e => e.type === "custom" && e.customType === "slaver.session");
      if (binding === "valid") {
        expect(answer).toContain('"status":"completed"');
        expect(readFileSync(join(target, "entry.ts"), "utf8")).toContain("entry = false");
        expect(readFileSync(join(target, "src/new.ts"), "utf8")).toContain("added = true");
        if (metadata?.type !== "custom") throw new Error("Original host lost delegated metadata");
        expect(metadata.data).toMatchObject({ parentId: hostId, workspace: { cwd: target }, implementation: { root: target } });
        expect(events.some(e => e.type === "tool_execution_update" && e.toolName === "delegate")).toBe(true);
        const notifications: string[] = [];
        const unsubscribe = client.onEvent(e => {
          const event = e as unknown as { type: string; method?: string; message?: string };
          if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event.message ?? "");
        });
        try { await client.prompt(`/subagents ${(metadata.data as { id: string }).id}`); }
        finally { unsubscribe(); }
        expect(notifications.join(" ")).toContain(target);
        expect(requests.find(r => r.tools?.some(t => t.function.name === "scoped_write"))?.tools?.map(t => t.function.name).sort())
          .toEqual(["find", "grep", "ls", "read", "scoped_edit", "scoped_write"]);
      } else {
        expect(answer).toContain("workspaceRoot");
        expect(readFileSync(join(target, "entry.ts"), "utf8")).toContain("entry = true");
        expect(existsSync(join(target, "src/new.ts"))).toBe(false);
        expect(metadata).toBeUndefined();
        expect(requests.some(r => r.tools?.some(t => t.function.name === "scoped_write"))).toBe(false);
      }
    } finally { await client.stop(); }
  }, 40_000);

  it.each(["missing", "inert"])("fails closed before model execution if the implementer guard is %s", async kind => {
    const { workspace, requests } = await fixture("implement");
    const guardPath = join(workspace, `${kind}-guard.ts`);
    if (kind === "inert") writeFileSync(guardPath, "export default function () {}\n");
    const runtime = new PiRpcRuntime(cliPath, guardPath);
    const manager = new AgentManager(new AgentRegistry(), new SessionStore(), runtime);
    const outcome = await manager.delegate({ agent: "implementer", task: { prompt: "Approved task", runPath: APPROVED_RUN },
      parentId: "host", cwd: workspace, model: "slaver-test/fixture", thinking: "off" });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("rpc_failed");
      expect(outcome.error.message).toContain("did not become ready");
    }
    expect(requests).toHaveLength(0);
    expect(readFileSync(join(workspace, "entry.ts"), "utf8")).toContain("entry = true");
    expect(existsSync(join(workspace, "src/new.ts"))).toBe(false);
    await manager.shutdown();
  }, 30_000);

  it("cancellation stops implementer without silently undoing partial approved edits", async () => {
    const { workspace, config, afterMutation } = await fixture("implement-hang");
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      await client.prompt("Use implementer for the approved task");
      await afterMutation;
      await client.abort();
      expect((await client.getState()).isStreaming).toBe(false);
      expect(readFileSync(join(workspace, "entry.ts"), "utf8")).toContain("entry = false");
      const entries = await client.getEntries();
      const metadata = entries.entries.find(e => e.type === "custom" && e.customType === "slaver.session");
      if (metadata?.type !== "custom") throw new Error("Missing terminal metadata");
      expect(metadata.data).toMatchObject({ status: "cancelled", implementation: { scope: ["entry.ts", "src/new.ts"] } });
      await client.promptAndWait("Continue and say ready", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain("HOST_READY");
    } finally { await client.stop(); }
  }, 40_000);

  it("surfaces child provider failure without crashing the host", async () => {
    const { workspace, config } = await fixture("failure");
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      await client.promptAndWait("Use scout to find the entry point", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain('"status":"failed"');
      await client.promptAndWait("Continue and say ready", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain("HOST_READY");
    } finally { await client.stop(); }
  }, 45_000);

  it("propagates host RPC abort to the child, then host can continue", async () => {
    const { childCall, workspace, config } = await fixture("hang");
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      await client.prompt("Use scout to find the entry point");
      await childCall;
      await client.abort();
      expect((await client.getState()).isStreaming).toBe(false);
      await client.promptAndWait("Continue and say ready", undefined, 30_000);
      expect(await client.getLastAssistantText()).toContain("HOST_READY");
    } finally { await client.stop(); }
  }, 40_000);

  it("cancels a pending child RPC run and cleans up", async () => {
    const { workspace, childCall } = await fixture("hang");
    const store = new SessionStore();
    const runtime = new PiRpcRuntime(cliPath);
    const manager = new AgentManager(new AgentRegistry(), store, runtime);
    const controller = new AbortController();
    const pending = manager.delegate({ agent: "scout", task: { prompt: "Wait forever" }, parentId: "host-id",
      cwd: workspace, model: "slaver-test/fixture", thinking: "off", signal: controller.signal });
    await childCall;
    // Inspect the installed client's PID only in this integration test, not in runtime code.
    const handles = Reflect.get(runtime, "handles") as Map<string, { client: RpcClient }>;
    const id = store.listByParent("host-id")[0].id;
    const child = Reflect.get(handles.get(id)!.client, "process") as { pid?: number };
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    controller.abort();
    const outcome = await pending;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.session.timestamps.endedAt).toBeDefined();
    expect(handles.size).toBe(0);
    if (process.platform !== "win32") expect(() => process.kill(pid!, 0)).toThrow();
    await manager.shutdown();
  }, 30_000);
});
