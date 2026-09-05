# Choose commands and evidence

Use the [canonical command reference](../contributing/commands.md) for runnable
examples. Run Nx through `pnpm nx`, the repository wrapper, and inspect resolved
project targets before choosing a command. The [Nx overrides](../../.agents/skill-overrides.md#nx-and-validation)
apply to the managed workspace, generation, and task-running skills.

| Need                                                         | Read                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project names, target discovery, or test argument forwarding | [Inspect and focus Nx work](../contributing/commands.md#inspect-and-focus-nx-work)                                                                                                                            |
| Select checks for the actual change                          | [Validation selection](../contributing/testing.md#choose-validation-by-the-change)                                                                                                                            |
| Distinguish tests, type checking, lint, and styles           | [Separate checks](../contributing/testing.md#tests-type-checking-and-style-are-separate)                                                                                                                      |
| Understand a failing source-shape guard                      | [Source-shape guards](../contributing/testing.md#source-shape-guards), then the guard's docstring                                                                                                             |
| Prove layout, touch, or a browser journey                    | [Real browser and E2E checks](../contributing/testing.md#real-browser-and-e2e-checks) and [browser evidence](../contributing/testing.md#browser-assertions-need-browser-evidence)                             |
| Run Synapse-backed checks                                    | [E2E command ownership](../contributing/commands.md#end-to-end-and-protocol-checks); fixed-port stacks run sequentially                                                                                       |
| Validate a host or create ignored UI proof                   | [Platform guides](../platforms/index.md), [conventions](../contributing/conventions.md#styles-and-interaction-hooks), and [failure evidence](../contributing/testing.md#failure-handling-and-review-evidence) |
| Interpret warnings or missing CI evidence                    | [Validation warnings](../maintaining/validation-warnings.md) and [CI and releases](../maintaining/ci-and-releases.md)                                                                                         |

Report each required check's command, revision or working-tree state, environment,
exit status, and log/artifact location in the [handoff](../../.agents/roles.md#handoffs).
A successful transpiled test does not prove type safety, layout, or native execution.
Keep failed and unavailable checks explicit; refresh results when relevant inputs change.
