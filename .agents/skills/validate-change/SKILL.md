---
name: validate-change
description: Select and run the Trinity checks a change needs (affected typecheck/lint/test, repository contracts, format, architecture, stylelint, docs site) and list the browser journeys to run. Use before committing, pushing or claiming a change is done.
---

# Validate a change

Selects checks from the changed files, following
[Validate a change](../../../apps/docs-developers/src/content/docs/contributing/validate-a-change.md).
Changed files are `git diff --name-only origin/main...HEAD` plus staged, unstaged and
untracked files.

1. Print the plan:

   ```bash
   node .agents/skills/validate-change/validate-change.mjs
   ```

2. Run it (sequential; every check runs even after a failure; exits non-zero if any failed):

   ```bash
   node .agents/skills/validate-change/validate-change.mjs --run
   ```

   Pass `--base <ref>` for another comparison base, such as a `release/X.Y.x` branch.

3. Run each listed browser journey yourself, one at a time: they share the disposable
   homeserver's fixed ports. Source the machine's E2E environment first if it has one.

4. Act on the printed notes (dependency map regeneration, docs heading anchors).

## What it selects

| Changed files                                 | Check                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Anything beyond docs-site Markdown            | `pnpm nx affected -t typecheck lint test --exclude=scripts` and `pnpm nx test scripts` |
| Always                                        | `pnpm format:check`                                                                    |
| `apps/`, `libs/`, `e2e/`, `electron/`, config | `pnpm architecture:check`                                                              |
| `*.scss`, `*.css`, stylelint config           | `pnpm stylelint`                                                                       |
| `apps/docs-*`, `tools/docs/`                  | `pnpm nx run docs-site:check` (headings need explicit `{#id}`)                         |
| `package.json`, lockfile, `project.json`      | Reminder: `pnpm architecture:map`                                                      |
| Source or journey paths naming a capability   | `pnpm nx run trinity-e2e-browser:e2e -- <capability>/`                                 |

The scripts suite holds the cross-cutting source-shape contracts (design system, styling,
docs, CI, agent catalog), so it runs for every non-docs change. The capability mapping is a
path-keyword heuristic; add journeys it misses when the change touches their behavior.

Unit tests do not prove type safety, layout or host behavior. Report each command with
its exit status, and name checks you could not run (for example, no Docker for E2E).
