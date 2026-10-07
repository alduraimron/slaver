# pi-slaver

A small Pi extension for one-at-a-time, blocking delegation to isolated child processes: read-only
`scout`/`reviewer`, plus an approved-scope `implementer`. The implementation fix is on `main` with package
version kept at 0.0.1 and no new tag. V1 names the capability contract, not a package release;
V0 read-only behavior remains compatible. Validated against `@earendil-works/pi-coding-agent` 1.0.4.

## Install from GitHub

Requires Pi 1.0.4 or newer (Node.js distribution), Node.js >=22.19, and SSH access to `git@github.com:alduraimron/slaver.git`. Standalone compiled Pi binaries are not supported by Pi's current Node-based `RpcClient`.

```sh
pi install git:git@github.com:alduraimron/slaver.git
```

Restart Pi (or run `/reload`) after installation. The extension registers the `delegate` tool automatically. To update an unpinned Git install, run `pi update --extensions`. To remove it, run `pi remove git:git@github.com:alduraimron/slaver.git`.

For local development instead:

```sh
npm install --ignore-scripts
pi -e ./src/index.ts
```

You can also install the checkout as a local Pi package with `pi install .` from this directory. Pi supplies the extension's peer modules at runtime; managed installs do not need local copies of Pi. The pinned Pi dev dependencies are only for typechecking and tests.

The main agent gets one tool:

```text
delegate({ agent: "scout" | "reviewer", task: "...", context?: "..." })
delegate({ agent: "implementer", task: "...", runPath: ".pi/stapler/runs/<file>.json", context?: "...", workspacePath?: "/absolute/project" })
```

It waits for a terminal outcome, returned as JSON with `id`, `agent`, and `status` (`completed`, `failed`, or `cancelled`). A successful result has `result`; a failure has a typed `error`. The full child event stream never enters the parent model context. Use `/subagents` to list delegated sessions, `/subagents <id>` to inspect one, and `/cancel-subagent [id]` to cancel the active child. Session metadata is also saved as non-model-context Pi entries when the host session is persisted.

## Behavior and boundaries

- Each task starts a fresh Pi RPC child in the host cwd or explicit existing absolute `workspacePath`,
  with no copied parent transcript. For cross-workspace implementer, the run must bind `workspaceRoot`
  to that canonical directory; missing/wrong bindings fail before spawn. Exact file scope is unchanged.
  Parent identity remains the current host, so `/subagents` and cancellation work there without a second SDK transport host. Its CLI comes from the host's `getPackageDir()` and declared `bin`, not Slaver's local `node_modules` or a different `pi` on `PATH`. Restart Pi after updating it so host and child stay on the same version.
- The default child model and thinking level come from the host. An agent definition may override the model with a `provider/model` ID and set a Pi-supported thinking level. A model override without a thinking override defaults to `off` to avoid inheriting an unsupported level. An unavailable or incompatible model fails rather than silently falling back.
- Scout/Reviewer tools are exactly `read`, `grep`, `find`, and `ls`. Implementer also gets `scoped_edit`
  and `scoped_write`, from one explicitly loaded guard extension. Built-in `write`/`edit`, bash/powershell,
  MCP, discovered extensions and recursive delegation remain unavailable to every child. Guard absence
  fails closed before the task. Project `AGENTS.md` instructions remain available.
- Implementer requires a parent-approved Stapler run (`schemaVersion: 1`, `acc: first/repeated`, exact
  file `scope`, non-empty `acceptance`) and a context pack. Run changes invalidate further writes.
  Protected workflow/harness/credential/ADR paths, symlinks, hardlinks, directory scopes and traversal
  are rejected. Read-only agents reject `runPath`. Parent owns actual conversational ACC and verification.
- This is a Pi capability/path boundary, **not** an OS filesystem sandbox or protection against a hostile
  same-user process racing directory changes. Reads are not sandboxed. Keep the workspace quiescent.
  Failed/cancelled implementations can leave partial approved edits; inspect them, never auto-rollback
  or blindly retry. Implementer cannot delete/rename files or run commands/tests; parent handles those.
- Blocking calls emit rate-limited progress: id, role, status, elapsed time, tool-call count and last
  allowed tool name. No child text, reasoning, arguments, secrets or raw event stream is forwarded.
  A progress observer failure never changes the child's outcome. It does not imply acceptance.
- Only one delegation may run at a time. A timeout fails the run, while host abort and explicit cancellation cancel it. All terminal paths stop the child process.
- Agent definition files are packaged in `agents/`; arbitrary project-defined roles are not loaded.

## Develop and verify

```sh
npm run typecheck
npm test
npm run test:integration
```

Integration tests use real Pi RPC processes and a local fake OpenAI-compatible endpoint. They need no external model credentials. They cover Scout, Reviewer, failure, cancellation, tool restrictions, parent continuation, session inspection after restart, and package loading without local Pi peers or with a stale peer copy.

To test another installed Node.js Pi CLI instead of the dev dependency:

```sh
SLAVER_TEST_CLI_PATH=/path/to/pi/dist/bundle/cli.js npm run test:integration
```

`SLAVER_TEST_EXTENSION_PATH` optionally selects another extension entry point for the existing host tests.

Normative implementer addition: [`docs/V1_IMPLEMENTER.md`](docs/V1_IMPLEMENTER.md). The V0 baseline and
shared architecture remain in [`docs/V0_SCOPE.md`](docs/V0_SCOPE.md), [`docs/AGENT_MODEL.md`](docs/AGENT_MODEL.md),
and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Integration coverage includes guarded edits/new files,
denied writes, missing/inert guards, and cancellation preserving partial edits. Update an unpinned Git
install to obtain the fix on main, or use the local checkout (`pi install /path/to/slaver`). Do not load
both sources simultaneously; existing tags are not moved.
