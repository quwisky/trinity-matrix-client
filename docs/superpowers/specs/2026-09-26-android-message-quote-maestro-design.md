# Android Message-Quote Maestro Migration Design

- Issue: #750, part of #660; blocked by #749 until #749's original-attempt hosted evidence is accepted
- Status: Design accepted for local implementation while #749 completes hosted acceptance
- Branch: local `wip/750-quotes` from `e7d4187e` (the head of PR #677's `test/676-android-sidebar-filter`); PR #677 stays draft and unmerged

This document records the design for the installed-Android `android.message-quote`
suite. Implementation and acceptance evidence are tracked in
`e2e/android/MIGRATION.md`. The hosted audit must pass before #750 can close.
The #749 poll suite is the structural template: contract, read-only observer,
artifacts and journeys modules, a Vitest guard with effective negative
controls, and the same registry, Nx, package and CI wiring. The #748 Markdown
suite supplies the native multiline input, the Send-button send and the
native long press that opens the Android message-action sheet.

## Intent and source boundary

Migrate both canonical quote definitions to one serial, two-stage
installed-Android Node/Maestro suite against real Synapse. The Playwright
predecessor stays enabled and unchanged.

The source of truth is
`e2e/browser/journeys/conversations/message-quote.spec.mts` (218 lines) at
SHA-256 `50b0e8a42aa1d61ee59b1c5dce97664365977aef7bc8b36aa3502e23e731064f`.

### Pin reconciliation with the issue

The issue pins `fdd2a9dc98324aaea47a4d6fd3bf768bd35756119eafd4751faee849da5baf66`,
the predecessor as it is on `develop`. The consolidated branch this suite is
built on carries `fe2c7c3e` ("send composer drafts with the Send button on
mobile"), which changed exactly four lines of the predecessor: one import of
`sendComposerDraft` (line 13) and its three calls in place of
`composer.press('Enter')` (lines 79, 101 and 178). Every issue span therefore
moves down by one line, and the predecessor is pinned at its branch hash.
The same commit re-pinned the #748 Markdown predecessor the same way.

`sendComposerDraft` (`e2e/support/message-composer.mts`, SHA-256
`4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d`) waits for
the composer's own Send button to be enabled before its mobile tap (line 53).
That wait is an `expect` the Android path reaches, so each of the three calls
expands one composer-send-readiness record, exactly as the Markdown suite
records `53@85`. The issue's 20 records (13 direct + 7 inherited, written
against `develop`) become **23**: the same 13 direct and 7 issue-named
inherited records plus three composer-send-readiness records. The helper
expansion is resolved by binding, so the guard cannot silently drop them.

| Span (branch) | Span (issue) | Definition / role                                                             | Direct `expect` sites           |
| ------------- | ------------ | ----------------------------------------------------------------------------- | ------------------------------- |
| 27            | 26           | module-level `synapseSession()`                                               | none                            |
| 29–37         | 28–36        | local Room-opening helper `openRoom(page, roomName)`                          | 34                              |
| 42–115        | 41–114       | `pulls a message into the composer as a > block and sends it as a blockquote` | 82, 94, 104, 110, 111, 112, 114 |
| 117–217       | 116–216      | `offers no Quote for a message with no text to bring` (Android branches only) | 181, 185, 187, 200, 204, 205    |

The quote definition's Android branch is 85–87; its desktop `else` (88–90,
`clickRowMenuItem`) is excluded. The capability definition's Android branches
are 183–187 and 201–205; its desktop `else` branches 188–197 (direct site 193
and `clickRowToolbar`) and 206–216 (direct sites 212 and 215 and
`clickRowToolbar`) are excluded. Line 200 (`imageRow` visible) is shared by
both platforms and is owned.

The guard also pins these shared sources:

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`              | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts`          | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |
| `e2e/support/message-composer.mts` | `4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d` |

The guard pins by exact line text: the run suffixes `q` (47) and `qn` (122),
the Room name templates `Quote ${runId}` (50) and `Quote none ${runId}` (125),
the paragraphs `alpha ${runId}` (51) and `omega ${runId}` (52), the two
Shift+Enter presses (76–77), the exact composer value
`` `> ${first}\n>\n> ${second}\n\n` `` (94), the answer `my point ${runId}`
(99), the control `plain ${runId}` (126), the PNG base64, `image/png`,
`filename=shot.png`, the transaction `${runId}img` and
`{ msgtype: 'm.image', body: 'shot.png', url: mxc }` (149–169), and the test
ids `sheet-quote` and `sheet-copy`.

## Parity records: 13 direct + 10 helper-expanded = 23

Identities are `message-quote.<stage>.<suffix>`, in source order. A helper call
runs before a matcher on a later line; `34@71` reads as helper line 34 reached
from the call on line 71.

### Stage `quote-block` (42–115): 12 records

| #   | Source (helper@call) | Kind      | Canonical assertion                              | Suffix                |
| --- | -------------------- | --------- | ------------------------------------------------ | --------------------- |
| 1   | 34@71                | inherited | `openRoom`: composer visible                     | `room-ready`          |
| 2   | 53@79                | inherited | `sendComposerDraft`: Send enabled for the source | `source-send-enabled` |
| 3   | 82                   | direct    | source row visible                               | `source-visible`      |
| 4   | 178@83               | inherited | `waitForSent`: source row has a `$` id           | `source-server-echo`  |
| 5   | 220@86               | inherited | `openMessageActionSheet`: sheet visible          | `sheet-ready`         |
| 6   | 94                   | direct    | composer is exactly `> first\n>\n> second\n\n`   | `composer-quote`      |
| 7   | 53@101               | inherited | `sendComposerDraft`: Send enabled for the quote  | `answer-send-enabled` |
| 8   | 104                  | direct    | answer row visible                               | `answer-visible`      |
| 9   | 110                  | direct    | exactly one blockquote                           | `one-blockquote`      |
| 10  | 111                  | direct    | blockquote contains the first paragraph          | `quotes-first`        |
| 11  | 112                  | direct    | blockquote contains the second paragraph         | `quotes-second`       |
| 12  | 114                  | direct    | blockquote excludes the answer                   | `answer-outside`      |

### Stage `quote-capability` (117–217): 11 records

| #   | Source (helper@call) | Kind      | Canonical assertion                               | Suffix                 |
| --- | -------------------- | --------- | ------------------------------------------------- | ---------------------- |
| 1   | 34@172               | inherited | `openRoom`: composer visible                      | `room-ready`           |
| 2   | 53@178               | inherited | `sendComposerDraft`: Send enabled for the control | `control-send-enabled` |
| 3   | 181                  | direct    | text control row visible                          | `control-visible`      |
| 4   | 178@182              | inherited | `waitForSent`: control row has a `$` id           | `control-server-echo`  |
| 5   | 220@184              | inherited | `openMessageActionSheet`: text sheet visible      | `text-sheet-ready`     |
| 6   | 185                  | direct    | text sheet shows Quote                            | `text-quote-visible`   |
| 7   | 187                  | direct    | sheet closed after native Cancel                  | `text-sheet-closed`    |
| 8   | 200                  | direct    | image row visible                                 | `image-visible`        |
| 9   | 220@202              | inherited | `openMessageActionSheet`: image sheet visible     | `image-sheet-ready`    |
| 10  | 204                  | direct    | image sheet shows Copy                            | `image-copy-visible`   |
| 11  | 205                  | direct    | image sheet has no Quote                          | `image-no-quote`       |

Helper expansion is resolved by binding, as the #748/#749 guards do: a call
expands only when the TypeChecker binds it to a named import from
`../../../support/` or to a module-level function declaration of the
predecessor. Calls inside the excluded desktop branches never expand.

## Selected architecture

| Unit      | File                                          | Responsibility                                                                                                        | Boundary                                                                |
| --------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Guard     | `scripts/message-quote-migration.spec.mjs`    | Source pins, AST site maps with Android-branch selection, binding-resolved expansion, simulated app, controls, wiring | Vitest in-process. No emulator, no network                              |
| Contract  | `e2e/android/message-quote-contract.mts`      | Two stages, 23 identities, quote fields, PNG fixture, pure parsers and asserters for renderer, sheet and events       | Pure; no I/O                                                            |
| Observer  | `e2e/android/message-quote-observer.mts`      | `evaluateNative` read-only expressions: composer, timeline rows with blockquotes and images, the message-action sheet | No click, focus, key, scroll, class, style, attribute or location write |
| Artifacts | `e2e/android/message-quote-artifacts.mts`     | Secrets in every form (including the media URI), scrub/scan, pass-only publication marker, abort revocation, cleanup  | Self-contained copy of the #749 policy, keyed to this suite             |
| Journeys  | `e2e/android/message-quote-journeys.mts`      | Runner, proof-first `record()`, `receipt()`, native helpers, both stage functions                                     | Maestro owns every product action                                       |
| Flow      | `e2e/android/flows/message-quote-append.yaml` | Append text at the focused composer caret without erasing or dismissing the keyboard                                  | Same shape as the Markdown append flow                                  |

Shared change: `account-workspace-fixtures.mts` gains one additive REST
fixture, `sendImageMessage`, which uploads exact bytes as `image/png` with a
filename and sends one `m.image` with a transaction id. It is the only way to
reach the closure-private access token; no other suite calls it.
`account-workspace-client.mts` is reused unchanged (`tapCurrent`,
`focusCurrent`, `focused`, `fillFocused`, `key`, `keyCombination`,
`longPressCurrent`, `swipeCurrent`, `elements`, `waitElements`,
`hideKeyboard`, `login`).

## Decisions

### D1. Profile

Both stages run at the Pixel 5 profile (393×727 CSS pixels, DPR 2.75, mobile
and touch), as #748 and #749 do. The installed app is a mobile OS, so a long
press opens the Android message-action sheet and Enter inserts a line break.

### D2. Native multiline input

- The predecessor's `fill(first)`, two Shift+Enter and `pressSequentially(second)`
  become: a native tap focuses the composer; the shared focused fill types
  `first` behind the digit sentinel `1` (both paragraphs start with a
  lowercase letter that Android would capitalise as a new paragraph); two
  native Enter keys, each proved by the exact composer value and a caret at
  its end (`alpha …\n`, then `alpha …\n\n`); then the second paragraph is
  appended at the caret behind the same sentinel.
- The append (`appendNativeLine`) never erases: the append flow types
  `1omega …`, the value and caret are proved, the caret walks left over the
  paragraph and is proved one past the sentinel, Backspace removes the
  sentinel and the value is proved, Ctrl+End restores the caret and it is
  proved at the end. Every key waits for the state the previous key produced,
  as the shared focused fill now does after its chords.
- The answer `my point …` is appended the same way after the Quote action,
  which leaves the composer focused with its caret at the end (`applyEdit`).
- The text control `plain …` is typed through the focused fill behind `1`.
- If Gboard changes a typed value, the exact read-back fails the stage; the
  value is never corrected after the fact and no retry is added.
- Enter is a line break on a mobile device, so every send hides the keyboard
  through the IME-aware helper, proves the composer's Send button enabled
  for the exact draft (helper line 53) and taps it natively.

### D3. Server readiness and identity

- The source row and the text control row are waited for as the reconciled
  row carrying their exact text with a `$` id (helper line 178). The Room is
  then read with the raw `/messages?dir=b&limit=50` page: it must hold exactly
  the native sends so far, oldest first, whose ids equal the reconciled rows,
  from the active sender, `m.text`, original (no relation), with the exact
  body (`alpha …\n\nomega …` with a real blank line; `plain …`).
- The quote event is proved before any blockquote record: the Room holds
  exactly `[source, quote]`; the quote is an original `m.text` from the active
  sender with body exactly `> alpha …\n>\n> omega …\n\nmy point …`,
  `format: org.matrix.custom.html`, and a `formatted_body` with exactly one
  `<blockquote>` holding both paragraphs and not the answer, followed by the
  answer outside it. `content['m.relates_to']` is absent, so there is no
  `m.in_reply_to` and no other relation.
- The image fixture is proved on the wire before the image row is used: the
  Room holds the one `m.image` with the transaction's event id, body
  `shot.png`, the uploaded `mxc://` URI and the active sender.

### D4. Rendered blockquote

Lines 110–114 are read from the reconciled quote row (its id equals the
quote event id): exactly one `blockquote` in the row's rendered HTML text,
its text contains `alpha …` and `omega …` and does not contain `my point …`,
and the answer is rendered in the same `.msg__text` outside the blockquote.
Plain quote-looking text without a real `blockquote` element fails.

### D5. Android sheet branches

- Every sheet is opened by a measured native 750 ms long press, and proved
  as the Markdown and message-forward suites prove it: exactly one visible
  `Message actions` dialog with one visible Forward action (helper line 220).
- Quote: after the source sheet opens, a native tap on `sheet-quote`; the
  sheet closes and the composer value is exactly the inserted block (line 94).
- Text control: `sheet-quote` is exactly one visible control (185); the
  sheet's Cancel button is reached with bounded native in-sheet swipes and
  tapped natively; the sheet is proved gone (187).
- Image: the same sheet shows exactly one visible `sheet-copy` (204), the
  positive per-message control, and zero `sheet-quote` (205). Quote absence
  is never accepted without the opened sheet and its Copy control.
- No sheet action other than Quote and Cancel is taken; the image sheet is
  left for teardown, which clears application data.

### D6. Selectors never carry identifiers

Native actions print their selector to stdout, which becomes the public job
log and `process.log`, outside the suite's artifact scan. Rows are targeted by
id-free selectors; text filters are not logged:

| Action      | Selector and filter                                                    |
| ----------- | ---------------------------------------------------------------------- |
| Rooms rail  | `[data-testid="rail-rooms"]`                                           |
| Room row    | `.channel` with `{ text: room.name }`                                  |
| Composer    | `[data-testid="composer-input"]`                                       |
| Send        | `[data-testid="composer-send"]`                                        |
| Source row  | `.scroll .msg[data-mid^="$"]` with `{ text: first }`                   |
| Control row | `.scroll .msg[data-mid^="$"]` with `{ text: body }`                    |
| Image row   | `.scroll .msg[data-mid^="$"]` with `{ text: 'shot.png' }`              |
| Quote       | `[data-testid="sheet-quote"]`                                          |
| Cancel      | `[role="dialog"][aria-label="Message actions"] button`, exact `Cancel` |

The guard rejects any selector with `data-mid=`, `data-mid*=` or an
interpolated id. Identity is proved read-only: before each long press the
timeline must hold exactly one row matching the selector and filter, and its
id must equal the proved event id (source, control or image).

### D7. Identifier protection

Every stage identifier is registered before any UI step: the run token, the
Account user id, username and password, the Room id (raw, `slice(1)`,
component-encoded, base64url route segment) and name, the image media URI
and its media id as soon as the upload returns, and each event id (source,
quote, control, image) as soon as it is known. The quoted and typed texts
contain the run token and are therefore covered. Records and receipts store
digests (`roomDigest`, `eventDigest`) and booleans, never raw values. The scan
also rejects `access_token` values and `Bearer` authorization. Failure text
rethrown to the job log keeps only error names and messages, redacted.

### D8. CI placement and budgets

- **Shard 6**, the last shard-6 line, directly after `room-widget-settings`.
  Shard 1 (113) would exceed its 120-minute native allowance; shard 6 (106)
  has the most room.
- Budget: the two stages took 372 s and 324 s on the first passing device
  run (about 12 minutes of wall time with Synapse and the prebuilt APK), a
  provisional 12 minutes, so shard 6 becomes about 118 native minutes,
  within the 120-minute native allowance of a 180-minute job (45 retained
  Playwright + 15 setup).
- Timeouts (provisional, re-derived from the acceptance runs):

  | Layer                     | Timeout      |
  | ------------------------- | ------------ |
  | Node `test()`             | 1 200 000 ms |
  | Nx project `--timeout-ms` | 1 500 000    |
  | `ci-run-command` wrapper  | 1 800 000    |

- The `ci.yml` budget comment and a `ci-workflow.spec.mjs` guard record the new
  shard-6 figure. The upload count rises from 75 to 76 and the emulator script
  from 68 to 69 lines, in every guard that pins them.

### D9. No CHANGELOG, no README

This is a test-only migration with no user impact, like #747, #748 and #749.

### D10. The image fixture renders as a download tile (device finding)

The first device run failed at `image-visible` with the selector
`:has(.media--image)`. The failure capture showed the row as `↓ shot.png
application/octet-stream`: the pinned fixture (`{ msgtype: 'm.image', body:
'shot.png', url }`) carries no `info.mimetype`, and the renderer classifies
media by MIME type, so it draws a named download tile rather than an `<img>`.
That tile's name is exactly the text the predecessor's
`page.locator('.scroll .msg', { hasText: 'shot.png' })` matches. The fixture
is pinned and stays unchanged; the row is targeted as the predecessor targets
it, by the id-free ready-row selector with the `shot.png` filter, and proved
read-only to be the fixture event with exactly one media attachment and no
message text. Whether an `m.image` without `info` should render as an image is
a product question outside this migration.

## Stage plan: `quote-block`

1. **Arrange.** `run = aliasLocalpart('quote-quote-block') + 'q'`. Register the
   Room name `Quote <run>`, then create a fresh Account and a private Room
   through real Synapse and register their identifiers. Nothing is seeded.
2. **Native start.** `client.reset(PIXEL_5_ACCOUNT_PROFILE)` and
   `profile-applied.json`; `client.login(account)`; `client.hideKeyboard()`.
3. **Room.** Tap the Rooms rail and the exact Room row; read the composer:
   exactly one visible composer with placeholder `Message #<name>` and the
   exact Room route → `room-ready` (34@71).
4. **Source.** Native multiline input (D2) → exact `alpha …\n\nomega …`;
   dismiss the keyboard; Send enabled → `source-send-enabled` (53@79); tap
   Send; composer cleared (receipt).
5. **Source row.** One visible row carrying `alpha …` → `source-visible` (82);
   the same row with a `$` id → `source-server-echo` (178@83); REST source
   proof (D3) as a receipt.
6. **Quote.** Native long press on the source row (D6); the sheet →
   `sheet-ready` (220@86); tap Quote; the sheet closes; the composer holds
   exactly `> alpha …\n>\n> omega …\n\n` with the caret at its end →
   `composer-quote` (94).
7. **Answer.** Append `my point …` natively (D2); dismiss the keyboard; Send
   enabled → `answer-send-enabled` (53@101); tap Send; composer cleared.
8. **Quote event.** REST quote proof (D3) as a receipt; then the reconciled
   quote row visible with the answer → `answer-visible` (104); its rendered
   blockquote → `one-blockquote` (110), `quotes-first` (111),
   `quotes-second` (112), `answer-outside` (114).
9. **Teardown.** `capture('passed')` (or `capture('failed')`), client close,
   application data clear; Matrix cleanup, scrub and the fail-closed scan run
   as guarded cleanups.

## Stage plan: `quote-capability`

1. **Arrange.** `run = aliasLocalpart('quote-quote-capability') + 'qn'`.
   Register the Room name `Quote none <run>`, create a fresh Account and Room,
   then upload the pinned 1×1 PNG (`image/png`, `shot.png`) and send the one
   `m.image` fixture with transaction `<run>img`; register the media URI,
   media id and image event id. The text control is not seeded.
2. **Native start, Room.** As in `quote-block` → `room-ready` (34@172).
3. **Control.** Native tap and focused fill of `plain …`; dismiss the
   keyboard; Send enabled → `control-send-enabled` (53@178); tap Send.
4. **Control row.** One visible row carrying `plain …` → `control-visible`
   (181); the same row with a `$` id → `control-server-echo` (178@182); REST
   proof of `[image, control]` in order as a receipt.
5. **Text sheet.** Native long press on the control row; the sheet →
   `text-sheet-ready` (220@184); one visible Quote → `text-quote-visible`
   (185); reach and tap Cancel natively; no sheet → `text-sheet-closed` (187).
6. **Image row.** Exactly one visible row carries `shot.png`, as the
   predecessor finds it; its id is the image event id, it holds one media
   attachment and no `.msg__text` → `image-visible` (200) (D10).
7. **Image sheet.** Native long press on the image row; the sheet →
   `image-sheet-ready` (220@202); one visible Copy → `image-copy-visible`
   (204); zero Quote in that same open sheet → `image-no-quote` (205).
8. **Teardown.** As in `quote-block`.

## Observation plan

- `composerExpression()`: composer count, visibility, focus, value, caret,
  placeholder, route; Send count and disabled state.
- `timelineExpression()`: every `.scroll .msg[data-mid]` row: id, event flag,
  visibility, text, image count; per `.msg__text`: HTML flag, text, and each
  `blockquote`'s text and visibility.
- `sheetExpression()`: named `Message actions` dialog count and visibility,
  and the count and visibility of `sheet-quote`, `sheet-copy`,
  `sheet-forward` and the exact `Cancel` button.
- Every expression is a pure read evaluated with only `document` in scope, so
  the guard executes the exact text in jsdom against production-shaped markup.
- Every wait is finite: renderer reads through `waitForNativeShellState`, REST
  reads through the same bounded poller over `fixtures.roomMessages`.

## Negative-control plan (guard, each must fail when its protection is removed)

- **Source shape.** A pinned hash differs by one byte; a line pin, the
  paragraph or answer template, the quoted value, the PNG bytes, MIME type,
  filename or `m.image` content, a test id or run suffix drifts; a direct site
  is dropped or added; a helper call is removed or shadowed; a desktop branch
  site is counted; the predecessor gains `test.only`/`fixme` or loses its
  single Synapse skip.
- **Native multiline source.** A single Enter or three, a missing blank line,
  a `\r`, a capitalised or sentinel-prefixed paragraph, or a sentinel left
  after the append fails before `source-send-enabled`.
- **Exact composer quote.** An unmarked blank line (`> a\n\n> b`), a missing
  trailing blank line, a stacked or duplicated block, or a caret not at the end
  fails `composer-quote`.
- **Ready quote event.** A local echo id, a relation of any kind including
  `m.in_reply_to`, a missing or plain `formatted_body`, a second blockquote, a
  paragraph outside the blockquote, the answer inside it, another sender, or
  an extra event fails before `answer-visible`.
- **Rendered blockquote.** No blockquote, two, a blockquote missing either
  paragraph, the answer inside, or the row of another event fails.
- **Text control.** Quote hidden or missing, a sheet that stays open after
  Cancel, or a second sheet fails.
- **Image capability.** A Quote on the image sheet, a missing or hidden Copy,
  a sheet opened on the text row instead, an image row with text, or an
  image event other than the fixture fails.
- **Cleanup and redaction.** Every raw, escaped, percent-encoded, sliced and
  base64url identifier, media URI and credential is rejected by the scan and
  removed by the scrub; rasters are removed; a failed cleanup, scrub or scan
  blocks publication; an abort revokes the marker; stage failures rethrow
  redacted.
- **Journey rules.** Any DOM click, focus, value write, dispatch, navigation,
  REST text send, `evaluateNative` in the journeys, retry, unbounded wait,
  id-bearing selector, missing record proof, desktop hover path, or
  out-of-order native step fails the source rules.
- **Wiring.** Cache or parallelism on, a missing resource, a wrong entrypoint,
  a missing package script, a wrong shard, timeout or order, a gate path or
  upload condition drift, or a stale upload/line count fails.

## Evidence and acceptance plan

1. Guard, typecheck (`e2e/tsconfig.json`), ESLint and Prettier on changed files,
   and the full `scripts/*.spec.mjs` suite.
2. Device development until both stages pass; each device finding is fixed at
   its root, never with a retry or a loosened assertion.
3. On the final unchanged commit, with a fresh production renderer and
   manifest: three consecutive `trinity-e2e-android:message-quote` first
   attempts, each 2/2 stages, 23/23 records (12/11), attempt 1, retries 0,
   `publication-safe`, built APK digest equal to the installed digest,
   renderer `production` at the final commit, an empty identifier scan
   including `process.log`, and no focused fill that needed its second
   attempt.
4. The exact browser predecessor at `--workers=1 --retries=0`.
5. Hosted: audit the original-attempt shard-6 `android-message-quote`
   artifact, the retained predecessor and the renderer manifest before
   closing #750.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-message-quote.md` is preparatory.
This design changes it as follows:

- 23 identities (12/11), not 20 (10/10): the predecessor now sends through
  `sendComposerDraft`, whose mobile Send-button wait is a reached `expect`.
- CI placement is shard 6 after `room-widget-settings`, not shard 2 after
  message-poll (message-poll runs on shard 1, and neither shard 1 nor 2 has
  room).
- One additive fixture (`sendImageMessage`) is needed for the PNG, because the
  access token is closure-private; the #748 `roomMessages` reader composes
  every event observation.
- Event ids and the media URI are registered secrets everywhere; records hold
  digests only.
