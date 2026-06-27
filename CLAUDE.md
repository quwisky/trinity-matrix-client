<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

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

## Agent delegation rules

### Plan (before building) — read-only
- Before building a new frontend feature or restructuring existing UI,
  delegate to frontend-architect to produce a plan first; present it for
  approval before writing code.

### Test (after implementing)
- After implementing or changing any frontend component, delegate to
  vitest-tester to add or update unit coverage.
- For end-to-end coverage of user flows, delegate to playwright-tester.

### Review (after implementing) — read-only, can run in parallel
- After changing code that handles authentication, user input, rendered
  user content, tokens/secrets, or external requests, delegate to
  frontend-security-auditor to audit the diff.
- For UI/UX, visual, or accessibility review, delegate to ui-ux-designer.

### Scope
- Do not invoke frontend-architect, ui-ux-designer, or
  frontend-security-auditor for routine bug fixes or trivial changes.
- Scope the security auditor to risk-relevant diffs, not every commit.
