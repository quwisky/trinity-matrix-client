# Working with agents

Use this guide to give an agent a bounded Trinity task, choose the work role,
and hand verified work to the next person. The repository instructions in
[`AGENTS.md`](../../AGENTS.md) provide the shared repository rules, subject to the active task instructions.

## Start a task

State the outcome, the files or capability in scope, and any decisions already
made. For a code or documentation change, name the agreed branch or base,
required validation, and what external action is authorized. The coordinator
keeps those decisions, integrates work, and handles authorized publication.

Begin with one of these plain-language requests:

| Need                        | Example request                                                                                                               | Role        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Explore an uncertain change | “Investigate this problem, identify the decisions still needed, and propose bounded implementation slices with evidence.”     | Planner     |
| Change an accepted slice    | “Implement this accepted slice in these files, preserve the decisions below, and report the checks actually run.”             | Implementer |
| Check a finished artifact   | “Independently review this stable base-to-head artifact against the acceptance criteria and report evidence-backed findings.” | Reviewer    |

For a small, clear edit, work directly. Delegate only when the assignment can
progress independently while the coordinator does useful work. Keep one writer
for each set of files.

## Choose the role

| Role        | Use it when                                                           | Deliverable                                                                   |
| ----------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Planner     | Requirements, architecture, scope, or validation are still uncertain. | Evidence, open decisions, dependencies, and testable slices.                  |
| Implementer | A slice is accepted and its files and behavior are bounded.           | The change, actual validation, and remaining limits.                          |
| Reviewer    | The artifact is frozen and needs an independent check.                | Findings with file locations and evidence, or an explicit no-findings result. |

The detailed boundaries and the [canonical handoff template](../../.agents/roles.md#handoffs)
are in [role routing](../../.agents/roles.md). Reuse an accepted plan and its
evidence until a relevant input changes. A new skill or a new agent does not
restart already accepted decisions or authorization.

Before independent review, freeze the comparison base and head plus staged,
unstaged, and relevant untracked files. Route material findings back to the
implementer, validate the affected behavior again, then obtain focused follow-up
review. The coordinator alone publishes tickets, commits, branches, or pull
requests when authorized.

## Select a skill or reference

Skills are task-specific help; they do not replace the repository rules. The
[catalog](../../.agents/README.md) lists available skills, while
[overrides](../../.agents/skill-overrides.md) adapt planning, review, research,
prototype, product-design, and Nx workflows to Trinity. The installed Superpowers
plugin supplies process skills; follow the [task-state mapping](../../.agents/skill-overrides.md#superpowers-integration)
and [dispatch mapping](../../.agents/roles.md#superpowers-dispatch) without restarting accepted stages.

| Task                                                      | Start here                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Scope a problem or split it into work                     | Planner role; `grill-me` / `grilling`, `domain-modeling`, `wayfinder`, or `to-tickets` when their triggers fit |
| Implement Angular, UI, platform, or Matrix behavior       | Implementer role; [`AGENTS.md`](../../AGENTS.md)'s task-reference table and the matching local skill           |
| Inspect a stable change                                   | Reviewer role and [review guidance](../../.agents/roles.md#work-in-sequence)                                   |
| Find a project, target, or dependency in the workspace    | [`nx-workspace`](../../.agents/skills/nx-workspace/SKILL.md), then [commands](commands.md)                     |
| Maintain the skill catalog, managed imports, or overrides | [`.agents/README.md`](../../.agents/README.md) and its managed-skills guidance                                 |

Working with agents and maintaining their catalog are separate tasks. The
repository-owned role definitions and overrides are ordinary reviewed
configuration; CLI-managed skill imports and their lockfile retain their
tooling ownership.

## Models and runtime choices

The [role definitions](../../.agents/roles.md#use-the-configured-defaults-deliberately)
configure Astra for orchestration, planning and review, and Luna for execution.
The project also includes explorer, worker, tester and researcher roles.
Start a new Codex session in a trusted checkout to load project settings.
User model choices take precedence.
See role routing for defaults, maintenance and runtime limitations.

## Keep evidence fresh

Use the compact handoff for any substantive work. It points to evidence rather
than copying logs, states the revision it applies to, and makes the next action
clear. Refresh evidence when changed code, configuration, dependencies,
environment, a failed check, or an unresolved question could invalidate it.
Otherwise, let the next owner rely on the accepted plan and recorded result.
