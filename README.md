# Trinity

[![CI](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml/badge.svg)](https://github.com/quwisky/trinity-matrix-client/actions/workflows/ci.yml)

Trinity is an end-to-end encrypted [Matrix](https://matrix.org) client for Web/PWA,
Android, iOS, and Electron desktop. One Angular application supplies the shared
renderer; host capabilities handle platform-specific behavior.

The project is in early development. Start with [installation and availability](docs/users/install.md)
before looking for a deployment or installer. [Using Trinity](docs/users/index.md)
explains current account, Room, Space, messaging, settings, and recovery workflows,
including permissions and host limits.

## Choose your task

| Task                                                    | Guide                                            |
| ------------------------------------------------------- | ------------------------------------------------ |
| Install, sign in, and use encrypted messaging           | [Using Trinity](docs/users/index.md)             |
| Set up the workspace and deliver a validated change     | [Developing Trinity](docs/contributing/index.md) |
| Diagnose CI, prepare a release, or update dependencies  | [Maintaining Trinity](docs/maintaining/index.md) |
| Give an agent a task, choose a role, or maintain skills | [Working with agents](docs/agents/index.md)      |

The [documentation index](docs/index.md) connects these reader paths to architecture,
platform, stack, and troubleshooting references.

## Run from source

Use Node `^24.15.0` and the pnpm version pinned in `package.json`:

```bash
corepack enable
pnpm install
pnpm start
```

Open `http://localhost:4200` and follow [signing in](docs/users/signing-in.md).
For prerequisites, test accounts, and the first change, follow
[Getting started](docs/contributing/getting-started.md). Android needs its SDK;
iOS needs macOS and Xcode. The [platform guides](docs/platforms/index.md) own desktop
and native build, launch, and packaging procedures.

Use the [command reference](docs/contributing/commands.md) for focused Nx targets,
argument forwarding, and host commands. [Testing](docs/contributing/testing.md)
explains which checks observe a change and why tests, type checking, browser layout,
and native execution are separate evidence.

## Understand the codebase

Trinity uses Angular standalone components and signals, RxJS actions, Spartan on
Tailwind, Matrix's JavaScript SDK and Rust crypto WASM, Capacitor, and Electron in
an Nx monorepo. [Stack notes](docs/reference/stack.md) record pinned versions and
integration constraints.

- `apps/trinity/` supplies the thin application entrypoint and routes.
- `libs/` contains capability owners, runtime and host contracts, public UI, and
  generated vendor wrappers. Cross-library imports use `@trinity/*` aliases.
- `e2e/` contains the owned browser, component, protocol, and host validation suites.
- `electron/`, `android/`, and `ios/` wrap the shared production `www/` build.

Read [Architecture](docs/architecture/index.md) before changing capability ownership,
state lifetimes, or dependency boundaries. [UI and theming](docs/architecture/ui-and-theming.md)
owns the public component and Appearance contracts. [Matrix and encryption](docs/architecture/matrix-and-encryption.md)
explains SDK, trust, and host-specific persistence behavior.

## Project status and limitations

Use the [current user guides](docs/users/index.md) for implemented behavior and the
[issue tracker](https://github.com/quwisky/trinity-matrix-client/issues) for proposed work.
A feature's presence does not establish validation on every host or deployment.
Check the [platform guides](docs/platforms/index.md) and the change's recorded evidence
for unavailable native, signing, notification, or recovery checks.

Trinity's built-in messaging does not provide voice or video calls. Offline caches
retain local content and the application shell; they do not replace a homeserver or
network access for first-time sign-in. [Troubleshooting](docs/reference/troubleshooting.md)
connects known symptoms to their owning contracts.

## License

Trinity is licensed under the [MIT License](LICENSE). Third-party dependencies and
vendored code retain their respective licenses.
