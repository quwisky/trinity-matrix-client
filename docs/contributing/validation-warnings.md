# Validation warning ledger

Local validation has one output contract: a new warning is a regression until its owner is
identified here. Fix repository-owned warnings at source. Keep an upstream warning only when a
repository change cannot remove it safely, and record the exact boundary that may emit it.

Run Nx through `pnpm nx` (or a named package script) so the workspace entrypoint applies the
same environment contract everywhere. The source-shape guard in
`scripts/validation-warning-policy.spec.mjs` pins the narrow suppressions and configuration
choices below.

## Resolved warnings

| Category                                   | Owner and resolution                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_COLOR` plus Nx `FORCE_COLOR`           | Nx 23 injects `FORCE_COLOR` into task children, making an inherited `NO_COLOR` ineffective and causing Node to warn in every worker. `scripts/nx.mjs` removes that contradictory variable before starting Nx; all package scripts and documented manual commands use this entrypoint.          |
| Deprecated Nx ESLint executor              | The five remaining Spartan projects use the workspace's existing `@nx/eslint/plugin` inferred lint target. Their redundant explicit `@nx/eslint:lint` targets were removed with Nx's `convert-to-inferred` generator.                                                                          |
| Vite native-config and path-plugin notices | The root package is ESM; project configs use `import.meta.dirname` and extension-bearing imports. `vite.base.config.ts` materializes the workspace alias catalog because Vite's project-root lookup does not discover this Nx workspace's extended root paths. The obsolete plugin is removed. |
| Missing jsdom APIs                         | `test-setup.base.ts` installs the no-layout `ResizeObserver` used by ordinary component specs. `feature-rooms` replaces it with its controllable measurement observer.                                                                                                                         |
| Angular component-ID collisions            | The media-query test hosts carry unique host metadata, so distinct local component classes do not hash to one ID.                                                                                                                                                                              |
| Missing icons                              | UI feature setups register the same typed Trinity icon catalog as production. Helpers that reset TestBed inside a test provide the catalog again at that local boundary.                                                                                                                       |
| Expected test logging                      | Failure-path specs spy on and assert their exact `console.log`, `console.warn`, or `console.debug` calls. Angular sanitizer notices for deliberate `mxc:` image fixtures are captured in those specs. Synthetic global-error events are canceled by a scoped event listener during dispatch.   |
| Browser support                            | `.browserslistrc` uses Angular 22.1's Baseline floor (`2026-05-07`): Chromium, Edge and Firefox 119; Safari and iOS 17.                                                                                                                                                                        |
| Script budget                              | The measured production total was 6.71 MB. The warning threshold is re-baselined to 7 MB while the 8 MB failure ceiling remains unchanged.                                                                                                                                                     |
| Message-row style budget                   | Reply-preview and thread-summary presentation now live in focused child components. The row is below the shared 6 kB warning threshold; the 8 kB failure threshold was not widened.                                                                                                            |
| Matrix CommonJS dependencies               | Angular's allowlist is exactly `another-json`, `content-type`, `events`, `loglevel`, `matrix-events-sdk`, `matrix-widget-api`, `sdp-transform`, and `unhomoglyph`. All are runtime dependencies reached through `matrix-js-sdk` 42.1.0; remove entries when that SDK ships ESM replacements.   |
| App-level Android `flatDir`                | The tracked app repository block was unused and removed. Direct `fileTree` dependencies do not need a flat-directory Maven repository.                                                                                                                                                         |
| Android native-library stripping           | The app keeps debug symbols for the three exact AndroidX libraries AGP cannot strip: Datastore's shared counter and Camera Core's image/surface utilities. The narrow packaging list prevents a no-op strip attempt without hiding diagnostics for any future native library.                  |

## Classified upstream Android output

Clean native compilation reaches Android/Kotlin sources shipped by Capacitor packages, so their
compiler diagnostics remain visible. Do not suppress compiler categories globally: that would also
hide warnings in `android/app`. The only classified messages are:

| Boundary                                      | Classified output                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| generated `capacitor-cordova-android-plugins` | One `flatDir` metadata warning. Capacitor regenerates this ignored repository for Cordova plugins that ship local AAR/JAR files. The tracked app copy has no `flatDir`.                             |
| `@capacitor/android` 8.5.0                    | Javac's paired `unchecked or unsafe operations` notes while compiling Capacitor core.                                                                                                               |
| `@capacitor/push-notifications` 8.1.2         | Javac's paired deprecated-API notes naming `PushNotificationsPlugin.java`.                                                                                                                          |
| `@capacitor/filesystem` 8.1.2                 | Kotlin warnings naming the legacy `downloadFile` method and the nullable-string mismatch in `LegacyFilesystemImplementation.kt`.                                                                    |
| `@capacitor/camera` 8.2.2                     | Kotlin's always-false condition in `IonCameraFlow.kt` and Javac's paired unchecked-operation notes naming `CameraBottomSheetDialogFragment.java`.                                                   |
| shared local Kotlin compiler service          | `Detected multiple Kotlin daemon sessions` may appear when other worktrees have live daemons for another Kotlin version. It names no repository source.                                             |
| local Android SDK metadata                    | The host may report SDK XML version 4 against tooling that understands version 3. The project already uses Capacitor 8.5.0's AGP 8.13.0; this is host SDK package metadata, not application source. |

Patch releases available during this audit changed Kotlin-plugin application, not these named
source diagnostics. Re-check the classifications whenever a listed package changes. A second
`flatDir` warning, an unknown native library in a strip warning, any diagnostic naming
`android/app`, or any other Android compiler, repository, or deprecation warning is unclassified
and must be investigated before merging.
