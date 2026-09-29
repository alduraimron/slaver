import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "../src/agents/registry.js";
import { AgentManager } from "../src/manager.js";
import { PiRpcRuntime } from "../src/runtime/pi-rpc-runtime.js";
import { SessionStore } from "../src/sessions/store.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extensionPath = resolve("src/index.ts");
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

type Mode = "success" | "failure" | "hang";
async function fixture(mode: Mode) {
  const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
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
      const role = JSON.stringify(body.messages).includes("reviewer") ? "reviewer" : "scout";
      send({ tool_calls: [{ index: 0, id: "call-1", type: "function",
        function: { name: "delegate", arguments: JSON.stringify({ agent: role, task: "Inspect the entry point" }) } }] });
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
  process.env.PI_CODING_AGENT_DIR = config;
  process.env.PI_OFFLINE = "1";
  return { requests, childCall, workspace, config };
}

describe("real Pi RPC process", () => {
  it("runs host extension -> restricted RPC child -> concise result and lets host continue", async () => {
    const { requests, workspace, config } = await fixture("success");
    const client = new RpcClient({ cliPath, cwd: workspace, model: "slaver-test/fixture", env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" },
      args: ["--no-session", "--no-extensions", "-e", extensionPath, "--tools", "delegate", "--thinking", "off"] });
    try {
      await client.start();
      const events = await client.promptAndWait("Use scout to find the entry point", undefined, 30_000);
      expect(events.some(e => e.type === "agent_settled")).toBe(true);
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
    const runtime = new PiRpcRuntime();
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
