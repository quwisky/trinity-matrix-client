# Conventions

These conventions keep one Angular codebase maintainable across web, mobile, and desktop.
Read them before changing code; use [Testing](testing.md) to select proof and
[Commands](commands.md) for runnable commands.

## Keep code with its owner

- Put Matrix SDK interaction in the owning `@trinity/data-access/*` library. Components
  never import `matrix-js-sdk` directly.
- Keep dependencies pointing inward. Features may depend on data access, UI, platform, and
  utilities; one feature does not import another feature.
- Use `@trinity/*` aliases across libraries and relative imports inside a library.
- Keep application composition in `apps/trinity/`; use [Architecture](../architecture/index.md)
  before adding a cross-layer edge.

## Components, templates, and forms

A component normally has its own directory with `.component.ts`, `.html`, `.scss`,
and `.spec.ts` files. Use the `trn` selector prefix; element selectors are kebab-case,
directive selectors camelCase, and component classes end in `Page` or `Component`.

Components are OnPush and read read-only signals. Model one-shot actions as cold
Observables and end component subscriptions with `takeUntilDestroyed`. Prefer Angular's
current control flow in templates. Use Signal Forms for new forms; do not introduce legacy
reactive-form APIs.

`libs/spartan/` is generated Helm code. Add or regenerate it through the designated
generator instead of hand-authoring it. Public domain-neutral UI belongs in
`libs/components/`; product presentation stays with its feature.

## Styles and interaction hooks

Use Trinity design tokens instead of literal colors. Global rendered Markdown belongs in
`apps/trinity/src/rendered-markdown.scss`; do not use `::ng-deep`. Read
[UI and theming](../architecture/ui-and-theming.md) before changing theme behavior,
breakpoints, or a vendor wrapper.

Keep `data-testid` attributes on interactive elements. Browser and native journeys use
them as their stable user-facing contract. Do not commit screenshots, GIFs, design
prototypes, or pixel baselines: generate review evidence in ignored test output and attach
it to the pull request when needed.

## Deprecated APIs are an error

Treat a deprecation warning as a change request, not background noise. Use the current
Angular, TypeScript, and Matrix SDK APIs and replace deprecated calls with their supported
alternatives. Do not suppress the rule or introduce a documentation-only exception. The
type-aware lint rules enforce this across library boundaries.

## Writing specs

Keep a component's unit spec alongside the component. Test an interaction or visible state
instead of a private implementation detail, use the shared testing setup where it is needed,
and keep browser-only claims in a real-browser journey. [Testing](testing.md) explains the
selection and limits.

## Tests and source-shape contracts

Write a behavior test at the layer that can observe the behavior. When changing a guarded
source pattern, read the guard's docstring before editing it. The `scripts/*.spec.mjs`
tests protect repository contracts such as module boundaries, styling inventories,
configuration keys, and media policy; moving covered source may require updating its named
inventory. [Testing](testing.md) describes where a unit test cannot prove layout or host behavior.

## Commits

Use Conventional Commits in the form `type(scope): imperative subject`. The subject is
lowercase and imperative. Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`,
`perf`, `test`, `build`, `ci`, `chore`, and `revert`. A breaking change uses `!` after the
type or scope, or a `BREAKING CHANGE:` footer. Do not use a bare `fix`, `update`, or `WIP`
as the whole subject.

The `pre-commit` hook runs lint-staged and `commit-msg` runs commitlint. Stage only task-owned
files. Commit types classify a change; they neither set a version nor publish a release.

## Branches and publication

Use `develop` as the normal branch base and pull-request target. A temporary integration branch,
including `refactor/refine-architecture`, applies only when the task explicitly requires it; it is
not the default for an architectural area. Name a work branch `type/short-description`, including
an issue number when one exists.

Inspect the branch, worktree, and local-change state before editing. Use a separate worktree for
unrelated active work, work on a task branch rather than a shared branch, and rebase on the agreed
target before an authorized pull request. Do not rewrite pushed history without explicit
authorization.

Authorization for a task remains valid for its necessary, reviewable steps; do not ask again for
the same authorized action. It does not authorize a new external action. When an action is not
authorized, leave changes uncommitted and report them. For an authorized commit or pull request,
run the selected checks, state unavailable validation accurately, and leave merging to the user.

## Changelog and releases

Every feature, bug fix, or breaking change needs an entry under `## [Unreleased]` in
`CHANGELOG.md`, using `Added`, `Fixed`, `Changed`, `Removed`, or `Security` to describe user
impact. Ordinary work commits do not change versions.

An authorized release uses a dedicated release commit: update `package.json` and
electron/package.json to the same version, rename the Unreleased section with the version and
date, then start a new Unreleased section. The tag must match both manifests. Tagging and
publishing require their own authorization. Choose PATCH for compatible fixes, MINOR for a new
compatible capability, and MAJOR for a breaking config or API change. See
[CI and releases](../maintaining/ci-and-releases.md#releases) for the executable release process.

## Formatting and unavailable checks

Run `pnpm format:check` before review, or `pnpm format` to apply formatting. Then run
the validation selected in [Testing](testing.md). When a required host is unavailable,
record the missing prerequisite and the checks that did run. A static host contract is not
proof that a native app launched, and a browser run is not proof of an Electron or mobile host.
