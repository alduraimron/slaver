# V0 Scope

## Goal

Prove that Pi can support useful, isolated, specialized child agents without building a general multi-agent framework.

The complete V0 user-visible capability is:

```text
Main Pi
   |
   +-- delegate to Scout or Reviewer
          |
          +-- isolated child Pi process
                  |
                  +-- concise final result
                          |
                          +-- Main Pi continues
```

## Included

V0 includes:

- standalone Pi extension package;
- `AgentDefinition`;
- `AgentSession`;
- agent definition registry;
- one-level parent -> child delegation;
- separate child Pi process;
- RPC control of the child process;
- blocking delegation;
- `scout` agent;
- `reviewer` agent;
- per-agent model override;
- per-agent tool allowlist;
- session lifecycle;
- explicit cancellation;
- concise result returned to parent;
- session inspection;
- basic session metadata persistence if needed for inspection/debugging;
- tests around contracts and lifecycle.

## Explicitly excluded

V0 does not include:

- background execution;
- parallel execution;
- recursive child delegation;
- child-to-child communication;
- agent teams;
- planner;
- implementer;
- worktree isolation;
- merging/cherry-picking;
- steering a running child;
- automatic retries;
- task queues;
- concurrency scheduler;
- workflow graph/DAG;
- remote execution;
- custom UI or Agent Hub;
- token/cost dashboards;
- semantic memory;
- vector storage;
- long-term task resume.

Do not implement excluded features behind unused abstractions.

## Required agents

### Scout

Purpose:

> Investigate a bounded repository question and return evidence-rich, compressed findings.

Scout is read-only.

Typical tasks:

- locate an implementation;
- trace a code path;
- find related tests;
- identify conventions;
- identify likely impact areas.

### Reviewer

Purpose:

> Independently assess an existing change against the requested behavior and repository evidence.

Reviewer is read-only.

Typical tasks:

- review a diff;
- identify correctness problems;
- identify missing tests;
- identify regressions;
- distinguish defects from preferences.

## V0 interaction contract

The main agent should be able to call a tool equivalent to:

```text
delegate(agent, task)
```

The exact schema may include optional bounded context, but the minimal request is:

- agent name;
- task.

The call blocks until the child reaches a terminal state.

The result returned to the main model must clearly distinguish:

- completed;
- failed;
- cancelled.

Do not represent failure as ordinary prose that the main model must guess from.

## Acceptance criteria

V0 is complete when all of the following are true.

### Definition

- Scout and Reviewer definitions are discovered and validated.
- Unknown agent names are rejected clearly.
- Invalid definitions fail early with actionable errors.
- The runtime receives the resolved model and exact allowed tool set.

### Session

- Delegation creates a unique `AgentSession`.
- The session records the host/parent relation.
- State transitions are validated.
- Start and end timestamps are correct.
- A terminal session cannot transition back to running.
- Result and error semantics are mutually coherent.

### Isolation

- Child execution uses a separate Pi process.
- Child context is not the parent's full transcript.
- Scout cannot receive edit/write tools.
- Reviewer cannot receive edit/write tools.

### Runtime

- A child can complete successfully and return final text.
- A child failure is surfaced without killing the host session.
- Cancellation terminates the child and marks the session cancelled.
- Cleanup is idempotent.
- No child process remains after terminal cleanup.

### Parent behavior

- The main agent receives a concise result.
- Raw RPC/event traffic is not injected into model context.
- Main Pi can continue after completed, failed, or cancelled child execution.

### Tests

At minimum:

- definition validation tests;
- state transition tests;
- parent relationship tests;
- manager tests using a fake runtime;
- cancellation test;
- one successful real RPC integration test;
- one failing/cancelled real RPC integration test.

## Non-goal

V0 is not trying to reproduce the full multi-agent feature set of other coding agents.

It is establishing the correct primitive:

> a specialized child session with isolated context, explicit capability, controlled lifecycle, and a useful result.
