# Diagnose validation warnings

Use this private guide when validation emits a warning or a successful task does not
produce its expected artifact. A zero exit code does not classify a warning or prove
that an artifact exists.

## Diagnose before rerunning

1. Preserve the original output, exit status, revision, task, host, and cache result.
2. Identify the first causal diagnostic and its owner.
3. Confirm the expected artifact or behavior independently of cached output.
4. Fix repository-owned causes. For upstream limitations, record the exact package,
   version, consequence, and checks that bound the exception.
5. Rerun the affected check and report the original and new results separately.

Use the public developer [commands](../../apps/docs-developers/src/content/docs/reference/commands.md)
and [validation guide](../../apps/docs-developers/src/content/docs/contributing/validate-a-change.md)
for reproducible invocation and check selection.

## Repository controls to preserve

| Diagnostic area                   | Current control                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Conflicting color variables       | The repository Nx wrapper removes inherited `NO_COLOR` before starting Nx.                                  |
| Deprecated Nx lint executor       | Projects use the inferred lint target; the source guard rejects explicit `@nx/eslint:lint` executors.       |
| Vite path resolution              | The ESM configs use `import.meta.dirname` and the shared Vite alias configuration.                          |
| Missing layout APIs in unit tests | The shared setup supplies an explicit no-layout `ResizeObserver`; browser behavior needs separate evidence. |
| Browser support                   | `.browserslistrc` owns configured floors; installed-browser runs own execution evidence.                    |
| Build budgets                     | `apps/trinity/project.json` owns script and component-style thresholds.                                     |
| Matrix CommonJS packages          | The Angular build allowlist is exact and must be rechecked when the SDK dependency graph changes.           |
| Android repository metadata       | The tracked application must not add a `flatDir` repository.                                                |
| Android native-library stripping  | The application preserves debug symbols only for its three named native libraries.                          |

Do not mute a compiler category, widen a budget, or remove an assertion merely to
obtain a quiet run. Warnings outside the boundaries below remain unclassified.

## Classified upstream Android output

These classifications permit only the named upstream or generated boundary. They
are not evidence of a current native compilation run.

| Boundary                                      | Classified output                                                                                                         | Recheck when                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Generated `capacitor-cordova-android-plugins` | One `flatDir` metadata warning from the ignored repository Capacitor generates for local AAR/JAR plugins.                 | Capacitor generation or plugin dependencies change, or another warning appears. |
| `@capacitor/android` 8.5.0                    | Javac's paired unchecked/unsafe-operation notes while compiling Capacitor core.                                           | The package changes or the diagnostic names application source.                 |
| `@capacitor/push-notifications` 8.1.2         | Paired deprecated-API notes naming `PushNotificationsPlugin.java`.                                                        | The package or named source changes.                                            |
| `@capacitor/filesystem` 8.1.2                 | Kotlin diagnostics for legacy `downloadFile` and its nullable-string mismatch.                                            | The package or method changes.                                                  |
| `@capacitor/camera` 8.2.2                     | The always-false condition in `IonCameraFlow.kt` and unchecked-operation notes in `CameraBottomSheetDialogFragment.java`. | The package or named source changes.                                            |
| Shared local Kotlin compiler service          | `Detected multiple Kotlin daemon sessions` when other worktrees use another Kotlin version.                               | The message accompanies a daemon failure or repository diagnostic.              |
| Local Android SDK metadata                    | SDK XML version 4 read by tooling supporting version 3.                                                                   | The SDK or Android Gradle Plugin changes, or native verification fails.         |

Any warning naming `android/app`, an unknown stripping library, or a compiler,
repository, or deprecation message outside this table is unclassified. Keep the
compiler output visible and use the developer
[native testing guide](../../apps/docs-developers/src/content/docs/testing/desktop-and-native-tests.md)
to reproduce the owning check.
