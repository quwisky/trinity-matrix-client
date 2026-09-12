---
title: Import aliases
description: Use Trinity public entrypoints across libraries and relative imports within an owning library.
audience: developer
contentChannel: develop
canonicalTopic: reference-import-aliases
pageType: reference
platforms: [web, desktop, android, ios]
---

`tsconfig.base.json` is the source of truth for aliases. Every classified library has one explicit public entrypoint; wildcarded Trinity product entrypoints are rejected.

## Public alias families {#alias-families}

| Prefix                      | Layer                                     |
| --------------------------- | ----------------------------------------- |
| `@trinity/application/*`    | Cross-capability application ownership    |
| `@trinity/data-access/*`    | Capability state and Matrix adapters      |
| `@trinity/feature/*`        | Lazy product features                     |
| `@trinity/components/*`     | Public Trinity UI                         |
| `@trinity/runtime/*`        | Projection, preference, and host kernels  |
| `@trinity/util/*`           | Shared utilities and Matrix modeling      |
| `@trinity/platform-native`  | Browser, Capacitor, and Electron adapters |
| `@trinity/theme-foundation` | Theme tokens and global foundations       |
| `@trinity/testing`          | Shared Angular test helpers               |

`@trinity/helm/*` aliases belong to the generated UI implementation tier and are not feature APIs.

Representative exact entrypoints include `@trinity/application/runtime`, `@trinity/data-access/timeline`, `@trinity/feature/rooms`, `@trinity/components/controls`, `@trinity/runtime/host`, `@trinity/util/matrix`, `@trinity/platform-native`, `@trinity/theme-foundation`, and `@trinity/testing`.

## Apply the boundary {#apply-alias}

Across libraries, import only from the exact alias exported for that library:

```ts
import { ConversationRuntime } from '@trinity/data-access/timeline';
```

Inside the same library, use a relative import. Do not deep-import another library's `src/lib` files. When an API is missing, decide whether it should become supported at the owner's `src/index.ts` rather than bypassing the boundary.
