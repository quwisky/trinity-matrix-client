# Android Message Grouping Maestro Migration Design

- Issue: #745, part of #660
- Status: Written spec and plan approved; review corrections locally validated, hosted audit pending
- Branch: `test/676-android-sidebar-filter`, PR #677 (draft, unmerged)

This document records the approved design. Implementation and acceptance
evidence are tracked in `e2e/android/MIGRATION.md`; the hosted audit remains
required before closing #745.

## Intent and source boundary

Migrate the Android-applicable part of the canonical message-grouping journey
to one installed-Android Node/Maestro stage. It must exercise the real Matrix
server, native Settings control, persisted preference, and WebView layout. The
Playwright predecessor stays enabled and unchanged; its desktop-only hover,
top-edge LTR/RTL, desktop Compact, and hybrid-pointer tail stays browser-only.
PR #677 remains draft/open and is not merged by this batch.

The source of truth is
`e2e/browser/journeys/conversations/message-grouping.spec.mts` at SHA-256
`9cdd8dcd5722dabe4783b9f045bcff56ab4c50adfce51f2ce9ba8e33884dd05f`:
lines 57–234 own the applicable journey through its explicit Android return;
lines 25–52 own the 40 px lead-width constant and API-login helper; lines
237–643 are excluded desktop behavior. The supporting login and account pins
are `e2e/support/app.mts` at
`60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3`
and `e2e/support/account.mts` at
`ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594`.
The unchanged predecessor passed at retry zero on the current pushed head;
that is coexistence baseline evidence, not native parity.

## Selected architecture

One serial `message-grouping` stage owns the entire cosy-to-Compact journey.
It composes the existing account/workspace fixture, native client and device
lease, production renderer provenance, and reporting conventions. A focused
contract maps the 22 Android-applicable assertions to stable, unique record
IDs; a source-shape guard pins the predecessor and rejects forbidden shortcuts.

| Unit                       | Responsibility                                                                                                                                     | Boundary                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Matrix fixture             | Create one fresh Account and named private Room; send three ordered, consecutive `m.text` events from that Account; retain their exact event IDs.  | REST arranges state only. Credentials and bearer tokens stay closure-private.                                              |
| Node/Maestro journey       | Log in, open Rooms and the exact Room, navigate to Settings → Appearance, select Compact, and return to the same Room through installed-app input. | No DOM click, focus, fill, submit, scroll, navigation, or synthetic pointer/hover action.                                  |
| Read-only WebView observer | Scope to the three exact `data-mid` event rows and measure rendered grouping in both modes.                                                        | No mutation of `data-density`, classes, styles, or scroll position; no stylesheet-value or screenshot-only geometry claim. |
| Native preference observer | Read the package-owned Capacitor Preferences file through `run-as`; decode only the density entry.                                                 | No preference writes, no raw XML or other keys in diagnostics.                                                             |
| Contract and reporting     | Count each source-mapped assertion once, record sanitized action/geometry/persistence receipts, provenance, and cleanup.                           | Additional integrity gates never inflate the 22 parity records.                                                            |

The dedicated Compact action uses the existing native Settings and Appearance
navigation pattern but changes only the density control. It must not reuse the
appearance flow that also changes Mode, Theme, and text size. Read-only
inspection may discover a native-accessible control ID; Maestro performs the
actual tap and option selection.

## Fixture, interaction, and observation flow

The fixture uses a run-scoped Account and named, non-DM private Room, and sends
the following bodies sequentially as the same sender, with no intervening
event: `First message`, `Second message with enough text to reach the trailing
action track without the reserved inset`, and `Third message`. It checks each
send response and retains the ordered event IDs. Login and Room opening use
Maestro, not renderer-side navigation. The stage waits for all three exact
body/ID pairs before taking geometry; a broad `.msg` query or body-text match
cannot silently include unrelated timeline rows.

For cosy, the observer reads used lead widths and text positions from
`getBoundingClientRect()`, and start/continuation padding and margin from
`getComputedStyle()`. It scopes `.msg__avatar`, `.msg__gutter`, `.msg__text`,
`.msg__body`, and `.msg--cont` to the three event-ID rows. The header must own
the sole avatar; the other two rows must be continuations. Each `.msg__text`
must itself be visible with positive used width and height; a visible row
does not prove its message body is visible. Each actual avatar
or gutter lead is exactly 40 CSS pixels, and all three text left edges align
within one CSS pixel. Group-start padding is at least 16 px, continuation
padding is zero, and group-start margin is zero. The gap must be padding inside
the border box, not a visually similar margin that the virtual list fails to
count. It records the sum of the three row border-box heights before the
preference change. No `.msg__toolbar` markup may exist in the installed phone
interaction model.

Maestro then leaves the Room, opens Settings → Appearance, and chooses Compact
through the production `density-select` control. The native observer checks
`shared_prefs/CapacitorStorage.xml` for exactly one
`trinity.appearance.density` entry. The stored XML string must decode to an
exact JSON envelope `{"version":1,"value":"compact"}`: version 1 and the
Compact value, not the bare string `compact`. A missing, duplicate, malformed,
wrong-version, wrong-value, or undecodable entry fails. The whole XML
document must parse structurally; commented-out entries are
not preferences and malformed surrounding XML cannot be ignored. Before selection,
absence is permitted only with the real rendered Cosy default; an existing
entry must decode to version-1 Cosy. Only a sanitized `{present, version,
value}` observation can enter reports. The same Room is reopened by Maestro;
the same event IDs, order, and exact bodies must still be present.

The Compact observer measures the same three event rows. It requires the
actual column gap to equal 8 CSS pixels, the sum of their border-box heights
to be lower than cosy, group-start padding to equal 12 px, group-start margin
and continuation padding to equal zero, and a present trailing body gap with
absolute magnitude at most one CSS pixel. That trailing gap is measured from
the continuation row's and `.msg__body`'s used boxes, subtracting the row's
computed inline-end padding. The rendered root `data-density` may be observed
as a projection of the saved choice; it is never set by the test.

## Exact parity accounting

There are exactly 22 stage-local records, each with one unique identity:

| Source-mapped behavior                                                                         | Records |
| ---------------------------------------------------------------------------------------------- | ------: |
| Exact Room visible                                                                             |       1 |
| Three exact message bodies visible                                                             |       3 |
| One avatar and two continuation rows                                                           |       2 |
| Three actual 40 px avatar/gutter leads                                                         |       3 |
| Three aligned text left edges                                                                  |       3 |
| Cosy start padding, continuation padding, and start margin                                     |       3 |
| No phone hover toolbar                                                                         |       1 |
| Exact Compact column gap                                                                       |       1 |
| Compact total height, start padding, start margin, continuation padding, and trailing body gap |       5 |
| **Total**                                                                                      |  **22** |

The native action path, exact event-ID scoping, preference envelope, source
hashes, provenance, redaction, and teardown are mandatory fail-closed gates
outside that count. The contract cannot declare all 22 passed if any gate
fails. The desktop-only tail contributes zero Android records.

## Failure, teardown, and diagnostics

The runner has one attempt and zero retries. Every native action, Matrix
request, WebView observation, preference poll, and resource cleanup is finite
and abort-aware where appropriate. Register cleanup before dependent setup;
on failure, close the client, clear installed-app data, release the Matrix
fixture and device lease, and aggregate cleanup errors. A cleanup or diagnostic
redaction failure makes the stage fail, never a partial pass.

Started-stage reports and pass/failure text captures exist on success and
failure. They carry the checked source revision, production renderer manifest,
built/installed APK digest,
device profile, ordered sanitized event IDs, native-action receipts, the 22
assertion results, geometry summaries, sanitized density envelope, attempt and
retry counts, and cleanup status. Retain only secret-safe text diagnostics;
credentials, access/session tokens, bearer headers, raw Preferences XML,
screenshots, GIFs, and pixel baselines must not enter commits or published
diagnostics. Captures that cannot be proven secret-safe remain ignored local
output and are not attached to PR #677.

## Verification and delivery gates

The focused guard pins the three source hashes, exact Android return and
excluded desktop span, all 22 identities, native-only product actions,
preference key and versioned serialization, registry/CI ownership, and
predecessor retention. Effective negative controls must fail changes to event
sender/order/body, counts, 40 px leads, alignment, padding versus margin,
no-toolbar state, native Compact persistence, Compact height/gap/trailing
geometry, redaction, and cleanup. Guard text matches alone are insufficient.

Register a non-cached Nx Android target holding `android-avd` and `synapse`
serially, plus the package command, suite registry, CI shard, started-only
diagnostic artifact, and migration documentation. Validate the focused guard,
negative controls, Android typecheck and selected repository gates through
`pnpm nx` where targets exist. Run the unchanged installed-Android target three
times sequentially; each original attempt must pass 1/1 stage and 22/22
records with zero retries. Rerun the unchanged Playwright predecessor
sequentially with one worker and `--retries=0`, then recheck all three hashes.
Run full selected quality, production renderer and host checks, review the
complete diff, and audit the original-attempt hosted Android, browser, and
renderer artifacts before #745 can close. Report unrelated CI failures
separately rather than concealing them with a retry.

After local validation and review, commit and push the implementation batch to
`test/676-android-sidebar-filter` so hosted checks can run. Only after auditing
the original-attempt hosted evidence may #745 close, with results posted to
#745, parent #660, migration tracker #653, and PR #677. Leave PR #677 draft
and unmerged. #746 is the next issue after #745 is accepted.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-message-grouping.md` is a
preparatory plan, not implementation permission. Once this spec is approved,
the writing-plans step must reconcile that plan with the exact version-1 JSON
preference envelope, the 22-record split above, and Nx-first validation. Do
not execute the older plan unchanged or modify unrelated untracked plans.
