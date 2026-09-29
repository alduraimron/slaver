# Architecture

## 1. Summary

V0 is a standalone Pi extension that delegates a bounded task to a separate Pi child process.

```text
Main Pi
   |
   | delegate(agent, task)
   v
+-------------------+
|   Agent Manager   |
+---------+---------+
          |
     +----+-------------------+
     |                        |
     v                        v
Agent Registry          Session Store
     |                        |
     +-----------+------------+
                 |
                 v
          Resolved Definition
                 +
          Delegated Task
                 |
                 v
         +---------------+
         | Agent Runtime |
         +-------+-------+
                 |
                 v
        Pi RPC child process
                 |
                 v
           final result
                 |
                 v
         Agent Manager
                 |
                 v
             Main Pi
```

Four core responsibilities:

1. **Registry** — reusable agent definitions.
2. **Session Store** — logical executions and hierarchy.
3. **Runtime** — child Pi execution/control.
4. **Manager** — coordinates them without doing model reasoning.

## 2. Why RPC

Use a separate Pi process controlled through Pi RPC.

Pi distinguishes:

- **SDK** — in-process TypeScript embedding;
- **RPC** — child process with bidirectional command/event control and process isolation.

For a subagent, RPC gives the better boundary:

- isolated child context;
- independent child lifecycle;
- child failure separated from host execution;
- per-child model/tool configuration;
- cancellation/control without coupling domain state to Pi internals.

Prefer Pi's supported/exported TypeScript RPC client for the installed version.

Do not invent another protocol around Pi.

## 3. Runtime boundary

The rest of the extension must not depend directly on `RpcClient`.

Use a narrow runtime contract.

Conceptually:

```ts
export interface AgentRuntime {
  run(input: RunAgentInput): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
```

```ts
interface RunAgentInput {
  session: AgentSession;
  definition: ResolvedAgentDefinition;
  signal: AbortSignal;
}
```

The runtime translates domain data into the installed Pi version's RPC/CLI configuration.

The manager should not know:

- RPC request IDs;
- JSONL framing;
- PID mechanics;
- Pi transport event details.

## 4. AgentManager

Responsibilities:

1. validate requested agent exists;
2. resolve the definition;
3. create an `AgentSession`;
4. record initial state;
5. perform legal state transitions;
6. invoke runtime;
7. store result/failure;
8. propagate cancellation;
9. return stable result semantics to Main Pi.

It must not:

- choose which agent the model should use;
- rewrite the task;
- investigate the repository itself;
- retry automatically;
- spawn extra agents.

## 5. AgentRegistry

Responsibilities:

- discover definition files;
- parse frontmatter;
- use Markdown body as instructions;
- validate definitions;
- reject duplicate names;
- apply documented defaults;
- lookup by name.

For V0, package-provided `scout` and `reviewer` definitions are sufficient.

Do not add global/project override resolution until a real need exists.

## 6. SessionStore

Minimum operations:

```ts
create(session)
get(id)
update(id, ...)
listByParent(parentId)
```

Do not introduce a database.

Do not persist live process/RPC objects.

Storage may be in-memory plus simple durable metadata if useful for inspection.

## 7. Parent identity

Use the current host Pi session ID available through Pi's extension/session context.

Child session:

```text
parentId = host Pi session id
```

The extension does not need to duplicate the host as another `AgentSession`.

## 8. Delegate tool

V0 needs one main LLM-facing tool.

Conceptual input:

```ts
{
  agent: "scout" | "reviewer",
  task: string,
  context?: string,
  constraints?: string[],
  expectedOutput?: string
}
```

Do not expose runtime fields such as PID, transport mode, or definition fingerprint.

V0 delegation is blocking.

## 9. Child launch

For each delegation:

1. resolve agent definition;
2. create logical child session;
3. start Pi RPC child in the selected `cwd`;
4. configure model/thinking if specified;
5. configure exact tool allowlist;
6. supply child instructions;
7. send delegated task;
8. listen for terminal completion/failure;
9. capture final assistant text;
10. cleanly close child;
11. update logical session.

Do not copy the host transcript into the child.

## 10. Capability enforcement

V0 Scout and Reviewer are read-only.

Tool permissions must be enforced by child runtime configuration.

Prompt text is not the security boundary.

## 11. Result handling

RPC may emit many events.

Those events can support diagnostics, but they must not be automatically inserted into Main Pi context.

Main Pi receives stable semantics:

```ts
completed -> AgentResult
failed    -> AgentError
cancelled -> cancelled state
```

## 12. Cancellation and cleanup

Every child run is tied to an `AbortSignal`.

```text
host cancellation
      |
      v
AgentManager
      |
      v
AgentRuntime
      |
      v
RPC child termination
      |
      v
session -> cancelled
```

Cleanup must be idempotent.

The same cleanup logic may be reached after:

- completion;
- failure;
- timeout;
- explicit cancellation;
- session shutdown;
- extension reload.

No orphan child process should remain.

## 13. Failure isolation

A child failure does not crash the host session.

```text
Main Pi
├── Scout -> failed
└── Main Pi remains usable
```

Record the child terminal state and return a clear failure result.

## 14. Definition fingerprint

At child-session creation, hash the resolved definition deterministically.

Purpose:

- identify which exact instructions/model/tools produced an old result after definitions change.

This is only diagnostic identity, not a versioning subsystem.

## 15. Extension lifecycle

Follow Pi extension lifecycle rules.

Do not start child processes during module/factory load.

Start a child only when delegation occurs.

Track live runtime handles and clean them during host shutdown/reload.

Do not make correctness depend on TUI-only APIs.

## 16. Suggested modules

Keep implementation small:

```text
src/
├── index.ts
├── agents/
│   ├── registry.ts
│   └── types.ts
├── sessions/
│   ├── store.ts
│   └── types.ts
├── runtime/
│   ├── runtime.ts
│   └── pi-rpc-runtime.ts
└── manager.ts
```

Do not add more layers without observed complexity.

## 17. Implementation order

1. domain types;
2. definition parser/validation;
3. registry;
4. session state transitions/store;
5. fake runtime;
6. manager tests;
7. Pi RPC runtime;
8. delegate tool;
9. cancellation integration;
10. Scout integration test;
11. Reviewer integration test.

## 18. Architecture invariants

1. One running child maps to one logical `AgentSession`.
2. Every child records one parent host session.
3. A resolved agent definition is stable during a run.
4. Tool capabilities are enforced by runtime configuration.
5. The parent's full transcript is not copied into the child.
6. Raw child events are not copied into parent context.
7. Terminal session state is final.
8. Runtime resources are cleaned up on every terminal path.
9. Child failure does not invalidate the host Pi session.
10. V0 requires no scheduler, workflow engine, or agent-team abstraction.
