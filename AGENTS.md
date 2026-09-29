# Project Instructions

This repository implements a small standalone Pi extension that adds isolated subagents.

Read these documents before changing architecture:

- `docs/V0_SCOPE.md`
- `docs/AGENT_MODEL.md`
- `docs/ARCHITECTURE.md`

The documents above are normative for V0. If implementation pressure suggests expanding scope, preserve V0 instead of adding speculative infrastructure.

## Product intent

Build the smallest subagent system that is genuinely reliable.

The extension must allow a main Pi session to delegate a bounded task to an isolated child Pi process and receive a concise result.

V0 has only two agent roles:

- `scout`
- `reviewer`

Both are read-only with respect to project source files.

## Engineering priorities

Use this order when trade-offs appear:

1. correctness of session and lifecycle semantics;
2. child isolation;
3. capability enforcement;
4. cancellation and cleanup;
5. result clarity;
6. implementation simplicity;
7. future extensibility.

Do not trade away correctness or isolation merely to reduce implementation effort.

At the same time, do not introduce abstractions for hypothetical future features.

## Source of truth

When sources conflict, use this priority:

1. behavior and APIs of the installed Pi version;
2. current official Pi documentation;
3. this repository's design documents;
4. implementation assumptions.

Do not copy old Pi extension APIs from examples without checking the installed/current API.

## Core design rules

### Keep domain state separate from runtime handles

Persisted or inspectable session data must not contain live process objects, RPC clients, abort controllers, callbacks, sockets, or other ephemeral runtime objects.

Use separate runtime-owned handles for live child processes.

### Keep definitions separate from sessions

An `AgentDefinition` describes reusable agent behavior and capability.

An `AgentSession` records one execution of one resolved definition for one delegated task.

Do not mix task state into an agent definition.

### Parent-child relation has one source of truth

Store `parentId` on the child session.

Do not also persist a mutable `children` array that can drift out of sync.

Derive children through the session store.

### Do not copy the parent transcript into the child

Delegation is explicit and bounded.

The child receives:

- its resolved agent instructions;
- the delegated task;
- relevant project instructions/resources naturally available to Pi;
- repository access permitted by its tools.

The parent should not serialize and forward its entire chat history.

### Enforce capabilities through tools

Prompt instructions such as "do not edit files" are useful but insufficient.

A read-only agent must not receive write/edit capabilities.

### Keep child output small

The parent receives the child's final result, not the complete event stream or transcript.

Raw events may be retained for diagnostics, but they are not automatically inserted into parent model context.

### Main agent owns the user task

A child session completing successfully does not imply the user's task is complete.

Subagents provide evidence and independent work. The main agent decides how to use it.

## Runtime rules

V0 uses a separate Pi child process controlled through RPC.

Use Pi's supported RPC client/API for the installed version rather than hand-rolling a JSONL protocol unless the official client cannot satisfy the requirement.

Required runtime behavior:

- child has its own Pi context/session;
- child uses the delegated working directory;
- child uses the resolved model/tool configuration;
- cancellation propagates to the child;
- child process is cleaned up on success, failure, cancellation, reload, and host shutdown;
- stdout/protocol data is not mixed with arbitrary logging;
- a child failure is represented as a child failure, not a crash of the host Pi session.

Do not start child processes at extension module load time.

## Error handling

Prefer explicit typed/domain errors over broad catch-and-ignore behavior.

Never silently convert a failed child into a successful empty result.

Cancellation is not an internal error. It is a terminal session state.

A timeout is a failure reason unless the product later defines a distinct timeout state.

## Testing expectations

Unit tests should not spawn real Pi children unless the behavior specifically requires integration coverage.

Use a fake runtime for:

- session lifecycle tests;
- manager behavior;
- registry behavior;
- cancellation state handling.

Have a small number of real integration tests for:

- main extension -> RPC child -> final result;
- child cancellation/cleanup;
- tool restriction propagation.

## Scope discipline

Do not add the following to V0:

- parallel delegation;
- background agent jobs;
- steering;
- recursive delegation;
- agent teams;
- peer-to-peer messaging;
- worktree management;
- automatic retries;
- planner or implementer agents;
- workflow DSL;
- DAG scheduler;
- remote workers;
- memory/vector database;
- custom TUI/agent hub.

The data model may avoid blocking obvious future evolution, but it must not implement those features now.

## Coding style

Prefer:

- small modules with one responsibility;
- explicit types at subsystem boundaries;
- validation when loading user-authored agent definitions;
- deterministic state transitions;
- dependency injection for runtime testing;
- comments that explain non-obvious invariants, not obvious syntax.

Avoid:

- generic framework abstractions;
- service/repository layers with no real purpose;
- global mutable runtime state;
- duplicated state;
- hidden retries;
- implicit lifecycle transitions.

## Completion standard

Do not call V0 complete until the acceptance criteria in `docs/V0_SCOPE.md` are satisfied by tests and one real Pi integration flow.
