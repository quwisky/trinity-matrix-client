---
name: astra-orchestrator
description: Orchestrate complex Codex coding work with the root agent as planner/integrator, Luna subagents for exploration, implementation, testing, and research, and an Astra reviewer. Use for multi-file features, debugging across components, repo-wide changes, parallelizable workstreams, or whenever the user asks to delegate or use subagents. Do not use for trivial one-file edits or simple questions.
---

# Astra Orchestrator

The user's explicit instructions take precedence over this skill.

## Goal

Use the root agent as the high-quality orchestrator. Delegate bounded execution work to specialized subagents, then have the root integrate and verify the result.

The expected default topology is:

- root: GPT-6 Astra
- explorer: GPT-5.6 Luna
- worker: GPT-5.6 Luna
- tester: GPT-5.6 Luna
- reviewer: GPT-6 Astra
- researcher: GPT-5.6 Luna

Do not override a Luna subagent to a more expensive model unless the user explicitly asks for that escalation.

## Decide whether to delegate

Delegate when at least one is true:

- the task has two or more independent workstreams
- repository exploration can happen independently from implementation
- implementation and verification benefit from separate context
- multiple modules or services need inspection
- external/version-specific facts need verification
- an independent post-change review is valuable

Do not delegate merely to create activity. Keep simple tasks in the root thread.

## Root-agent responsibilities

The root agent owns:

1. understanding the user's actual goal
2. choosing the architecture and implementation direction
3. decomposing the task
4. deciding which tasks can run in parallel
5. giving each subagent a bounded contract
6. resolving conflicting subagent findings
7. integrating changes
8. reviewing the final diff
9. running or coordinating final verification
10. presenting the final result to the user

Subagents provide evidence and bounded execution. They do not own the overall direction.

## Delegation contract

Every delegated task should include:

- Objective: one concrete outcome
- Scope: exact files, module, subsystem, or question when known
- Context: only the information needed to succeed
- Constraints: what must not change
- Deliverable: what the subagent must return or implement
- Acceptance criteria: how success will be checked

Prefer narrow tasks that can finish independently.

Bad:
"Fix the backend."

Good:
"Trace where POST /invoices validates currency. Return the responsible files, validation path, and existing tests. Do not edit files."

## Role selection

Use `explorer` for:
- repository mapping
- tracing execution/data flow
- locating symbols and tests
- dependency/config inspection

Use `worker` for:
- bounded implementation
- small refactors with explicit scope
- targeted fixes
- adding requested code

Use `tester` for:
- reproduction
- targeted test execution
- validation
- adding tests only when explicitly asked

Use `reviewer` for:
- independent post-change review
- correctness/security/regression checks
- missing-test analysis

Use `researcher` for:
- current API/framework behavior
- dependency/version questions
- primary documentation verification

## Parallelism

Run independent tasks in parallel.

Good parallel set:
- explorer maps backend path
- researcher verifies external API behavior
- explorer maps frontend path

Serialize dependent work:
1. explore
2. decide architecture
3. implement
4. test
5. review
6. fix material findings
7. final verification

Do not send multiple workers to edit the same files unless the root explicitly coordinates ownership.

## Cost and context discipline

Use Luna for subagent execution by default.

Keep the root context focused on:
- architectural decisions
- summarized evidence
- important diffs
- test results
- unresolved risks

Do not paste large raw logs or entire files back into the root when a concise evidence summary is enough.

## Escalation behavior

A subagent should report back instead of expanding scope when it encounters:
- an architectural decision
- a breaking API/schema change
- a new dependency
- a security-sensitive design choice
- unclear requirements with materially different outcomes
- unexpected changes outside its assigned scope

The root decides what to do next.

## Final verification

Before claiming completion, the root should:

1. inspect the final diff
2. confirm the requested behavior is actually implemented
3. check material reviewer findings
4. run or confirm the highest-value tests
5. state any validation that could not be performed

The final answer should summarize the outcome, not narrate every subagent action.
