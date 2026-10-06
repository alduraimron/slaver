import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { resolvePiCliPath } from "../src/runtime/pi-cli.js";
import { RuntimeFailure } from "../src/runtime/runtime.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getPackageDir: vi.fn() }));
const folders: string[] = [];

function hostPackage(bin: unknown, entry?: string): string {
  const root = mkdtempSync(join(tmpdir(), "slaver-host-pi-"));
  folders.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ bin }));
  if (entry) {
    const file = join(root, entry);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "// Fake Pi CLI; unit tests never execute it.\n");
  }
  return root;
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("host Pi CLI resolution", () => {
  it("uses the host-provided package root and its declared bundled entry point", () => {
    const root = hostPackage({ pi: "dist/bundle/cli.js" }, "dist/bundle/cli.js");
    vi.mocked(getPackageDir).mockReturnValue(root);
    expect(resolvePiCliPath()).toBe(join(root, "dist/bundle/cli.js"));
    expect(getPackageDir).toHaveBeenCalledOnce();
  });

  it.each([{ pi: "dist/cli.js" }, "dist/cli.js"])("supports an unbundled CLI declared as %j", bin => {
    const root = hostPackage(bin, "dist/cli.js");
    expect(resolvePiCliPath(root)).toBe(join(root, "dist/cli.js"));
    expect(getPackageDir).not.toHaveBeenCalled();
  });

  it.each(["missing manifest", "invalid JSON", "missing bin", "binary bin", "missing CLI", "directory CLI"])(
    "reports a typed startup failure for %s instead of falling back to another Pi", kind => {
      const root = hostPackage({ pi: "dist/cli.js" });
      if (kind === "missing manifest") rmSync(join(root, "package.json"));
      if (kind === "invalid JSON") writeFileSync(join(root, "package.json"), "not JSON");
      if (kind === "missing bin") writeFileSync(join(root, "package.json"), "{}");
      if (kind === "binary bin") writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { pi: "pi.exe" } }));
      if (kind === "directory CLI") mkdirSync(join(root, "dist/cli.js"), { recursive: true });
      expect(() => resolvePiCliPath(root)).toThrow(RuntimeFailure);
      expect(() => resolvePiCliPath(root)).toThrow(expect.objectContaining({ code: "spawn_failed" }));
    },
  );
});
