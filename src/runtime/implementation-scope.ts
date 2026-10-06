import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

export interface ApprovedImplementation {
  root: string;
  runPath: string;
  runHash: string;
  scope: string[];
  acceptance: string[];
}

export class ScopeError extends Error {
  constructor(message: string) { super(message); this.name = "ScopeError"; }
}

export const WRITE_GUARD_COMMAND = "slaver-write-guard-ready";
const MAX_RUN_BYTES = 64 * 1024;
const PROTECTED_PARTS = new Set([".git", ".pi", ".agents", ".ssh", ".aws", ".gnupg", "adr", "adrs"]);
const PROTECTED_NAMES = new Set(["agents.md", "agents.override.md", "claude.md", "decisions.md"]);
const PACKAGE_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

/** A child cannot rewrite the installed code that defines its own/future capability boundary. */
export function isSlaverRuntimePath(full: string): boolean {
  const rel = relative(PACKAGE_ROOT, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  const normalized = rel.toLowerCase();
  return ["src", "agents", "node_modules"].includes(normalized.split(sep)[0]) || normalized === "package.json";
}

function repoPath(value: string): string {
  if (!value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("~") ||
    /[\\:\x00-\x1f\x7f*?]/.test(value) || value.split("/").includes("..") ||
    value.split("/").some(part => part !== "." && /[. ]$/.test(part))) {
    throw new ScopeError("Scope/run paths must be literal repository-relative paths without traversal");
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized.endsWith("/")) throw new ScopeError("Scope requires exact file paths");
  return normalized;
}

function statIfExists(full: string): Stats | undefined {
  try { return lstatSync(full); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** No symlinks in any existing component; missing parents are allowed for new files. */
function inspectPath(root: string, full: string): Stats | undefined {
  const rel = relative(root, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ScopeError("Path is outside the workspace");
  const parts = rel.split(sep);
  let cursor = root;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    const stat = statIfExists(cursor);
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new ScopeError("Symlink paths are not writable by implementer");
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) throw new ScopeError("A parent path is not a directory");
    } else {
      if (!stat.isFile() || stat.nlink !== 1) throw new ScopeError("Target must be a regular, non-hard-linked file");
      return stat;
    }
  }
  return undefined;
}

function runBytes(root: string, runPath: string): Buffer {
  const full = join(root, runPath);
  const stat = inspectPath(root, full);
  if (!stat || stat.size > MAX_RUN_BYTES) throw new ScopeError("Approved run is missing or exceeds 64 KiB");
  const bytes = readFileSync(full);
  if (bytes.length > MAX_RUN_BYTES) throw new ScopeError("Approved run exceeds 64 KiB");
  return bytes;
}

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function prepareImplementation(cwd: string, requestedRun: string): ApprovedImplementation {
  const root = realpathSync(cwd);
  const runPath = repoPath(requestedRun);
  if (!/^\.pi\/stapler\/runs\/[^/]+\.json$/.test(runPath)) throw new ScopeError("runPath must be .pi/stapler/runs/<file>.json");
  const bytes = runBytes(root, runPath);
  let run: Record<string, unknown>;
  try { run = JSON.parse(bytes.toString("utf8")); }
  catch { throw new ScopeError("Approved run must be valid JSON"); }
  if (!run || run.schemaVersion !== 1 || !["first", "repeated"].includes(run.acc as string)) {
    throw new ScopeError("Approved run requires schemaVersion 1 and acc first/repeated");
  }
  if (!Array.isArray(run.scope) || !run.scope.length || run.scope.some(p => typeof p !== "string")) {
    throw new ScopeError("Approved run requires non-empty exact file scope");
  }
  if (!Array.isArray(run.acceptance) || !run.acceptance.length || run.acceptance.some(a => typeof a !== "string" || !a.trim())) {
    throw new ScopeError("Approved run requires non-empty acceptance criteria");
  }
  const scope = (run.scope as string[]).map(repoPath);
  if (new Set(scope).size !== scope.length) throw new ScopeError("Duplicate scope paths");
  for (const file of scope) {
    const parts = file.toLowerCase().split("/");
    const name = basename(file).toLowerCase();
    if (parts.some(part => PROTECTED_PARTS.has(part)) || PROTECTED_NAMES.has(name) || /^\.env(?:\.|$)/.test(name)) {
      throw new ScopeError(`Protected file cannot be delegated: ${file}`);
    }
    if (isSlaverRuntimePath(join(root, file))) throw new ScopeError("Cannot delegate writes to the loaded Slaver runtime or definitions");
    inspectPath(root, join(root, file));
  }
  for (const file of ["index.md", "manifest.json", "rules.md", "deviations.md"]) {
    if (!inspectPath(root, join(root, ".pi/stapler", file))) throw new ScopeError(`Missing context pack file: ${file}`);
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, ".pi/stapler/manifest.json"), "utf8")); }
  catch { throw new ScopeError("Invalid context pack manifest"); }
  if (manifest?.schemaVersion !== 1) throw new ScopeError("Implementer requires pack schemaVersion 1");
  return { root, runPath, runHash: hash(bytes), scope, acceptance: [...run.acceptance] as string[] };
}

export class ImplementationGuard {
  readonly approval: ApprovedImplementation;

  constructor(snapshot: ApprovedImplementation) {
    const fresh = prepareImplementation(snapshot.root, snapshot.runPath);
    if (fresh.runHash !== snapshot.runHash || JSON.stringify(fresh.scope) !== JSON.stringify(snapshot.scope) ||
      JSON.stringify(fresh.acceptance) !== JSON.stringify(snapshot.acceptance)) throw new ScopeError("Approval changed before child startup");
    this.approval = fresh;
  }

  assertCwd(cwd: string): void {
    if (realpathSync(cwd) !== this.approval.root) throw new ScopeError("Child cwd does not match approved workspace");
  }

  assertUnchanged(): void {
    if (hash(runBytes(this.approval.root, this.approval.runPath)) !== this.approval.runHash) {
      throw new ScopeError("Approved run changed during implementation; return to parent");
    }
  }

  target(requested: string): { path: string; stat?: Stats } {
    this.assertUnchanged();
    if (/[\x00-\x1f\x7f]/.test(requested) || requested.split(/[\\/]/).includes("..") ||
      (sep !== "\\" && requested.includes("\\"))) throw new ScopeError("Invalid target path or traversal");
    const full = resolve(this.approval.root, requested);
    if (!this.approval.scope.some(file => join(this.approval.root, file) === full)) throw new ScopeError("Write is outside approved file scope");
    return { path: full, stat: inspectPath(this.approval.root, full) };
  }

  parent(directory: string): void {
    const file = this.approval.scope.find(p => dirname(join(this.approval.root, p)) === directory);
    if (!file) throw new ScopeError("Directory creation is outside approved scope");
    this.target(file);
  }
}

/** Never truncate before checking the descriptor; no following leaf symlinks or hard-linked writes. */
export async function writeApprovedFile(guard: ImplementationGuard, requested: string, content: string): Promise<void> {
  const target = guard.target(requested);
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (target.stat ? 0 : constants.O_CREAT | constants.O_EXCL);
  const file = await open(target.path, flags, 0o666);
  try {
    const opened = await file.stat();
    const current = guard.target(requested).stat;
    if (!opened.isFile() || opened.nlink !== 1 || !current || current.dev !== opened.dev || current.ino !== opened.ino ||
      (target.stat && (opened.dev !== target.stat.dev || opened.ino !== target.stat.ino))) {
      throw new ScopeError("Approved file changed before mutation");
    }
    await file.truncate(0);
    await file.writeFile(content, "utf8");
  } finally { await file.close(); }
}
