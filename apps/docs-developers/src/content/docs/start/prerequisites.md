---
title: Prerequisites
description: Install the tools required for Trinity web development and identify optional host prerequisites.
audience: developer
contentChannel: develop
canonicalTopic: start-prerequisites
pageType: how-to
platforms: [web, desktop, android, ios]
---

Start with the web workspace. Desktop, Android, iOS, and Matrix end-to-end work add tools only when a change reaches those environments.

## Required for every checkout {#required-tools}

Trinity currently requires Node.js `^24.15.0`. Corepack selects the repository's pinned pnpm `11.19.0`; the install guard rejects npm and Yarn so they cannot create a competing lockfile.

Check the active tools:

```bash
node --version
corepack enable
pnpm --version
git --version
```

You also need Git and a modern browser. Treat the versions in the root `package.json` as authoritative when this page and a local checkout disagree.

## Add tools for the work you are doing {#optional-tools}

| Work                           | Additional prerequisite                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| Browser automation             | Playwright browser binaries                                               |
| Synapse-backed Matrix journeys | Docker available to the current user                                      |
| Electron                       | The separate `electron/` dependency tree and host packaging prerequisites |
| Android                        | Android Studio, Android SDK, Java, and an emulator or device              |
| iOS                            | macOS, Xcode, CocoaPods, and a simulator or device                        |

A missing native SDK, signing identity, emulator, browser, or Docker daemon makes that check unavailable. Record the gap instead of treating an unrun host check as passed.

## Continue {#continue}

Next, [clone and install Trinity](../clone-and-install/).
