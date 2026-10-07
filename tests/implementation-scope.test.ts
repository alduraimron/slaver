import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImplementationGuard, isSlaverRuntimePath, prepareImplementation, resolveWorkspace, writeApprovedFile } from "../src/runtime/implementation-scope.js";
import { approvedRun, APPROVED_RUN } from "./implementation-fixture.js";

const roots: string[] = [];
const directory = () => { const root = mkdtempSync(join(tmpdir(), "slaver-scope-")); roots.push(root); return root; };
const fixture = () => {
  const root = directory();
  writeFileSync(join(root, "entry.ts"), "original\n");
  approvedRun(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("approved implementation scope", () => {
  it("loads and freezes approval; writes only exact approved files, including new files", async () => {
    const root = fixture();
    const approval = prepareImplementation(root, APPROVED_RUN);
    const guard = new ImplementationGuard(approval);
    expect(approval).toMatchObject({ scope: ["entry.ts", "src/new.ts"], acceptance: ["Approved files implement the requested change"] });
    expect(approval.runHash).toHaveLength(64);
    await writeApprovedFile(guard, "entry.ts", "changed\n");
    guard.parent(join(root, "src"));
    mkdirSync(join(root, "src"));
    await writeApprovedFile(guard, join(root, "src/new.ts"), "new\n");
    expect(readFileSync(join(root, "entry.ts"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(root, "src/new.ts"), "utf8")).toBe("new\n");
    expect(() => guard.target("other.ts")).toThrow(/outside approved/);
    expect(() => guard.target(join(directory(), "escape.ts"))).toThrow(/outside approved/);
    expect(() => guard.target("src/../entry.ts")).toThrow(/traversal/);
    expect(() => guard.parent(join(root, "unrelated"))).toThrow(/outside approved/);
  });

  it.each([
    { acc: "pending" }, { acc: "approved" }, { acc: "" }, { schemaVersion: 2 },
    { scope: [] }, { scope: ["entry.ts", "./entry.ts"] }, { scope: ["../escape.ts"] },
    { scope: ["src/*.ts"] }, { scope: [".pi/stapler/rules.md"] }, { scope: [".git/config"] },
    { scope: ["AGENTS.md"] }, { scope: ["docs/adr/0001.md"] }, { scope: [".env.local"] },
    { scope: [".agents/skills/x.md"] }, { scope: ["AGENTS.md::$DATA"] }, { scope: ["AGENTS.md."] },
    { scope: ["AGENTS.md "] }, { acceptance: [] }, { acceptance: [""] },
  ])("rejects invalid/protected approval before startup: %j", overrides => {
    const root = fixture();
    approvedRun(root, overrides);
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow();
  });

  it("rejects missing/malformed approval, missing pack, incompatible pack and directories", () => {
    const root = fixture();
    expect(() => prepareImplementation(root, "outside.json")).toThrow(/runPath/);
    expect(() => prepareImplementation(root, ".pi/stapler/runs/missing.json")).toThrow(/missing/);
    writeFileSync(join(root, APPROVED_RUN), "not JSON");
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/valid JSON/);
    approvedRun(root);
    rmSync(join(root, ".pi/stapler/rules.md"));
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/Missing context pack/);
    approvedRun(root);
    writeFileSync(join(root, ".pi/stapler/manifest.json"), '{"schemaVersion":2}');
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/pack schemaVersion/);
    approvedRun(root, { scope: ["src"] });
    mkdirSync(join(root, "src"));
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/regular/);
  });

  it("requires an exact canonical workspace binding for cross-workspace approval, preserving legacy runs", () => {
    const root = fixture();
    expect(prepareImplementation(root, APPROVED_RUN).root).toBe(root);
    expect(() => prepareImplementation(root, APPROVED_RUN, { requireWorkspaceBinding: true })).toThrow(/workspaceRoot/);
    approvedRun(root, { workspaceRoot: directory() });
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/workspaceRoot/);
    approvedRun(root, { workspaceRoot: root });
    const bound = prepareImplementation(root, APPROVED_RUN, { requireWorkspaceBinding: true });
    expect(new ImplementationGuard(bound).approval.root).toBe(root);
    approvedRun(root, { workspaceRoot: null });
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/workspaceRoot/);
  });

  it("resolves only explicitly selected existing absolute workspace directories", () => {
    const root = fixture();
    expect(resolveWorkspace(root)).toBe(root);
    expect(resolveWorkspace(directory(), root)).toBe(root);
    for (const bad of ["../other", "~/code", "", root + "/*", root + "/missing", join(root, "entry.ts")]) {
      expect(() => resolveWorkspace(root, bad)).toThrow(/existing absolute directory/);
    }
  });

  it("protects the loaded Slaver runtime/definitions from self-modification", () => {
    expect(isSlaverRuntimePath(join(process.cwd(), "src/runtime/child-write-guard.ts"))).toBe(true);
    expect(isSlaverRuntimePath(join(process.cwd(), "src/agents/types.ts"))).toBe(true);
    expect(isSlaverRuntimePath(join(process.cwd(), "SRC/runtime/child-write-guard.ts"))).toBe(true);
    expect(isSlaverRuntimePath(join(process.cwd(), "agents/implementer.md"))).toBe(true);
    expect(isSlaverRuntimePath(join(directory(), "entry.ts"))).toBe(false);
  });

  it("accepts literal bracketed route paths and repeated ACC, not expanded patterns", () => {
    const root = fixture();
    approvedRun(root, { acc: "repeated", scope: ["src/[id]/page.ts"] });
    expect(prepareImplementation(root, APPROVED_RUN).scope).toEqual(["src/[id]/page.ts"]);
  });

  it("rejects symlinked target/parents/approval and hard-linked targets", () => {
    const root = fixture();
    const outside = directory();
    writeFileSync(join(outside, "victim.ts"), "untouched");
    rmSync(join(root, "entry.ts"));
    symlinkSync(join(outside, "victim.ts"), join(root, "entry.ts"));
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/Symlink/);
    rmSync(join(root, "entry.ts"));
    linkSync(join(outside, "victim.ts"), join(root, "entry.ts"));
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/hard-linked/);
    rmSync(join(root, "entry.ts"));
    writeFileSync(join(root, "entry.ts"), "original");
    symlinkSync(outside, join(root, "src"), "dir");
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/Symlink/);
    rmSync(join(root, "src"));
    writeFileSync(join(outside, "run.json"), readFileSync(join(root, APPROVED_RUN)));
    rmSync(join(root, APPROVED_RUN));
    symlinkSync(join(outside, "run.json"), join(root, APPROVED_RUN));
    expect(() => prepareImplementation(root, APPROVED_RUN)).toThrow(/Symlink/);
    expect(readFileSync(join(outside, "victim.ts"), "utf8")).toBe("untouched");
  });

  it("blocks an altered run and detects approval changed before guard construction", async () => {
    const root = fixture();
    const snapshot = prepareImplementation(root, APPROVED_RUN);
    const guard = new ImplementationGuard(snapshot);
    approvedRun(root, { scope: ["entry.ts"] });
    await expect(writeApprovedFile(guard, "entry.ts", "must not write")).rejects.toThrow(/changed/);
    expect(() => new ImplementationGuard(snapshot)).toThrow(/changed/);
    expect(readFileSync(join(root, "entry.ts"), "utf8")).toBe("original\n");
  });

  it.each(["symlink", "hardlink"])("rechecks a %s substituted after approval without truncation", async kind => {
    const root = fixture();
    const outside = directory();
    writeFileSync(join(outside, "victim.ts"), "untouched");
    const guard = new ImplementationGuard(prepareImplementation(root, APPROVED_RUN));
    rmSync(join(root, "entry.ts"));
    if (kind === "symlink") symlinkSync(join(outside, "victim.ts"), join(root, "entry.ts"));
    else linkSync(join(outside, "victim.ts"), join(root, "entry.ts"));
    await expect(writeApprovedFile(guard, "entry.ts", "must not write")).rejects.toThrow();
    expect(readFileSync(join(outside, "victim.ts"), "utf8")).toBe("untouched");
  });
});
