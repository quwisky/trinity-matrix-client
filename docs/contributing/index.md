# Contributing

This guide takes a contribution from a fresh checkout to review preparation. Trinity is an
Nx integrated monorepo: the web PWA, Android, iOS, and Electron shell share the Angular
application and libraries. The production web build creates root `www/`; native and
desktop hosts consume that output.

## License

Trinity uses the [MIT License](../../LICENSE). Keep the copyright and permission
notice when redistributing copies or substantial portions of the project.
Third-party dependencies and vendored code retain their respective licenses and notices.

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

## Reporting issues and opening pull requests

Use the [issue chooser](https://github.com/quwisky/trinity-matrix-client/issues/new/choose)
and search existing reports first. Add new evidence to a matching report instead of
opening a duplicate. Report suspected security vulnerabilities through the private
contact in the chooser; ordinary encryption, verification and sign-in bugs belong
in the bug form.

Bug reports ask for observed and expected behavior, reproduction steps, affected
platforms, environment and Trinity version. Select only platforms where you saw the
problem and include the starting state, such as an already signed-in Account. Use
"unknown" for missing details; an intermittent bug does not need a reliable reproduction
to be reported. Logs, encryption details, frequency and the last working version are
optional. Redact tokens, recovery keys and private message content before posting.

Feature requests ask for the problem and the desired outcome. A proposed solution,
prior examples and platform scope are optional; roadmap classification belongs to triage.
Both forms add their category (`bug` or `enhancement`) and `needs-triage`. These labels
start evaluation; they do not mark a report ready for implementation.

During triage, distinguish the reporter's observations, checks actually performed and
unresolved questions. Add an implementation brief in a comment when requirements are
ready: desired behavior, acceptance criteria, validation, dependencies and scope
boundaries. Contributors do not need to supply that brief to open a report.

The PR template uses **Change**, **Related issue**, **Validation** and optional **Notes**.
Explain what changes and why, adding design detail only when useful to review. Use
`Closes #123` when the PR resolves an issue, `Refs #123` for partial or related work,
or "None" when there is no issue. Report actual commands or manual checks and their
outcomes, plus tested and untested affected platforms. State failed/skipped checks and
missing prerequisites plainly; do not replace this evidence with a blanket checklist.
Choose checks from [Testing](testing.md), and update relevant docs and the changelog
before review. Put remaining work, limitations and migration/configuration needs in
Notes; explicitly flag migrations, secrets handling, infrastructure configuration and
public API changes. Remove Notes when empty.

## Use the right guide

| Task                                               | Guide                                                |
| -------------------------------------------------- | ---------------------------------------------------- |
| Install and run the web app                        | [Getting started](getting-started.md)                |
| Look up an exact command or focus a target         | [Commands](commands.md)                              |
| Decide what check proves a change                  | [Testing](testing.md)                                |
| Understand shared E2E resources and coverage       | [End-to-end test architecture](e2e-architecture.md)  |
| Follow code, commit, and publication conventions   | [Conventions](conventions.md)                        |
| Work on web, desktop, Android, or iOS delivery     | [Platforms](../platforms/index.md)                   |
| Understand CI or release preparation               | [CI and releases](../maintaining/ci-and-releases.md) |
| Give an agent a task or maintain its skill catalog | [Working with agents](../agents/index.md)            |
| Find a known local failure                         | [Troubleshooting](../reference/troubleshooting.md)   |

The [documentation map](../documentation-map.md) records current topic ownership and the rewrite dispositions.
It is for maintaining the documentation set, not the normal starting point for a contribution.
