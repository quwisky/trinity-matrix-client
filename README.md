# Trinity

[![CI](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml/badge.svg)](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml)

Trinity is an end-to-end encrypted [Matrix](https://matrix.org) client for Web/PWA,
Android, iOS, and Electron desktop. One Angular application supplies the shared
renderer; host capabilities handle platform-specific behavior.

Trinity has not published its first release. The
[user guide](https://quwisky.github.io/trinity-matrix-client/users/) is therefore a
work-in-progress notice until a release exists. The
[developer guide](https://quwisky.github.io/trinity-matrix-client/developers/) follows
the `develop` branch and documents the current source tree.

## Run from source

Use Node `^24.15.0` and the pnpm version pinned in `package.json`:

```bash
corepack enable
pnpm install
pnpm start
```

Open `http://localhost:4200`. For prerequisites, repository orientation, platform
setup, commands, testing, architecture, and contribution policy, use the
[developer guide](https://quwisky.github.io/trinity-matrix-client/developers/).
Its English source lives in
[`apps/docs-developers/src/content/docs`](apps/docs-developers/src/content/docs).

## Repository layout

- `apps/trinity/` contains the Angular application entrypoint and routes.
- `libs/` contains capabilities, data access, host contracts, and public UI.
- `e2e/` contains browser, component, protocol, and host validation suites.
- `electron/`, `android/`, and `ios/` wrap the shared production `www/` build.
- `apps/docs-users/` and `apps/docs-developers/` contain the two public Starlight sites.
- [`docs-internal`](docs-internal/README.md) contains private maintainer and decision records;
  it is not included in the public documentation build.

## Project status

The project is in early development. A feature's presence does not establish support
or validation on every host or deployment. Use the
[issue tracker](https://github.com/quwisky/trinity-matrix-client/issues) for proposed
work and the developer guide for the current implementation contract.

Trinity's built-in messaging does not provide voice or video calls. Offline caches
retain local content and the application shell; they do not replace a homeserver or
network access for first-time sign-in.

## License

Trinity is licensed under the [MIT License](LICENSE). Third-party dependencies and
vendored code retain their respective licenses.
