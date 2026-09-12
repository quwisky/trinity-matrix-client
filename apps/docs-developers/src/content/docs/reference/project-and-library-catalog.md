---
title: Project and library catalog
description: Find Trinity Nx projects by responsibility, naming family, and live workspace metadata.
audience: developer
contentChannel: develop
canonicalTopic: reference-project-catalog
pageType: reference
platforms: [web, desktop, android, ios]
---

The live Nx graph is the canonical catalog. Project names often include their layer and capability and do not always match the final directory segment.

## Discover exact projects {#discover-projects}

```bash
pnpm nx show projects
pnpm nx show project trinity --json
pnpm nx graph --print
```

The documentation source validator reads every `project.json`, compares it with Nx discovery, and sorts names, roots, tags, and targets for deterministic checking.

## Project families {#project-families}

| Family              | Examples                                                                                                                     | Responsibility                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Applications        | `trinity`, `trinity-desktop`, `trinity-android`, `trinity-ios`                                                               | Composition and platform delivery |
| Application         | `application-runtime`, `application-workspace`, `application-appearance`                                                     | Cross-capability coordination     |
| Data access         | `data-access-accounts`, `data-access-matrix-client`, `data-access-room-library`, `data-access-timeline`, `data-access-trust` | Capability state and commands     |
| Features            | `feature-auth`, `feature-crypto`, `feature-rooms`, `feature-settings`, `feature-shell`                                       | Product workflows and pages       |
| Components          | `components-controls`, `components-foundations`, `components-navigation-layout`, `components-overlay`                        | Public reusable UI                |
| Runtime and utility | `runtime-host`, `runtime-preferences`, `runtime-projection`, `util-matrix`, `util-ui`                                        | Shared kernels and adapters       |
| E2E                 | `trinity-e2e-browser`, `trinity-e2e-components`, `trinity-e2e-protocol`, host suites                                         | User, protocol, and host journeys |
| Documentation       | `docs-users`, `docs-developers`, `docs-site`                                                                                 | Public sites and their validation |

Use project tags to determine role, capability, type, and scope. Read [dependency boundaries](../../architecture/dependency-boundaries/) before adding an edge.
