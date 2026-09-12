---
title: Commands
description: Canonical commands for inspecting, building, testing, and running Trinity projects.
audience: developer
contentChannel: develop
canonicalTopic: reference-commands
pageType: reference
platforms: [web, desktop, android, ios]
---

Run Nx through pnpm so the workspace wrapper and pinned CLI are used.

## Workspace {#workspace-commands}

| Command                   | Purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `pnpm start`              | Serve the web application                       |
| `pnpm build`              | Build the production renderer to `www/`         |
| `pnpm test`               | Run all Nx test targets                         |
| `pnpm lint`               | Run all Nx lint targets                         |
| `pnpm stylelint`          | Check CSS and SCSS                              |
| `pnpm format:check`       | Check formatting                                |
| `pnpm architecture:check` | Check architecture, host, UI, and E2E contracts |
| `pnpm storybook`          | Serve the public-component Storybook            |

## Inspect and focus {#inspect-focus}

```bash
pnpm nx show project <project-name> --json
pnpm nx show projects
pnpm nx test <project-name> -- <file-or-pattern>
pnpm nx run-many -t typecheck
pnpm nx affected -t lint test
```

Inspect targets before forwarding runner-specific arguments.

## Hosts and journeys {#host-journeys}

| Command                | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `pnpm electron:start`  | Build and launch Electron                              |
| `pnpm electron:verify` | Check the Electron host contract                       |
| `pnpm android:run`     | Build, sync, and launch Android                        |
| `pnpm ios:run`         | Build, sync, and launch iOS                            |
| `pnpm e2e:browser`     | Run canonical browser journeys with disposable Synapse |
| `pnpm e2e:components`  | Run component browser suites                           |
| `pnpm e2e:all`         | Run every available registered E2E suite               |

Synapse-backed commands share fixed ports and run sequentially. See the relevant [testing strategy](../../testing/testing-strategy/) or platform guide before interpreting a result.
