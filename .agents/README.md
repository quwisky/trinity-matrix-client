# `.agents/` — shared agent tooling for Trinity

Capability packs and conventions for any coding agent working in this repository. It holds two
kinds of thing:

- **Skills** ([`skills/`](skills)) — capability packs an agent loads on demand when a task
  matches their triggers.
- **Rules** ([`rules/`](rules)) — always-on conventions applied to every change.

`.claude/skills` and `.claude/rules` are **symlinks to these directories**, so Claude Code
finds them at the path it looks for. Edit the files here; the links have no content of their
own.

The always-loaded instructions live in [`AGENTS.md`](../AGENTS.md) (project) and
[`.claude/CLAUDE.md`](../.claude/CLAUDE.md) (Angular/TypeScript style guide). This file is a
catalog of the _optional_ tooling around them — nothing here needs manual wiring; an agent
selects a skill by matching the task to the descriptions below.

---

## Skills (`skills/`)

[Role routing](roles.md) connects these skills to planning, implementation and review.
Project-local Codex agent definitions live in [`.codex/agents/`](../.codex/agents).
They configure models for delegated work; skills remain CLI-managed and model-independent.
The root [`AGENTS.md`](../AGENTS.md) routes detailed command, capability and convention
guidance to task-specific references so each task loads only the context it needs.

Skills are loaded on demand — an agent reads a skill's `SKILL.md` when a task matches its
triggers. The repository keeps 26 skills focused on building and maintaining the Trinity client:
22 CLI-managed imports and four local references. Repository rules and accepted scope apply to each.

### Local skills

Authored in this repo. Standalone skills sit at the top level; **collections** group several related
skills under one directory (the invocable skill is the nested one, named in parentheses).

| Skill                                          | Covers                                                                                                                                      | Don't use for                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `electron`                                     | Electron desktop apps: architecture, IPC, security, packaging, auto-updates, backend integration.                                           | Tauri apps.                                              |
| `ux/design-systems` (`design-systems`)         | Design tokens (W3C spec), atomic design, component docs, theming, dark/light mode, CSS custom properties.                                   | Specific component APIs; animation timing; WCAG audits.  |
| `ux/interaction-design` (`interaction-design`) | Motion/animation timing, microinteractions, loading & skeleton states, optimistic UI, form UX, touch targets / thumb zones, reduced motion. | CSS animation syntax; perf profiling; WCAG audits.       |
| `ux/visual-hierarchy` (`visual-hierarchy`)     | Fluid type scales, spatial layout, colour contrast, cognitive-load reduction, scanning patterns (F-pattern), progressive disclosure.        | WCAG audits; Tailwind utilities; component-library APIs. |

### Workflow skills

The planning, review and Nx workflows are CLI-managed imports alongside the managed skills
below. Their upstream source, skill path and content hash are recorded in
[`../skills-lock.json`](../skills-lock.json). Keep their installed files unchanged; read
[`skill-overrides.md`](skill-overrides.md) when using these workflows for Trinity-specific
behavior. These repository-owned overrides survive upstream updates.

| Skill                                                                    | Upstream                   | Use when                                                         |
| ------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------- |
| [`grill-me`](skills/grill-me/SKILL.md)                                   | `mattpocock/skills`        | Requesting a design interview; entrypoint to `grilling`.         |
| [`grilling`](skills/grilling/SKILL.md)                                   | `mattpocock/skills`        | Resolving dependent product decisions with the user.             |
| [`domain-modeling`](skills/domain-modeling/SKILL.md)                     | `mattpocock/skills`        | Sharpening vocabulary or recording a significant ADR.            |
| [`wayfinder`](skills/wayfinder/SKILL.md)                                 | `mattpocock/skills`        | Charting or advancing a large issue map.                         |
| [`to-tickets`](skills/to-tickets/SKILL.md)                               | `mattpocock/skills`        | Publishing approved implementation slices with dependencies.     |
| [`prototype`](skills/prototype/SKILL.md)                                 | `mattpocock/skills`        | Exploring a UI or state model through a throwaway artifact.      |
| [`research`](skills/research/SKILL.md)                                   | `mattpocock/skills`        | Gathering primary-source facts.                                  |
| [`diagnosing-bugs`](skills/diagnosing-bugs/SKILL.md)                     | `mattpocock/skills`        | Building a reproducible feedback loop for a difficult bug.       |
| [`code-review`](skills/code-review/SKILL.md)                             | `mattpocock/skills`        | Reviewing standards and originating requirements.                |
| [`ponytail`](skills/ponytail/SKILL.md)                                   | `DietrichGebert/ponytail`  | Simplifying implementation and reviewing unnecessary complexity. |
| [`resolving-merge-conflicts`](skills/resolving-merge-conflicts/SKILL.md) | `mattpocock/skills`        | Resolving an authorized merge or rebase.                         |
| [`nx-generate`](skills/nx-generate/SKILL.md)                             | `nrwl/nx-ai-agents-config` | Discovering and running generators before scaffolding.           |
| [`nx-run-tasks`](skills/nx-run-tasks/SKILL.md)                           | `nrwl/nx-ai-agents-config` | Running resolved Nx targets.                                     |
| [`writing-for-agents`](skills/writing-for-agents/SKILL.md)               | `mattpocock/skills`        | Editing agent instructions and skill references.                 |

Use the [skills CLI](https://github.com/vercel-labs/skills) with pnpm, in project scope:

```bash
pnpm dlx skills list --json
pnpm dlx skills update wayfinder to-tickets --project --yes
pnpm dlx skills add mattpocock/skills --skill wayfinder to-tickets --agent codex --yes
pnpm dlx skills add DietrichGebert/ponytail --skill ponytail --agent codex --yes
```

Update only the requested skill names, inspect their diff and lockfile, and check referenced
skills and supporting files. The existing `.claude/skills` link shares the canonical
`.agents/skills` directory; no global installation or second copy is needed.

**Selection:** retain skills that support Trinity product work. Branding, marketing-page workflows,
fixed visual-style presets and generic reference sheets belong outside this repository's skill set.
Use the UX references for design principles, `redesign-existing-projects` for targeted audits,
and `imagegen-frontend-mobile` for mobile mockups. Desktop product mockups use the available
general image-generation capability with Trinity references.

For design work, read [the product-design overrides](skill-overrides.md#product-design).
Preserve Trinity's tokens, public components, interaction models and behavior. Angular, Spartan,
Nx and repository documentation cover implementation; diagnosis and testing skills cover measurement.
No external design service, paid API or plugin is required merely because a skill mentions it.

### Managed skills

Pinned in [`../skills-lock.json`](../skills-lock.json) and pulled from upstream repos — **update them
through the skills tooling, don't hand-edit** the copied files.

| Skill                        | Upstream                                       | Covers                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `angular-developer`          | `angular/angular`                              | Angular code generation + architecture: signals (`linkedSignal`, `resource`), forms, DI, routing, SSR, ARIA, animations, styling, testing, CLI.                                                       |
| `imagegen-frontend-mobile`   | `leonxlnx/taste-skill`                         | Premium mobile-app screen and flow image generation without code generation.                                                                                                                          |
| `nx-workspace`               | `nrwl/nx-ai-agents-config`                     | Exploring/understanding the Nx workspace — projects, targets, dependencies — and debugging nx task failures. Use the repository-local `nx-generate` for scaffolding and `nx-run-tasks` for execution. |
| `playwright-best-practices`  | `currents-dev/playwright-best-practices-skill` | Writing & fixing Playwright tests: flakiness, Page Object Model, CI, mocking, auth, accessibility, and more (E2E/component/API/visual/security/Electron).                                             |
| `playwright-cli`             | `microsoft/playwright-cli`                     | Automating browser interactions and driving Playwright tests from the CLI.                                                                                                                            |
| `redesign-existing-projects` | `leonxlnx/taste-skill`                         | Audit-first visual upgrades for existing websites and apps without breaking behavior.                                                                                                                 |
| `spartan`                    | `spartan-ng/spartan`                           | spartan/ui: Brain (headless) + Helm (styled) layers, the `@spartan-ng/cli` generators, `components.json` projects.                                                                                    |
| `vitest`                     | `antfu/skills`                                 | Vitest unit testing: mocking, coverage, test filtering, fixtures.                                                                                                                                     |

---

## Rules (`rules/`)

Always-on conventions — no invocation needed; they apply to every change.

| Rule                          | What it enforces                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `code-quality.md`             | Single-responsibility splits and soft line-count refactor thresholds per file type (component `.ts`, template, service/store). |
| `git/branch-protection.md`    | Points to the shared branch policy: `develop` by default, task-specific integration branches and authorized publication.       |
| `git/conventional-commits.md` | Conventional Commits format `type(scope): description` — lowercase, imperative, breaking changes via `!` or footer.            |
| `git/semver.md`               | `MAJOR.MINOR.PATCH` bump rules; version numbers change only in dedicated release commits.                                      |
| `docs/changelog.md`           | Keep a Changelog: every feature/fix/breaking change gets an `[Unreleased]` entry.                                              |
| `docs/readme-accuracy.md`     | Keep the README correct when features, setup steps, or public APIs change.                                                     |

> **Commit types.** Enforced by `@commitlint/config-conventional` through the `commit-msg` hook:
> allowed types are `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert` — see
> [`AGENTS.md`](../AGENTS.md) and `git/conventional-commits.md`.
