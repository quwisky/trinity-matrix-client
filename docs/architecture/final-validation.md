# Final architecture validation

Issue #326 contracts the capability-centered rewrite after every migration frontier completed.
This record is source evidence; UI screenshots and GIFs remain pull-request attachments only.

## Static and quality contracts

- `architecture/contract.json` is in the `contracted` phase. Classification, secondary
  entrypoint, multi-capability, dependency-exception, and source-baseline ledgers are empty.
- `pnpm architecture:check` validates the classified Nx graph, explicit primary entrypoints,
  dependency direction, absence of cycles, quality-baseline registry, and generated map.
- `scripts/final-boundaries.spec.mjs` rejects direct platform packages outside
  `platform-native`, Router imports in data-access/kernels/utilities, Matrix SDK imports in
  application/feature/UI code, and reintroduced retired QR/message compatibility paths.
- The existing host, design-system, message-presentation, performance-budget, and
  security/diagnostic contracts remain part of the uncached `scripts:test` target.

## Performance and security

The approved restore, switch, attach, projection, Workspace, retained-resource, and background
CPU contracts remain registered in `architecture/quality-baselines.json`. Deterministic limits
are hard assertions; machine timings remain diagnostic evidence rather than universal constants.
The final validation reruns those contracts without changing their approved budgets.

Security validation combines the Matrix hostile-input suites, secret-safe typed diagnostics,
SDK and platform import containment, preference policy validation, Electron sender/protocol
checks, lint, dependency-cycle checks, and production builds.

## Host parity matrix

The final local evidence was captured on 2026-08-30 from the Linux validation host:

| Host     | Shared renderer and contract evidence                                  | Host-specific evidence                                                                       |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Web      | Production Angular build and web-host contract passed                  | Chromium production startup, routing, and offline Playwright journey passed.                 |
| Android  | Capacitor sync graph, plugin manifest, and native-host contract passed | Android SDK was available; Gradle `testDebugUnitTest` passed after a fresh sync.             |
| iOS      | Capacitor sync graph, plugin manifest, and native-host contract passed | Native compilation is unavailable on Linux because `xcodebuild` is absent; macOS CI owns it. |
| Electron | Desktop host, IPC, preload, packaging, and scheme contracts passed     | All nine launched-shell smoke journeys passed with the installed binary under Xvfb.          |

Docker was unavailable on the validation host, so Synapse-backed integration journeys remain
delegated to required CI. The Docker-independent Web and Electron journeys above still exercise
the exact production renderer produced by the final architecture.

Any unavailable host combination is recorded in the pull request with the attempted command and
the environment reason; it does not weaken the checked-in host contract or silently count as a
pass.

## Design-system and Appearance delivery

The final local delivery evidence for issues #413 and #495 was captured on 2026-09-04 from the
Linux validation host, using branch `test/413-design-system-integration` based on
`refactor/refine-architecture` revision `6d1fd660af6d6365663ca1773a68a0516fc92e71`.

- `pnpm e2e:all` completed every registered suite under invocation
  `mtmwf0kv-c0975144-882c-42c8-bc7b-12044ede97a1`: 22 passed, zero failures, zero retries, zero
  quarantined or unavailable suites, and zero suites skipped by tier or left unrun.
- The aggregate covered the canonical browser journey, all three component environments, both
  Web/PWA environments, both Electron environments, the installed Android WebView, and all 13
  sequential Synapse protocol suites. Android completed 269 journeys with eight intentional
  host-specific skips; the production renderer completed nine behavior checks with nine
  attachment-only proof cases skipped by configuration.
- `pnpm ios:verify` passed the static iOS Nx, shared-renderer, Capacitor-plugin, and capability-host
  contract. Native iOS compilation and Simulator execution remain unavailable on Linux because
  Xcode is absent.
- GitHub Actions minutes were unavailable, so this record is based on local gates. Intermittent
  E2E harness behavior discovered during precursor runs remains separately tracked in #419 and
  #498; the successful aggregate above used no retries.
