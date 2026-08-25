---
id: conventional-commits
name: Conventional Commits
description: All commits must follow the Conventional Commits specification
category: git
recommended: true
---

# Conventional Commits

All commits follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

Format: `type(scope): description`

**Types** — enforced by `@commitlint/config-conventional` via the `commit-msg` hook:
- `feat` — new feature → triggers MINOR version bump
- `fix` — bug fix → triggers PATCH version bump
- `docs` — documentation only
- `style` — formatting / whitespace, no behaviour change
- `refactor` — restructuring without behaviour change
- `perf` — performance improvements
- `test` — adding or updating tests
- `build` — build system, tooling, or dependency changes
- `ci` — CI/CD configuration changes
- `chore` — maintenance that touches neither `src` nor tests (deps, tooling, housekeeping)
- `revert` — reverts a previous commit

**Rules:**
- Description must be lowercase, imperative mood ("add feature" not "added feature")
- Scope is optional but recommended for larger projects
- Breaking changes: append `!` after type/scope (e.g. `feat!: remove endpoint`) or add `BREAKING CHANGE:` footer
- Never use generic messages like "fix", "update", "changes", or "WIP" as the entire commit message
