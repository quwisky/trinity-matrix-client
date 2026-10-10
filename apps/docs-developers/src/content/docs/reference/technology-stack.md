---
title: Technology stack
description: Current runtime, framework, host, and test versions used on Trinity's main branch.
audience: developer
contentChannel: develop
canonicalTopic: reference-technology-stack
pageType: reference
platforms: [web, desktop, android, ios]
---

The docs build reads each version from the root `package.json` or `electron/package.json`, so a cell shows the declared version or range, not the installed one. The site footer identifies the exact build commit whose source was used.

## Required toolchain {#required-toolchain}

| Tool       | Version                  |
| ---------- | ------------------------ |
| Node.js    | `version:engines.node`   |
| pnpm       | `version:packageManager` |
| Nx         | `version:nx`             |
| TypeScript | `version:typescript`     |

## Application runtime {#application-runtime}

| Package         | Version                     |
| --------------- | --------------------------- |
| Angular         | `version:@angular/core`     |
| `matrix-js-sdk` | `version:matrix-js-sdk`     |
| RxJS            | `version:rxjs`              |
| Capacitor Core  | `version:@capacitor/core`   |
| Electron        | `version:electron/electron` |

Angular framework packages and the builder can intentionally use different patch releases. Treat installed peer requirements and repository checks as the compatibility contract.

## Documentation and tests {#documentation-tests}

| Package    | Version                      |
| ---------- | ---------------------------- |
| Astro      | `version:astro`              |
| Starlight  | `version:@astrojs/starlight` |
| Vitest     | `version:vitest`             |
| Playwright | `version:@playwright/test`   |

The Electron shell has a separate manifest and lockfile. Use its declared versions and run its own type and host checks after dependency changes.
