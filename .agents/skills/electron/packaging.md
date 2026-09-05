# Trinity desktop packaging

Use the [desktop guide](../../../docs/platforms/desktop.md) for local build,
sync, launch, debug, package, and host prerequisites. Use
[CI and releases](../../../docs/maintaining/ci-and-releases.md#releases) for
versioning, release verification, artifacts, signing names, draft review, and
publication authorization.

## Package the existing shell

The committed [`electron-builder.yml`](../../../electron/electron-builder.yml)
packages Linux AppImage and deb artifacts, macOS dmg and zip artifacts, and a
Windows NSIS executable. The release workflow builds those desktop artifacts
with publishing disabled, then creates or updates a draft GitHub release.

Before changing packaging:

1. Trace the Nx-owned desktop command and the Electron builder configuration.
2. Keep the shared production renderer and desktop shell contract intact; a
   package is not proof that every browser or native journey passed.
3. For macOS signing or notarization, follow the desktop guide and release
   guide. Use configured secret names only; never document or log credential
   values.
4. Inspect the produced artifact and architecture on its target before making a
   distribution claim. Record unavailable host or signing prerequisites.

There is no configured public auto-publish provider, auto-updater feed, Web ZIP
release, container publication, or mobile-store delivery in this shell. Do not
advertise one or add a generic release recipe without an accepted, source-backed
change.
