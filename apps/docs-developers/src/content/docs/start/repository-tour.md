---
title: Repository tour
description: Locate Trinity application, capability, UI, host, test, and tooling projects.
audience: developer
contentChannel: develop
canonicalTopic: start-repository-tour
pageType: explanation
platforms: [web, desktop, android, ios]
---

Trinity is an Nx integrated monorepo. A directory is useful orientation, but the resolved Nx project and its tags establish ownership and permitted dependencies.

## Main areas {#main-areas}

| Path                            | Responsibility                                                          |
| ------------------------------- | ----------------------------------------------------------------------- |
| `apps/trinity/`                 | Angular composition root, routes, assets, and global styles             |
| `libs/application/`             | Cross-capability orchestration such as startup and workspace navigation |
| `libs/data-access/`             | Capability state, Matrix adapters, and commands                         |
| `libs/feature/`                 | Product pages and feature composition                                   |
| `libs/components/`              | Public, domain-neutral Trinity UI                                       |
| `libs/spartan/`                 | Generated or vendor-facing UI implementation layer                      |
| `libs/runtime/`                 | Reusable state, preference, and host kernels                            |
| `libs/platform-native/`         | Browser, Capacitor, and Electron host adapters                          |
| `electron/`, `android/`, `ios/` | Platform hosts and packaging projects                                   |
| `e2e/`                          | Browser, protocol, desktop, and native journeys                         |
| `scripts/`, `tools/`            | Repository automation and documentation tooling                         |

## Inspect before editing {#inspect-project}

Use the project graph to replace assumptions with the current workspace definition:

```bash
pnpm nx show project data-access-room-library --json
pnpm nx show project feature-rooms --json
pnpm nx graph --print
```

Read a library through its `src/index.ts` public entrypoint. Imports between libraries use `@trinity/*`; imports inside one library remain relative.

## Follow ownership, not proximity {#follow-ownership}

A screen can present state without owning it. Matrix-backed state belongs in the relevant data-access capability, navigation belongs to Workspace, cross-capability startup belongs to Application Runtime, and reusable presentation belongs to the component tier. The [capability ownership](../../architecture/capability-ownership/) and [dependency boundaries](../../architecture/dependency-boundaries/) guides turn those distinctions into placement rules.

Continue with [Make your first change](../make-your-first-change/).
