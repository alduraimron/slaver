# V1: approved-scope implementer

This is the explicitly approved extension of V0. It supersedes V0's exclusion of implementers only;
Scout and Reviewer remain read-only. The V0 lifecycle, single blocking child, cancellation, isolated
context, host ownership and no-recursion contracts remain unchanged. No teams, scheduler or shell runner.

## Input and authority

`delegate` accepts `agent: "implementer"` and requires `runPath`, a repository-relative JSON file under
`.pi/stapler/runs/`. Read-only agents reject `runPath`. The host loads the run before creating a child.

Optional `workspacePath` selects an existing absolute project directory for any role; omitted means the
host cwd, preserving V0 calls. Selection is explicit, canonicalized, and belongs to the child session,
not task prose or agent definitions. An implementer targeting a different canonical cwd requires the
run's `workspaceRoot` to equal that selected canonical absolute path. A missing/mismatched binding fails
before child creation. Legacy runs without that field remain valid only for same-workspace writes;
when provided, a binding is always validated. All writes remain exact-file scoped inside the selected
root, with the same protected paths and readiness handshake. Parent must obtain ACC for that root and
check its pack, not the host's unrelated pack. ParentId remains the original host session, so inspect
and cancel continue through its /subagents and /cancel-subagent commands; no transport SDK host is needed.

The run must have `schemaVersion: 1`, an `acc` value of `first` or `repeated`, a non-empty list of literal
file paths in `scope`, and non-empty `acceptance`. These ACC values record parent approval; they do not
cryptographically prove conversational user consent. Stapler must obtain explicit ACC before writing the
run or calling implementer. Scope is snapshotted and tied to the run's SHA-256. Edits to that run during
execution invalidate further mutations. Required pack files are index.md, manifest.json, rules.md and
deviations.md; the manifest must have schemaVersion 1. Pack freshness is checked by the parent, not child.

Scope entries are exact files, not directories, prefixes or expanded globs. New files are allowed.
Traversal, paths outside cwd, symlinks, hard-linked files, special files, colon/alternate-stream names
and ambiguous trailing-dot/space aliases are rejected. Protected paths
include .git, .pi, .agents, credential directories/.env files, harness instruction files, and directories
named adr/adrs or DECISIONS.md. Parent must also exclude any differently named policy/ADR files from scope.
The loaded Slaver package's src/agents/node_modules and package.json are also protected against child
self-modification. Develop those files in the parent, or use a separate immutable installed copy of Slaver.
The child must not change approved decisions, acceptance, scope, ADRs or workflow metadata.

## Capability boundary

Implementer receives read/grep/find/ls plus `scoped_edit` and `scoped_write`. Built-in edit/write,
bash/powershell, MCP, discovered extensions, recursive delegation and process execution stay disabled.
The two scoped tools are registered by one explicitly loaded, packaged guard extension. They validate
the frozen approval, exact path and filesystem topology at mutation time. Writes use non-following file
opens, reject non-regular/multiply linked targets, and validate the opened inode before truncating.

The child advertises a readiness command only after its active tools match the guarded allowlist.
The runtime checks that marker before sending the task. If the guard is absent or invalid, no built-in
mutating tool is available and the task fails closed. Scout/Reviewer never load this guard.

This is a Pi capability/path boundary, not an OS sandbox against a hostile same-user process racing
filesystem directory changes. Reads are not sandboxed. Use a quiescent workspace; no worktree isolation
is introduced. The parent independently reviews the resulting diff and runs scope/acceptance verification.

## Execution and terminal outcomes

The parent owns run metadata, writes outside the delegated scope, commands, verifier, review and ADRs.
Implementer only edits approved files and reports changes/blockers; completed does not imply acceptance
or verification passed. No git operations, migrations, installs, check/verifier or tests run in the child. Deletion/rename is also
parent-owned; scoped_edit/scoped_write do not provide those operations.

The blocking tool emits bounded progress: logical id, role, lifecycle status, elapsed time, tool-call
count and last allowed tool name. No prompts, parameters, model text/reasoning, credentials or raw events
are forwarded. Heartbeats are rate-limited and observation failures cannot change execution outcomes.
Progress is not acceptance, a write-success claim or an automatic retry.

Failure, timeout or cancellation can leave partial in-scope edits. Do not auto-rollback, retry, or blindly
fall back to more writes. The parent first inspects the worktree and reports the state; cancellation waits
for user direction. A blocked scope/decision requires a revised pre-ACC summary, not a wider child scope.

## Required coverage

- Legacy read-only agents and persisted sessions remain compatible.
- Invalid/missing approval fails before a child starts; a changed run blocks mutation.
- In-scope edits/new files work; out-of-scope, traversal, protected paths, symlinks/hardlinks and directories fail.
- Guard absence fails before model execution, with no writable built-ins.
- Real RPC tests exercise approved writes and denied writes, and confirm host continuation/tool isolation.
- Cross-workspace writes require explicit root binding and retain the original parent identity/inspection;
  wrong/missing bindings fail before spawn. Legacy same-cwd runs remain valid.
- Progress exposes bounded metadata only; observer failures, heartbeat updates and cancellation do not
  leak child text/arguments or change cleanup and terminal semantics.
