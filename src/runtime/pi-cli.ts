import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RuntimeFailure } from "./runtime.js";

export function resolvePiCliPath(packageDir = getPackageDir()): string {
  // Pi maps this API to the host installation. import.meta.resolve() would instead
  // require a local peer copy and could launch an old Pi from Slaver's node_modules.
  let bin: unknown;
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      bin?: string | { pi?: unknown };
    } | null;
    bin = typeof manifest?.bin === "string" ? manifest.bin : manifest?.bin?.pi;
  } catch {
    throw new RuntimeFailure("spawn_failed", "Could not read the host Pi CLI manifest. Reinstall Pi and restart the host session.");
  }
  if (typeof bin !== "string" || !/\.(?:c|m)?js$/.test(bin)) {
    throw new RuntimeFailure("spawn_failed", "Host Pi has no Node.js CLI entry point. Slaver requires Pi's Node.js distribution.");
  }
  const cliPath = resolve(packageDir, bin);
  try {
    if (!statSync(cliPath).isFile()) throw new Error("Not a file");
  } catch {
    throw new RuntimeFailure("spawn_failed", "Host Pi CLI is missing. Install Pi's Node.js distribution and restart the host session.");
  }
  return cliPath;
}
