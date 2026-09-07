# AGENTS.md

Shared guidance for coding agents working on Trinity. `CLAUDE.md` points here.
Trinity is an end-to-end encrypted Matrix client for Web/PWA, iOS, Android and Electron,
using Angular, signals, Spartan, Tailwind, Capacitor and Nx. Read pinned versions from
`package.json` and [stack notes](docs/reference/stack.md) when version compatibility matters.

## Working agreement

- Preserve accepted decisions and authorization across turns. Continue authorized work;
  ask only for an unresolved decision or material scope change.
- Before editing or publishing, read [Branches and publication](docs/contributing/conventions.md#branches-and-publication).
  Use `develop` by default; a temporary integration branch needs an explicit task instruction.
  Isolate unrelated work in a separate worktree. Commits, pushes and PRs follow user authorization;
  stage only task-owned files and leave merging to the user.
- Before selecting checks, read [Choose validation by the change](docs/contributing/testing.md#choose-validation-by-the-change).
  Report actual results and unavailable checks. Efficiency never reduces required coverage.
- Never commit design prototypes, screenshots, GIF proof or pixel baselines, including on
  throwaway branches. Store proof in ignored output and attach it to an authorized PR.
  Application assets remain tracked in their platform/app asset directories.

## Skills and task context

Use repository-local skills in `.agents/skills`; `.claude/skills` shares that directory.
Load the matching skill and its relevant supporting references once, then reuse them until
changed. Read [the catalog](.agents/README.md) for selection or maintenance, and
[Trinity overrides](.agents/skill-overrides.md) with planning, review, research, prototype,
product-design, Ponytail or Nx skills. Keep CLI-managed files unchanged.
For agent-instruction edits, use `writing-for-agents`. If a Skill tool is unavailable,
read the named `SKILL.md` and use the available tools.

For planning, implementation and review, follow [role routing and compact handoffs](.agents/roles.md).
Delegate bounded work to the configured role when useful work can proceed alongside it;
the coordinator owns user decisions, integration and publication. Reuse accepted plans and
current evidence; investigate again when changed inputs or unresolved questions require it.

Read these references when the task reaches the indicated area; load the relevant sections
and expand through their links as needed. Repository paths in their prose are relative to the root.

| Task                                                             | Required reference                                                                                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source changes                                                   | [Angular/TypeScript style](.claude/CLAUDE.md), [code quality](.agents/rules/code-quality.md), [conventions and styling/platform pitfalls](docs/agents/conventions.md) |
| Capability ownership, state, SDK access, dependencies or routing | [Capability map and runtime constraints](docs/agents/architecture.md), then the relevant [architecture document](docs/architecture/index.md)                          |
| Commands, tests, builds, E2E or platform validation              | [Command and validation reference](docs/agents/commands.md); [platform guides](docs/platforms/index.md) for host details                                              |
| UI, themes or appearance                                         | [UI and theming](docs/architecture/ui-and-theming.md)                                                                                                                 |
| Matrix, authentication or encryption                             | [Matrix and encryption](docs/architecture/matrix-and-encryption.md)                                                                                                   |
| Push notifications                                               | [Push reference](docs/reference/push-notifications.md)                                                                                                                |
| Issues, labels or domain documentation                           | [Issue tracker](docs/agents/issue-tracker.md), [triage labels](docs/agents/triage-labels.md), or [domain layout](docs/agents/domain.md), as applicable                |
| Changelog, versions or releases                                  | [Changelog and releases](docs/contributing/conventions.md#changelog-and-releases)                                                                                     |
| Setup or an unfamiliar failure                                   | [Contributing](docs/contributing/index.md), [troubleshooting](docs/reference/troubleshooting.md)                                                                      |

## Codex orchestration

For complex multi-file work or explicit delegation requests, use the
[astra-orchestrator skill](.agents/skills/astra-orchestrator/SKILL.md) together with
[Trinity role routing](.agents/roles.md). The root owns architecture, integration,
verification and authorized publication; assign bounded work with one writer per
file set. Handle trivial edits directly. User instructions take precedence.

## Constraints to keep in view

- Use **pnpm** and repository Nx targets. The web app is `apps/trinity`; its build emits
  root `www/`, shared by Capacitor and Electron. Cross-library imports use `@trinity/*`;
  imports within a library stay relative. `@trinity/core` no longer exists.
- Respect Nx `type:*`, `scope:*` and `ui:*` boundaries. Components never import `matrix-js-sdk`;
  SDK access belongs in data-access services. Features never import other features.
  Product UI consumes `@trinity/components/*`; vendors and `@trinity/helm/*` stay behind that tier.
- The SDK owns Matrix state. Data-access services project it into read-only signals;
  components are `OnPush`. One-shot actions return cold finite RxJS Observables and
  subscriptions use lifecycle cleanup. Preserve Account/Conversation ownership and lifetimes.
- Keep component logic, templates, styles and tests in their own files. Preserve `trn`
  selectors, `data-testid` hooks, design tokens and generated Spartan ownership.
  Read the source-change references before selecting styling or platform predicates.
- Unit tests do not typecheck or prove browser layout. Run required typechecks and browser
  checks separately; inspect exit codes. Read failing source-shape guards before changing them.
  Synapse-backed E2E harnesses share fixed ports and must run sequentially.

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

<!-- graft:start -->

## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
