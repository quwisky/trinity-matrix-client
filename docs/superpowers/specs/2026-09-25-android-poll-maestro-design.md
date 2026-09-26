# Android Poll Maestro Migration Design

- Issue: #749, part of #660; blocked by #748 until #748's original-attempt hosted evidence is accepted
- Status: Design accepted for local implementation while #748 completes hosted acceptance
- Branch: local `wip/749-poll` from `1ff6adf0` (the head of PR #677's `test/676-android-sidebar-filter`); PR #677 stays draft and unmerged

This document records the design for the installed-Android `android.message-poll`
suite. Implementation and acceptance evidence are tracked in
`e2e/android/MIGRATION.md`. The hosted audit must pass before #749 can close.
The #748 Markdown suite is the structural template: contract, read-only
observer, artifacts and journeys modules, a Vitest guard with effective
negative controls, and the same registry, Nx, package and CI wiring.

## Intent and source boundary

Migrate the single canonical poll create/vote/end definition to one serial,
one-stage installed-Android Node/Maestro suite against real Synapse. The
Playwright predecessor stays enabled and unchanged.

The source of truth is
`e2e/browser/journeys/conversations/message-poll.spec.mts` (93 lines) at SHA-256
`e23c045d237ba9fde15eb5a39d24479dfc2019e07579142c9193a8dc05ea1674`.

| Span  | Definition / role                                | Direct `expect` sites          |
| ----- | ------------------------------------------------ | ------------------------------ |
| 12    | module-level `synapseSession()`                  | none                           |
| 14–22 | local Room-opening helper `openRoom(page, name)` | 19                             |
| 27–92 | `creates a poll, votes, and ends it`             | 59, 60, 73, 74, 75, 86, 87, 91 |

The definition calls `registerUser` (32), `login` (48), the local `openRoom`
(54) and `waitForSent` (80). `registerUser` and `login` reach no `expect`
site. The local `openRoom` reaches line 19 (the composer is visible) and
`waitForSent` reaches `e2e/support/app.mts` line 178 (the row's `data-mid`
starts with `$`). The inline password login (33–41) and `createRoom` (43–46)
are unchecked arrangement.

The guard also pins these shared sources:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`     | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts` | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |

The poll fields the predecessor drives are pinned by exact line text: the
question template `Best fruit ${runId}?` (65), the options `Apple` (67) and
`Pear` (68), the run suffix `p` (28), the Room name template `Poll E2E ${runId}`
(42), and the test ids `composer-insert`, `composer-poll`, `insert-poll`,
`poll-question`, `poll-option-0`, `poll-option-1`, `poll-create`, `poll` and
`poll-end`.

## Parity records: 8 direct + 2 helper-expanded = 10

One stage, `create-vote-end`, owns every record. Identities are
`message-poll.create-vote-end.<suffix>`, in source order. A helper call runs
before a matcher on a later line; `19@54` reads as helper line 19 reached from
the call on line 54.

| #   | Source (helper@call) | Kind      | Canonical assertion                  | Suffix                |
| --- | -------------------- | --------- | ------------------------------------ | --------------------- |
| 1   | 19@54                | inherited | `openRoom`: composer visible         | `room-ready`          |
| 2   | 59                   | direct    | `composer-insert` visible            | `insert-tray`         |
| 3   | 60                   | direct    | `composer-poll` count 0              | `no-inline-poll`      |
| 4   | 73                   | direct    | first `poll` visible                 | `poll-visible`        |
| 5   | 74                   | direct    | poll contains the exact question     | `poll-question`       |
| 6   | 75                   | direct    | poll contains `0 votes`              | `zero-votes`          |
| 7   | 178@80               | inherited | `waitForSent`: poll row has a `$` id | `server-echo`         |
| 8   | 86                   | direct    | poll contains `1 vote`               | `one-vote`            |
| 9   | 87                   | direct    | poll contains `1 (100%)`             | `one-hundred-percent` |
| 10  | 91                   | direct    | poll contains `Final results`        | `final-results`       |

Helper expansion is resolved by binding, as the #748 guard does: a call
expands only when the TypeChecker binds it to an imported helper from
`../../../support/` or to a module-level function declaration of the
predecessor itself. A shadowing local constant of the same name never
expands. The local `openRoom` is the one module-local helper.

## Selected architecture

| Unit      | File                                      | Responsibility                                                                                                           | Boundary                                                                |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Guard     | `scripts/message-poll-migration.spec.mjs` | Source pins, AST site maps, binding-resolved helper expansion, contract/observer/artifact controls, source rules, wiring | Vitest in-process. No emulator, no network                              |
| Contract  | `e2e/android/message-poll-contract.mts`   | One stage, 10 identities, poll fields, pure parsers and asserters for renderer and MSC3381 events                        | Pure; no I/O                                                            |
| Observer  | `e2e/android/message-poll-observer.mts`   | `evaluateNative` read-only expressions: composer and tray controls, Create poll dialog fields, poll rows                 | No click, focus, key, scroll, class, style, attribute or location write |
| Artifacts | `e2e/android/message-poll-artifacts.mts`  | Secrets in every form, scrub/scan, pass-only publication marker, abort revocation, stage cleanup runner                  | Self-contained copy of the #748 policy, keyed to this suite             |
| Journeys  | `e2e/android/message-poll-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, native helpers, the stage function                                          | Maestro owns every product action                                       |

The only shared change is the read-only caret wait inside `fillFocused`
(D2), found on the device. `account-workspace-fixtures.mts` already provides
`account`, `createRoom` and the raw `roomMessages` page reader that #748 added;
`account-workspace-client.mts` already provides `tapCurrent`, `focusCurrent`,
`focused`, `fillFocused(selector, value, sentinel)`, `hideKeyboard`,
`waitElements` and `login`. No new Maestro YAML is needed: taps use
`accounts-current-point-tap.yaml` and input uses `accounts-focused-fill.yaml`.

## Decisions

### D1. Profile

The stage runs at the Pixel 5 profile (393×727 CSS pixels, DPR 2.75, mobile
and touch), as #748 does. The issue asks for the phone composer. The installed
app is a mobile OS in either profile, so the `+` opens the mobile action sheet
(`isMobileOs()`), never the desktop dropdown. The predecessor comment on lines
56–58 (desktop viewport) is a Playwright-only detail.

### D2. Native input and Gboard

- The Create poll dialog autofocuses `[data-testid=poll-question]`
  (`create-poll.service.ts`). The journey proves that focus read-only (the
  dialog observation and `fillFocused`'s own focus wait), then types the
  question through `fillFocused` without a Tab or a scripted focus.
- `poll-option-0` and `poll-option-1` are focused by a native tap
  (`focusCurrent`) and typed through `fillFocused`.
- Every field uses the sentinel `(` (`FIELD_SENTINEL`). Every poll value starts
  with a capital, so capitalization is not at stake; the sentinel only has to
  stay out of the first word. The first device run disproved the #748 digit
  sentinel for this input: Gboard joins a letter or digit to the first word
  and recases it on the next space. An `<input>` probe on the emulator (the
  exact `fillFocused` key sequence) gave `1Best fruit …` → `1best fruit …` and
  `xBest fruit …` → `Xbest fruit …` in every trial, while single words
  (`1Apple`, `1Pear`) stayed exact. `(`, `.`, `,` and `*` all kept the value
  exact; `(` passed 20/20 trials for the question, `Apple` and `Pear`.
- The second device run passed only through `fillFocused`'s own second
  attempt: on the autofocused question the value kept its sentinel.
  Instrumenting the fill showed the caret still at the end when Forward Delete
  arrived; Ctrl+Home moved it afterwards. The chord and the key are separate
  adb injections the WebView applies later, so the delete raced the caret
  move. The fix is in the shared fill, not in this suite: a bounded read-only
  wait for the caret at the start before Forward Delete and at the end before
  the final space. No retry is added and no assertion is loosened.
- The exact field values are read back from the dialog before Create is
  tapped, and the exact question is later required in the poll row and in the
  authoritative start event. If Gboard changes a typed value, the stage fails;
  it is never corrected after the fact.
- `fillFocused` ends with the IME-aware `hideKeyboard`, so the Create tap is
  never made under the on-screen keyboard.

### D3. Server readiness before the vote

The predecessor waits for the poll row's `data-mid` to start with `$` before it
clicks (`waitForSent`, line 80). The journey records `server-echo` from the
same read-only row observation, then reads the Room with the #748 raw
`/messages?dir=b&limit=50` page. The page must hold exactly one poll event,
the `m.poll.start` whose id equals the reconciled row id, with the active
sender, the exact question, `m.poll.disclosed`, `max_selections: 1` and
exactly the answers `a0 Apple` and `a1 Pear`. No response or end event may
exist yet. Only then is Apple tapped, after the observer proves the Apple
option is the first option and is enabled.

### D4. Vote and end are proved on the wire first

- **Vote.** After the native Apple tap, a bounded REST poll waits for exactly
  `[start, response]`. The response must be `m.poll.response` from the active
  sender with `answers: ['a0']` and an `m.reference` relation to the start
  event. Then the same poll row must read `1 vote`, Apple `1 (100%)` with
  `aria-pressed="true"`, and Pear `0 (0%)`.
- **End.** After the native End tap, a bounded REST poll waits for exactly
  `[start, response, end]`. The end must be `m.poll.end` from the active
  sender with an `m.reference` relation to the same start event. Then the same
  row must read `Final results`, keep `1 vote`, disable both options and render
  no End control.
- A tally or a final state observed before its wire event is never accepted:
  the renderer read starts only after the REST proof.

### D5. Selectors never carry identifiers

Native actions print their selector to stdout, which becomes the public job
log and `process.log`, outside the suite's artifact scan. Rows are targeted by
stable test ids and text filters only:

| Action      | Selector and filter                                              |
| ----------- | ---------------------------------------------------------------- |
| Rooms rail  | `[data-testid="rail-rooms"]`                                     |
| Room row    | `.channel` with `{ text: room.name }` (filters are not logged)   |
| Tray        | `[data-testid="composer-insert"]`                                |
| Poll action | `[data-testid="insert-poll"]`                                    |
| Options     | `[data-testid="poll-option-0"]`, `[data-testid="poll-option-1"]` |
| Create      | `[data-testid="poll-create"]`                                    |
| Vote        | `[data-testid="poll"] .poll__option` with `{ text: 'Apple' }`    |
| End         | `[data-testid="poll-end"]`                                       |

The guard rejects any selector with `data-mid=` or an interpolated id.
Identity is proved by read-only observation: the one poll row's id equals the
start event id, and every later read requires the same row.

### D6. Identifier protection

Every stage identifier is registered before any UI step: the run token, the
Account user id, username and password, the Room id (raw, `slice(1)`,
component-encoded, base64url route segment) and name, and each poll event id
(start, response, end) as soon as it is known. The question contains the run
token and is therefore covered. Records and receipts store digests
(`roomDigest`, `eventDigest`) and booleans, never raw values. Failure text
rethrown to the job log keeps only error names and messages, redacted.

### D7. CI placement and budgets

- **Shard 1**, the last shard-1 line, directly after `message-linkify` and
  before shard 2's `edit-history`. The message-linkify guard (`runner` between
  `room-http-error-recovery` and `edit-history`) still holds.
- Budget: shard 1 is about 105 native minutes. One poll stage takes about 6–8
  minutes locally (build included), so shard 1 becomes about 113, within the
  120-minute native allowance of a 180-minute job (45 retained Playwright + 15
  setup). Shards 5 (110) and 6 (106) are fuller or equal.
- Timeouts (provisional, re-derived from the acceptance runs):

  | Layer                     | Timeout    |
  | ------------------------- | ---------- |
  | Node `test()`             | 900 000 ms |
  | Nx project `--timeout-ms` | 1 200 000  |
  | `ci-run-command` wrapper  | 1 500 000  |

- The `ci.yml` budget comment and a `ci-workflow.spec.mjs` guard record the new
  shard-1 figure.

### D8. No CHANGELOG, no README

This is a test-only migration with no user impact, like #747 and #748.

## Stage plan: `create-vote-end`

1. **Arrange.** `run = aliasLocalpart('poll-create-vote-end') + 'p'`. Register
   the Room name `Poll E2E <run>`, then create a fresh Account and a private
   Room through real Synapse and register their identifiers. No poll event is
   seeded.
2. **Native start.** `client.reset(PIXEL_5_ACCOUNT_PROFILE)` and
   `profile-applied.json`; `client.login(account)`; `client.hideKeyboard()`.
3. **Room.** Tap the Rooms rail and the exact Room row; read the composer:
   exactly one visible composer with placeholder `Message #<name>` and the
   exact Room route → `room-ready` (19@54).
4. **Tray and no inline control.** Read the composer controls:
   one visible enabled `composer-insert` with `aria-haspopup="dialog"` and
   `aria-expanded="false"` → `insert-tray` (59); zero `composer-poll` and zero
   `insert-poll` while the tray is closed → `no-inline-poll` (60).
5. **Dialog.** Tap `composer-insert`; wait for one visible `Add to message`
   sheet with one visible `insert-poll` (receipt). Tap `insert-poll`; wait for
   one visible `Create poll` dialog with its question focused (receipt).
6. **Input and create.** Type the question and both options (D2). Read the
   dialog: exact question, exactly two options `Apple` and `Pear`, one enabled
   Create (receipt). Tap Create; wait for the dialog and sheet to close
   (receipt).
7. **Rendered poll.** Read the timeline: exactly one visible poll →
   `poll-visible` (73); its question is exactly the typed question →
   `poll-question` (74); its total reads `0 votes` and both options read
   `0 (0%)` → `zero-votes` (75).
8. **Server echo.** The one poll row carries a `$` id → `server-echo`
   (178@80). REST start proof (D3) as a receipt.
9. **Vote.** Tap Apple; REST response proof (D4) as a receipt; then
   `one-vote` (86) and `one-hundred-percent` (87) from the same row.
10. **End.** Tap End; REST end proof (D4) as a receipt; then `final-results`
    (91): `Final results`, both options disabled, no End control, the same row.
11. **Teardown.** `capture('passed')` (or `capture('failed')`), client close,
    application data clear; Matrix cleanup, scrub and the fail-closed scan run
    as guarded cleanups.

## Observation plan

- `composerExpression()`: composer count, visibility, placeholder, route; the
  `composer-insert` count, visibility, disabled, `aria-haspopup`,
  `aria-expanded`; the `composer-poll` and `insert-poll` counts.
- `pollDialogExpression()`: `Create poll` dialog count and visibility; the
  question count, value and focus; the ordered `poll-option-*` values; the
  Create count and disabled state.
- `timelineExpression()`: every `[data-testid=poll]` inside `.scroll`, and each
  poll row's `data-mid`, visibility, question, total text, End control count
  and disabled state, and per option its text, count text, `disabled` and
  `aria-pressed`.
- Every expression is a pure read evaluated with only `document` in scope, so
  the guard executes the exact text in jsdom against production-shaped markup.
- Every wait is finite: renderer reads through `waitForNativeShellState`, REST
  polls through the same bounded poller over `fixtures.roomMessages`.

## Negative-control plan (guard, each must fail when its protection is removed)

- **Source shape.** A pinned hash differs by one byte; a line pin, the question
  template, an option, a test id or the run suffix drifts; a direct site is
  dropped or added; the `waitForSent` call is removed; a shadowing local
  `waitForSent` would still be counted by spelling; the predecessor gains
  `test.only`/`fixme` or loses its single Synapse skip.
- **Tray / no inline.** A missing, hidden, disabled or desktop-dropdown
  (`aria-haspopup` missing) insert control; an inline `composer-poll`; a
  pre-opened `insert-poll`.
- **Question / options.** A capitalized, sentinel-prefixed or truncated
  question; `apple`, `Pear ` or a third option in the dialog; a disabled
  Create; a start event with another question, answer text, answer id or
  order, kind or `max_selections`.
- **Server readiness.** A local echo row id (`~…`); a start event whose id is
  not the row id; a response or end already present before the vote; another
  sender or Room; a relation on the start event.
- **Vote.** No response; a response to another poll id, with `a1`, with two
  answers, from another sender or with a non-reference relation; a second
  response; a tally of `1 vote` on another row; Apple not pressed; Pear
  counted.
- **End.** No end event; an end relating to another poll; `Final results`
  with an enabled option, with an End control still rendered, or on another
  row; a lost vote after the end.
- **Cleanup and redaction.** Every raw, escaped, percent-encoded, sliced and
  base64url identifier and credential is rejected by the scan and removed by
  the scrub; rasters are removed; a failed cleanup, scrub or scan blocks
  publication; an abort revokes the marker; stage failures rethrow redacted.
- **Journey rules.** Any DOM click, focus, value write, dispatch, navigation,
  REST poll/vote/end send, `evaluateNative` in the journeys, retry, unbounded
  wait, id-bearing selector, missing record proof, or out-of-order native
  step fails the source rules.
- **Wiring.** Cache or parallelism on, a missing resource, a wrong entrypoint,
  a missing package script, a wrong shard, timeout or order, a gate path or
  upload condition drift, or a stale upload/line count fails.

## Evidence and acceptance plan

1. Guard, typecheck (`e2e/tsconfig.json`), ESLint and Prettier on changed files,
   and the full `scripts/*.spec.mjs` suite.
2. Device development until the stage passes; each device finding is fixed at
   its root, never with a retry or a loosened assertion.
3. On the final unchanged commit, with a fresh production renderer and
   manifest: three consecutive `trinity-e2e-android:message-poll` first
   attempts, each 1/1 stage, 10/10 records, attempt 1, retries 0,
   `publication-safe`, built APK digest equal to the installed digest, renderer
   `production` at the final commit, and an empty identifier scan including
   `process.log`.
4. The exact browser predecessor at `--workers=1 --retries=0`.
5. Hosted: audit the original-attempt shard-1 `android-message-poll` artifact,
   the retained predecessor and the renderer manifest before closing #749.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-message-poll.md` is preparatory.
This design changes it as follows:

- CI placement is shard 1 after `message-linkify`, not shard 2 after
  `message-markdown` (message-markdown runs on shard 5, and shard 2 has no
  headroom).
- No fixture change: the #748 `roomMessages` reader composes the MSC3381
  observation.
- Event ids are registered secrets everywhere; records hold digests only,
  instead of a separate raw-id evidence receipt.
