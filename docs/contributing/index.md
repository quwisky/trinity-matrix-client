# Contributing

This guide takes a contribution from a fresh checkout to review preparation. Trinity is an
Nx integrated monorepo: the web PWA, Android, iOS, and Electron shell share the Angular
application and libraries. The production web build creates root `www/`; native and
desktop hosts consume that output.

## Follow a task from checkout to review

1. [Set up the checkout](getting-started.md): install the pinned package manager and start the web app.
2. [Find the code you need](#find-your-change), then read the relevant architecture boundary.
3. Make one scoped change that follows [Conventions](conventions.md).
4. [Choose validation](testing.md#choose-validation-by-the-change) that can demonstrate the behavior.
5. Use [Commands](commands.md), then prepare the change for review using the branch and commit rules.

## Find your change

| Area                             | Start here                                  | What it owns                                   |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| Application bootstrap and routes | `apps/trinity/`                             | Application composition, routes, global styles |
| Product capability               | `libs/feature/` and `libs/data-access/`     | Screens and Matrix-backed state                |
| Reusable UI                      | `libs/components/`                          | Public, domain-neutral Trinity components      |
| Platform capabilities            | `libs/runtime/` and `libs/platform-native/` | Host contracts and Capacitor implementations   |
| Desktop host                     | `electron/`                                 | The Electron shell and its dependencies        |
| Browser and host journeys        | `e2e/`                                      | Playwright suites and disposable resources     |

Use an import alias or folder to find its project, then inspect it before guessing a target:

```bash
pnpm nx show project data-access-room-library --json
pnpm nx show project trinity --json
```

[Architecture](../architecture/index.md) explains dependency direction and state boundaries.
[The stack](../reference/stack.md) records pinned versions and compatibility constraints.
A directory name is not always an Nx project name: nested libraries use names such as
`data-access-room-library`.

## Use the right guide

| Task                                             | Guide                                                |
| ------------------------------------------------ | ---------------------------------------------------- |
| Install and run the web app                      | [Getting started](getting-started.md)                |
| Look up an exact command or focus a target       | [Commands](commands.md)                              |
| Decide what check proves a change                | [Testing](testing.md)                                |
| Understand shared E2E resources and coverage     | [End-to-end test architecture](e2e-architecture.md)  |
| Follow code, commit, and publication conventions | [Conventions](conventions.md)                        |
| Work on web, desktop, Android, or iOS delivery   | [Platforms](../platforms/index.md)                   |
| Understand CI or release preparation             | [CI and releases](../maintaining/ci-and-releases.md) |
| Work with repository agent roles and rules       | [Working with agents](../agents/index.md)            |
| Find a known local failure                       | [Troubleshooting](../reference/troubleshooting.md)   |

The [documentation map](../documentation-map.md) is the migration ownership inventory.
It is for maintaining the documentation set, not the normal starting point for a contribution.
