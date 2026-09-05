# Getting started

Use this path to get a fresh checkout running as a web client. It establishes the ordinary
development route; desktop, mobile, and end-to-end work add prerequisites only when you
need those environments.

## Prerequisites

| Tool                 | Required for            | Current requirement                          |
| -------------------- | ----------------------- | -------------------------------------------- |
| Node.js              | Every workspace command | `^24.15.0`                                   |
| Corepack and pnpm    | Installation and Nx     | pnpm `11.19.0` is pinned by `packageManager` |
| Modern browser       | Local web development   | A browser capable of running the application |
| Docker               | Synapse-backed E2E only | Installed and available to the current user  |
| Android SDK or Xcode | Native work only        | See [platform guides](../platforms/index.md) |

The repository is pnpm-only. Its install guard stops npm and Yarn before they create a
second lockfile. Enable Corepack once on the machine so it selects the pinned pnpm release.

## Checkout and install

Clone the repository, enter it, then install dependencies:

```bash
git clone https://github.com/quwisky/trinity-matrix-client.git
cd trinity-matrix-client
corepack enable
pnpm install
```

A successful install finishes without the pnpm-only guard or a blocked dependency-build
message. If it does not, confirm the Node version and that Corepack selected pnpm 11;
[troubleshooting](../reference/troubleshooting.md) covers known setup failures.

The root install does not install Electron's separate dependency tree. Run
`pnpm electron:install` only before desktop work. Do not add `electron/` as a pnpm
workspace package.

## Run the web client

```bash
pnpm start
```

Open the printed local address (normally `http://localhost:4200`). A fresh client
redirects to sign-in; this proves the development server is serving the app, not that
authentication, a homeserver, or encryption succeeded.

Stop the server with Ctrl+C when finished. Use [Commands](commands.md#web-workspace-and-formatting)
for production builds, focused Nx targets, and other commands.

## Find a change and make it scoped

Start from the route or component you are changing, then inspect resolved metadata instead
of guessing the project name:

```bash
pnpm nx show project trinity --json
pnpm nx show project data-access-room-library --json
```

Read the nearest code and [architecture](../architecture/index.md) before crossing a
library boundary. Keep the change within its owning layer where possible; [Conventions](conventions.md)
explains the import, component, style, and test-hook contracts.

## Add a host only when the task needs it

- For Electron, run `pnpm electron:install`, then use [Desktop commands](commands.md#desktop).
- For Android or iOS, use the SDK/Xcode setup in [Platforms](../platforms/index.md), then
  [Native host commands](commands.md#native-hosts).
- For browser automation, install Playwright browsers and check Docker before a
  Synapse-backed suite. [E2E architecture](e2e-architecture.md) explains resource ownership.

A missing SDK, browser, Docker daemon, macOS host, signing identity, or emulator is an
unavailable prerequisite. Record it; do not describe an unavailable host check as passed.

## Before review

Choose the smallest meaningful validation in [Testing](testing.md), run its canonical
command from [Commands](commands.md), and record the actual exit status. Then follow
[Branches and publication](conventions.md#branches-and-publication) before creating a
commit or pull request.
