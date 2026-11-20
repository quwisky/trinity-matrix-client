---
title: Dependency boundaries
description: Follow Trinity's Nx roles, public entrypoints, UI tiers, and Matrix SDK boundary.
audience: developer
contentChannel: develop
canonicalTopic: architecture-dependency-boundaries
pageType: reference
platforms: [web, desktop, android, ios]
---

Nx tags enforce the direction recorded in `architecture/contract.json`. The current roles are `app`, `application`, `capability`, `kernel`, `adapter`, and `design-system`.

## Allowed role direction {#role-direction}

| Consumer role   | May depend on                                                |
| --------------- | ------------------------------------------------------------ |
| `app`           | application, capability, kernel, adapter, design-system, app |
| `application`   | application, capability, kernel, adapter, design-system      |
| `capability`    | capability, kernel, adapter, design-system                   |
| `adapter`       | adapter, kernel                                              |
| `design-system` | design-system, kernel, adapter                               |
| `kernel`        | kernel only                                                  |

The graph is intentionally asymmetric. A reusable kernel cannot reach into product capabilities, and a capability cannot depend on application orchestration.

## Import through public APIs {#public-apis}

Cross-library imports use the `@trinity/*` aliases declared in `tsconfig.base.json`. A library's `src/index.ts` is its public API. Import internal files relatively only from within the same library.

Features never import other feature libraries. Shared behavior moves to the owning data-access capability, an application-level orchestrator, or a genuinely domain-neutral component or utility. `matrix-js-sdk` stays behind data-access services; components and feature pages do not import it.

Product UI imports `@trinity/components/*`. The Spartan and vendor layers sit behind that public component tier. Generated Spartan source remains generator-owned and is not a shortcut around the component boundary.

## Keep side-effect-free barrels `export *`-only {#side-effect-free-barrels}

Some libraries carry a nameless `package.json` with `"sideEffects": false`, or with a list of the files whose top-level code must run on import (`libs/util/matrix` lists `message-html.ts`, which installs its DOMPurify hooks). Their `src/index.ts` contains only `export * from './lib/…'` and `export type * from './lib/…'` lines. Angular emits each component definition as a `static {}` block, which esbuild cannot drop as unused. esbuild leaves a barrel's unused files out of the startup bundle only when the library declares no side effects and the barrel uses no named re-export. One `export { A } from './lib/a'` line puts every file that barrel names back into the startup bundle. The build still passes, and only the bundle grows. Converting eight of these barrels in one change took about 234 kB out of the JavaScript the app loads at startup.

When a file's public surface is only types, publish it with `export type *`; its functions stay private. When a file mixes public and private values, move the private ones into a file the barrel does not list. Keep a new file in such a library free of top-level side effects, such as a bare `import '…'` or a call at the top level. `scripts/side-effect-free-barrels.spec.mjs` catches bare imports and top-level expression statements only; a call in a variable initializer (`export const x = register()`) is not caught, so keep initializers pure. When a file must run code on import, replace `false` with an array that lists both the file and the barrel, as `libs/util/matrix/package.json` does: `["./src/index.ts", "./src/lib/message-html.ts"]`. Listing only the file has no effect. esbuild treats the unlisted barrel as side-effect-free, skips it without following its `export *` lines, and drops the file's top-level code whenever the app imports nothing from that file. Listing the barrel has a cost: with code splitting, every file of the library that any lazy chunk uses moves into a shared chunk that loads at startup (about 24 kB for `libs/util/matrix`). So prefer code that runs on first use over a load-time side effect.

`scripts/side-effect-free-barrels.spec.mjs` checks the barrel lines, that a `sideEffects` array lists the barrel and only files that exist, and that every file with a bare import or a top-level expression statement is listed.

## Check a proposed edge {#check-edge}

Inspect the exact projects and graph before adding an import:

```bash
pnpm nx show project feature-rooms --json
pnpm nx show project data-access-timeline --json
pnpm nx graph --print
pnpm architecture:check
```

The architecture check validates more than TypeScript resolution: it checks the repository contract, design-system edges, host boundaries, and registered E2E suites. A compiling deep import or untagged edge is not therefore an accepted dependency.

Use [capability ownership](../capability-ownership/) to find the correct destination when an edge is rejected.
