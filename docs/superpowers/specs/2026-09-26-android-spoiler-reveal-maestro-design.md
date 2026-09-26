# Android Spoiler-Reveal Maestro Migration Design

- Issue: #753, part of #660; blocked by #752 until #752's original-attempt hosted evidence is accepted
- Status: Design accepted for local implementation while #752 completes hosted acceptance
- Branch: local `wip/753-spoiler` from `9c522450` (the locally accepted #752 message-source suite on top of PR #677's `test/676-android-sidebar-filter`); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.message-spoiler` suite. Implementation and acceptance evidence are
tracked in `e2e/android/MIGRATION.md`. The hosted audit must pass before #753
can close. The #752 message-source suite is the structural template: contract,
read-only observer, artifacts and journeys modules, a Vitest guard with
effective negative controls, the same registry, Nx, package and CI wiring, and
its stricter privacy handling (every Matrix event-id shape is redacted from
every text diagnostic and rejected by the scan, and the job-log rethrow keeps
only an assertion's first line). The #751 read-receipt suite supplies the
REST-arranged message fixture with no typing, the desktop profile and the
shard-3 placement. #752 supplies the computed-colour parser that reads
`oklch(…)` and other functional colour syntaxes.

## Intent and source boundary

Migrate the single canonical spoiler-reveal definition to one serial,
one-stage installed-Android Node/Maestro suite against real Synapse. The
Playwright predecessor stays enabled and unchanged.

The source of truth is
`e2e/browser/journeys/conversations/message-spoiler.spec.mts` (111 lines) at
SHA-256 `d89c5751a43ac54b44329e2d65b9e7b0db2974118f6198d2fff1d6f0d050f673`.

### Pin reconciliation with the issue

The branch file hashes to the issue's pin. The Send-button change `fe2c7c3e`
did not touch this predecessor (it never types or sends through the composer),
so no `develop` reconstruction is needed and every issue span holds as
written. The guard pins the branch file at the issue's hash and proves that
the definition calls no composer helper.

| Span   | Definition / role                                        | Direct `expect` sites   |
| ------ | -------------------------------------------------------- | ----------------------- |
| 18     | module-level `synapseSession()`                          | none                    |
| 20–69  | `seedRoomWithSpoiler(request, hs, runId)` fixture helper | none                    |
| 71–79  | local Room-opening helper `openRoom(page, roomName)`     | 76                      |
| 84–110 | `conceals a spoiler and reveals it on click`             | 101, 102, 104, 108, 109 |

The definition calls `testResourceId` (88, from `../../../fixtures.mts`),
the module-local `seedRoomWithSpoiler` (89), `login` (95) and the local
`openRoom` (96). `seedRoomWithSpoiler` reaches `registerUser` (31); neither
it nor `login` reaches an `expect` site. The token login (32–40),
`createRoom` (43–49) and the message `PUT` (51–62) are unchecked arrangement.
The predecessor has no `isAndroidE2E` branch.

The guard also pins these shared sources:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`     | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts` | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |

The guard pins by exact line text: the run suffix `s` (88), the username
template `spoiler-user-${runId}` (26), the Room name `Spoiler E2E ${runId}`
(28), the secret `answer-${runId}` (29), the `createRoom` body with no preset
(46), the transaction `spoiler-${runId}` (52), the exact message content
(56–59: `m.text`, body `the secret is ${secret}`, format
`org.matrix.custom.html` and formatted body
`the secret is <span data-mx-spoiler>${secret}</span>`), the leaf locator
`.scroll .mx-spoiler` (100), the class matcher `/is-revealed/` (102, 108) and
the transparent colour `rgba(0, 0, 0, 0)` (104, 109).

## Parity records: 5 direct + 1 helper-expanded = 6

One stage, `conceal-reveal`, owns every record. Identities are
`message-spoiler.conceal-reveal.<suffix>`, in source order. `76@96` reads as
helper line 76 reached from the call on line 96.

| #   | Source (helper@call) | Kind      | Canonical assertion                        | Suffix                |
| --- | -------------------- | --------- | ------------------------------------------ | --------------------- |
| 1   | 76@96                | inherited | `openRoom`: composer visible               | `room-ready`          |
| 2   | 101                  | direct    | the rendered spoiler leaf is visible       | `spoiler-visible`     |
| 3   | 102                  | direct    | the leaf has no revealed state             | `initial-unrevealed`  |
| 4   | 104                  | direct    | the leaf paints its text fully transparent | `initial-transparent` |
| 5   | 108                  | direct    | the same leaf gains the revealed state     | `revealed`            |
| 6   | 109                  | direct    | the leaf no longer paints transparent text | `revealed-painted`    |

Helper expansion is resolved by binding, as the #748–#752 guards do: a call
expands only when the TypeChecker binds it to a named import from
`../../../support/` or to a module-level function declaration of the
predecessor. A shadowing local never expands. `testResourceId` binds to
`../../../fixtures.mts`, outside `support/`, and adds no site.

## Selected architecture

| Unit      | File                                         | Responsibility                                                                                                                   | Boundary                                                                |
| --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Guard     | `scripts/message-spoiler-migration.spec.mjs` | Source pins, AST site map, binding expansion, simulated app, raster policy, controls, wiring                                     | Vitest in-process. No emulator, no network                              |
| Contract  | `e2e/android/message-spoiler-contract.mts`   | One stage, 6 identities, source fields, the exact formatted content, pure parsers and asserters for composer, leaf, paint, scope | Pure; no I/O                                                            |
| Fixture   | `e2e/android/message-spoiler-fixture.mts`    | A closure-private REST session that sends the one formatted spoiler message and logs out on cleanup                              | REST arrangement only; the token never leaves the closure               |
| Observer  | `e2e/android/message-spoiler-observer.mts`   | `evaluateNative` read-only expressions: composer, the rendered spoiler leaf, its row, computed paint, box, hit tests, animations | No click, focus, key, scroll, class, style, attribute or location write |
| Artifacts | `e2e/android/message-spoiler-artifacts.mts`  | Secrets in every form, the leaf-scoped raster capture and its allowlist, scrub/scan, pass-only marker, abort revocation, cleanup | Self-contained copy of the #752 policy, keyed to this suite             |
| Journeys  | `e2e/android/message-spoiler-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, native helpers, the stage                                                           | Maestro owns every product action                                       |

No shared source changes. `account-workspace-fixtures.mts` is reused
unchanged (`account`, `createRoom`, `roomMessages`), and so is
`account-workspace-client.mts` (`reset`, `login`, `hideKeyboard`,
`tapCurrent`, `visible`, `record`, `capture`). The suite-local fixture
composes them, as `edit-history-fixture.mts` does, because the shared
fixtures send only plain `m.text` bodies.

## Decisions

### D1. Profile

The stage runs at `DESKTOP_ACCOUNT_PROFILE` (1280×720 CSS pixels, DPR 1, no
touch, not mobile), the profile the predecessor runs at: it has no
`test.use` and no platform branch, the browser project uses Desktop Chrome and
the retained Android Playwright project's canonical wide shell is 1280×720
without touch. #751 ran the same way. The tap is still a genuine native touch
through Maestro; the paint claims are computed styles of the measured leaf
and do not depend on the viewport.

### D2. Exact formatted fixture through real Synapse

- `run = aliasLocalpart('spoiler-reveal') + 's'`. The Room name is
  `Spoiler E2E <run>`, the secret `answer-<run>` and the transaction
  `spoiler-<run>`.
- One fresh Account from `fixtures.account('spoiler-reveal')` (the harness's
  disposable username and a random-UUID password) creates the Room with only
  its name, as line 46 sends no preset.
- The suite-local fixture logs the Account in once more, keeps that token in
  its closure and `PUT`s exactly one `m.room.message`:
  `{ msgtype: 'm.text', body: 'the secret is <secret>', format:
'org.matrix.custom.html', formatted_body: 'the secret is <span
data-mx-spoiler><secret></span>' }`. The session logs out in a guarded,
  bounded cleanup.
- Before any UI step, `/messages?dir=b&limit=50` must hold exactly one
  `m.room.message`: the sent event id, the exact Room and sender, content
  deep-equal to the sent content, exactly one `data-mx-spoiler` span wrapping
  exactly the secret, and no relation. REST never touches renderer state.

### D3. The one rendered leaf and its computed paint

- The observer reads every `.scroll .mx-spoiler` element. Exactly one must
  exist in the Room's one scroller; its text is exactly the secret; it lies in
  the non-event row whose `data-mid` is the proved event id and whose text
  carries the exact body; it contains no nested spoiler; its measured box is
  finite, non-zero, inside the viewport and over the conversation scroller;
  and it has exactly one client rect (it does not wrap). That is
  **101 `spoiler-visible`**.
- **102 `initial-unrevealed`.** The leaf's class list has no `is-revealed`.
- **104 `initial-transparent`.** The leaf's own computed `color` is parsed in
  Node with the #752 parser (legacy `rgb()`/`rgba()`, `/ alpha`, percentage
  alphas, `oklch()`, `color()`, `transparent`); its alpha must be exactly 0.
  An unparseable colour fails. The black bar itself is a receipt: the
  computed `backgroundColor` must have a non-zero alpha.
- **108 `revealed`.** After the native tap the same leaf (the same single
  leaf, secret, row and event id) carries `is-revealed`.
- **109 `revealed-painted`.** Its computed `color` alpha is strictly above 0.
  A changed class with transparent text fails; the secret's presence in the
  DOM is never treated as exposure.
- Paint is read only from the computed style of the measured leaf; class
  names, declarations and rasters are never consulted for an assertion.

### D4. Native activation

The leaf is tapped with `client.tapCurrent('.scroll .msg[data-mid^="$"]
.mx-spoiler', { exactText: secret })`: the client requires exactly one
visible, enabled match whose centre hit-tests inside it, maps that centre to
the device and taps through Maestro. The renderer's own
`SpoilerRevealDirective` receives the resulting click. The observer never
calls a handler, adds a class, focuses, dispatches or scrolls.

### D5. Visual captures scoped to the leaf

The issue asks for pass and failure captures showing the black-bar conceal
and reveal states. The #752 suite deletes every raster because its dialog
shows identifiers; here the full screen shows the Room name, the Account and
the timeline, so full-screen rasters are still deleted, and only rasters
scoped to the one spoiler leaf are kept:

- The capture is a WebView `Page.captureScreenshot` whose `clip` is exactly
  the leaf's measured box (document coordinates). It is taken only when the
  leaf passes the D3 identity checks, has one client rect, lies inside the
  viewport and the conversation, is unobstructed at its centre and at four
  inset corners (`elementFromPoint`, read-only), and has no running CSS
  animation or transition (`getAnimations()`), so the bar is fully drawn or
  fully faded.
- `conceal-reveal/spoiler-concealed.png` is taken after 104 and the black-bar receipt;
  `conceal-reveal/spoiler-revealed.png` after 109 once the colour transition has
  settled. On failure, `spoiler-failed.png` is taken only when the leaf still
  passes the scope checks; otherwise the failure metadata records that no
  scoped capture was possible.
- Each raster has a `<name>.json` metadata file: state, PNG SHA-256 and
  dimensions, the CSS clip, the device-pixel ratio and the computed paint
  strings. The PNG dimensions must equal the clip times the ratio (±1 px).
- Pixels inside the clip are the bar or the secret only. The secret is
  run-scoped test text (`answer-` plus a hash-derived alias of the run
  namespace); it is not derived from the username (a different per-purpose
  hash) or the password (a random UUID), and no token, Room name, id or
  sender is inside the clip.
- The scrub deletes every raster that is not one of those three exact paths
  with valid metadata, and deletes a failure raster from a passing run. The
  scan fails closed on any other raster, on metadata that does not match its
  raster, and on a pass without both conceal and reveal captures.
- Rasters stay in ignored run output and hosted artifacts only; they are
  never committed and never serve as the assertion oracle.

### D6. Selectors never carry identifiers

Native actions print their selector to stdout, which becomes the public job
log and `process.log`, outside the suite's artifact scan. Text filters are not
logged:

| Action     | Selector and filter                                                    |
| ---------- | ---------------------------------------------------------------------- |
| Rooms rail | `[data-testid="rail-rooms"]`                                           |
| Room row   | `.channel` with `{ text: room.name }`                                  |
| Spoiler    | `.scroll .msg[data-mid^="$"] .mx-spoiler` with `{ exactText: secret }` |

The guard rejects any selector with `data-mid=`, `data-mid*=` or an
interpolated id, and any wait description that interpolates a value.

### D7. Privacy

- Every stage identifier is registered before any UI step: the run token, the
  Account user id (raw and component-encoded), username and password, the
  Room id (raw, `slice(1)`, component-encoded, base64url route segment) and
  name, the body, the secret, the transaction id and the event id (registered
  the moment the fixture returns it).
- The scrub redacts every registered value in raw, JSON-escaped and
  percent-encoded form from every text diagnostic, including Maestro's
  per-flow `device-logcat.txt`, and also redacts every room-version-3+ Matrix
  event-id shape (the SDK logs "Event $… already in timeline" for state
  events that are never registered). The scan rejects any identifier,
  event-id shape, token, authorization header, native storage payload or
  unallowlisted raster.
- Records and receipts store digests (`eventDigest`, `roomDigest`), booleans,
  computed paint strings and measured numbers only.
- Failure text rethrown to the job log keeps error names and messages; an
  assertion keeps only its first line (its operator when Node generated the
  whole message), because Node 24 appends actual and expected values, and
  every registered value and event-id shape is redacted.

### D8. CI placement and budgets

- **Shard 3**, the last shard-3 line, directly after `message-source`. Shard
  3 has the most headroom (168 of its 180 native minutes in a 240-minute
  job); shard 2 would reach 182 against 180 and shards 1, 5 and 6 have less.
- Budget: one stage of about 3 minutes with Synapse and the prebuilt APK, a
  provisional 5 minutes, so shard 3 becomes about 173 native minutes.
- Timeouts (provisional, re-derived from the acceptance runs):

  | Layer                     | Timeout    |
  | ------------------------- | ---------- |
  | Node `test()`             | 600 000 ms |
  | Nx project `--timeout-ms` | 900 000    |
  | `ci-run-command` wrapper  | 1 200 000  |

- The `ci.yml` budget comment and a `ci-workflow.spec.mjs` guard record the
  new shard-3 figure. The upload count rises from 78 to 79 and the emulator
  script from 71 to 72 lines, in every guard that pins them. The #752 guards
  that make message-source the last shard-3 line and the last `MIGRATION.md`
  section become "followed only by message-spoiler".

### D9. No CHANGELOG, no README

This is a test-only migration with no user impact, like #747–#752.

## Stage plan: `conceal-reveal`

1. **Arrange.** Register the run, Room name, body, secret and transaction;
   create the Account and the Room; send the formatted message and register
   its event id; prove it on real Synapse (D2) as the `spoiler-event`
   receipt.
2. **Native start.** `client.reset(DESKTOP_ACCOUNT_PROFILE)` and
   `profile-applied.json`; `client.login(account)`; `client.hideKeyboard()`.
3. **Room.** Tap the Rooms rail and the exact Room row; read the composer:
   exactly one visible composer with placeholder `Message #<name>` and the
   exact Room route → `room-ready` (76@96).
4. **Concealed.** One visible leaf → `spoiler-visible` (101); no revealed
   class → `initial-unrevealed` (102); transparent text →
   `initial-transparent` (104); black bar (receipt); settled and scoped →
   `spoiler-concealed.png` (receipt).
5. **Activation.** Native tap on the leaf (D4).
6. **Revealed.** The same leaf revealed → `revealed` (108); painted text →
   `revealed-painted` (109); settled and scoped → `spoiler-revealed.png`
   (receipt).
7. **Teardown.** `capture('passed')` (or the scoped failure capture and
   `capture('failed')`), client close, application data clear; Matrix cleanup
   (REST logout, Room leave/forget, Account logout), scrub and the fail-closed
   scan run as guarded cleanups.

## Observation plan

- `composerExpression()`: composer count, visibility, placeholder, route.
- `spoilerExpression()`: the scroller count and box, every `.scroll
.mx-spoiler` leaf with its row id, row event flag, row text, own text,
  nested-spoiler count, revealed flag, visibility, client-rect count, box,
  centre and inset-corner hit tests, running animation count and computed
  `color` and `backgroundColor`; the viewport, scroll offset and device-pixel
  ratio.
- Every expression is a pure read evaluated with only `document` in scope, so
  the guard executes the exact text in jsdom against production-shaped markup.
- Every wait is finite: renderer reads through `waitForNativeShellState`, REST
  reads through the same bounded poller over `fixtures.roomMessages`.

## Negative-control plan (guard, each must fail when its protection is removed)

- **Source shape.** A pinned hash differs by one byte; a line pin, the
  username, Room, secret or transaction template, the run suffix, the
  formatted body, the preset absence, the leaf locator, the class matcher or
  the transparent colour drifts; a direct site is dropped or added; the
  helper call is removed or shadowed; the predecessor gains
  `test.only`/`fixme` or loses its single Synapse skip.
- **Exact fixture and spoiler identity.** A missing, doubled or plain event,
  another body, format, formatted body, sender or Room, two spoiler spans,
  a relation, two leaves, a leaf with other text, in another row or a nested
  spoiler, a hidden, wrapped or covered leaf fails before `spoiler-visible`.
- **Initial state and paint.** A leaf rendered revealed fails
  `initial-unrevealed`; opaque or semi-transparent text in every colour
  syntax, and an unparseable colour, fail `initial-transparent`; a missing
  bar fails the black-bar receipt.
- **Native activation.** No tap, a tap that does not reach the directive, or
  a class change without painted text fails `revealed` or
  `revealed-painted`; a DOM click in the journeys fails the source rules.
- **Captures.** An unallowlisted, unscoped, mismatched or missing raster, a
  failure raster in a passing run, or a capture of an unsettled or covered
  leaf fails the scan, the marker or the capture guard.
- **Cleanup and redaction.** Every raw, escaped, percent-encoded, sliced and
  base64url identifier and credential, and every event-id shape, is rejected
  by the scan and removed by the scrub; a failed cleanup, scrub or scan blocks
  publication; an abort revokes the marker; stage failures rethrow redacted
  without assertion values.
- **Journey rules.** Any DOM click, focus, value write, dispatch, navigation,
  class or style write, `evaluateNative` in the journeys, retry, unbounded
  wait, id-bearing selector, missing record proof, or out-of-order native
  step fails the source rules.
- **Wiring.** Cache or parallelism on, a missing resource, a wrong entrypoint,
  a missing package script, a wrong shard, timeout or order, a gate path or
  upload condition drift, or a stale upload/line count fails.

## Evidence and acceptance plan

1. Guard, typecheck (`e2e/tsconfig.json`), ESLint and Prettier on changed
   files, and the full `scripts/*.spec.mjs` suite.
2. Device development until the stage passes; each device finding is fixed at
   its root, never with a retry or a loosened assertion.
3. On the final unchanged commit, with a fresh production renderer and
   manifest: three consecutive `trinity-e2e-android:message-spoiler` first
   attempts, each 1/1 stage, 6/6 records, attempt 1, retries 0,
   `publication-safe`, built APK digest equal to the installed digest,
   renderer `production` at the final commit, an empty identifier scan
   including `process.log`, and exactly the two scoped rasters.
4. The exact browser predecessor at `--workers=1 --retries=0`.
5. Hosted: audit the original-attempt shard-3 `android-message-spoiler`
   artifact, its two scoped rasters, the retained predecessor and the renderer
   manifest before closing #753.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-message-spoiler.md` is
preparatory. This design changes it as follows:

- CI placement is shard 3 after `message-source`, not shard 2 after it:
  message-source runs on shard 3, and shard 2 has about 3 minutes of
  headroom.
- The formatted message is sent by a suite-local fixture that composes the
  shared fixtures, so `account-workspace-fixtures.mts` is unchanged.
- The stage id is `conceal-reveal` and the suite id `android.message-spoiler`.
