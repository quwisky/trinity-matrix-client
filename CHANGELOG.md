# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Restructured the Nx workspace into typed, per-domain libraries.** The monolithic
  `@trinity/core` lib was dissolved into `@trinity/util-matrix` (pure DI-free models/
  helpers), `@trinity/platform-native` (Capacitor/native capabilities), and per-domain
  `@trinity/data-access-*` libs over the shared `@trinity/data-access-matrix-client`
  foundation. The app shell moved to `@trinity/feature-shell`, leaving `apps/trinity` as
  bootstrap + routing only. `@nx/enforce-module-boundaries` now enforces a typed
  dependency ladder (`app → feature → {data-access, ui} → {util, platform}`, features
  never depend on features) plus a `scope:shared` / `scope:matrix` split so the kernel
  stays domain-agnostic. Consumers import the specific lib instead of `@trinity/core`.
- Migrated the unit test suite to `@testing-library/angular` (`render`) + `ng-mocks`
  (`MockProvider`/`MockComponent`).
- Slimmed oversized component input/output surfaces (channel-sidebar, message-row +
  message-toolbar, media-bubble, server-rail) — grouping related inputs into view-model
  objects, reading core signals directly, and collapsing the message-action outputs into
  one typed event.
- Moved all inline component templates into sibling `.html` `templateUrl` files.

### Fixed

- OnPush re-render regression on the message timeline: per-row caps are now memoized so
  scrolling/typing no longer re-renders every visible row and its toolbar.

### Removed

- Leftover Ionic `--ion-*` CSS custom properties (dead since the UI moved to spartan-ng);
  the dark-mode class `.ion-palette-dark` was renamed to `.dark`.
