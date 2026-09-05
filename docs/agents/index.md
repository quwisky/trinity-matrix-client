# Working with agents

This guide helps a person direct coding-agent work in Trinity. The repository instructions are
the authority for an agent's task; this page helps choose the right workflow and locate its
supporting configuration.

## Start with the outcome

| Outcome                                                                                                   | Use                                                         | Read next                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Clarify a problem, design a change or prepare implementation slices                                       | The planner role                                            | [Role routing](../../.agents/roles.md), then the relevant planning skill in the [catalog](../../.agents/README.md)              |
| Implement an accepted, bounded change                                                                     | The implementer role                                        | [Role routing](../../.agents/roles.md), [repository instructions](../../AGENTS.md) and the task-specific references they select |
| Review a stable change independently                                                                      | The reviewer role                                           | [Role routing](../../.agents/roles.md) and the `code-review` entry in the [catalog](../../.agents/README.md)                    |
| Select, update or maintain repository skills                                                              | The [skills and rules catalog](../../.agents/README.md)     | The catalog's project-scoped skills workflow and lockfile guidance                                                              |
| Apply Trinity's rules to a planning, review, research, prototype, product-design, Ponytail or Nx workflow | [Trinity skill overrides](../../.agents/skill-overrides.md) | The section that matches the work being done                                                                                    |

## Roles and configuration

The named roles divide responsibility: the planner investigates and returns decisions and
slices; the implementer changes an accepted slice and validates it; the reviewer examines a
stable artifact independently. [Role routing and compact handoffs](../../.agents/roles.md)
defines the boundaries and the evidence each handoff carries.

The current Codex definitions are repository configuration, separate from the skill catalog:

| Role                        | Configuration                                                            |
| --------------------------- | ------------------------------------------------------------------------ |
| Planner                     | [`.codex/agents/planner.toml`](../../.codex/agents/planner.toml)         |
| Implementer                 | [`.codex/agents/implementer.toml`](../../.codex/agents/implementer.toml) |
| Reviewer                    | [`.codex/agents/reviewer.toml`](../../.codex/agents/reviewer.toml)       |
| Built-in Codex review model | [`.codex/config.toml`](../../.codex/config.toml)                         |

Codex loads named definitions from trusted project configuration when a task starts in this
checkout. A user-selected model takes precedence over a role default; when named delegation is
not available, the coordinator follows the role instructions with the available model. The
separate `review_model` controls Codex's built-in `/review`, not the `code-review` skill.

## Give delegated work enough context

For a substantive handoff, state the worktree and branch/base, bounded scope, accepted
decisions, applicable skills, owned files and acceptance criteria. Return a compact evidence
packet: conclusions, decision status, evidence references and limitations. Keep full logs and
artifacts at their existing locations, and refresh evidence only when relevant inputs change.

The coordinator retains user decisions, integration and authorized publication. The detailed
[handoff rules](../../.agents/roles.md#handoffs) also define the additional review scope and
validation evidence needed before an independent review.
