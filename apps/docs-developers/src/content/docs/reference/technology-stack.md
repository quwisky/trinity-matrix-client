---
title: Technology stack
description: Current runtime, framework, host, and test versions used on Trinity's develop branch.
audience: developer
contentChannel: develop
canonicalTopic: reference-technology-stack
pageType: reference
platforms: [web, desktop, android, ios]
---

These versions are checked against the root and Electron manifests. The site footer identifies the exact build commit whose source was used.

## Required toolchain {#required-toolchain}

| Tool       | Version    |
| ---------- | ---------- |
| Node.js    | `^24.15.0` |
| pnpm       | `11.19.0`  |
| Nx         | `23.2.1`   |
| TypeScript | `6.0.3`    |

## Application runtime {#application-runtime}

| Package         | Version   |
| --------------- | --------- |
| Angular         | `22.1.5`  |
| `matrix-js-sdk` | `^42.1.0` |
| RxJS            | `~7.8.2`  |
| Capacitor Core  | `8.5.0`   |
| Electron        | `43.2.0`  |

Angular framework packages and the builder can intentionally use different patch releases. Treat installed peer requirements and repository checks as the compatibility contract.

## Documentation and tests {#documentation-tests}

| Package    | Version   |
| ---------- | --------- |
| Astro      | `7.3.2`   |
| Starlight  | `0.42.0`  |
| Vitest     | `4.1.11`  |
| Playwright | `^1.62.1` |

The Electron shell has a separate manifest and lockfile. Use its declared versions and run its own type and host checks after dependency changes.
