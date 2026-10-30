---
title: Clone and install
description: Create a Trinity checkout and install its pinned workspace dependencies.
audience: developer
contentChannel: develop
canonicalTopic: start-clone-install
pageType: tutorial
platforms: [web, desktop, android, ios]
---

The root workspace uses pnpm. Its one member package is the local Capacitor push plugin in `libs/native/capacitor-push`, which `pnpm install` links so native synchronization can find it. Electron deliberately keeps a separate dependency tree and is installed only for desktop work.

## Create the checkout {#create-checkout}

```bash
git clone https://github.com/quwisky/trinity-matrix-client.git
cd trinity-matrix-client
corepack enable
pnpm install
```

A successful install completes without the pnpm-only guard, an unsupported Node message, or a blocked required build script. Keep the generated `pnpm-lock.yaml` change only when dependency work intentionally changed it.

## Confirm the workspace {#confirm-workspace}

Ask Nx for the application rather than relying on a folder name:

```bash
pnpm nx show project trinity --json
pnpm nx show projects
```

The first command should resolve an application whose production build writes the shared web bundle to `www/`. The second shows the live project names that commands accept.

## Install desktop dependencies only when needed {#desktop-install}

```bash
pnpm electron:install
```

Do not add `electron/` to the pnpm workspace. Its package manifest and lockfile belong to the desktop host.

## Install the Rust toolchain only when needed {#rust-toolchain}

Only work under `native/**`, the Rust engine workspace, needs Rust. Install [rustup](https://rustup.rs/); `rust-toolchain.toml` pins the compiler version and the `rustfmt` and `clippy` components, and `rustup toolchain install` installs that toolchain under `~/.rustup`, not in the checkout. Homebrew's rustup is keg-only, so `$(brew --prefix rustup)/bin` must be on your `PATH`.

```bash
rustup toolchain install
pnpm nx run native-engine:cargo-test
```

The first test run compiles the Matrix SDK and takes several minutes. `native-engine:cargo-lint` runs `cargo fmt --check` and `cargo clippy`, and `native-engine:cargo-build` builds every crate.

Continue with [Run Trinity](../run-trinity/).
