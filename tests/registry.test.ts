import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry, DefinitionError, parseDefinition, UnknownAgentError } from "../src/agents/registry.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = (name: string, tools = "  - read\n  - grep") => `---\nname: ${name}\ndescription: Test agent\ntools:\n${tools}\ncanDelegate: false\n---\nDo the task carefully.\n`;
const registry = () => {
  const dir = mkdtempSync(join(tmpdir(), "slaver-registry-"));
  dirs.push(dir);
  writeFileSync(join(dir, "scout.md"), file("scout"));
  writeFileSync(join(dir, "reviewer.md"), file("reviewer"));
  return dir;
};

describe("definition registry", () => {
  it("loads two read-only agents, resolves defaults, and fingerprints the resolved configuration", () => {
    const agents = new AgentRegistry(registry());
    const scout = agents.resolve("scout", "openai/example", "low");
    expect(scout).toMatchObject({ model: "openai/example", thinking: "low", tools: ["read", "grep"], canDelegate: false });
    expect(scout.fingerprint).toHaveLength(64);
    expect(agents.resolve("scout", "openai/example", "low").fingerprint).toBe(scout.fingerprint);
    expect(agents.resolve("scout", "openai/other", "low").fingerprint).not.toBe(scout.fingerprint);
    expect(() => agents.resolve("worker", "openai/example", "off")).toThrow(UnknownAgentError);
    const override = parseDefinition(file("scout").replace("canDelegate: false", "model: anthropic/small\nthinking: medium\ncanDelegate: false"), "override.md");
    expect(override).toMatchObject({ model: "anthropic/small", thinking: "medium" });
    const dir = registry();
    writeFileSync(join(dir, "scout.md"), file("scout").replace("canDelegate: false", "model: anthropic/small\ncanDelegate: false"));
    expect(new AgentRegistry(dir).resolve("scout", "openai/example", "high").thinking).toBe("off");
  });

  it("rejects unsafe tools, unknown fields, invalid timeout, duplicate names and missing roles", () => {
    expect(() => parseDefinition(file("scout", "  - bash"), "bad.md")).toThrow(/only read/);
    expect(() => parseDefinition(file("reviewer").replace("canDelegate: false", "canDelegate: true"), "bad.md")).toThrow(/canDelegate/);
    expect(() => parseDefinition(file("scout").replace("---\nDo", "timeoutMs: -1\n---\nDo"), "bad.md")).toThrow(/timeoutMs/);
    expect(() => parseDefinition(file("scout").replace("description: Test agent", "description: Test agent\nextra: 5"), "bad.md")).toThrow(/unknown field/);
    const dir = registry();
    writeFileSync(join(dir, "duplicate.md"), file("scout"));
    expect(() => new AgentRegistry(dir)).toThrow(DefinitionError);
    rmSync(join(dir, "duplicate.md"));
    rmSync(join(dir, "reviewer.md"));
    expect(() => new AgentRegistry(dir)).toThrow(/missing required agent/);
  });
});
