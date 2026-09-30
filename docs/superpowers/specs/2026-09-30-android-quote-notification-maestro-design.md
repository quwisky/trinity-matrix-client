# Android Quote-Notification Maestro Migration Design

- Issue: #758, part of #660
- Status: Ruled 2026-09-30; the coordinator's rulings are recorded under "Rulings"
- Branch: local `wip/758-quote-notification` at `54bd802b` (head of PR #677); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.quote-notification` suite. Implementation and acceptance evidence
will be tracked in `e2e/android/MIGRATION.md`. The #750 message-quote suite is
the domain template: its native long press, `sheet-quote` tap, composer
observation and sentinel-guarded native append are reused. The #757
pinned-message-workflow suite is the harness template: its proof-first
`record()`, receipts, tap-anchored windows, redacted rethrows, exported
finish-stage function and publication marker are ported. The suite has one
stage. The notification decision is read from the real homeserver, exactly
where the predecessor reads it.

## Intent and source boundary

Migrate the one quoted-display-name notification definition to a serial,
one-stage installed-Android Node suite against real Synapse. The predecessor
stays enabled and unchanged until hosted acceptance (D13).

### Source pins and the stale issue pin

**Ruled (Q1 + Q2): the canonical predecessor is the working tree.**
`e2e/browser/journeys/conversations/quote-mentions.spec.mts` hashes to
`5186fc3b45f12fd03e2ad71e79ae636a688fce41b96d05fb0e38f278f80266e5`
(175 lines). That is also the blob at `RETIRED_PREDECESSOR_COMMIT`
`dd0cb53c`, the bytes the retirement registry will pin (D13).

**The issue's pin is stale.** The issue pins
`354f8f2ccd02e32b12bf74bea400abb4dec40bad31715fd80e03c4fd79fd49f8`
(174 lines), which is blob `d30e3ceb` at `d3b27323` (`fe2c7c3e^`). The
issue's baseline comment is dated 2026-09-20. It predates `fe2c7c3e`
(2026-09-25, "send composer drafts with the Send button on mobile"), which
changed exactly two lines:

- it added tree line 16,
  `import { sendComposerDraft } from '../../../support/message-composer.mts';`;
- it replaced the issue's line 134, `await composer.press('Enter');`, with
  tree line 135, `await sendComposerDraft(composer);`.

The difference is behavioural, not cosmetic. Since `d3b27323`, Enter inserts
a new line on mobile, and the predecessor that runs today sends through the
composer's Send button after asserting it is enabled (composer line 53).
Porting the stale bytes would drop that live assertion. Every earlier suite
took the branch bytes: #748, and #750, which grew its issue's 20 records to 23. Every issue span below line 16 moves down by one: the definition
63–173 becomes **64–174**, and the display-name constant and API-login
helper 39–58 become **40–59**. The file has not changed since `fe2c7c3e`.

The guard pins the bytes three ways:

1. it reads the blob with `readRetiredPredecessor(PREDECESSOR)` at
   `dd0cb53c`, and pins it at `5186fc3b…`;
2. it reads the working tree, pins it at `5186fc3b…`, and proves the two
   are equal byte for byte. Any later drift of the working tree is then
   detected, and only this pin moves at the D13 retirement;
3. for provenance, it undoes exactly `fe2c7c3e` in memory (drops the
   import, restores the Enter press) and requires SHA-256 `354f8f2c…`. So
   the issue's stale pin is proved to be these bytes minus that change.
   This test fixes no numbering.

The guard also pins these shared sources:

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`              | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts`          | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |
| `e2e/support/message-composer.mts` | `4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d` |

All three were recomputed for this design, and they match the issue and the
#750 guard. All numbering below is the working tree's:

| Span           | Issue (stale) | Role                                                                                       |
| -------------- | ------------- | ------------------------------------------------------------------------------------------ |
| 16             | —             | the `sendComposerDraft` import (`fe2c7c3e`)                                                |
| 38             | 37            | `const session = synapseSession();`                                                        |
| 40–41          | 39–40         | the JSDoc and `READER_DISPLAY_NAME = 'Zephyrine'`                                          |
| 43–59          | 42–58         | `loginApi`: password login for a REST token (replaced; D1)                                 |
| 40–59          | 39–58         | the "display-name constant and API-login helper" span                                      |
| 64–174         | 63–173        | the definition `a quoted display name gives the reader no highlight`                       |
| 69             | 68            | ``runId = `${testResourceId('run')}qm` ``                                                  |
| 70–73          | 69–72         | `qmw-${runId}`, `qmr-${runId}`, `${runId}-pass`, `Quote mentions ${runId}`                 |
| 75–80          | 74–79         | `registerUser` ×2, `loginApi` ×2, both `Bearer` headers                                    |
| 83–86          | 82–85         | the reader's display name is set to `READER_DISPLAY_NAME`                                  |
| 88–97          | 87–96         | the writer creates the `private_chat` Room inviting the reader; the reader joins           |
| 101–105        | 100–104       | `named`, sent **by the reader** with txn `${runId}-src`                                    |
| 107–117        | 106–116       | UI `login` as the writer, `rail-rooms`, `.channel` by name (30 s `waitFor`), open          |
| 124–126        | 123–125       | the `isAndroidE2E` branch: `openMessageActionSheet`, then `sheet-quote`                    |
| 127–129        | 126–128       | the desktop `else`: `clickRowMenuItem(… 'msg-quote')`: **excluded**                        |
| 133–135        | 132–134       | `answer = on it ${runId}`, `pressSequentially`, `sendComposerDraft(composer)`              |
| 143–146        | 142–145       | the reader's full `sync?timeout=0` for `next_batch`                                        |
| 147–150        | 146–149       | the writer's REST probe `poke ${runId}`, txn `${runId}-probe`                              |
| 152–169        | 151–168       | the incremental-sync poll (`expect.poll`, 30 s)                                            |
| 173            | 172           | `expect(counts.highlight_count).toBe(0)`                                                   |
| app 214–222    | —             | `openMessageActionSheet`: touch long press, then `expect(sheet).toBeVisible` at 220 (10 s) |
| app 202–211    | —             | `clickRowMenuItem`: its `expect(…).toPass` starts at **206**, reached only from 128        |
| composer 45–55 | —             | `sendComposerDraft`: on mobile, `expect(send).toBeEnabled` at **53** (20 s), then click    |

Every definition span, site and helper line is AST-derived. The guard
computes the direct sites with a counter that includes `expect.poll`, the
helper lines with `helperExpectLines`, and the call lines with
`importedCalls`, over the pinned sources. The contract's values must equal
that output. No line in the contract is typed by hand and left unchecked
(the #757 `clickRowMenuItem` 207→206 defect).

## Parity records: 6 direct + 2 inherited = 8

A site is every `expect(…)` call **and every `expect.poll(…)` call** in the
definition's span, as the edit-history and message-action-sheet guards
count them. Line 153 is `await expect` followed by `.poll(` on 154. The
call expression starts at 153. An identifier-only counter finds 5 sites and
misses it; the guard proves that difference.

- The definition owns 6 direct sites: 118, 123, 132, 136, 153 and 173.
- The Android branch at 125 expands `openMessageActionSheet`'s one
  readiness site (app 220).
- Line 135 expands `sendComposerDraft`'s mobile send-readiness site
  (composer 53). Its `isMobileComposerPage` guard is `true` for
  `isAndroidE2E`, and it reaches no site of its own.
- The desktop `else` branch's `clickRowMenuItem` site (app 206, reached
  from 128) is excluded, as the message-quote and pinned-workflow guards
  exclude their desktop branches.
- `login`, `registerUser`, `loginApi`, `synapseSession` and
  `touchLongPress` reach no site. The guard proves this by binding
  resolution.
- The `waitFor` at 116 is not an `expect` site. It becomes a polled
  precondition (D4).

Identities are `quote-notification.quoted-display-name.<suffix>`, ordered
as #750 orders them: a direct site by its line, an inherited site by its
call line, before a direct site on the same line.

| #   | Source  | Kind      | Predecessor claim                                                         | Suffix                  |
| --- | ------- | --------- | ------------------------------------------------------------------------- | ----------------------- |
| 1   | 118     | direct    | `composer-input` visible (15 s)                                           | `composer-visible`      |
| 2   | 123     | direct    | the `.scroll .msg` row with `named` is visible (30 s)                     | `source-row-visible`    |
| 3   | 220@125 | inherited | the `Message actions` sheet is visible (10 s)                             | `sheet-ready`           |
| 4   | 132     | direct    | the composer value is exactly `> ${named}\n\n` (10 s)                     | `composer-quote`        |
| 5   | 53@135  | inherited | the composer's Send button is enabled for the draft (20 s)                | `answer-send-enabled`   |
| 6   | 136     | direct    | the `.scroll .msg` row with the answer is visible (30 s)                  | `answer-visible`        |
| 7   | 153     | direct    | the reader's incremental-sync `notification_count` is above 0 (30 s poll) | `notification-positive` |
| 8   | 173     | direct    | that same response's `highlight_count` is exactly 0                       | `highlight-zero`        |

The stage `quoted-display-name` is titled after the predecessor,
`a quoted display name gives the reader no highlight`, with 8 records. The
suffix `answer-send-enabled` is #750's name for the same helper site on the
same answer send.

The helper table has two entries:

- `openMessageActionSheet`: module `e2e/support/app.mts`,
  `expectLines: [220]`, role `action-sheet-readiness`, call 125;
- `sendComposerDraft`: module `e2e/support/message-composer.mts`,
  `expectLines: [53]`, role `composer-send-readiness`, call 135.

A naive expansion that follows every support call finds 9 sites (+206). The
guard asserts that number, which is not the contract's 8.

## Selected architecture

| Unit      | File                                            | Responsibility                                                                                                                     |
| --------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Guard     | `scripts/quote-notification-migration.spec.mjs` | Pins, AST site map, bindings and exclusion, the imported-export shape guard, action bans, simulated app, negative controls, wiring |
| Contract  | `e2e/android/quote-notification-contract.mts`   | One stage, 8 identities, texts, sheet/composer asserters, arrangement, answer-event and sync decision asserters                    |
| Artifacts | `e2e/android/quote-notification-artifacts.mts`  | Secrets, the publication marker and abort revocation                                                                               |
| Journeys  | `e2e/android/quote-notification-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, the stage, `finishQuoteNotificationStage`, redacted rethrows                          |
| Fixture   | `e2e/android/account-workspace-fixtures.mts`    | **One additive read-only member**, `roomUnreadSync` (ruled Q3), with its tests in `scripts/account-workspace-fixtures.spec.mjs`    |

There is no local observer: every renderer read the suite needs already
exists. Reused unchanged, by import (ruled Q4):

- `account-workspace-client.mts`: `reset`, `login`, `hideKeyboard`,
  `tapCurrent`, `longPressCurrent`, `visible`, `capture`, `record`,
  `close`. There is no `SharedStageAccount`: the suite has one stage.
- `account-workspace-fixtures.mts`: `account`, `setDisplayName`,
  `createRoom` (with `invite`), `join`, `sendMessage`, `roomMessages`, and
  the new `roomUnreadSync`.
- `message-quote-observer.mts`: `readComposer`, `readTimeline`,
  `readSheet`, `readAppliedProfile` and the type `ObservationOptions`.
- `message-quote-contract.mts`: `assertRoomReady`, `assertSameRow`,
  `assertServerEcho`, `assertSendEnabled`, `assertDraftSent` and
  `assertSheetClosed`, plus the types `ComposerObservation`,
  `TimelineObservation` and `SheetObservation`.
- `message-quote-journeys.mts`: `appendNativeLine`. It is the
  sentinel-guarded native paragraph append through
  `flows/message-quote-append.yaml`, which uses `PARAGRAPH_SENTINEL` `'1'`.
- `pinned-message-panel-artifacts.mts`: `redactDiagnosticText`,
  `scrubPinnedPanelArtifacts`, `scanPinnedPanelArtifacts`,
  `runPinnedPanelStageCleanup` and the type `PinnedPanelPublicationSafety`.
  These are the stage-free helpers #757 already imports.

**Imported-export shape guard (ruled Q4).** No suite has imported a
journeys module across capabilities before. So the guard pins, by AST, the
shape of every name this suite imports from `message-quote-*` and
`pinned-message-panel-artifacts`:

- for each function, the exported declaration's normalized parameter list
  and return type;
- for each interface, its member names, in order;
- for each constant, its initializer.

It also pins the append flow's bytes (SHA-256
`d5484742203e25b7ba90cd58831219e0dcd5889080caaa3d8f106b2155eb7cd4`). The
pinned values were generated from the sources at `54bd802b`, not typed. A
renamed, removed, re-typed or re-parameterized export fails the guard
before the typecheck runs. Any change to how the flow types fails it too.
Each pin is shown effective by an in-memory mutation of its declaration.

## Feasibility probe

Two local probes ran on 2026-09-30 from `54bd802b`, with a production
renderer (manifest `d09ab490…`) and a debug APK built from it. They used the
API 36 emulator (Pixel 6 AVD, gesture navigation) and the Pixel 5 profile.
The probe files lived under `.superpowers/probes/`, were never committed,
and wrote only counts, booleans and timings. Host load was 17 when probe 1
started, from another session. It fell to 4–7 during the UI part.

**Probe 1: the full journey on the device** (3 min 03 s wall including
Synapse, install and teardown; 159 s in the test). It used the predecessor's
exact texts, fixture Accounts and a native writer:

1. **Arrangement.** The writer's `/messages` page reached `m.room.create`
   and held exactly one `m.room.message`, from the reader. The reader's two
   member events (invite, join) both carried `displayname: Zephyrine`,
   because the name was set before the invite and the join.
2. **Sign-in and Room.** `reset` took 6.3 s. The one-flow sign-in took
   47.0 s, the `rail-rooms` tap 10.7 s and the Room-row tap 9.5 s. At the
   first read after the Room tap (8 ms), the composer was visible, empty,
   unfocused, with Send disabled and the exact placeholder
   `Message #Quote mentions <run>`. The source row was visible and
   reconciled, and its id equalled the arranged event (9 of 9 rows
   rendered).
3. **Native Quote.** The long press took 12.3 s, and the sheet was up at
   the first read. It had one visible `sheet-quote` at y 522–566 of the 727
   px viewport, with an unobstructed centre, so no in-sheet swipe is needed.
   The `sheet-quote` tap took 10.7 s. At the first read the sheet was gone
   and the composer held exactly `> Zephyrine, can you look at this?\n\n`,
   focused, with the caret collapsed at 36, the value's length.
4. **Native answer.** `appendNativeLine` (flow `inputText 1on it <run>`,
   arrows, Backspace, Ctrl+End) took 17.7 s. After `hideKeyboard`, the first
   read showed the exact draft with Send enabled. The Send tap took 10.0 s.
   At the first read the answer row was visible, reconciled to a `$` id, and
   rendered one blockquote. The composer was empty.
5. **Answer event.** The event was from the writer, and its body was exactly
   `> Zephyrine, can you look at this?\n\non it <run>`. Its content keys were
   `body`, `format` (`org.matrix.custom.html`), `formatted_body`,
   `m.mentions` (`{}`) and `msgtype`, with no `m.relates_to`.
6. **Decision.** The reader's `sync?timeout=0` took 47 ms. It returned a
   29-character `next_batch` and already reported this Room at
   `notification_count` 1, `highlight_count` 0: the answer, counted.
   **Synapse 1.161 therefore does not report zeroes on a full sync, as the
   predecessor's comment says.** The REST probe send returned in 35 ms. The
   first incremental read, 16 ms later, carried the Room with 2/0, the probe
   in its one-event timeline (not `limited`), and no ephemeral events. One
   read decided.
7. **Response cache.** A later full `sync?timeout=0` returned the stale 1/0.
   A later incremental read that repeated an earlier request's exact
   `since`/`timeout` returned the earlier non-empty response and missed a
   newer event for its whole 30 s window. Synapse caches non-empty `/sync`
   responses by request key (`sync_response_cache_duration`, default 2 min).

**Probe 2: REST only, cache and sensitivity** (same Synapse image and
harness):

8. An **empty** incremental read (nothing since `X`) was not cached. The
   identical request made after a new event returned that event.
9. **Sensitivity.** The writer sent, through REST, the same quoted body with
   no `m.mentions` key (`> Zephyrine, can you look at this?\n\nno mentions
<run>`). Every later read, including one after the 125 s cache lifetime,
   reported `highlight_count` 1 for the reader. On this Synapse, the legacy
   display-name rule fires on quoted text without `m.mentions`. So a zero
   from the product's send is a decision, not a disabled rule.

## Decisions

### D1. Profile, Accounts and sign-in

- The stage runs at the shared Pixel 5 profile (`PIXEL_5_ACCOUNT_PROFILE`,
  393×727 CSS px, DPR 2.75, mobile, touch), applied at `reset`. The applied
  profile is read back through `readAppliedProfile`. #757's `isPixel5Profile`
  predicate must pass before any tap. The result is recorded as
  `profile-applied`.
- Two fresh fixture Accounts are created: `fixtures.account('qm-writer')`
  for the predecessor's `qmw-` user and `fixtures.account('qm-reader')` for
  its `qmr-` user. Their fixture sessions replace `loginApi` (43–59) and the
  two `Bearer` headers, and their tokens never leave the fixture closure.
- Only the writer signs in on the device, through the one-flow
  `client.login(writer)`, then `client.hideKeyboard()`. The reader never
  signs in, because the predecessor's reader side is the homeserver's
  decision, read through REST (D6).

### D2. Arrangement

All of it goes through real Synapse, in the predecessor's order, before any
UI step:

- `run` is `${resources.aliasLocalpart('quote-notification')}qm` (69);
- `fixtures.setDisplayName(reader, 'Zephyrine')` (83–86) runs **before**
  the Room exists, so the invite and join member events carry the name that
  `.m.rule.contains_display_name` matches (probe 1);
- the writer creates the Room `Quote mentions <run>` with
  `preset: 'private_chat'` and `invite: [reader.userId]` (88–94), and the
  reader joins it (95–97);
- **the reader** sends `Zephyrine, can you look at this?` with txn
  `<run>-src` (101–105). The fixture's content is exactly the predecessor's
  `{ msgtype: 'm.text', body }`.

A fail-closed read-back (`assertArrangement`) uses the writer's whole
`/messages` page, oldest first. It must reach `m.room.create`. It must hold
exactly one `m.room.message`, the arranged event, from the reader, with the
exact body. The reader's latest `m.room.member` event must be `join` with
`displayname` exactly `Zephyrine`. The answer and the probe are never seeded.

### D3. Native action ownership

Every product action is a Maestro action through `AccountWorkspaceClient`,
and each proves a trusted, matched activation of its target. In order:

1. `client.login(writer)` (the one-flow `accounts-sign-in.yaml`), then
   `hideKeyboard`;
2. tap `[data-testid="rail-rooms"]`;
3. tap `.channel` `{ text: roomName }`, after it has been visible for up to
   30 s (the 116 `waitFor`);
4. `hideKeyboard`, then
   `longPressCurrent('.scroll .msg[data-mid^="$"]', { text: SOURCE_BODY })`,
   after the record-2 read proves exactly one such reconciled row, and that
   it is the arranged event;
5. tap `[data-testid="sheet-quote"]`, which is visible and unobstructed
   without a swipe (probe 1.3);
6. `appendNativeLine(client, QUOTED_COMPOSER, answer)` (D5);
7. `hideKeyboard`, then, once record 5 proves Send is enabled, tap
   `[data-testid="composer-send"]` (`sendComposerDraft`'s mobile path, 135).

No suite source contains a renderer `.click(`, `.focus(`, `dispatchEvent`,
`.value =`, `location.`, `history.`, `.fill(`, `.press(`, `requestSubmit`,
`.submit(`, `preventDefault` or `stopPropagation`. It contains no product
handler call (`quote(`, `onQuote`), no `new SharedStageAccount(`, `input_method` or `dumpsys`, and
no `pushrules`: the push-rule JSON is never read (issue boundary). Renderer
code only reads.

### D4. Observation and windows

Renderer observations are the message-quote builders, polled on the wall
clock. Server observations are fixture reads, polled the same way. **No
window is ever anchored before the action it waits for.** A tap's return
comes after its proven activation, so tap latency (9.5–47 s in probe 1)
never counts against a window. UI bounds of 10 s and 15 s become 20 s under
host load, as in #757. Bounds of 30 s are kept.

| Claim                                      | Type                                | Bound     | Anchored at                                                 |
| ------------------------------------------ | ----------------------------------- | --------- | ----------------------------------------------------------- |
| Room row visible (116 `waitFor`)           | poll-until-true                     | 30 s      | the `rail-rooms` tap's return                               |
| 1 `composer-visible`                       | poll-until-true                     | 20 s      | the Room-row tap's return                                   |
| `composer-empty` (receipt)                 | single read                         | —         | the read that satisfied record 1                            |
| 2 `source-row-visible`                     | poll-until-true                     | 30 s      | the read that satisfied record 1                            |
| 3 `sheet-ready`                            | poll-until-true                     | 20 s      | the long press's return                                     |
| `quote-offered` (receipt)                  | single read                         | —         | the read that satisfied record 3                            |
| `quote-picked` (receipt): no sheet remains | poll-until-true                     | 20 s      | the `sheet-quote` tap's return                              |
| 4 `composer-quote`                         | poll-until-true                     | 20 s      | the `sheet-quote` tap's return                              |
| `quote-caret` (receipt)                    | single read                         | —         | the read that satisfied record 4                            |
| `answer-native-draft` (receipt)            | `appendNativeLine`'s own 15 s reads | 15 s each | each native key's return                                    |
| 5 `answer-send-enabled`                    | poll-until-true                     | 20 s      | the `hideKeyboard` return                                   |
| `answer-sent` (receipt): composer empty    | poll-until-true                     | 20 s      | the Send tap's return                                       |
| answer row reconciled (echo)               | poll-until-true                     | 30 s      | the Send tap's return                                       |
| `answer-event` (receipt, REST)             | poll-until-true                     | 30 s      | the Send tap's return                                       |
| 6 `answer-visible`                         | single read                         | —         | justified by the echo poll, compared to the proved event id |
| `sync-token` (receipt, REST)               | single read                         | —         | after record 6                                              |
| `probe-sent` (receipt, REST)               | single send                         | —         | after `sync-token`                                          |
| 7 `notification-positive`                  | poll-until-true (REST)              | 30 s      | the probe send's return                                     |
| 8 `highlight-zero`                         | single read                         | —         | **the same response** that satisfied record 7               |

Server polls use `left(bound, anchor) = max(bound − (now − anchor), 1)`, as
#757's `server()` does. A convergence that beats a fresh bound measured from
the poll's own start, but misses the bound measured from the anchor, fails.

### D5. The composer: Quote insertion, native answer and send

- **Quote ownership.** The `composer-empty` receipt proves that the
  composer was empty after the Room opened. Only the native `sheet-quote`
  tap can then produce the record-4 value. The `quote-picked` receipt
  proves that the tap closed the sheet.
- **Exact value (132).** Record 4 requires the composer's value to be
  exactly `QUOTED_COMPOSER` = `> Zephyrine, can you look at this?\n\n`: one
  `> ` line, the source verbatim, and a trailing blank line. Focus and caret
  are not part of the predecessor's claim. They are the `quote-caret`
  receipt: focused, caret collapsed at the value's length (36). Probe 1.3
  observed exactly that, and the native append needs it.
- **Native answer (134).** `pressSequentially(answer)` becomes #750's
  `appendNativeLine(client, QUOTED_COMPOSER, 'on it <run>')`. Android
  capitalises a lowercase letter that starts a paragraph, so the flow types
  `1on it <run>` (the digit sentinel `PARAGRAPH_SENTINEL`, one sentinel per
  typed value). It then walks the caret back with `arrowLeft` ×
  `answer.length`, deletes the sentinel with Backspace, and restores the
  caret with Ctrl+End. After every key, it waits for the exact value and
  caret. It never erases the quote and never sends Back. The
  `answer-native-draft` receipt records `QUOTED_COMPOSER + answer` exactly,
  with the caret at its end.
- **Send (135): record 5, `answer-send-enabled`.** The predecessor calls
  `sendComposerDraft(composer)`. On a mobile page (always, for
  `isAndroidE2E`) it waits for that composer's `composer-send` to be enabled
  (composer 53, 20 s) and clicks it, because Enter inserts a new line on
  mobile since `d3b27323`. The suite dismisses the keyboard, then polls
  record 5 with `assertSendEnabled(composer, QUOTED_COMPOSER + answer)`:
  exactly the draft, one Send button, enabled. That is the inherited site
  53@135, as #750 records it. The suite then taps Send natively, and the
  `answer-sent` receipt proves the composer cleared. Probe 1.4 saw Send
  enabled at the first read after `hideKeyboard`.
- **Answer visible (136).** First, the echo poll: exactly one visible row
  carrying the answer, with a `$` id. The id is registered at once. Next,
  `answer-event` reads the writer's `/messages` until that id is an
  `m.room.message` from the writer whose body is exactly
  `QUOTED_COMPOSER + answer`. It records `namesReader` (the body contains
  `Zephyrine`), and records, **without asserting**, `mentionsKey` and
  `relation: false`. Record 6 is then `assertSameRow(timeline, answer,
answerId)`: the one visible answer row is the proved server event. The
  body check fails closed, because the zero-highlight decision means
  something only if the quoted display name is in the body the server
  evaluated.

### D6. The server decision (records 7 and 8)

- **Token (143–146).** After record 6, `fixtures.roomUnreadSync(reader,
room.id)` makes the predecessor's exact `sync?timeout=0` as the reader's
  fixture session. Its `nextBatch` becomes `since`. The `sync-token`
  receipt records `{ established: true, baseline }`, where `baseline` is
  the Room's counts in that response or `null`. It is recorded, never
  asserted (probe 1.6).
- **Probe (147–150).** `fixtures.sendMessage(writer, room.id, 'poke <run>',
'<run>-probe')`, sent by the writer through REST with the predecessor's
  exact content. The event id is registered. `probeSentAt = Date.now()`
  after the send returns.
- **No read before the probe.** No incremental read with `since` is made
  before the probe send returns. Synapse caches non-empty `/sync` responses
  by request key for two minutes (probe 1.7). Every response computed after
  the probe's send returned already contains the persisted probe. So the
  only stale response a poll could see would come from a read made before
  the probe, and there is none. Empty responses are not cached (probe 2.8),
  so polling after an empty read still converges.
- **Record 7 (153).** `roomUnreadSync(reader, room.id, since)` is polled
  within `left(30 s, probeSentAt)` until one response satisfies
  `assertNotificationPositive(sync, { since, probeId })`. That response must
  echo the exact `since` (an incremental read, never a full sync), carry the
  Room, report `notificationCount > 0`, and hold the probe's event id in the
  Room's timeline. The last condition is the predecessor's own intent at
  151 ("Poll until the probe lands in the reader's incremental sync").
- **Record 8 (173).** `assertHighlightZero(decided)` runs on **that same
  response object**: `highlightCount === 0`. The poll stops at the first
  accepted response. It never re-polls for a convenient zero, and it never
  combines counts from two responses. The predecessor's `counts` variable
  had the same same-response semantics.
- The records hold `{ notificationCount, probeInSync: true }` and
  `{ highlightCount: 0, notificationCount, sameResponse: true }`. They never
  hold a token or an id.

### D7. Stage sequence (`quoted-display-name`)

1. Arrange (D2) and register every identifier (D9), then set
   `safety.unsafeSecrets = false`. Write the `arranged` receipt
   `{ messages: 1, readerJoined: true, displayName: true, roomDigest }`.
2. `reset` at Pixel 5, read back the profile, `login(writer)`,
   `hideKeyboard`.
3. Tap `rail-rooms`, wait for the Room row, and tap it. Poll and record
   `composer-visible` (`assertRoomReady`: one visible composer whose
   placeholder names the Room, on the Room's route). Write the receipt
   `composer-empty`.
4. Poll and record `source-row-visible`
   (`assertSameRow(timeline, SOURCE_BODY, sourceId)`).
5. `hideKeyboard`, then long-press the source row. Poll and record
   `sheet-ready` (`assertSheetVisible`: exactly one visible `Message actions`
   dialog). Write the receipt `quote-offered` (exactly one visible
   `sheet-quote`).
6. Tap `sheet-quote`. Poll for the `quote-picked` receipt
   (`assertSheetClosed`). Poll and record `composer-quote`. Write the
   receipt `quote-caret`.
7. `appendNativeLine`, then the receipt `answer-native-draft`.
8. `hideKeyboard`, then poll and record `answer-send-enabled`. Tap Send,
   then the `answer-sent` receipt.
9. The echo poll, then the `answer-event` receipt, then record
   `answer-visible`.
10. The `sync-token` receipt, the probe and the `probe-sent` receipt.
11. Poll and record `notification-positive`, then record `highlight-zero`
    from the same response.
12. Teardown (D10).

### D8. Documented reinterpretations

- **Sign-in and REST sessions (43–59, 75–81, 108–113).** Fixture Accounts
  and their closure-private sessions replace `registerUser`, `loginApi` and
  the `Bearer` headers. The writer signs in through the native one-flow
  sign-in.
- **Action sheet (124–126).** Playwright's synthetic touch long press
  becomes a native Maestro long press on the reconciled source row, and
  `sheet-quote` is tapped natively.
- **Answer entry (134).** `pressSequentially` becomes the sentinel-guarded
  native append (D5).
- **Send (135).** `sendComposerDraft`'s Playwright click on the Send button
  becomes a native tap, after its enabled-wait is proved as record 5.
- **Stronger row identity (123, 136).** The rows are the arranged source
  event and the proved answer event, compared by id in Node and never
  printed.
- **Answer on the wire.** A fail-closed receipt proves the server event's
  exact body, which includes the reader's display name, before any
  decision.
- **Incremental sync (152–169).** The accepting response must echo the
  `since`, carry the Room and include the probe. The highlight decision is
  read from that response alone. The predecessor's comment says a full sync
  reports zeroes; probe 1.6 shows Synapse 1.161 reports the real counts.
  The incremental requirement is kept anyway, for fidelity and because it
  proves the probe landed.
- **The reader's badge.** The predecessor's header comment names
  `.channel__badge` as "the honest observable end", but its code asserts the
  homeserver's counts. The suite follows the code. The reader never signs
  in, so no reader-side UI is observed.
- **Bounds.** Visible means one element with a non-empty box and
  `visibility: visible`. The 10 s and 15 s bounds become 20 s. Every window
  is anchored after its event (D4).
- **Identity without identifiers.** The Room is opened by exact name, and
  rows are found by body text. No selector or wait description carries an
  event or Room id.

### D9. Protection

Before any UI step, the stage registers:

- both Accounts' user ids, usernames and passwords;
- the Room id and the Room name;
- the run-bearing texts: the answer `on it <run>` and the probe `poke <run>`.
  The appended flow's `1on it <run>` contains the answer, so the same
  redaction covers it;
- both transaction ids, `<run>-src` and `<run>-probe`;
- the source event id.

The answer and probe event ids are registered the moment they are known.
The fixed texts (`Zephyrine`, `SOURCE_BODY`, `QUOTED_COMPOSER`) are
constants, not secrets. A test asserts that they are not registered, so the
scrub cannot blank the evidence that names them. The #752 strict scrub and
fail-closed scan apply unchanged, through the imported #756 helpers. No raw
`$…` event id, `!…:…` Room id, `syt_` token (writer device, writer fixture
or reader fixture), secure-storage payload, password, Room name, answer or
probe text may reach an artifact. The `since` token never enters a record.
Every raster is deleted.

The gated `android-quote-notification` upload runs only after
`publication-safe` is written. The marker requires:

- 1 stage and 8 records, in contract order;
- `pixel-5`, attempt 1 and retries 0;
- `quoted-display-name/profile-applied.json` and the three passed captures;
- runtime provenance with the Pixel 5 profile digest;
- a clean scan.

A failed stage is rethrown through `redactStageFailure`. Only error names
and the first line of each message survive, with every registered value and
every Matrix identifier shape redacted. The runner's single throw line is
exactly `throw redactStageFailure(entry.id, failures, secrets);`. Teardown
failures join the same `failures` list. A failed guarded cleanup is
rethrown through `redactCleanupFailure`, never as the raw error.

### D10. Teardown, must-run steps and guard strength

The suite writes no device setting. The teardown is `client.close()`, then
`device.clearApplicationData('eu.qwky.trinity')`, exported as
`quoteNotificationTeardown(client, device)`. The runner's stage `finally`
calls only
`finishQuoteNotificationStage(client, device, failures): Promise<boolean>`,
which runs that list through `runPinnedPanelStageCleanup`.

**Every "must run" step gets a guard that fails when the step is deleted,
moved or weakened.** Where the step lives in the device-bound runner
closure, the guard is an AST check with an effective in-memory mutation,
never a regex over the file:

| Must-run step                                                                                                      | Guard                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| stage `finally` → `if (await finishQuoteNotificationStage(client, device, failures)) safety.cleanupFailed = true;` | AST: first statement of the stage `TryStatement`'s `finallyBlock`; deleting it or moving it into the `try` fails                  |
| `finishQuoteNotificationStage` runs close then clear, even when close throws                                       | behavioural: fakes; order `['close', 'clear:eu.qwky.trinity']`; `true` on a throw, `false` on success                             |
| scan and scrub cleanups registered before `openMaestroDevice`, scan first                                          | AST: both `guardedCleanup('Scan …')` / `guardedCleanup('Scrub …')` calls, in that order, before the device; deleting either fails |
| outer `finally` → `if (effectiveSignal.aborted) await revokeOnAbort?.();`                                          | AST plus the behavioural revocation test                                                                                          |
| `assertQuoteNotificationRecords(entry.id, records)` then `client.capture('passed')` after the stage runner         | AST: both, in that order, in the stage `try` block after the runner call                                                          |
| the single `throw redactStageFailure(entry.id, failures, secrets);`                                                | exact count 1, and no other `throw failures`/`AggregateError` in the file                                                         |
| every identifier registered before any native action                                                               | simulated: the secrets snapshot taken by the fake `reset` contains every D9 value                                                 |
| the guarded cleanup marks failure, saves and rethrows id-free                                                      | behavioural port of #757's test                                                                                                   |

**Windows (fake clock).** The guard's simulated app drives the real,
imported `runQuotedDisplayName`. Each fake tap, long press and send first
advances the fake clock by `tapMs` (45 s in the window tests), then records
its return time. It changes no UI or server state inside the call. Every
state change becomes visible only in later reads, as a pure function of
`Date.now()` relative to the recorded return time and a named lag. For each
window class there is one passing case, 5 s inside the bound, and one
failing case, 1 s past it:

- 20 s UI windows (composer after the Room tap, sheet after the long press,
  sheet closed and composer quote after the Quote tap, Send enabled after
  `hideKeyboard`): 15 s passes, 21 s fails;
- 30 s windows (source row after record 1's read, answer echo after the Send
  tap): 25 s passes, 31 s fails;
- the answer event on the server: a lag of 15 s passes. Never converging
  fails. Converging 31 s after the Send tap, with every read burning 10 s,
  fails, even though that beats a fresh 30 s measured from the poll's start;
- the notification decision: the Room appears in the incremental sync 25 s
  after the probe send returns, which passes; 31 s, which fails; and 31 s
  with every read burning 10 s, which fails.

A window anchored anywhere earlier (at the stage start, or before the tap)
fails the passing cases.

### D11. CI placement and budget

- **Shard.** Headroom is `limit − figure − 45 (retained Playwright) − 15
(diagnostics)`, from the current `ci.yml` budget comment:

  | Shard | Figure | Limit | Headroom |
  | ----- | ------ | ----- | -------- |
  | 1     | 84     | 180   | 36       |
  | 2     | 75     | 180   | 45       |
  | 3     | 81     | 240   | 99       |
  | 4     | 85     | 240   | 95       |
  | 5     | 78     | 180   | 42       |
  | 6     | 89     | 180   | 31       |

  **Shard 3 has the most headroom.** The suite goes last, after
  `pinned-message-panel`. The latest hosted shard times agree: shard 3 took
  74 minutes and shard 4 88 minutes in run 36436865291 (ruled Q5).

- **Budget.** The estimate is 4 minutes, from probe 1's 3 min 03 s plus
  provenance and captures. That gives 81 + N, and 81 + N + 45 + 15 ≤ 240 for
  any N ≤ 99. With the estimate, the shard-3 figure is 85 of 240, with 95
  minutes of headroom left. The acceptance task replaces the estimate with the measured local
  time, rounded up. It changes `shard 3 about 81` and adds "Shard 3 also
  carries quote-notification at its N-minute local acceptance time until a
  hosted run measures it."
- **Timeouts.** A 15-minute Node test (`--timeout-ms=900000`) and a
  20-minute CI wrapper (`1200000`), as #757. The acceptance task re-derives
  both if the measured run exceeds 10 minutes.
- **Docs.** There is no CHANGELOG or README change: this is a test-only
  migration.

### D12. MIGRATION.md section

The suite appends `## Quote-notification journey` after
`## Pinned-message workflow journeys`, in #757's shape:

- the source paragraph: the canonical working tree and `dd0cb53c` blob
  `5186fc3b…`, the stale issue pin `354f8f2c…` with its two-line
  `fe2c7c3e` difference, the spans (64–174, 40–59), and the three shared
  pins;
- the sentence
  `The suite records 8 ordered, unique identities: 6 direct + 2 inherited (the action-sheet readiness of openMessageActionSheet, app line 220, reached from line 125, and the Send readiness of sendComposerDraft, message-composer line 53, reached from line 135).`,
  and the 8-row table;
- the arrangement and native-ownership paragraph;
- the decision paragraph (D6), including the no-read-before-the-probe rule;
- the protection paragraph, ending exactly: "a failed teardown step is
  rethrown through `redactStageFailure`, and a failed guarded cleanup is
  rethrown through `redactCleanupFailure`, never as the raw error.";
- `Documented reinterpretations of the predecessor:` with the D8 bullets;
- known-limitation bullets:
  - **Desktop path.** The hover `⋯` menu (`clickRowMenuItem`, `msg-quote`, 128) is not exercised on Android;
  - **Server rule sensitivity.** The suite does not re-prove, on each run,
    that the display-name rule would fire without `m.mentions`. Probe 2.9
    showed it does on Synapse 1.161 (ruled Q7);
  - **Full-sync comment.** The predecessor's claim that a full sync reports
    zeroes does not hold on Synapse 1.161. The incremental requirement is
    kept anyway;
- the command block and the target paragraph: one attempt, zero retries,
  the 15/20-minute bounds, and the placement sentence, which begins with the
  invariant text `Shard 3 runs it last, after pinned-message-panel`;
- the acceptance paragraph, written in the acceptance task;
- `Predecessor status: enabled; after hosted acceptance the coordinator keeps the file as a desktop-only definition, skipped on Android (#839).`

### D13. Predecessor retention and retirement scope

Until hosted acceptance, the predecessor file is unchanged. The guard
asserts that the working tree is `5186fc3b…`, with one definition, one
`test.skip(` (the Synapse self-skip), and no `fixme`/`only`. It also asserts
one browser-journey catalog entry, and that the Android Playwright config
still matches `browser/journeys/**`.

The definition holds a desktop `else` branch (127–129). So under #839 the
file is not deleted on hosted acceptance: the definition stays for its
desktop branch, loses its Android branch, and skips on Android, where this
suite owns its execution. The registry entry would be:

```js
{
  path: 'e2e/browser/journeys/conversations/quote-mentions.spec.mts',
  sha256: '5186fc3b45f12fd03e2ad71e79ae636a688fce41b96d05fb0e38f278f80266e5',
  issues: [758],
  deleted: false,
  retired: [],
  desktopOnly: ['a quoted display name gives the reader no highlight'],
}
```

The blob at `dd0cb53c` is `5186fc3b…`, so this entry pins at the existing
commit, as #750 did for `message-quote.spec.mts` ("0 retired", kept
desktop-only). The retirement commit also moves this guard's working-tree
pin and switches its retention assertions to the desktop-only state. The
`dd0cb53c` blob pin, and every span and site read from it, stay unchanged
(ruled Q6). Retirement is the coordinator's step; no plan task touches the
retirement registry.

## Negative-control plan

Each control names its fault exactly. The guard models that fault, not a
neighbouring one. Each control must fail when its protection is removed:

- **Sources and ledger.**
  - The five hashes: the `dd0cb53c` blob, the working tree, `app.mts`,
    `account.mts` and `message-composer.mts`. A one-byte flip of each fails.
  - The blob equals the working tree. A one-byte drift of the tree fails
    equality as well as its hash.
  - The stale issue pin's provenance: undoing `fe2c7c3e` gives `354f8f2c…`.
    A third changed line, or the import at another index, fails.
  - Every text pin under a one-character in-memory mutation, including
    `READER_DISPLAY_NAME`, the `qm`, `qmw-` and `qmr-` templates, the Room
    name, the `private_chat` and `invite` line, the reader's `-src` send,
    the `isAndroidE2E` branch, `sheet-quote`, the exact `toHaveValue`, the
    answer template, `sendComposerDraft(composer)`, both `sync` URLs, the writer's
    `-probe` send, the `poke` body, `unread_notifications`, the 30 s poll
    bound, `.toBeGreaterThan(0)` and `toBe(0)`.
  - The site map: the identifier-only counter finds 5, not 6.
  - A shadowing local `openMessageActionSheet` or `sendComposerDraft` does
    not expand.
  - The naive expansion counts 9, not 8.
  - Each AST-derived line (the 6 direct sites, 220@125, 53@135, 206@128)
    differs from the contract under mutation.
- **Imported-export shape (ruled Q4).** Each pinned import signature,
  interface member list, `PARAGRAPH_SENTINEL` and the append-flow hash fails
  under an in-memory mutation of its declaration.
- **Fixture read-only (ruled Q3).** `roomUnreadSync` fails its guard if it
  gains `request(`, `'POST'` or `'PUT'`, reads anything other than
  `access(observer)` through `get(`, or returns a token field. Its test
  proves every call is a `GET` and no result contains the token.
- **Arrangement.** The stage rejects, before any native action:
  - a source sent by the writer;
  - a second message;
  - a display name `Zephyrin`;
  - a reader left at `invite`;
  - a page that does not reach `m.room.create`.
- **Native quote and composer ownership.** The stage fails on:
  - a composer already holding the quote before the long press
    (`composer-empty`);
  - a sheet with no `sheet-quote`, or with two;
  - a Quote tap that leaves the sheet open;
  - a native action replaced by a renderer dispatch (source bans, each shown
    effective by an in-memory insertion);
  - a composer that loses focus before the append.
- **Exact quote value.** The stage fails on a one-character difference in
  the source line, a missing trailing blank line (`\n` only), an extra
  `>` line, and a caret left at 0 (`quote-caret`).
- **Native answer and send readiness.** The stage fails on a capitalised
  `On it`, a kept sentinel, an erased quote prefix, and a Send button that
  never enables (record 5).
- **Sent-answer visibility.** The stage fails on:
  - an answer row that never reconciles (a `~` local id);
  - a server body that differs by one character, or lacks the quote;
  - an answer event from the reader;
  - two rows carrying the answer;
  - a composer not cleared after Send.
- **Positive ordinary notification control.** The stage fails on:
  - an incremental sync that never carries the Room;
  - `notificationCount` 0 forever;
  - a positive count whose response lacks the probe;
  - a response that does not echo the pre-probe `since` (a full sync);
  - an incremental read made before the probe send returns (the fake
    rejects it as the cached pre-probe response Synapse would serve).
- **Zero highlight decision.** The stage fails on:
  - `highlightCount` 1;
  - a first accepted response with highlight 1 followed by a later response
    with highlight 0 (no re-poll to a convenient zero);
  - a source containing `pushrules`.
- **Windows.** The D10 fake-clock pairs.
- **Cleanup and redaction.** The D10 must-run table; every identifier form,
  both passwords, both fixture tokens and the device token in the scan; the
  answer and probe texts; a raster; a failed cleanup, scrub or scan;
  revocation on abort; and the publication marker withheld for:
  - 0 stages;
  - 7 records;
  - a swapped record;
  - `retries: 1`;
  - a wrong profile;
  - `cleanupFailed`;
  - an unscrubbed identifier.

## Evidence and acceptance plan

1. Run the guard, the fixture test, the typecheck, ESLint on the changed
   files, and the neighbour guards. These include `message-quote-migration`
   and `pinned-message-panel-migration`, whose modules this suite imports,
   and every guard that reads `account-workspace-fixtures.mts`. Then run the
   full `pnpm nx run scripts:test`.
2. Develop on the device until the stage passes. Fix each finding at its
   root, and add one guard control per fix.
3. On the final unchanged commit, with a fresh production renderer, run
   three consecutive `trinity-e2e-android:quote-notification` first
   attempts. Each must show:
   - 1/1 stage and 8/8 records at attempt 1, with zero retries;
   - `publication-safe`;
   - matching built and installed APK digests;
   - the Pixel 5 profile digest;
   - a clean identifier and raster scan.

   Each run also reports every tap latency, the decision's
   `notificationCount`/`highlightCount`, and the number of incremental reads.

4. Run the predecessor sequentially at `--workers=1 --retries=0`. It must
   pass, exactly as the issue's baseline comment ran it.
5. Hosted: the coordinator audits the original-attempt shard-3 Android
   artifact, the browser artifact and the renderer artifact. It then applies
   D13 and updates the parent ledger.

## Rulings (coordinator, 2026-09-30)

1. **Q1 + Q2, canonical bytes and Send readiness. Ruled against the first
   recommendation.** The canonical predecessor is the working tree, equal
   to the `dd0cb53c` blob (`5186fc3b…`, 175 lines). Spans move down by one,
   and there are **8 records**: 6 direct, plus `openMessageActionSheet`
   readiness (app 220@125), plus `sendComposerDraft` send readiness
   (composer 53@135) as the inherited record `answer-send-enabled`,
   following #748 and #750. The reason: the difference from `354f8f2c`
   is behavioural, so porting the stale bytes would drop a live assertion.
   The issue's pin is recorded as stale, with the two-line diff and its
   `fe2c7c3e` provenance. The guard pins the blob and the working tree,
   proves them equal, and keeps AST verification of every span, including
   the `expect.poll` at 153 and composer 53.
2. **Q3, reader sync. Accepted.** The additive read-only `roomUnreadSync`
   fixture member, with its token kept in the closure. A source guard and a
   behavioural test prove it is read-only and never exposes the token.
3. **Q4, cross-suite reuse. Accepted.** The suite imports #750's readers,
   asserters and `appendNativeLine`, and #756's artifact helpers. Because
   importing from a journeys module is new, the imported-export shape guard
   (Selected architecture) pins every imported name's shape and the append
   flow.
4. **Q5, shard. Accepted.** Shard 3, after `pinned-message-panel`. The
   budget arithmetic is in D11.
5. **Q6, retirement. Accepted.** After hosted acceptance, a `desktopOnly`
   entry at `dd0cb53c` keeps the file for its desktop `else` (D13). This is
   the coordinator's step; no task touches the retirement files.
6. **Q7, sensitivity control. Accepted.** There is no per-run sensitivity
   control. Probe 2.9 is the evidence, recorded as a known limitation.

Also binding, from #757's execution:

- no guard pins text that a later task must change;
- every negative control above has a test step;
- every must-run call has a deletion guard;
- no specified fault is modelled by a substitute.
