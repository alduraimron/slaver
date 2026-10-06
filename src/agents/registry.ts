import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { IMPLEMENTER_TOOLS, type AgentDefinition, type AgentName, type ResolvedAgentDefinition } from "./types.js";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENTS = new Set<AgentName>(["scout", "reviewer", "implementer"]);

export class DefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionError";
  }
}

export class UnknownAgentError extends Error {
  constructor(name: string) {
    super(`Unknown agent "${name}". Available agents: scout, reviewer, implementer.`);
    this.name = "UnknownAgentError";
  }
}

export function parseDefinition(content: string, source: string): AgentDefinition {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch (error) {
    throw new DefinitionError(`${source}: invalid YAML: ${String(error)}`);
  }
  const fail = (message: string): never => { throw new DefinitionError(`${source}: ${message}`); };
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) fail("frontmatter must be a mapping");
  const allowed = new Set(["name", "description", "model", "thinking", "tools", "canDelegate", "timeoutMs"]);
  for (const key of Object.keys(frontmatter)) if (!allowed.has(key)) fail(`unknown field "${key}"`);
  const { name, description, model, thinking, tools, canDelegate, timeoutMs } = frontmatter;
  if (typeof name !== "string" || !AGENTS.has(name as AgentName)) fail("name must be scout, reviewer or implementer");
  if (typeof description !== "string" || !description.trim()) fail("description must be non-empty");
  if (!body.trim()) fail("instructions must be non-empty Markdown body");
  if (model !== undefined && (typeof model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(model))) {
    fail("model must be a provider/model ID");
  }
  if (thinking !== undefined && (typeof thinking !== "string" || !THINKING.has(thinking))) fail("invalid thinking level");
  const permitted = name === "implementer" ? new Set(IMPLEMENTER_TOOLS) : READ_TOOLS;
  if (!Array.isArray(tools) || tools.length === 0 || tools.some(t => typeof t !== "string" || !permitted.has(t))) {
    fail(name === "implementer" ? "implementer tools must be read-only tools or scoped_edit/scoped_write" :
      "tools must be a non-empty array containing only read, grep, find, ls");
  }
  if (name === "implementer" && !["read", "scoped_edit", "scoped_write"].every(t => (tools as string[]).includes(t))) {
    fail("implementer requires read, scoped_edit and scoped_write");
  }
  const toolNames = tools as string[];
  if (new Set(toolNames).size !== toolNames.length) fail("duplicate tools");
  if (canDelegate !== false) fail("canDelegate must be false");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    fail("timeoutMs must be a positive integer");
  }
  return {
    name: name as AgentName,
    description: description as string,
    instructions: body,
    model: model as string | undefined,
    thinking: thinking as ThinkingLevel | undefined,
    tools: [...toolNames],
    canDelegate: false,
    timeoutMs: timeoutMs as number | undefined,
  };
}

export class AgentRegistry {
  private readonly definitions = new Map<AgentName, AgentDefinition>();

  constructor(directory = fileURLToPath(new URL("../../agents/", import.meta.url))) {
    for (const filename of readdirSync(directory).filter(f => f.endsWith(".md")).sort()) {
      const definition = parseDefinition(readFileSync(join(directory, filename), "utf8"), filename);
      if (this.definitions.has(definition.name)) throw new DefinitionError(`${filename}: duplicate agent "${definition.name}"`);
      this.definitions.set(definition.name, definition);
    }
    for (const name of AGENTS) if (!this.definitions.has(name)) throw new DefinitionError(`missing required agent "${name}"`);
  }

  resolve(name: string, fallbackModel: string, fallbackThinking: ThinkingLevel): ResolvedAgentDefinition {
    const definition = this.definitions.get(name as AgentName);
    if (!definition) throw new UnknownAgentError(name);
    const model = definition.model ?? fallbackModel;
    if (!/^[^\s/]+\/[^\s]+$/.test(model)) throw new DefinitionError(`No usable model for ${name}: expected provider/model ID`);
    // A model override may not support the parent's thinking level. Default it to off.
    const thinking = definition.thinking ?? (definition.model ? "off" : fallbackThinking);
    const resolved = { ...definition, tools: [...definition.tools], model, thinking };
    const fingerprint = createHash("sha256").update(JSON.stringify(resolved)).digest("hex");
    return { ...resolved, fingerprint };
  }
}
