import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentRegistry } from "./agents/registry.js";
import { AgentManager } from "./manager.js";
import { PiRpcRuntime } from "./runtime/pi-rpc-runtime.js";
import { SessionStore } from "./sessions/store.js";
import type { AgentSession } from "./sessions/types.js";

const ENTRY_TYPE = "slaver.session";

export default function (pi: ExtensionAPI): void {
  const store = new SessionStore();
  const manager = new AgentManager(new AgentRegistry(), store, new PiRpcRuntime(),
    (session) => pi.appendEntry(ENTRY_TYPE, session));

  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const session = entry.data as AgentSession;
        if (!store.get(session.id)) store.restoreTerminal(session);
      }
    }
  });

  pi.on("session_shutdown", async () => { await manager.shutdown(); });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: "Delegate one bounded, read-only investigation to scout or independent review to reviewer. Waits for a terminal result.",
    parameters: Type.Object({
      agent: StringEnum(["scout", "reviewer"] as const),
      task: Type.String({ minLength: 1, description: "Specific question or change to review" }),
      context: Type.Optional(Type.String({ description: "Small, task-specific context; not a transcript" })),
      constraints: Type.Optional(Type.Array(Type.String())),
      expectedOutput: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const outcome = await manager.delegate({
        agent: params.agent,
        task: { prompt: params.task, context: params.context, constraints: params.constraints, expectedOutput: params.expectedOutput },
        parentId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
        thinking: ctx.thinkingLevel ?? "off", signal,
      });
      const data = {
        id: outcome.session.id, agent: outcome.session.agent.name, status: outcome.status,
        ...(outcome.status === "completed" ? { result: outcome.result.text } : {}),
        ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: { session: outcome.session } };
    },
  });

  pi.registerCommand("subagents", {
    description: "List delegated sessions, or inspect one with /subagents <id>",
    handler: async (args, ctx) => {
      const sessions = store.listByParent(ctx.sessionManager.getSessionId());
      const id = args.trim();
      const selected = id ? sessions.find(s => s.id === id) : undefined;
      const text = id ? (selected ? JSON.stringify(selected, null, 2) : `Unknown session ${id}`)
        : sessions.length ? sessions.map(s =>
          `${s.id} ${s.agent.name} ${s.status} ${s.timestamps.endedAt ?? s.timestamps.createdAt}`,
        ).join("\n") : "No delegated sessions.";
      if (ctx.hasUI) ctx.ui.notify(text, id && !selected ? "error" : "info");
    },
  });

  pi.registerCommand("cancel-subagent", {
    description: "Cancel the active delegated child; optionally supply its session ID",
    handler: async (args, ctx) => {
      const active = store.listByParent(ctx.sessionManager.getSessionId())
        .filter(s => s.status === "starting" || s.status === "running");
      const id = args.trim() || active[0]?.id;
      const permitted = active.some(s => s.id === id);
      const cancelled = permitted && id ? await manager.cancel(id) : false;
      if (ctx.hasUI) ctx.ui.notify(cancelled ? `Cancellation requested for ${id}` : "No matching active child", cancelled ? "info" : "warning");
    },
  });
}
