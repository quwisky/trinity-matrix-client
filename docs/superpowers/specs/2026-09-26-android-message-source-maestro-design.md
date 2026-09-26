# Android Message-Source Maestro Migration Design

- Issue: #752, part of #660; blocked by #751 until #751's original-attempt hosted evidence is accepted
- Status: Design accepted for local implementation while #751 completes hosted acceptance
- Branch: local `wip/752-message-source` from `4d19c94d` (the locally accepted #751 read-receipt suite on top of PR #677's `test/676-android-sidebar-filter`); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.message-source` suite. Implementation and acceptance evidence are
tracked in `e2e/android/MIGRATION.md`. The hosted audit must pass before #752
can close. The #750 quote suite is the structural template: contract,
read-only observer, artifacts and journeys modules, a Vitest guard with
effective negative controls, and the same registry, Nx, package and CI
wiring. It also supplies the native focused fill behind a digit sentinel, the
Send-button send, the measured native long press that opens the Android
message-action sheet, and bounded in-sheet swipes to reach a lower action.
The #751 suite supplies the single-stage shape and the shard-3 placement.

## Intent and source boundary

Migrate the single canonical View-source definition to one serial, one-stage
installed-Android Node/Maestro suite against real Synapse. The Playwright
predecessor stays enabled and unchanged.

The source of truth is
`e2e/browser/journeys/conversations/message-source.spec.mts` (106 lines) at
SHA-256 `1a18b0772645d8d1a9cfeb38c8f620f53f37c818543d32b044a7c48be0151ca6`.

### Pin reconciliation with the issue

The issue pins `3d7637643bb5f9b4c8124077f9eb880cb5b8e95e22a899f0ab82269f55115512`,
the predecessor as it is on `develop`. The consolidated branch carries
`fe2c7c3e` ("send composer drafts with the Send button on mobile"), which
changed exactly two lines of the predecessor: one import of
`sendComposerDraft` (line 12) and its call in place of
`composer.press('Enter')` (line 63). Every issue span therefore moves down by
one line, and the predecessor is pinned at its branch hash. The guard
rebuilds the `develop` file from the branch file and proves it hashes to the
issue pin, exactly as the #750 guard does.

`sendComposerDraft` (`e2e/support/message-composer.mts`, SHA-256
`4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d`) waits
for the composer's own Send button to be enabled before its mobile tap (line
53). That wait is an `expect` the Android path reaches, so the call expands
one composer-send-readiness record, exactly as #748 and #750 record `53@…`.
The issue's 10 records (7 direct + 3 inherited, written against `develop`)
become **11**: the same 7 direct and 3 issue-named inherited records plus one
composer-send-readiness record. The expansion is resolved by binding, so the
guard cannot silently drop it.

| Span (branch) | Span (issue) | Definition / role                                     | Direct `expect` sites         |
| ------------- | ------------ | ----------------------------------------------------- | ----------------------------- |
| 16            | 15           | module-level `synapseSession()`                       | none                          |
| 18–26         | 17–25        | local Room-opening helper `openRoom(page, roomName)`  | 23                            |
| 31–105        | 30–104       | `shows an event’s raw JSON in the view-source dialog` | 65, 78, 80, 81, 100, 103, 104 |

The definition's Android branch is 69–71 (`openMessageActionSheet`, then
`sheet-view-source`); its desktop `else` (72–74, `clickRowMenuItem` with
`msg-view-source`) is excluded, and so is the retrying `expect` that
`clickRowMenuItem` reaches. The definition calls `registerUser` (42), `login`
(58), the local `openRoom` (59), `sendComposerDraft` (63), `waitForSent` (66)
and `openMessageActionSheet` (70). `registerUser` and `login` reach no
`expect` site. The token login (43–52) and `createRoom` (53–56) are unchecked
arrangement.

The guard also pins these shared sources:

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`              | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts`          | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |
| `e2e/support/message-composer.mts` | `4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d` |

The guard pins by exact line text: the run suffix `src` (36), the Room name
`Source ${runId}` (39), the body `inspect me ${runId}` (40), the
`private_chat` preset (55), the row locator `.scroll .msg` with the body
(64), the Android branch (69–71) with `sheet-view-source`, the dialog test
ids `message-source` (77) and `message-source-json` (79), the two
`toContainText` matchers (80–81), the alpha rule on a fourth channel (92–95),
`borderTopWidth` (96) and `boxShadow !== 'none'` (97).

## Parity records: 7 direct + 4 helper-expanded = 11

One stage, `view-source`, owns every record. Identities are
`message-source.view-source.<suffix>`, in source order. A helper call runs
before a matcher on a later line; `23@59` reads as helper line 23 reached
from the call on line 59.

| #   | Source (helper@call) | Kind      | Canonical assertion                             | Suffix           |
| --- | -------------------- | --------- | ----------------------------------------------- | ---------------- |
| 1   | 23@59                | inherited | `openRoom`: composer visible                    | `room-ready`     |
| 2   | 53@63                | inherited | `sendComposerDraft`: Send enabled for the body  | `send-enabled`   |
| 3   | 65                   | direct    | the message row is visible                      | `row-visible`    |
| 4   | 178@66               | inherited | `waitForSent`: the row has a `$` id             | `server-echo`    |
| 5   | 220@70               | inherited | `openMessageActionSheet`: sheet visible         | `sheet-ready`    |
| 6   | 78                   | direct    | the message-source dialog is visible            | `dialog-visible` |
| 7   | 80                   | direct    | its JSON is the `m.room.message` event          | `json-event`     |
| 8   | 81                   | direct    | its JSON carries the exact body                 | `json-body`      |
| 9   | 100                  | direct    | the dialog surface paints a fully opaque colour | `surface-opaque` |
| 10  | 103                  | direct    | the dialog surface has a non-zero border        | `surface-border` |
| 11  | 104                  | direct    | the dialog surface has a shadow                 | `surface-shadow` |

Helper expansion is resolved by binding, as the #748–#751 guards do: a call
expands only when the TypeChecker binds it to a named import from
`../../../support/` or to a module-level function declaration of the
predecessor. A shadowing local never expands, and calls inside the excluded
desktop branch never expand.

## Selected architecture

| Unit      | File                                        | Responsibility                                                                                                                         | Boundary                                                                |
| --------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Guard     | `scripts/message-source-migration.spec.mjs` | Source pins and develop reconstruction, AST site map with Android-branch selection, binding expansion, simulated app, controls, wiring | Vitest in-process. No emulator, no network                              |
| Contract  | `e2e/android/message-source-contract.mts`   | One stage, 11 identities, source fields, pure parsers and asserters for the composer, rows, sheet, event, dialog JSON and paint        | Pure; no I/O                                                            |
| Observer  | `e2e/android/message-source-observer.mts`   | `evaluateNative` read-only expressions: composer, timeline rows, the message-action sheet, the source dialog and its computed paint    | No click, focus, key, scroll, class, style, attribute or location write |
| Artifacts | `e2e/android/message-source-artifacts.mts`  | Secrets in every form, scrub/scan, pass-only publication marker, abort revocation, cleanup                                             | Self-contained copy of the #751 policy, keyed to this suite             |
| Journeys  | `e2e/android/message-source-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, native helpers, the stage                                                                 | Maestro owns every product action                                       |

No shared source changes. `account-workspace-fixtures.mts` is reused
unchanged (`account`, `createRoom`, `roomMessages`), and so is
`account-workspace-client.mts` (`reset`, `login`, `hideKeyboard`,
`tapCurrent`, `focusCurrent`, `fillFocused`, `longPressCurrent`,
`swipeCurrent`, `waitElements`, `visible`, `record`, `capture`).

## Decisions

### D1. Profile

The stage runs at the Pixel 5 profile (393×727 CSS pixels, DPR 2.75, mobile
and touch), as #748–#750 do for the Android action-sheet branch. The
predecessor's owned path is `isAndroidE2E`: a touch long press opens the
Android message-action sheet and the mobile Send button sends. The retained
Android Playwright project reaches that branch at its 1280×720 shell by
synthesising touch; the installed app is a mobile OS on a touch device, so
the native journey uses the phone profile at which a long press and a Send
tap are genuine device input. The paint claims are computed styles of the
measured surface and do not depend on the viewport.

### D2. Native input and send

- A native tap focuses the composer; the shared focused fill types
  `inspect me <run>` behind the digit sentinel `1` (the body starts with a
  lowercase letter Android would capitalise at the start of the field, and a
  letter sentinel is autocorrected, as #748 measured). The exact value and a
  caret at its end are read back.
- Enter is a line break on a mobile device, so the send hides the keyboard,
  proves the composer's Send button enabled for the exact draft (helper line
  53), taps it natively and proves the composer cleared.
- If Gboard changes the value, the exact read-back fails the stage; the value
  is never corrected after the fact and no retry is added.

### D3. Server readiness and authoritative event

- The row is waited for as the one visible row carrying the exact body
  (line 65), then as that row reconciled to a `$` id (helper line 178). A
  pending local echo is never long-pressed.
- The Room is then read with the raw `/messages?dir=b&limit=50` page: it must
  hold exactly one `m.room.message`, the native send, whose `event_id` equals
  the reconciled row id, in the exact Room, from the active sender, an
  original `m.text` with exactly the body and no relation. REST never sends
  the message under test.
- That server event is the authoritative event the dialog JSON is compared
  with.

### D4. Native sheet and View source

- Before the long press the timeline must hold exactly one reconciled row
  matching the id-free selector and body filter, and its id must equal the
  proved event id.
- A measured native 750 ms long press opens the sheet, proved as #750 proves
  it: exactly one visible `Message actions` dialog with one visible Forward
  action (helper line 220), and exactly one `sheet-view-source` control.
- `sheet-view-source` sits below Copy text, Copy link and Forward; it is
  reached with bounded native in-sheet swipes until it is visible,
  unobstructed and inside the sheet's scroller, then tapped natively. The
  sheet must close. No other sheet action is taken; the desktop hover
  toolbar and overflow menu are never used.

### D5. Dialog and exact parsed JSON

- **78 `dialog-visible`.** Exactly one `[role="dialog"][aria-label="Message
source"]`, exactly one visible `[data-testid="message-source"]` inside it,
  exactly one `[data-testid="message-source-json"]` in that surface, and no
  message-action sheet left.
- The observer returns that JSON element's text; Node parses it strictly
  (`JSON.parse` of the whole text) and requires one plain object. Substring
  matching is never accepted.
- **80 `json-event`.** The parsed `event_id`, `type`, `sender` and `room_id`
  equal the authoritative event's and the expected values exactly: the
  proved event id, `m.room.message`, the active Account and the exact Room.
- **81 `json-body`.** The parsed `content.body` is exactly the native body
  and the parsed `content` deep-equals the authoritative content, so the
  dialog shows this event's content and not only text that contains it.

### D6. Measured paint over the conversation

- The surface's `getBoundingClientRect` is finite and non-zero, intersects
  the conversation scroller's measured box, and the element at the surface's
  centre (`elementFromPoint`, read-only) lies inside the surface: the dialog
  is drawn over the conversation.
- **100 `surface-opaque`.** The computed `backgroundColor` is parsed in Node
  (legacy `rgb()`/`rgba()`, space-separated `/ alpha`, percentage alphas and
  functional spaces such as `oklch()` and `color()`); its alpha must be
  exactly 1. `transparent`, an unparseable colour or any alpha below one
  fails.
- **103 `surface-border`.** The computed `borderTopWidth` is a finite length
  above zero and `borderTopStyle` is neither `none` nor `hidden`.
- **104 `surface-shadow`.** The computed `boxShadow` is neither empty nor
  `none`.
- Paint is read only from the computed style of the measured element; class
  names, declarations and screenshots are never consulted.

### D7. Selectors never carry identifiers

Native actions print their selector to stdout, which becomes the public job
log and `process.log`, outside the suite's artifact scan. Text filters are
not logged:

| Action      | Selector and filter                                 |
| ----------- | --------------------------------------------------- |
| Rooms rail  | `[data-testid="rail-rooms"]`                        |
| Room row    | `.channel` with `{ text: room.name }`               |
| Composer    | `[data-testid="composer-input"]`                    |
| Send        | `[data-testid="composer-send"]`                     |
| Message row | `.scroll .msg[data-mid^="$"]` with `{ text: body }` |
| Sheet swipe | the sheet surface's `.overflow-y-auto` scroller     |
| View source | `[data-testid="sheet-view-source"]`                 |

The guard rejects any selector with `data-mid=`, `data-mid*=` or an
interpolated id, and any wait description that interpolates a value.

### D8. The dialog displays identifiers: protection

The View-source dialog renders the raw event JSON, which contains the event
id, the Room id and the sender's user id; the pass and failure captures
(`passed.json`, `passed-surface.json`, `passed-ui.json` and their failure
twins) include the document text, and the capture step also writes WebView
and device screenshots.

- Every stage identifier is registered before any UI step: the run token,
  the Account user id (raw and component-encoded), username and password,
  the Room id (raw, `slice(1)`, component-encoded, base64url route segment)
  and name, and the body. The event id is registered the moment the row
  reconciles, before the sheet or the dialog opens.
- The scrub redacts every registered value in raw, JSON-escaped and
  percent-encoded form from every text diagnostic and deletes every raster,
  so no screenshot of the dialog is ever published; the fail-closed scan
  rejects any remaining identifier, raster, token or authorization header.
- The parsed JSON never leaves memory: records and receipts store digests
  (`eventDigest`, `roomDigest`, `senderDigest`), booleans and measured
  numbers only, never the JSON text or a field value.
- The issue's "preserving the event fields under test" is met by the exact
  in-memory comparison and the recorded digests and booleans; publishing the
  raw fields would publish the identifiers the house policy protects.
- Failure text rethrown to the job log keeps only error names and messages,
  redacted.

### D9. CI placement and budgets

- **Shard 3**, the last shard-3 line, directly after `message-receipts`.
  Shard 3 has the most headroom (about 163 of its 180 native minutes in a
  240-minute job); shard 5 has 10 minutes and shards 1, 2 and 6 fewer.
- Budget: one stage of about 4 minutes with Synapse and the prebuilt APK, a
  provisional 5 minutes, so shard 3 becomes about 168 native minutes.
- Timeouts (provisional, re-derived from the acceptance runs):

  | Layer                     | Timeout    |
  | ------------------------- | ---------- |
  | Node `test()`             | 600 000 ms |
  | Nx project `--timeout-ms` | 900 000    |
  | `ci-run-command` wrapper  | 1 200 000  |

- The `ci.yml` budget comment and a `ci-workflow.spec.mjs` guard record the
  new shard-3 figure. The upload count rises from 77 to 78 and the emulator
  script from 70 to 71 lines, in every guard that pins them. The #751 guards
  that make message-receipts the last shard-3 line and the last
  `MIGRATION.md` section become "followed only by message-source".

### D10. No CHANGELOG, no README

This is a test-only migration with no user impact, like #747–#751.

## Stage plan: `view-source`

1. **Arrange.** `run = aliasLocalpart('source-view-source') + 'src'`.
   Register the run, the Room name `Source <run>` and the body, then create a
   fresh Account and a private Room through real Synapse and register their
   identifiers. Nothing is seeded.
2. **Native start.** `client.reset(PIXEL_5_ACCOUNT_PROFILE)` and
   `profile-applied.json`; `client.login(account)`; `client.hideKeyboard()`.
3. **Room.** Tap the Rooms rail and the exact Room row; read the composer:
   exactly one visible composer with placeholder `Message #<name>` and the
   exact Room route → `room-ready` (23@59).
4. **Send.** Native focus and focused fill (D2); dismiss the keyboard; Send
   enabled → `send-enabled` (53@63); tap Send; composer cleared (receipt).
5. **Row.** One visible row carrying the body → `row-visible` (65); the same
   row with a `$` id → `server-echo` (178@66); the event id is registered;
   REST proof (D3) as the `message-event` receipt.
6. **Sheet.** Identity of the one ready row (D4); native long press →
   `sheet-ready` (220@70); bounded swipes to View source; native tap; sheet
   closed (receipt).
7. **Dialog.** One visible dialog → `dialog-visible` (78); strict JSON parse
   → `json-event` (80) and `json-body` (81).
8. **Paint.** Measured surface over the conversation (receipt), then
   `surface-opaque` (100), `surface-border` (103), `surface-shadow` (104).
9. **Teardown.** `capture('passed')` (or `capture('failed')`), client close,
   application data clear; Matrix cleanup, scrub and the fail-closed scan run
   as guarded cleanups.

## Observation plan

- `composerExpression()`: composer count, visibility, focus, value, caret,
  placeholder, route; Send count and disabled state.
- `timelineExpression()`: every `.scroll .msg[data-mid]` row: id, event flag,
  visibility, text.
- `sheetExpression()`: named `Message actions` dialog count and visibility,
  and the count and visibility of `sheet-forward` and `sheet-view-source`.
- `sourceExpression()`: the `Message source` dialog and surface counts, the
  surface's visibility and containment, the JSON element count and text, the
  surface's measured box and computed `backgroundColor`, `borderTopWidth`,
  `borderTopStyle` and `boxShadow`, the conversation scroller's box, whether
  the surface's centre hit-tests inside it, and the open sheet count.
- Every expression is a pure read evaluated with only `document` in scope, so
  the guard executes the exact text in jsdom against production-shaped markup.
- Every wait is finite: renderer reads through `waitForNativeShellState`, REST
  reads through the same bounded poller over `fixtures.roomMessages`.

## Negative-control plan (guard, each must fail when its protection is removed)

- **Source shape.** A pinned hash differs by one byte; the develop
  reconstruction no longer hashes to the issue pin; a line pin, the body or
  Room template, the run suffix, a test id, the alpha rule, the border or
  shadow check drifts; a direct site is dropped or added; a helper call is
  removed or shadowed; the desktop branch is counted; the predecessor gains
  `test.only`/`fixme` or loses its single Synapse skip.
- **Ready event identity.** A local echo id, no server echo, a second or
  REST-seeded message, another sender, body or Room, a relation, or a row
  whose id is not the server event fails before `sheet-ready`.
- **Native sheet and View-source ownership.** No sheet, two sheets, a missing
  Forward or View-source control, a View source that stays out of reach, a
  sheet left open, or a long press on another row fails.
- **Exact parsed JSON.** No dialog, two dialogs, a hidden surface, invalid or
  non-object JSON, JSON that merely contains the body, and each of
  `event_id`, `type`, `sender`, `room_id` and `content.body` drifting
  (including a local-echo id and a different event of the Room) fails.
- **Opaque paint over the conversation.** A transparent or semi-transparent
  background in every colour syntax, an unparseable colour, a zero border,
  `border-style: none`, `box-shadow: none`, a zero or non-finite box, a
  surface off the conversation or covered at its centre fails.
- **Cleanup and redaction.** Every raw, escaped, percent-encoded, sliced and
  base64url identifier and credential, including a dialog JSON capture, is
  rejected by the scan and removed by the scrub; rasters are removed; a
  failed cleanup, scrub or scan blocks publication; an abort revokes the
  marker; stage failures rethrow redacted.
- **Journey rules.** Any DOM click, focus, value write, dispatch, navigation,
  REST text send, `evaluateNative` in the journeys, desktop hover path,
  retry, unbounded wait, id-bearing selector, missing record proof, or
  out-of-order native step fails the source rules.
- **Wiring.** Cache or parallelism on, a missing resource, a wrong entrypoint,
  a missing package script, a wrong shard, timeout or order, a gate path or
  upload condition drift, or a stale upload/line count fails.

## Evidence and acceptance plan

1. Guard, typecheck (`e2e/tsconfig.json`), ESLint and Prettier on changed files,
   and the full `scripts/*.spec.mjs` suite.
2. Device development until the stage passes; each device finding is fixed at
   its root, never with a retry or a loosened assertion.
3. On the final unchanged commit, with a fresh production renderer and
   manifest: three consecutive `trinity-e2e-android:message-source` first
   attempts, each 1/1 stage, 11/11 records, attempt 1, retries 0,
   `publication-safe`, built APK digest equal to the installed digest,
   renderer `production` at the final commit, an empty identifier scan
   including `process.log`, no published raster, and no focused fill that
   needed its second attempt.
4. The exact browser predecessor at `--workers=1 --retries=0`.
5. Hosted: audit the original-attempt shard-3 `android-message-source`
   artifact, the retained predecessor and the renderer manifest before
   closing #752.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-message-source.md` is
preparatory. This design changes it as follows:

- 11 identities, not 10: the predecessor now sends through
  `sendComposerDraft`, whose mobile Send-button wait is a reached `expect`.
- CI placement is shard 3 after `message-receipts`, not shard 2 (shard 2 has
  about 3 minutes of headroom; message-receipts runs on shard 3).
- No new fixture: the existing `roomMessages` reader observes the
  authoritative event.
- The plan's structured-evidence allowlist for the five event fields is
  replaced by digests and booleans (D8): the fields are compared exactly in
  memory, and every identifier stays a registered secret.
