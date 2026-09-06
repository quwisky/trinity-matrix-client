# Testing

Choose validation that observes the behavior you changed. Start focused while iterating,
then run the broader checks needed for the changed boundary. [Commands](commands.md)
contains executable commands; [E2E architecture](e2e-architecture.md) owns shared resource
and coverage details.

## Choose validation by the change

| Change                                                         | Start with                                                                                                   | Add when needed                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Documentation only                                             | `pnpm format:check` and link checking                                                                        | No application test is implied                               |
| TypeScript behavior in one library                             | Its `test` and `typecheck` targets                                                                           | Dependent or workspace-wide checks when the boundary changed |
| Imports, architecture, configuration, or generated inventories | Relevant `scripts/*.spec.mjs` through `pnpm test`; `pnpm architecture:check` when its named contract applies | The behavior check for the feature                           |
| SCSS, design tokens, or responsive layout                      | `pnpm stylelint`                                                                                             | A real-browser component or journey check                    |
| Application workflow                                           | Focused browser journey                                                                                      | Synapse-backed lifecycle target when it uses Matrix state    |
| Production PWA, desktop, Android, or iOS behavior              | Matching host target                                                                                         | A host launch/run where prerequisites are available          |

A check is meaningful only if it can fail for the claimed regression. Record the exact
command and exit status. If Docker, a Playwright browser, an emulator, a desktop display,
macOS, Xcode, signing material, or a test account is missing, record that prerequisite as
unavailable rather than calling its check passed.

## Tests, type checking, and style are separate

`pnpm test` executes the workspace test targets. Application-library Vitest tests are
transpiled without typechecking; the desktop target uses its own Vitest installation and Node-environment configuration. Run explicit type checks for changed TypeScript:

```bash
pnpm nx test data-access-room-library
pnpm nx run-many -t typecheck
```

`pnpm lint` is separate from `pnpm stylelint`. Run the latter for SCSS or CSS:

```bash
pnpm lint
pnpm stylelint
pnpm format:check
```

Use a project name, not a path or import alias. Application-library targets run `vitest run`
in the project directory and forward arguments after `--`; see
[focused Nx examples](commands.md#inspect-and-focus-nx-work).

Read the process exit status, not a favorable-looking line in output. Nx can report task
failures after individual tool output. Use `pnpm nx reset` only to clear suspect local Nx state, then rerun.

## Unit-test limits

jsdom does not calculate layout or media queries. It cannot prove rendered size, overlay
stacking, a responsive breakpoint, a browser permission prompt, or a native host interaction.
Put those claims in a rendered browser, platform, or E2E check.

Make a test fail for the behavior it protects. Assert the user-visible outcome when the
feature is user-visible, not only an internal signal or method call. Avoid sleeps where a
route, control, request, or state transition supplies a readiness condition.

## Source-shape guards

The `scripts` project contains structural tests for module boundaries, styling idioms,
host directives, configuration keys, message-row consumers, and repository media policy.
They are not replaceable by a narrow unit test.

Before changing source a guard names, read its docstring and update its inventory only
when the product rule itself changes. For repository-wide contracts, use their documented
command or `pnpm architecture:check`; do not remove a failing assertion merely to make
an unrelated feature pass.

## Real browser and E2E checks

Use Storybook or a browser journey when rendering, accessibility, pointer input, or routing
is part of the claim. The canonical browser journeys run through one serialized target:

```bash
pnpm nx run trinity-e2e-browser:e2e -- conversations/message-links.spec.mts
```

The target builds a development web bundle and uses disposable Synapse. It does not prove
production PWA behavior, native wrappers, or desktop. For production Web/PWA routing,
service worker, and offline behavior, run:

```bash
pnpm nx run trinity-e2e-web:production-pwa
```

For broader flows and host prerequisites, use [the E2E router](../../e2e/README.md) and
[E2E architecture](e2e-architecture.md). Do not start an extra server, Synapse, or
emulator beside a lifecycle target: the target owns that resource and its cleanup.

## Failure handling and review evidence

On failure, keep command output and inspect the retained trace, report, or host diagnostic
before retrying. A retry can identify flakiness but does not turn an initial failure into a
clean pass. Avoid parallel Synapse-backed commands: they share fixed ports and state.

Artifacts under `dist/` are ignored. Attach review evidence to a pull request when useful,
but never commit screenshots, videos, traces, or pixel baselines. Before review, state the
behavior checked, exact command, result, and meaningful unavailable host checks.

## Angular test setup

Most application-library test targets run Vitest in jsdom through the shared workspace
configuration; the `scripts` project runs Node-side Vitest guards, and
`pnpm electron:test` is the Electron shell's separate Node-side test target. Do not call
all test targets browser-like Vitest tests or assume one runner proves every host.

The application is zoneless in production and tests. Import `render` from
`@trinity/testing`, not directly from Angular Testing Library:

```ts
import { render } from '@trinity/testing';
```

The wrapper applies the repository's `inputs` and `on` test options before its first
change detection. Direct zoneless Angular Testing Library rendering silently ignores those
options, leaving required signal inputs unset. Use a detached `TestBed.createComponent`
fixture when a test must synchronously drive `requestAnimationFrame` or layout-dependent
message-list work; an attached render fixture can re-enter the zoneless scheduler.

Use the shared setup's Vitest-backed `ng-mocks` spies and its existing browser API shims.
Do not add a broad fake browser implementation to solve one component's test. Signal Forms
are the production form model: test their visible validation and submission behavior through
the component rather than replacing them with legacy form controls.

## Browser assertions need browser evidence

jsdom cannot evaluate responsive CSS. A mobile layout assertion needs a real browser device
profile such as Playwright's `devices['Pixel 5']`; `hasTouch` on desktop Chromium preserves
the desktop user agent and can take the wrong application path. An installed Android WebView
journey is required when the claim is about Capacitor, Android permission behavior, hardware
Back, or WebView TLS.

Playwright counts `opacity: 0` elements as visible. When a control is intentionally hidden,
assert the state or class that removes interaction instead of relying only on visibility.
For a live Matrix client, do not wait for `networkidle`: its `/sync` long poll may remain open.
Wait for the route or the concrete control the journey needs.

## Complete validation before review

Focused checks are for iteration. Before a behavior or test change is ready for review, run
its focused proof and the applicable quality gates:

```bash
pnpm test
pnpm nx run-many -t typecheck
pnpm lint
pnpm stylelint
pnpm format:check
pnpm build
pnpm architecture:check
```

Run `pnpm e2e:all` for a delivery change that requires the full registered host and journey
gate. It requires Docker and the Android environment; record an unavailable host rather than
a pass if this machine cannot supply it. A changed Angular template needs a build even when
its unit tests pass. Expand validation again only after a review or failure changes the
behavioral boundary.

## Guard inputs and coverage

The `scripts` target is deliberately uncached and declares repository source, documentation,
manifest, and lockfile inputs because its guards read across project boundaries. Keep those declared inputs aligned with the files new guards read. Source-reading guards should strip comments before matching and prove their sweep
finds at least one intended source; otherwise a refactor can make a guard silently vacuous.

Coverage is opt-in and has no enforced threshold. Do not interpret a normal `pnpm test` run
as a coverage measurement. When testing a change by mutation, confirm the mutation reached the
method under test and that the check fails; a test that never fails for the changed behavior is
not evidence.

## The scripts project runs plain Node, on a raised timeout

`scripts` is the repository-invariant test project. It runs Node-side `*.spec.mjs` guards,
not Angular rendering, and gives real configuration resolution enough time to finish on a
loaded runner. Keep its raised timeout: a guard timing out is neither a product assertion nor
permission to delete the guard. The target is uncached and explicitly names the repository-wide
inputs its guards read.

## Vitest does not type-check specs

Vitest transpiles specs without type checking, while the desktop shell has its own
`electron:typecheck` target. Run the affected project typecheck or the cross-project
`pnpm nx run-many -t typecheck` gate for TypeScript changes; `pnpm test` alone cannot
prove a spec or template type-correct.

## Scoped capability-health validation

For changes to capability health, run the affected Nx test, typecheck and lint targets, including
Application Runtime, the affected capability, Matrix Client when its projection adapter changes,
and Projection Runtime. Their behavioral tests cover simultaneous
Account isolation, expected dormancy, retained reconciliation failure/success, released ownership,
retry generations, same-scope recovery serialization, independent-scope recovery, stop/restart
rejection, diagnostic serialization and finite preparation/recovery observation. `scripts:test`
includes the System Status retirement/privacy contract and session-owner guards.

The `identity/presence.spec.mts` browser journey injects a failing Identity read through Angular's
development-only debug API, then exercises the real projection, health ledger and visible retry.
Desktop Chromium and the full Pixel 5 browser profile prove unknown status, failure presentation,
restored presence and an unchanged Conversation URL. It introduces no production test hook.
Screenshots are Playwright attachments under ignored invocation output, never tracked media.
Browser mobile emulation does not establish native Android or iOS runtime validation.

The `host-shell/system-status.spec.mts` journey covers the System Status presentation contract:
desktop keeps the directory and detail panes side by side, compact mobile starts at Overview and
uses the directory/detail Back cycle, actionable groups remain selectable, support details stay
value-free, and a recovery attempt remains owned when the surface is dismissed and reopened.
The Pixel 5 profile also proves the operating-system-selected bottom-sheet geometry and that the
text-scaled compact layout remains usable. A touch-capable desktop is kept on the desktop
interaction model; this does not establish native sheet behavior on Android or iOS.

Trust-health changes additionally prove that asynchronous initial and event-driven reads settle
through Projection Runtime, last-known data is explicitly stale, and compatibility signals never
turn unavailable verification or backup state into `false`. Exercise retained invalidation and
released ownership recovery separately, plus Account-switch generation rejection. The
`trust/security-settings.spec.mts` journey injects a failing Trust read through Angular's
development-only debug API and uses the visible scoped retry; proof remains an ignored Playwright
attachment.

Notification and Host-health changes distinguish Room-rule projection failure from delivery,
unsupported presentation and denied permission from failure, and individual presentation,
navigation and badge-write incidents from persistent health. Cover retained and released
Room-rule recovery, native-push registration/listener ownership, finite badge/update checks,
foreground retry, obsolete recovery rejection and value-free diagnostics. The
`notifications/notification-settings.spec.mts` journey injects a real Room-rule reconciliation
failure and proves visible targeted recovery without leaving the Room route. Its screenshots are
Playwright attachments under ignored output. Browser mobile emulation does not prove APNs, FCM,
native badge or iOS runtime behavior; report installed-host validation separately.

Room Administration health changes cover permissions separately from the shared member-and-ban
projection, initial unavailable data versus retained stale snapshots, coherent command authority,
released-owner reattachment, exact Account-and-Room generation rejection and expected no-demand
dormancy. The `room-administration/kick-member.spec.mts` journey injects a retained membership
reconciliation failure through Angular's development-only debug API. It proves that the last-known
roster is labeled stale, fresh permission-backed actions remain usable, retry repairs both member
and ban health, and the open members panel survives recovery. Screenshots remain ignored
Playwright attachments rather than repository media.

Preference-health changes additionally cover the exact twelve-producer policy ledger, independent
settlement, declared defaults, explicit missing-baseline blockers, and one exact recovery that does
not rerun healthy siblings. Reset tests assert the exact exported catalogue and exclusions,
value-free per-entry partial results, stale-attempt rejection, outstanding-only retry, and retained
Promise ownership after timeout or subscriber cancellation. Room-order tests use separate Account
scopes and prove that removal retires a failure. Long-lived Appearance-effect tests have no fake
deadline: fault, exact restart, runtime stop and restart are ownership assertions.

Destructive Account recovery changes must cover both confirmation surfaces and the Account-owned
lifetime. Use exported budgets with deterministic clocks to prove stalled registry/session reads,
provider and Matrix operations, IndexedDB enumeration/deletion, secure storage, Preferences, raw
web storage, caches, and service-worker registration cannot hang invisibly or falsely settle.
Assert that detached UI does not cancel ownership and identical requests join. Conflicts remain
unavailable while late work is live. A reopened reset cannot dispatch the erase twice. Exercise
settled partial residue and local-only retry separately from `uncertain-cleanup`, including blocked
IndexedDB that later succeeds. Application Runtime must preserve the complete value-free ledger of
scopes and recoveries;
tests and source guards must reject Account identities, database names, values, tokens, raw errors,
false rollback language, false cancellation, and any return of the retired warning channel.

## Required startup-policy validation

For Application Runtime startup-policy changes, run the Application Runtime, Accounts, Room
Library, Projection Runtime, and Host Runtime test, typecheck, and lint targets. Deterministic
tests must distinguish unsupported optional Host operations from a failed Host contract; Active
from inactive Account restoration; empty Room Library dormancy from preparation failure and
timeout; safe-root Workspace repair from an unrecoverable route; persistence denial from a
required blocker; readiness timeout from retained session ownership; and an overall watchdog
from an operation deadline. Assert exact producer settlements, dependency-skipped stages, and
that scoped recovery does not repeat healthy upstream stages. Advance fake time using exported
budgets rather than copying values.

Timeout tests must prove late results cannot advance an obsolete attempt. They must not imply
that wrapping a Promise cancelled its underlying work, and must advance beyond a preparation
deadline after readiness to prove that a healthy retained lifetime remains owned. Source guards
verify the one producer ledger and the absence of a parallel warning path. Browser proof is
needed for visible eviction-risk and scoped-recovery consequences; keep that proof in ignored
Playwright output and attach it to the pull request.
