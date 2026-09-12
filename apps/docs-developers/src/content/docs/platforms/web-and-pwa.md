---
title: Web and PWA
description: Build, serve, and validate Trinity's browser and installable PWA delivery.
audience: developer
contentChannel: develop
canonicalTopic: platform-web-pwa
pageType: how-to
platforms: [web]
---

The web host runs the shared Angular renderer directly. Its production build is also the renderer copied into every packaged host.

## Develop in a browser {#develop-browser}

```bash
pnpm start
```

Open the printed address, normally `http://localhost:4200`. Development serving does not enable the production service worker and does not prove the built PWA fallback.

## Build the delivery artifact {#build-web}

```bash
pnpm build
pnpm nx run trinity-e2e-web:production-pwa
```

The `trinity` production target writes a flat bundle to root `www/`; `index.html` sits directly in that directory. The production-PWA journey checks the built host, navigation fallback, assets, and service worker without Docker.

## Keep browser boundaries explicit {#browser-boundaries}

Use Web Host adapters for browser implementations and expected unavailable operations. Origin storage is script-readable and must not be described as an OS-secure credential store. Browser responsive emulation proves web behavior only; it does not exercise Capacitor plugins, installed WebViews, or native lifecycle.

Run focused unit and browser journeys for product behavior, then add build, typecheck, lint, stylelint, and architecture checks as the change requires. Read [component and browser tests](../../testing/component-and-browser-tests/) for evidence selection.
