# Android Edit History Maestro Migration Design

- Issue: #743, part of #660
- Status: Design sections approved in conversation; written spec awaiting review
- Branch: `test/676-android-sidebar-filter`, PR #677 (draft, unmerged)

Committing this document records the design only. It does not satisfy #743's
implementation, runtime, or hosted acceptance gates.

## Intent and boundary

Replace the two Android-applicable edit-history browser journeys with faithful
installed-Android Node/Maestro journeys. The replacement must exercise the real
Trinity WebView and Matrix server, preserve the observable behavior of the
predecessors, and leave all three Playwright definitions enabled. The third,
desktop/settings-frame definition remains browser-only. No predecessor is
retired and PR #677 is not merged by this work.

The source of truth is
`e2e/browser/journeys/conversations/message-edit-history.spec.mts` at SHA-256
`66b251c72f0939a9913fb31641107f500d22cf627ff7b566740e15e744c37153`.
The applicable definitions are lines 123–396 and 500–552; lines 29–118 own the
shared edit-chain and dialog-opening helpers. Lines 398–495 are explicitly
excluded from Android coverage. Login and account behavior remain pinned to
`e2e/support/app.mts` at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `e2e/support/account.mts` at
`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.

The #742 predecessor is accepted on original-attempt hosted evidence. The
unchanged #743 browser spec has a three-definition, one-worker, retry-zero
baseline pass. A separate installed-Android probe showed that changing Android
`font_scale` from 1.0 to 1.5 and relaunching Trinity changes the live WebView
root/body computed size from 16px to 24px, without changing the viewport or
setting an inline root style, and that restoration returns it to 16px. That
probe establishes feasibility only: it did not exercise the Pixel 5 history
dialog or satisfy the 62-record acceptance contract.

## Selected architecture

Use two serial, independently reported journey stages: `revision-lifecycle`
and `pixel5-large-text`. They share a small exact assertion contract and a
focused Matrix fixture, not mutable renderer state. Existing account/room
fixture ownership, `AccountWorkspaceClient`, Maestro device leasing, runtime
provenance, and registry conventions remain the base infrastructure.

| Unit                             | Responsibility                                                                                                                       | Boundary                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Edit-history contract and guard  | Map all applicable assertion sites to stable stage-local identities; pin source/helper hashes and excluded desktop span.             | No product actions or fixture setup.                                                             |
| Matrix fixture                   | Create a run-scoped account/room and exact original/edit/redaction chains; read direct events and relations after native removal.    | Authentication stays closure-private; only sanitized IDs and semantic facts reach reports.       |
| Node/Maestro journey             | Log in, navigate, open dialogs, toggle, scroll, remove, confirm, and close through native input; emit assertion and action receipts. | No DOM actions, synthetic focus, or renderer-driven scrolling.                                   |
| Read-only WebView observer       | Measure text, markup, accessible marker/dialog state, geometry, overflow, and computed font size.                                    | No style mutation, event dispatch, handlers, scroll offsets, filling, submission, or navigation. |
| Reversible Android setting lease | Save the exact prior `font_scale` value, apply large text, and restore on normal exit, cancellation, or device close.                | Cleanup runs through abort-independent bounded ADB, before emulator teardown.                    |

`edit-history-fixture.mts` composes `createAccountFixtures` for account/room
lifecycle and opens its own bounded REST login for edit requests and relation
observations. It registers logout before seeding events and keeps that second
bearer token inside the fixture closure. Neither the token nor an authorization
header is returned to the journey or written to diagnostics; the shared
account-fixture API does not acquire a general-purpose authenticated request
escape hatch.

## Fixture and journey data flow

### Revision lifecycle

The fixture registers a unique account, creates a named non-DM room, and seeds
three independent chains over real Matrix Client-Server REST:

1. A plain original plus two same-target `m.replace` events, with retained
   original/edit event IDs, exact `* ` fallback bodies, `m.new_content`, and
   run-scoped first/second/final wording.
2. A formatted `Friday` original and `Monday` replacement using
   `org.matrix.custom.html` and `<strong>` bodies. Both edit payload and
   replacement content are checked.
3. A separate message that is edited and then redacted, leaving its edit on
   the server to test history suppression in the client.

The installed app then logs in and opens the exact Room through Maestro. Native
touch opens the edited marker and the single history dialog. Read-only
observations prove latest timeline wording, visible accessible marker, three
oldest-first revision rows, exact labels, `final` insertion and `second`
deletion, no original diff, complete/error-free state, and native close.
Maestro toggles highlights off and on; the observer proves exact unhighlighted
versions and restored diffs. The formatted chain proves `Mon` insertion and
`Fri` deletion inside `strong`, retained `day`, then exact bold `Monday` with
no stale deleted text when highlighting is off.

Maestro reopens plain history, removes the current edit and taps the nested
destructive confirmation. The fixture proves that exact edit event is redacted
server-side and that only the expected live `m.replace` relation remains.
After refetch, the observer proves a two-row non-error dialog, then the timeline
shows the second draft and still has its edited marker. Reopening must still
show the second draft and not the removed final wording. Maestro then removes
the last edit and confirms; server reads prove it redacted and no live edits
remain. The dialog has only the original, and the timeline returns to the
exact original text with no marker. The separately redacted row is visible but
exposes neither its old body nor edit-history affordance.

Server checks use bounded direct event and relation reads after each removal;
they cannot infer success solely from the dialog. Before removal, the fixture
verifies each edit's target, sender, and wire content against its sent payload.
After removal, it verifies redaction of the exact event IDs and the expected
survivor ordering among live relations without publishing authorization
material.

### Pixel 5 and real large text

The second stage seeds the long three-version chain from the shared helper and
uses the production Pixel 5 WebView profile: 393×727 CSS pixels, DPR 2.75,
mobile/touch. Its three helper-expanded records prove Room readiness, latest
message text, and opened dialog. At baseline it measures full-screen dialog
width and height (within one CSS pixel), visible fixed-header Close control,
at least 44×44 CSS-pixel Close target, no horizontal dialog overflow, and
visible toggle and revisions.

The stage records the baseline Android setting and WebView root size, closes
the dialog, applies real Android `font_scale=1.5`, then force-stops and cold
relaunches Trinity with application data preserved. It reapplies the exact
Pixel 5 profile, reopens the Room/history by native input, and requires a
non-vacuous root-size increase to at least 24px while the viewport and DPR
remain unchanged and the root inline font-size remains unset. The history
reading region must not overflow horizontally. Maestro swipes the revisions
container until the trailing Remove action is fully visible; read-only
geometry proves it is within both viewport edges. No DOM root-style mutation,
viewport resize, or renderer scroll method may substitute for this path.

The Pixel 5 viewport is already compact at baseline. The large-text proof is
therefore real WebView scaling plus reading-region and action reachability,
not a claim that changing the font crosses the desktop-to-compact breakpoint.

## Failure, cancellation, and cleanup

`MaestroDevice` owns a focused reversible `font_scale` operation. It snapshots
the previous raw value, including an absent setting, and registers an
idempotent restore action **before** the first write. The normal stage
`finally` calls restore and verifies the readback; device-lease closure calls
the same action as a fallback before stopping an owned emulator or releasing
a borrowed one. Restoration uses the lease's bounded, abort-independent raw
ADB path, never `MaestroDevice.adb`, because that method inherits the
invocation's aborted signal. An absent prior value is restored by deleting
the setting, not by writing `1.0`. An app relaunch after restoration verifies
baseline computed text size when the invocation is still live; cancellation
must still restore and verify the Android setting.

Matrix requests, native actions, observations, and teardown have finite
timeouts. Account/room and device resources are registered before dependent
operations. Started-stage diagnostics are emitted on both pass and failure;
credentials, access tokens, bearer headers, and event authorization are
redacted, and unsafe raster captures are not published or committed. Cleanup
continues after an individual failure and aggregates restoration, Matrix,
WebView, application-data, device, and diagnostic-redaction errors. A cleanup
failure cannot leave a passing stage or accepted artifact.

## Assertion contract and validation

The exact stage-local contract has 62 records:

| Owned source                           | Direct sites |   Helper expansions |       Records |
| -------------------------------------- | -----------: | ------------------: | ------------: |
| Core revision lifecycle, lines 123–396 |           46 |                   0 |            46 |
| Pixel 5, lines 500–552                 |           13 | 3 from lines 91–118 |            16 |
| Desktop/settings-frame, lines 398–495  |           25 |                   0 | **0 Android** |

Font-scale, native-action, server-authority, provenance, and cleanup checks
are additional fail-closed gates. Their receipts do not replace or inflate
the 62 source-mapped parity records.

The guard uses the pinned hashes plus AST counts and exact owned spans; it
requires a unique identity for each applicable assertion, registration and
retention of all three Playwright definitions, and explicit desktop
exclusion. Effective negative controls must reject weakening of edit targets
or wire content; ordering, word diffs, formatted markup, highlight toggles,
error/truncation absence, current and last-edit removal, authoritative server
and timeline repair, redacted-history suppression, Pixel 5 fullscreen/touch/
overflow/large-text reachability, native-action ownership, secret redaction,
and abort-safe setting/other cleanup. Guard text matches alone are not enough:
semantic mutation tests must make the relevant checker fail.

The runner is a non-cached, serial `android.edit-history` Nx target holding
`android-avd` and `synapse`, with one test attempt and zero retries. Registry,
package command, CI shard, started-only diagnostics, and `MIGRATION.md` must
name the same journey and 62-record contract. Runtime reports retain exact
renderer build, built/installed APK digest, Pixel 5 profile, native-action
receipts, Matrix/server proof, font-scale readback, assertion results, and
cleanup status.

Acceptance requires three consecutive unchanged installed-Android local first
attempts passing both stages and all 62 records at retry zero. All three
unchanged Playwright definitions pass sequentially with one worker and retry
zero, with hashes rechecked after implementation. Run focused guards and
negative controls, Android type checking, affected unit/lint/build/architecture
checks, and policy-required repository validation; report commands and exit
statuses separately. Original-attempt hosted Android, browser, and renderer
artifacts must be audited for stage/record counts, native and server receipts,
zero retries, provenance, redaction, and cleanup. An unrelated full-workflow
failure remains visible under #665; it cannot be hidden by rerun or treated as
evidence of #743 failure or success without its own artifact audit.

Only after that evidence and review pass may the implementation batch be
committed and pushed to the authorized branch, #743 and parent ledgers and PR
#677 updated, and #743 closed. #744 remains blocked until #743 original-attempt
hosted acceptance. PR #677 remains draft/open and unmerged.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-edit-history.md` is a preparatory
plan, not permission to implement. It predates this design review. After this
spec is approved, the writing-plans step must reconcile that plan with the
completed feasibility probe and this spec, especially its proposed
Pixel 5 breakpoint claim and its font-scale teardown seam. Do not execute the
old plan unchanged or modify unrelated untracked plans.
