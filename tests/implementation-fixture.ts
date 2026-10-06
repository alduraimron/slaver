import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APPROVED_RUN = ".pi/stapler/runs/approved.json";

export function approvedRun(root: string, overrides: Record<string, unknown> = {}): string {
  mkdirSync(join(root, ".pi/stapler/runs"), { recursive: true });
  for (const name of ["index.md", "rules.md", "deviations.md"]) writeFileSync(join(root, ".pi/stapler", name), "# Fixture context\n");
  writeFileSync(join(root, ".pi/stapler/manifest.json"), JSON.stringify({ schemaVersion: 1, rawReads: "forbidden" }));
  writeFileSync(join(root, APPROVED_RUN), JSON.stringify({ schemaVersion: 1, acc: "first", mode: "bugfix",
    scope: ["entry.ts", "src/new.ts"], acceptance: ["Approved files implement the requested change"], ...overrides }));
  return APPROVED_RUN;
}
