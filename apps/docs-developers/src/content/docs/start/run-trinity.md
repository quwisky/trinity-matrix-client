---
title: Run Trinity
description: Start the Angular development server and understand what a successful launch proves.
audience: developer
contentChannel: develop
canonicalTopic: start-run-trinity
pageType: tutorial
platforms: [web]
---

Run the shared Angular application in a browser before adding a host-specific environment.

## Start the development server {#start-server}

```bash
pnpm start
```

The root script delegates to the repository's Nx wrapper and serves the `trinity` project in its development configuration. Open the address printed by the command, normally `http://localhost:4200`.

A fresh profile should reach sign-in. That confirms the application compiled and the browser received it; it does not prove homeserver connectivity, authentication, encryption, push notifications, or a native bridge.

## Stop and restart safely {#stop-server}

Stop the process with <kbd>Ctrl</kbd>+<kbd>C</kbd>. If a change to workspace configuration is not detected, stop the server and start it again rather than launching a competing instance on another port.

For a production bundle, run the project target explicitly:

```bash
pnpm nx build trinity
```

The output is the root `www/` directory consumed by the Web/PWA, Capacitor, and Electron delivery paths.

## Choose the next path {#next-path}

Take the [repository tour](../repository-tour/) before selecting an owner for a change. Read the [system overview](../../architecture/system-overview/) before working across libraries.
