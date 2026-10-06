# pi-slaver

A small Pi extension for one-at-a-time, blocking delegation to isolated, read-only `scout` and `reviewer` child processes. Validated against `@earendil-works/pi-coding-agent` 1.0.4.

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
```

It waits for a terminal outcome, returned as JSON with `id`, `agent`, and `status` (`completed`, `failed`, or `cancelled`). A successful result has `result`; a failure has a typed `error`. The full child event stream never enters the parent model context. Use `/subagents` to list delegated sessions, `/subagents <id>` to inspect one, and `/cancel-subagent [id]` to cancel the active child. Session metadata is also saved as non-model-context Pi entries when the host session is persisted.

## Behavior and boundaries

- Each task starts a fresh Pi RPC child in the host working directory, with no copied parent transcript. Its CLI comes from the host's `getPackageDir()` and declared `bin`, not Slaver's local `node_modules` or a different `pi` on `PATH`. Restart Pi after updating it so host and child stay on the same version.
- The default child model and thinking level come from the host. An agent definition may override the model with a `provider/model` ID and set a Pi-supported thinking level. A model override without a thinking override defaults to `off` to avoid inheriting an unsupported level. An unavailable or incompatible model fails rather than silently falling back.
- Child tools are exactly `read`, `grep`, `find`, and `ls`. `bash`, `powershell`, `write`, `edit`, extension tools, MCP tools, and recursive delegation are unavailable. The child disables extensions and MCP explicitly. This is a Pi tool-capability boundary, **not** an OS-level filesystem sandbox. Project `AGENTS.md` instructions remain available to the child.
- Only one delegation may run at a time. A timeout fails the run, while host abort and explicit cancellation cancel it. All terminal paths stop the child process.
- Agent definition files are packaged in `agents/`; V0 does not load arbitrary project-defined agent roles.

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

Normative scope and architecture: [`docs/V0_SCOPE.md`](docs/V0_SCOPE.md), [`docs/AGENT_MODEL.md`](docs/AGENT_MODEL.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
