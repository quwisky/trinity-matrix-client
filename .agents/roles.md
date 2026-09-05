# Planning, implementation and review

The main agent coordinates the task and retains the user's chosen session model.
For substantive work, delegate a bounded assignment to the appropriate role when the
coordinator can make useful progress alongside it. Handle trivial edits and short answers
directly. A planning request authorizes planning; implementation starts only within the
user's accepted scope. Explicit user model choices take precedence over these defaults.

## Roles and skills

| Role          | Assignment                                                                                       | Skills to load when relevant                                                        |
| ------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `planner`     | Investigate requirements and architecture; return a decision frontier and implementation slices. | `grill-me` / `grilling`, `domain-modeling`, `to-tickets`, planning with `wayfinder` |
| `implementer` | Implement an accepted slice, update its documentation and validate the changed behavior.         | Angular, Spartan, Nx, diagnosis, testing and optional `ponytail` guidance           |
| `reviewer`    | Independently review a stable change against its requirements and repository rules.              | `code-review`, optional `ponytail` for complexity findings                          |

Model and reasoning defaults live in the project-local definitions:
[`planner`](../.codex/agents/planner.toml),
[`implementer`](../.codex/agents/implementer.toml) and
[`reviewer`](../.codex/agents/reviewer.toml).
Change those files when changing the defaults. Role definitions are repository-owned
configuration; they are separate from the managed skill catalog.

## Handoffs

- The coordinator supplies the exact worktree, branch/base, task scope, accepted decisions,
  applicable skills, owned files and acceptance criteria. Handoffs use a compact evidence packet:
  conclusions, decision status, evidence references and limitations; retain full logs and artifacts
  at their locations. Reuse accepted decisions and verified investigation until affected evidence
  changes. A model override may require a fresh agent context rather than a full conversation fork.
- Planning returns evidence, unresolved decisions and testable slices to the coordinator.
  The coordinator handles user questions and authorized ticket publication, preserving prior
  approvals. An implementer receives the accepted slice after its dependencies are resolved.
- Assign one writer to a given set of files. Delegate only bounded work that can progress
  independently; dependent planning, implementation and review steps wait for their input. The
  coordinator can inspect dependencies or prepare integration checks while a role works.
- Implementers return changed files, behavior, checks actually run and remaining limitations.
  Freeze the review scope before assigning the reviewer: base and head identifiers, plus
  staged, unstaged and relevant untracked changes for work in progress. Keep that artifact
  stable during review. Findings include concrete evidence and file locations.
- The coordinator evaluates findings, routes in-scope fixes to the implementer and verifies
  the affected behavior. Re-review material changes against the stable artifact and affected
  behavior; track unrelated concerns separately. The coordinator owns authorized commits,
  pushes and issue/PR updates.
- Delegated roles complete their assignment directly and return to the coordinator. Generic
  skill instructions to spawn more reviewers or researchers do not create recursive delegation.

## Runtime support

Use named custom agents when the Codex runtime exposes them. When only explicit model and
reasoning overrides are available, read the matching TOML and pass its settings and instructions
to the delegated agent. If a user requests a different model, use explicit overrides without a
named definition that would take precedence over them.

If delegation or the selected model is unavailable, report the limitation and apply the role's
instructions with the current model. Never claim that reading a skill or entering Plan mode
changed the main agent's model. These instructions do not require every task to run all three roles.

Codex loads [custom agent definitions](https://learn.chatgpt.com/docs/agent-configuration/subagents)
from trusted project configuration. Start a new task in this checkout to load the definitions;
other coding tools can follow this document using their own model-selection mechanism.
The project [`review_model`](../.codex/config.toml) separately selects the model for Codex's
built-in `/review`; it does not control the `code-review` skill.
