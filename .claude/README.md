# `.claude/` — AI tooling for Trinity

This directory configures **Claude Code** for the Trinity workspace. It holds two kinds of thing:

- **Skills** (`skills/` → [`../.agents/skills/`](../.agents/skills)) — capability packs Claude
  loads on demand when a task matches their triggers. They live under `.agents/` so any agent
  can read them; `skills/` here is a symlink so Claude Code still discovers them at the path it
  looks for. Add a skill to `.agents/skills/`, not through the link.
- **Rules** (`rules/` → [`../.agents/rules/`](../.agents/rules)) — always-on conventions
  applied to every change. Same arrangement as the skills above: they live under `.agents/`
  so any agent can read them, and `rules/` here is a symlink so Claude Code still loads them
  from the path it looks for. Edit them in `.agents/rules/`.

The always-loaded instructions live in [`AGENTS.md`](../AGENTS.md) (project) and
[`.claude/CLAUDE.md`](CLAUDE.md) (Angular/TypeScript style guide). This file is a catalog of the
_optional_ tooling around them — nothing here needs manual wiring; Claude selects skills by matching
the task to the descriptions below.

---

## Skills (`.agents/skills/`)

Skills are loaded on demand — Claude reads a skill's `SKILL.md` when a task matches its triggers.
Two kinds live there.

### Local skills

Authored in this repo. Standalone skills sit at the top level; **collections** group several related
skills under one directory (the invocable skill is the nested one, named in parentheses).

| Skill | Covers | Don't use for |
| --- | --- | --- |
| `electron` | Electron desktop apps: architecture, IPC, security, packaging, auto-updates, backend integration. | Tauri apps. |
| `typescript` | The TypeScript language: types, generics, advanced patterns, `tsconfig`, utility types, type guards, branded types. | Plain JS; Node runtime; framework-specific typing. |
| `pnpm` | pnpm package manager + workspaces: commands, `pnpm-workspace.yaml`, workspace protocol, monorepo setup. | npm / yarn / bun. |
| `jsdoc-tsdoc` | JSDoc & TSDoc standards: tags (`@param`, `@returns`), TS integration, TypeDoc / API Extractor, API docs. | JavaScript-only JSDoc. |
| `best-practices/performance` (`performance`) | Web performance: frontend/backend/DB optimisation, Core Web Vitals (LCP/INP/CLS), bundle size, caching, N+1 queries, memory leaks. | Algorithm complexity; readability (use `quality/common`); security. |
| `quality/common` (`quality-common`) | Universal code quality: Clean Code, SOLID, code smells, cyclomatic/cognitive complexity, refactoring, maintainability. | Language-specific linting; security; testing. |
| `state-management/ngrx` (`ngrx`) | NgRx Store / Effects / Entity / ComponentStore with signals integration. | Redux Toolkit, Zustand, Pinia, simple Angular signals state. |
| `styling/tailwindcss` (`tailwindcss`) | Tailwind CSS: utility classes, responsive design, `tailwind.config` customisation. | CSS-in-JS, CSS-Modules-only, traditional SCSS, MUI-style component libs. |
| `ux/design-systems` (`design-systems`) | Design tokens (W3C spec), atomic design, component docs, theming, dark/light mode, CSS custom properties. | Specific component APIs; animation timing; WCAG audits. |
| `ux/interaction-design` (`interaction-design`) | Motion/animation timing, microinteractions, loading & skeleton states, optimistic UI, form UX, touch targets / thumb zones, reduced motion. | CSS animation syntax; perf profiling; WCAG audits. |
| `ux/visual-hierarchy` (`visual-hierarchy`) | Fluid type scales, spatial layout, colour contrast, cognitive-load reduction, scanning patterns (F-pattern), progressive disclosure. | WCAG audits; Tailwind utilities; component-library APIs. |

### Managed skills

Pinned in [`../skills-lock.json`](../skills-lock.json) and pulled from upstream repos — **update them
through the skills tooling, don't hand-edit** the copied files.

| Skill | Upstream | Covers |
| --- | --- | --- |
| `angular-developer` | `angular/skills` | Angular code generation + architecture: signals (`linkedSignal`, `resource`), forms, DI, routing, SSR, ARIA, animations, styling, testing, CLI. |
| `nx-workspace` | `nrwl/nx-ai-agents-config` | Exploring/understanding the Nx workspace — projects, targets, dependencies — and debugging nx task failures. The same nx plugin also provides `nx-generate` for scaffolding. |
| `playwright-best-practices` | `currents-dev/playwright-best-practices-skill` | Writing & fixing Playwright tests: flakiness, Page Object Model, CI, mocking, auth, accessibility, and more (E2E/component/API/visual/security/Electron). |
| `playwright-cli` | `microsoft/playwright-cli` | Automating browser interactions and driving Playwright tests from the CLI. |
| `spartan` | `spartan-ng/spartan` | spartan/ui: Brain (headless) + Helm (styled) layers, the `@spartan-ng/cli` generators, `components.json` projects. |
| `vitest` | `antfu/skills` | Vitest unit testing: mocking, coverage, test filtering, fixtures. |

---

## Rules (`.agents/rules/`)

Always-on conventions — no invocation needed; they apply to every change.

| Rule | What it enforces |
| --- | --- |
| `code-quality.md` | Single-responsibility splits and soft line-count refactor thresholds per file type (component `.ts`, template, service/store). |
| `git/branch-protection.md` | Never commit to `main`/`master`; work on `type/short-description` branches through PRs. |
| `git/conventional-commits.md` | Conventional Commits format `type(scope): description` — lowercase, imperative, breaking changes via `!` or footer. |
| `git/semver.md` | `MAJOR.MINOR.PATCH` bump rules; version numbers change only in dedicated release commits. |
| `docs/changelog.md` | Keep a Changelog: every feature/fix/breaking change gets an `[Unreleased]` entry. |
| `docs/readme-accuracy.md` | Keep the README correct when features, setup steps, or public APIs change. |

> **Commit types.** Enforced by `@commitlint/config-conventional` through the `commit-msg` hook:
> allowed types are `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert` — see
> [`AGENTS.md`](../AGENTS.md) and `git/conventional-commits.md`.
