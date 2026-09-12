---
title: Choose the change owner
description: Locate the capability, application, UI, host, test, or tooling project that owns a contribution.
audience: developer
contentChannel: develop
canonicalTopic: contributing-change-owner
pageType: how-to
platforms: [web, desktop, android, ios]
---

Place a change where its behavior is owned, even when the first visible symptom appears elsewhere.

## Start from the responsibility {#responsibility}

| Change                                              | Start with                              |
| --------------------------------------------------- | --------------------------------------- |
| Matrix read model or command                        | Owning `libs/data-access/` capability   |
| Product page or workflow                            | Owning `libs/feature/` library          |
| Startup, recovery, or cross-capability coordination | `libs/application/` owner               |
| Semantic destination or history                     | Workspace                               |
| Reusable domain-neutral control                     | `libs/components/`                      |
| Projection, preference, or host primitive           | `libs/runtime/`                         |
| Browser, Capacitor, or Electron implementation      | `libs/platform-native/` or host project |
| Repository invariant                                | `scripts/` or the owning tool project   |

## Confirm the live project {#confirm-project}

```bash
pnpm nx show project <project-name> --json
pnpm nx graph --print
```

Inspect tags, targets, dependencies, source root, public entrypoint, and adjacent tests. A directory name is not always the Nx project name.

## Avoid ownership shortcuts {#avoid-shortcuts}

Do not import another feature, move SDK access into a component, duplicate Workspace navigation, or branch directly on the host. If a dependency is rejected, revisit the owner or introduce a narrow public contract at the correct layer.

Read [capability ownership](../../architecture/capability-ownership/) and [dependency boundaries](../../architecture/dependency-boundaries/) before changing project edges.
