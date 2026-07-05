# `.claude/` — AI tooling for Trinity

This directory configures **Claude Code** for the Trinity workspace. It holds three kinds of thing:

- **Agents** (`agents/`) — specialised subagents Claude can delegate a scoped task to.
- **Skills** (`skills/`) — capability packs Claude loads on demand when a task matches their triggers.
- **Rules** (`rules/`) — always-on conventions applied to every change.

The always-loaded instructions live in [`CLAUDE.md`](../CLAUDE.md) (project) and
[`.claude/CLAUDE.md`](CLAUDE.md) (Angular/TypeScript style guide). This file is a catalog of the
_optional_ tooling around them — nothing here needs manual wiring; Claude selects agents and skills
by matching the task to the descriptions below.

---

## Agents (`agents/`)

Delegate a focused, multi-step job to one of these instead of doing it inline. Each runs with its own
model and tool set. Invoke with the `Agent` tool (or let Claude pick one).

| Agent | Model | Use it when |
| --- | --- | --- |
| `angular-architect` | opus | Architecting enterprise Angular 15+ apps — complex state, RxJS optimisation, micro-frontends, large-codebase performance/scalability. |
| `architect-reviewer` | inherit | Evaluating system-design decisions, architectural patterns, and technology choices at the macro level. |
| `code-reviewer` | inherit | Comprehensive code review — code quality, security vulnerabilities, best practices. |
| `debugger` | sonnet | Diagnosing and fixing bugs — root-cause analysis, error logs, stack traces. |
| `dependency-manager` | haiku | Auditing dependencies for vulnerabilities, resolving version conflicts, optimising bundle size, automating updates. |
| `devops-engineer` | opus | Infrastructure automation, CI/CD pipelines, containerisation, deployment workflows. |
| `electron-pro` | opus | Electron desktop apps — native OS integration, cross-platform distribution, security hardening, signed/notarised installers. |
| `frontend-developer` | opus | Building complete frontends across React, Vue, and Angular with full-stack integration. |
| `mobile-app-developer` | opus | iOS/Android apps — native or cross-platform implementation, performance, platform-specific UX. |
| `security-auditor` | inherit | Security audits, compliance assessments, risk evaluation, evidence-based vulnerability analysis. Read-only (`Read`/`Grep`/`Glob`). |
| `ui-designer` | sonnet | Visual interface design, design systems, component libraries, accessibility-minded aesthetics. |

> **Note:** the `frontend-developer` agent is stored in the mis-spelled file `agents/frontend-developar.md`.
> Claude registers agents by their `name:` front-matter, so it is invoked as `frontend-developer`
> regardless of the filename.

---

## Skills (`skills/`)

Skills are loaded on demand — Claude reads a skill's `SKILL.md` when a task matches its triggers.
Two kinds live here.

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

## Rules (`rules/`)

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
> [`CLAUDE.md`](../CLAUDE.md) and `git/conventional-commits.md`.
