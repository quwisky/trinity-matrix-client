# Trinity agent guidance

Trinity is an end-to-end encrypted Matrix client for Web/PWA, iOS, Android and
Electron, built with Angular, signals, Spartan, Tailwind, Capacitor and Nx.
`CLAUDE.md` points here. Check `package.json` and the [stack reference](docs/reference/stack.md)
when version compatibility matters.

## Working agreement

- Continue authorized work and reuse accepted plans and current evidence. Ask only
  for unresolved decisions or material scope changes; refresh evidence when its inputs change.
- Before editing or publishing, read [branch and publication policy](docs/contributing/conventions.md#branches-and-publication).
  Use `develop` as the default base; temporary integration bases require task instructions.
  Isolate unrelated work in a separate worktree. Stage only task-owned files;
  commits, pushes and PRs require authorization, and merging belongs to the user.
- Select checks from [validation policy](docs/contributing/testing.md#choose-validation-by-the-change).
  Report commands, exit status and unavailable checks. Unit tests do not prove type
  safety or browser layout; run those checks separately. Read failing source-shape
  guards before changing them. Run Synapse-backed E2E sequentially because ports are shared.
- Keep prototypes, screenshots, GIF proof and pixel baselines in ignored output,
  never in commits, including throwaway branches. Attach proof to authorized PRs;
  tracked application assets belong in their platform/app asset directories.

## Skills and delegation

Use installed Superpowers process skills and repository domain skills according to
[Trinity overrides](.agents/skill-overrides.md). Enter at the current task stage;
invoking a skill does not restart accepted decisions. Use the [catalog](.agents/README.md)
for selection or maintenance. Local skills live in `.agents/skills`, shared through
`.claude/skills`. Keep CLI-managed imports unchanged.

Load the matching skill and relevant references once; reuse them until changed.
Without a Skill tool, read its `SKILL.md`. The active tool schema determines available
capabilities and parameters; examples below do not establish tool availability.

Follow [role routing and compact handoffs](.agents/roles.md) for planning,
implementation and review. Delegate bounded work only when useful work can proceed
alongside it; keep one writer per file set. The coordinator owns user decisions,
integration and publication. Handle small, unambiguous edits directly.

## Load references by task

Read the relevant sections before acting; expand through their links as needed.
Repository paths in reference prose are relative to the root.

| Task                                           | Required references                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source changes, styling or platform predicates | [Angular/TypeScript](.claude/CLAUDE.md), [code quality](.agents/rules/code-quality.md), [conventions](docs/agents/conventions.md)                   |
| Ownership, state, SDK, dependencies or routing | [Capability map and runtime constraints](docs/agents/architecture.md), then the relevant [architecture document](docs/architecture/index.md)        |
| Commands, tests, builds or E2E                 | [Commands and validation](docs/agents/commands.md); [platform guides](docs/platforms/index.md) for host checks                                      |
| UI, themes or appearance                       | [UI and theming](docs/architecture/ui-and-theming.md)                                                                                               |
| Matrix, authentication or encryption           | [Matrix and encryption](docs/architecture/matrix-and-encryption.md)                                                                                 |
| Push notifications                             | [Push reference](docs/reference/push-notifications.md)                                                                                              |
| Issues, labels or domain docs                  | [Issue tracker](docs/agents/issue-tracker.md), [triage labels](docs/agents/triage-labels.md), [domain layout](docs/agents/domain.md), as applicable |
| Changelog, versions or releases                | [Changelog and releases](docs/contributing/conventions.md#changelog-and-releases)                                                                   |
| Setup or unfamiliar failures                   | [Contributing](docs/contributing/index.md), [troubleshooting](docs/reference/troubleshooting.md)                                                    |

## Runtime constraints

- Use **pnpm** and repository Nx targets. `apps/trinity` builds to root `www/`,
  shared by Capacitor and Electron. Cross-library imports use `@trinity/*`;
  within-library imports stay relative. `@trinity/core` no longer exists.
- Respect Nx `type:*`, `scope:*` and `ui:*` boundaries. Features never import other
  features. Product UI uses `@trinity/components/*`; vendors and `@trinity/helm/*`
  stay behind that tier. Components never import `matrix-js-sdk`.
- SDK access belongs in data-access services. The SDK owns Matrix state; services
  project it into read-only signals. Components are `OnPush`. One-shot actions
  return cold finite RxJS Observables with lifecycle-cleaned subscriptions.
  Preserve Account/Conversation ownership and lifetimes.
- Separate component logic, templates, styles and tests. Preserve `trn` selectors,
  `data-testid` hooks, design tokens and generated Spartan ownership.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
