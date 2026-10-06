import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IMPLEMENTER_TOOLS } from "../agents/types.js";
import { ImplementationGuard, ScopeError, WRITE_GUARD_COMMAND, writeApprovedFile, type ApprovedImplementation } from "./implementation-scope.js";

/** Explicitly loaded only for implementer; absent/invalid config grants no mutating tools. */
export default function (pi: ExtensionAPI): void {
  const raw = process.env.SLAVER_IMPLEMENTER_SCOPE;
  if (!raw) throw new ScopeError("Missing implementer approval snapshot");
  const config = JSON.parse(raw) as { approval: ApprovedImplementation; tools: string[] };
  if (!Array.isArray(config.tools) || config.tools.some(t => !IMPLEMENTER_TOOLS.includes(t)) ||
    !["read", "scoped_edit", "scoped_write"].every(t => config.tools.includes(t))) {
    throw new ScopeError("Invalid implementer tool allowlist");
  }
  const guard = new ImplementationGuard(config.approval);
  guard.assertCwd(process.cwd());
  const edit = createEditToolDefinition(guard.approval.root, { operations: {
    async access(full) { guard.target(full); await access(full, constants.R_OK | constants.W_OK); },
    async readFile(full) { guard.target(full); return readFile(full); },
    async writeFile(full, content) { await writeApprovedFile(guard, full, content); },
  } });
  const write = createWriteToolDefinition(guard.approval.root, { operations: {
    async mkdir(directory) { guard.parent(directory); await mkdir(directory, { recursive: true }); },
    async writeFile(full, content) { await writeApprovedFile(guard, full, content); },
  } });
  pi.registerTool({ ...edit, name: "scoped_edit", label: "Scoped edit",
    description: "Precisely edit an existing file within the frozen approved scope. Cannot edit workflow/protected files.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(id, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new ScopeError("Implementation cancelled");
      guard.assertCwd(ctx.cwd);
      return edit.execute(id, { ...params, path: guard.target(params.path).path }, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({ ...write, name: "scoped_write", label: "Scoped write",
    description: "Create or fully rewrite a file within the frozen approved scope. Cannot write workflow/protected files.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(id, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new ScopeError("Implementation cancelled");
      guard.assertCwd(ctx.cwd);
      return write.execute(id, { ...params, path: guard.target(params.path).path }, signal, onUpdate, ctx);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    guard.assertCwd(ctx.cwd);
    guard.assertUnchanged();
    const actual = pi.getActiveTools().slice().sort();
    if (JSON.stringify(actual) !== JSON.stringify(config.tools.slice().sort())) throw new ScopeError("Unsafe child tool selection");
    // Registration only after validation provides the host's pre-prompt readiness handshake.
    pi.registerCommand(WRITE_GUARD_COMMAND, { description: guard.approval.runHash, handler: async () => {} });
  });
}
