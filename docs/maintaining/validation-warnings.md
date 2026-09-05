# Diagnose validation warnings

Use this guide when validation emits a warning or a supposedly successful task has not
produced its expected result. A new warning needs an owner and an explanation. Fix
repository-owned causes; retain an upstream diagnostic only at its named boundary, with the
reason and verification limit recorded here. An exit code of zero does not classify a warning
or establish that an artifact exists.

For a failing assertion, start with [CI diagnosis](ci-and-releases.md) and the
[validation policy](../contributing/testing.md#choose-validation-by-the-change). Warning
classification does not turn a failed test into a pass.

## Diagnose before rerunning

1. Keep the complete original output, exit status, commit, task, host and cache result. Identify
   the first causal diagnostic rather than only the final Nx “Failed tasks” summary.
2. Find the named source or package. Match both the message and its emitting boundary to this
   ledger; a familiar phrase from a different owner is still unclassified.
3. Check the expected artifact or behavior. A cached log is a replay of previous output, not
   proof that a new compiler warning was emitted. A cached success without its build output is
   a preparation failure; preserve it and diagnose artifact restoration.
4. Fix a repository-owned cause at source. For an upstream limitation, record the exact owner,
   package version, affected command, consequence and checks that bound it. Do not mute whole
   compiler categories, widen budgets, or remove assertions to obtain a quiet run.
5. Rerun the affected check after the change. Record the original failure and new result
   separately. Repeated success alone does not resolve a flaky failure.

Run Nx through `pnpm nx` or a named package script. The workspace
[entrypoint](../../scripts/nx.mjs) normalizes conflicting color environment variables without
filtering output. See [commands](../contributing/commands.md) for reproducible invocation and
[the Storybook host guide](../../libs/components/storybook-host/README.md#build-and-run-browser-checks)
for the missing-catalog-artifact recovery command.

## Repository controls to preserve

These are current configuration and test boundaries, not a claim that every possible run is
warning-free. The [warning-policy guard](../../scripts/validation-warning-policy.spec.mjs)
checks the wrapper, configuration and narrow classifications; other behavioral guards cover
their own source owners.

| Diagnostic area                        | Current control and investigation path                                                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_COLOR` together with `FORCE_COLOR` | Nx injects color settings into children. The wrapper removes inherited `NO_COLOR` before starting Nx. Check whether a command bypassed it or the message came from a cached log before changing the environment contract.                                                          |
| Deprecated Nx ESLint executor          | Projects use the inferred `@nx/eslint/plugin` target; the guard rejects remaining explicit `@nx/eslint:lint` targets. Inspect resolved targets before changing a project.                                                                                                          |
| Vite native-config/path resolution     | The root package is ESM. Project configs use `import.meta.dirname` and the shared [Vite configuration](../../vite.base.config.ts), which supplies workspace aliases. The removed path plugin is not a dependency to reinstall as a workaround.                                     |
| Missing jsdom layout APIs              | [Shared test setup](../../test-setup.base.ts) has an explicit no-layout `ResizeObserver`; Rooms uses a controllable observer. Neither proves actual browser measurements or media queries.                                                                                         |
| Angular component IDs or missing icons | Keep test host metadata distinct and register the production typed icon catalog at the test's TestBed boundary. Do not globally suppress framework diagnostics.                                                                                                                    |
| Expected failure-path logging          | A test that deliberately causes a warning must spy on and assert its exact output locally. Deliberate sanitizer fixtures and synthetic error events need scoped handling, not a global console mute.                                                                               |
| Browser support                        | [`.browserslistrc`](../../.browserslistrc) explicitly targets Chromium/Edge/Firefox 119 and Safari/iOS 17 or later. Recheck these entries against the installed Angular builder when upgrading it. A configured floor is not evidence of execution on every supported browser.     |
| Script and stylesheet budgets          | Use the full table below; measure the current production output. Older measured totals are historical observations, not guaranteed sizes.                                                                                                                                          |
| Matrix CommonJS dependencies           | The build permits exactly `another-json`, `content-type`, `events`, `loglevel`, `matrix-events-sdk`, `matrix-widget-api`, `sdp-transform` and `unhomoglyph`. Recheck this list against the installed SDK dependency tree on upgrade; an unrelated CommonJS package is not covered. |
| Android repository metadata            | The tracked app has no `flatDir` repository. A generated Cordova repository has its own narrow classification below; do not copy it into the app.                                                                                                                                  |
| Android native-library stripping       | [App packaging](../../android/app/build.gradle) keeps debug symbols for exactly `libdatastore_shared_counter.so`, `libimage_processing_util_jni.so` and `libsurface_util_jni.so`. An additional library warning requires investigation.                                            |

The production budgets are declared in the [web project](../../apps/trinity/project.json).
They apply to different quantities; passing the aggregate budget does not satisfy the others.

| Quantity                 | Warning threshold | Error threshold |
| ------------------------ | ----------------: | --------------: |
| Initial bundle           |              2 MB |            5 MB |
| Any script               |           3.75 MB |            5 MB |
| All scripts              |              7 MB |            8 MB |
| Any component stylesheet |              6 kB |            8 kB |

For script growth, identify the changed eager/lazy chunk and dependency before choosing a
remedy. For style growth, inspect the owning component and shared presentation boundaries.
Record before/after sizes rather than increasing a threshold as part of an unrelated change.

## Classified upstream Android output

These are the retained classifications from native compilation, checked against the package
versions in the documentation baseline. They permit only the named upstream or generated
boundary. This documentation update does not constitute another native compilation run.

| Boundary                                      | Classified output                                                                                                                              | Recheck when                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Generated `capacitor-cordova-android-plugins` | One `flatDir` metadata warning from the ignored repository Capacitor creates for local AAR/JAR plugins. The tracked app has none.              | Capacitor generation or plugin dependencies change; a second warning is outside this classification. |
| `@capacitor/android` 8.5.0                    | Javac's paired unchecked/unsafe-operation notes while compiling Capacitor core.                                                                | The package changes or the diagnostic names app source.                                              |
| `@capacitor/push-notifications` 8.1.2         | Paired deprecated-API notes naming `PushNotificationsPlugin.java`.                                                                             | The package or named source changes.                                                                 |
| `@capacitor/filesystem` 8.1.2                 | Kotlin diagnostics for legacy `downloadFile` and the nullable-string mismatch in `LegacyFilesystemImplementation.kt`.                          | The package or method changes.                                                                       |
| `@capacitor/camera` 8.2.2                     | The always-false condition in `IonCameraFlow.kt` and unchecked-operation notes in `CameraBottomSheetDialogFragment.java`.                      | The package or named source changes.                                                                 |
| Shared local Kotlin compiler service          | `Detected multiple Kotlin daemon sessions` when other worktrees have live daemons using another Kotlin version; no repository source is named. | The message accompanies a daemon failure or repository diagnostic.                                   |
| Local Android SDK metadata                    | SDK XML version 4 read by tooling supporting version 3. The baseline uses Capacitor's AGP 8.13.0; this is a host-tooling mismatch to inspect.  | The SDK/AGP changes or native verification fails.                                                    |

Any warning naming `android/app`, an unknown stripping library, or an Android compiler,
repository or deprecation message outside this table is unclassified. Keep compiler output
visible. Use the [mobile host guide](../platforms/mobile.md) to reproduce the owning native
check and report the distinction between static contracts, toolchain compilation and device
behavior.

## Storybook diagnostics and failure evidence

The UI documentation validation on 2026-09-05 produced the following diagnostics from a fresh
catalog build. The build completed, but this is not a blanket harmless-warning classification.
The [final integration handoff](https://github.com/quwisky/trinity-matrix-client/issues/542#issuecomment-5550995972)
retains the failures; the [warning handoff](https://github.com/quwisky/trinity-matrix-client/issues/540#issuecomment-5550996062)
records the build messages.

| Message                                                          | Owner to inspect                                                                                                                                                                            | Required disposition                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LightningCSS reports `:host-context` is not a valid pseudo-class | Angular/Vite processing of [Trinity icon styles](../../libs/components/foundations/src/lib/icon/trn-icon/trn-icon.component.scss), specifically button/anchor focus, hover and active rules | Compare emitted selectors with the source and exercise all affected interactions. Do not replace Angular syntax with the suggested pseudo-element solely to silence the minifier. Existing passing motion cases do not explain every emitted selector. |
| Vite/Rolldown `PLUGIN_TIMINGS`                                   | The named build plugins and their measured timing shares                                                                                                                                    | Retain the diagnostic and determine whether it represents material build cost; a timing advisory is distinct from a rendering assertion. Do not tune unrelated build configuration during a documentation change.                                      |
| Chunks exceed 500 kB after minification                          | The generated static catalog's chunk graph                                                                                                                                                  | Identify the catalog chunks and cost before accepting or splitting them. This threshold is separate from Angular application production budgets.                                                                                                       |

In that fresh run, icon-motion cases passed in Chromium, mobile Chromium and WebKit. The
catalog advisory named the Angular platform, Axe, crypto-wrapper and iframe chunks; the
reported plugin shares and chunk sizes describe that build, not fixed performance budgets.

The same validation also exposed two failures, which do not belong in a warning allowlist:

- A cache hit reported a catalog build success without `index.html` or `iframe.html`; the
  browser received “Not found”. The owned run was interrupted after confirming missing output.
- The separate fresh build's browser suite finished with **154 passed and 1 failed**, retries
  disabled. The failing overlay accessibility case reported `Axe is already running` while
  invoking the shared scan helper.

Final integration isolated that scan race: Storybook's accessibility addon can replace
`window.axe` and start scanning between the helper's injection and its later global lookup.
The [shared helper](../../e2e/components/storybook/catalog-accessibility.mts) now captures its
injected instance in the same browser operation and disposes the retained handle after its
scan. The [regression](../../e2e/components/storybook/navigation-overlay-catalog.spec.mts)
holds the actual addon module response until injection, then checks that both owners finish
using distinct instances. Restoring the former helper failed that regression; the corrected
helper passed. Accessibility rules and result assertions remain intact.

On 2026-09-05, the full corrected catalog passed **156 tests** with retries disabled,
including the final regression's identity-order and independent-completion assertions.
A separate normal Nx cache-hit probe restored both missing HTML artifacts after moving
aside only the owned generated output. That establishes current restoration behavior,
not the cause of the earlier missing output. These results do not resolve the compiler
and bundle diagnostics above or substitute for validation of the final candidate. Record
its complete checks and any remaining limits on the pull request.
