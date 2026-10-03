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

Releases ship this bundle as `Trinity-Web-<version>.zip` and as the `ghcr.io/quwisky/trinity-web` image built from it; see [Self-host a release](#self-host-release).

## Keep browser boundaries explicit {#browser-boundaries}

Use Web Host adapters for browser implementations and expected unavailable operations. Origin storage is script-readable and must not be described as an OS-secure credential store. Browser responsive emulation proves web behavior only; it does not exercise Capacitor plugins, installed WebViews, or native lifecycle.

Run focused unit and browser journeys for product behavior, then add build, typecheck, lint, stylelint, and architecture checks as the change requires. Read [component and browser tests](../../testing/component-and-browser-tests/) for evidence selection.

## Self-host a release {#self-host-release}

Every Trinity release ships the web app in two forms. Both contain the same files.

### Container image {#self-host-container}

```sh
docker run -d -p 8080:8080 ghcr.io/quwisky/trinity-web
```

Open `http://localhost:8080`. The image runs as a non-root user, listens on port 8080 and
answers `/health` for health checks. It supports `linux/amd64` and `linux/arm64`.

| Tag      | Follows                           |
| -------- | --------------------------------- |
| `latest` | the newest stable release         |
| `X.Y`    | the newest stable `X.Y.*` release |
| `X.Y.Z`  | exactly that release              |
| `next`   | the newest prerelease             |

Pin `X.Y.Z` in production and update deliberately.

### Release zip {#self-host-zip}

Download `Trinity-Web-X.Y.Z.zip` from the
[releases page](https://github.com/quwisky/trinity-matrix-client/releases) and serve
`trinity-web/www/` from any static web server. The server must:

- answer unknown app routes (`/login`, `/rooms/…`, `/settings/…`, `/encryption/…`) with
  `index.html`, but return 404 for missing files with an extension;
- send `Cache-Control: no-cache` for `index.html`, `ngsw.json`, `ngsw-worker.js` and
  `manifest.webmanifest`, and may cache hashed `*.js`/`*.css` files for a year;
- serve `.wasm` as `application/wasm`.

The container's [`sws.toml`](https://github.com/quwisky/trinity-matrix-client/blob/main/container/sws.toml)
is a complete reference configuration.

### HTTPS {#self-host-https}

Serve Trinity over HTTPS (or `localhost`). Browsers only install the app and run its service
worker on secure origins. Third-party notices are in `3rdpartylicenses.txt`.
