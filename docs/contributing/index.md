# Contributing

Trinity is one Angular codebase that ships to four places: the web PWA, iOS,
Android, and a hand-rolled Electron desktop shell. There is no per-platform fork.
The web build emits to a root `www/` directory, and Capacitor and Electron wrap
that same directory unchanged, so almost every change you make lands everywhere at
once.

The workspace is an Nx **integrated** monorepo. Libraries are not separate npm
packages linked by pnpm; they are folders resolved through `@trinity/*` TypeScript
path aliases in `tsconfig.base.json`, with `@nx/enforce-module-boundaries` deciding
which library may import which.

## Where things live

| Path           | What it is                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/trinity` | The deployable Angular app. Thin: routing, bootstrap, global styles.                                       |
| `libs/*`       | Every reusable layer, one folder per library, imported as `@trinity/<name>`.                               |
| `libs/spartan` | Generated spartan-ng Helm components, aliased `@trinity/helm/*`, owned by `@spartan-ng/cli`.               |
| `electron/`    | The desktop shell. Its own `package.json`, own lockfile, own TypeScript version, installed separately.     |
| `e2e/`         | Playwright specs, standalone protocol harnesses, and the disposable Synapse Docker stack they run against. |
| `scripts/`     | Node build scripts plus the invariant specs that guard configuration a green test run cannot see.          |
| `android/`     | The checked-in Capacitor Android project.                                                                  |
| `ios/`         | The checked-in Capacitor iOS project, using Swift Package Manager.                                         |
| `www/`         | Generated. The web build output that the native and desktop wrappers consume. Not tracked in git.          |

## The shape of the work

Branch off `develop`. It is the repository's default base, and it is what
`nx affected` diffs against, so a branch cut from anywhere else produces a
misleading affected set.

Commits go through two Husky hooks: `pre-commit` runs lint-staged over the staged
files, and `commit-msg` runs commitlint against the Conventional Commits
specification. A module-boundary violation fails the commit rather than the
pull request.

Opening a pull request runs five parallel CI jobs: quality, unit tests, the
production build, the desktop shell, and the Playwright journeys. Each one mirrors
commands you can run locally, so nothing in CI is a black box.

## Where to go next

| If you want to                                | Read                                               |
| --------------------------------------------- | -------------------------------------------------- |
| Get the repo running for the first time       | [Getting started](getting-started.md)              |
| Look up a command                             | [Commands](commands.md)                            |
| Understand what proves a change correct       | [Testing](testing.md)                              |
| Know the code style and commit rules          | [Conventions](conventions.md)                      |
| Understand the CI jobs and how a release cuts | [CI and releases](ci-and-releases.md)              |
| Understand how the code is organised          | [Architecture](../architecture/index.md)           |
| Check a pinned version or a known gotcha      | [The stack](../reference/stack.md)                 |
| Fix something that is broken on your machine  | [Troubleshooting](../reference/troubleshooting.md) |
