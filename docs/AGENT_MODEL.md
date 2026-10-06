# Agent Domain Model

This document defines the core domain concepts for V0. The current V1 addition is specified in
[V1_IMPLEMENTER.md](V1_IMPLEMENTER.md): AgentName also accepts implementer, DelegatedTask gains optional
runPath, and implementer sessions persist an optional frozen implementation snapshot (root, runPath,
runHash, scope, acceptance). This is durable approval data, not a live runtime handle. Read-only sessions
and historical entries have no snapshot and remain compatible.

The semantics matter more than the exact TypeScript syntax. Do not casually add fields; each field must represent durable domain meaning.

## 1. AgentDefinition

An `AgentDefinition` is reusable configuration for a type of subagent.

It answers:

> What kind of agent is this, how should it behave, and what is it allowed to use?

It does **not** represent a running execution.

Recommended shape:

```ts
export interface AgentDefinition {
  name: string;
  description: string;
  instructions: string;

  model?: string;
  thinking?: ThinkingLevel;

  tools: string[];

  canDelegate: boolean;
  timeoutMs?: number;
}
```

### `name`

Stable logical identifier.

Examples:

```text
scout
reviewer
```

Requirements:

- non-empty;
- unique within the resolved registry;
- suitable for tool input and logs;
- should not encode version numbers.

### `description`

Short explanation of what the agent does and when it is useful.

It is routing information for the main model and humans.

It must not contain the full operating procedure.

### `instructions`

Complete role-specific instructions supplied to the child.

Instructions should define:

- role;
- objective;
- evidence expectations;
- boundaries;
- output discipline.

Do not duplicate general Pi/project instructions unnecessarily.

### `model`

Optional child model override.

If absent, use the extension's documented default child model resolution strategy.

Do not store provider clients, credentials, or connection objects here.

### `thinking`

Optional Pi-supported thinking level.

Validation and actual support must follow the installed Pi version/provider.

### `tools`

The exact child tool allowlist.

This is part of the capability boundary.

V0 Scout and Reviewer are read-only.

Never grant write/edit tools to these agents.

Do not rely on prompt text as the only access control.

### `canDelegate`

V0 value:

```text
false
```

Keep the property because delegation capability is meaningful, but V0 does not enable recursion.

### `timeoutMs`

Optional execution limit.

Expiration fails the child run and performs normal cleanup.

Do not retry automatically.

---

## 2. ResolvedAgentDefinition

The registry may apply defaults while loading a definition.

Runtime code should receive one stable resolved configuration.

Conceptually:

```ts
export interface ResolvedAgentDefinition extends AgentDefinition {
  model: string;
  canDelegate: boolean;
}
```

The exact TypeScript representation is flexible.

The invariant is:

> one running session must use one stable resolved definition.

Do not re-read and mutate its definition during execution.

---

## 3. DelegatedTask

A `DelegatedTask` is bounded work sent from the parent to the child.

```ts
export interface DelegatedTask {
  prompt: string;
  context?: string;
  constraints?: string[];
  expectedOutput?: string;
}
```

Only `prompt` is required.

### `prompt`

Good:

```text
Trace the backend authentication flow from login through refresh-token rotation.
```

Bad:

```text
Understand the whole project.
```

### `context`

Small task-specific information that the child cannot efficiently infer on its own.

Do not copy the parent conversation into this field.

### `constraints`

Semantic task boundaries.

Examples:

```text
backend only
focus on refresh flow
do not evaluate frontend behavior
```

Capabilities remain enforced by tools.

### `expectedOutput`

Optional guidance about what would make the result useful.

V0 should not require a rigid machine-generated JSON result unless an actual consumer requires it.

---

## 4. AgentSession

An `AgentSession` records one child-agent execution.

It answers:

> What was delegated, which agent definition was used, where is the run in its lifecycle, and how did it end?

Recommended durable shape:

```ts
export interface AgentSession {
  id: string;
  parentId: string;

  agent: {
    name: string;
    definitionFingerprint: string;
  };

  task: DelegatedTask;

  status: AgentSessionStatus;

  workspace: {
    cwd: string;
  };

  timestamps: {
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
  };

  result?: AgentResult;
  error?: AgentError;
}
```

### `id`

Unique extension-level child session identifier.

It identifies the logical execution, not the OS process.

Do not use PID as session identity.

### `parentId`

Identifier of the host Pi session that delegated the task.

This is the source of truth for hierarchy.

Do not also persist a mutable `children` array.

Children are derived by querying sessions with the matching `parentId`.

### `agent`

Records:

- definition name;
- fingerprint of the exact resolved definition used.

The fingerprint is for reproducibility/debugging if an agent definition changes later.

A deterministic hash is enough.

Do not build a version-management system around it.

### `task`

Immutable delegated task.

Do not rewrite the original task after execution.

### `workspace.cwd`

Working directory used by the child.

Workspace belongs to a session, not a reusable agent definition.

Worktree isolation is out of scope.

### `timestamps`

Use machine-readable UTC timestamps.

- `createdAt`: logical record created;
- `startedAt`: runtime successfully began child execution;
- `endedAt`: terminal state reached.

Do not invent `startedAt` if the child never actually starts.

---

## 5. Session lifecycle

```ts
export type AgentSessionStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
```

Legal transitions:

```text
queued -> starting
starting -> running
starting -> failed
starting -> cancelled
running -> completed
running -> failed
running -> cancelled
```

Terminal states:

```text
completed
failed
cancelled
```

A terminal session never returns to a non-terminal state.

If retry is added later, prefer a new session rather than rewriting history.

---

## 6. AgentResult

V0 intentionally keeps result semantics small.

```ts
export interface AgentResult {
  text: string;
}
```

The text is the final concise child answer returned to the parent.

Agent-specific structure belongs initially in the agent's output instructions.

Do not prematurely grow the core result into fields like:

```text
findings
files
plan
patch
risks
review
```

Add machine-readable fields only when a real consumer needs them.

Invariant:

- `completed` => non-empty result;
- `failed` => no successful result.

---

## 7. AgentError

```ts
export type AgentErrorCode =
  | "spawn_failed"
  | "rpc_failed"
  | "agent_failed"
  | "timeout"
  | "invalid_result"
  | "runtime_error";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  detail?: string;
}
```

Keep codes few and operationally meaningful.

Do not expose secrets or credentials in `detail`.

Cancellation is primarily represented by the `cancelled` state rather than a generic error.

---

## 8. RuntimeHandle

Live process state is not part of `AgentSession`.

Conceptually:

```ts
interface RuntimeHandle {
  sessionId: string;
  // RpcClient, process, AbortController, etc.
}
```

This is ephemeral and must not be persisted.

Core rule:

```text
AgentSession = durable logical state
RuntimeHandle = ephemeral live execution state
```

---

## 9. Definition file format

Definitions are human-authored Markdown.

Example:

```markdown
---
name: scout
description: Investigates repository code and returns focused evidence.
model: provider/model
thinking: medium
tools:
  - read
  - grep
canDelegate: false
timeoutMs: 300000
---

# Role

...
```

This frontmatter belongs to this extension; it is not Pi Skill frontmatter.

The Markdown body becomes `instructions`.

Unknown fields should be rejected in V0 so configuration mistakes are visible.

---

## 10. Registry invariants

Before runtime execution the registry must guarantee:

- names are unique;
- required fields are valid;
- configured tools are valid/available;
- V0 agents cannot enable delegation;
- Scout and Reviewer remain read-only;
- timeout is positive when present;
- resolved definition is stable for the run.

Malformed definitions should fail before child startup.

---

## 11. Tree semantics

V0 supports:

```text
Host/Main
├── Scout
└── Reviewer
```

Hierarchy is modeled through `parentId` so future nested sessions do not require replacing the identity model.

Do not implement recursive delegation merely because the model can represent it.
