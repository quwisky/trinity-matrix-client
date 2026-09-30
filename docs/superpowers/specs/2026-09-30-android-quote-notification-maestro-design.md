# Android Quote-Notification Maestro Migration Design

- Issue: #758, part of #660
- Status: Proposed; the coordinator rules on the open questions below
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

### Pin reconciliation with the issue

The issue pins
`e2e/browser/journeys/conversations/quote-mentions.spec.mts` at SHA-256
`354f8f2ccd02e32b12bf74bea400abb4dec40bad31715fd80e03c4fd79fd49f8`
(174 lines). **The working tree no longer hashes to that pin.** It hashes to
`5186fc3b45f12fd03e2ad71e79ae636a688fce41b96d05fb0e38f278f80266e5`
(175 lines). The issue's baseline comment (2026-09-20) predates `fe2c7c3e`
(2026-09-25, "send composer drafts with the Send button on mobile"), which
changed exactly two lines of this file:

- it added line 16, `import { sendComposerDraft } from '../../../support/message-composer.mts';`;
- it replaced `await composer.press('Enter');` (canonical line 134) with
  `await sendComposerDraft(composer);` (working-tree line 135).

Every other line is unchanged, so every issue span below line 16 moves down
by one in the working tree. The file has not changed since, so the blob at
`RETIRED_PREDECESSOR_COMMIT` `dd0cb53c` is also `5186fc3b…` (verified with
`git show dd0cb53c:<path> | sha256sum`). The issue's bytes are the blob
`d30e3ceb` at `d3b27323` (`fe2c7c3e^`), verified by hash.

The #757 method (read the issue's bytes at `dd0cb53c`) does not apply,
because `dd0cb53c` holds the post-`fe2c7c3e` bytes. The guard therefore
combines #757's read with #750's reconstruction (open question 1):

1. it reads the predecessor with `readRetiredPredecessor(PREDECESSOR)` at
   `dd0cb53c` and pins it at `5186fc3b…`;
2. it pins the working tree separately at `5186fc3b…` (identical today; only
   this pin moves when the file is later edited under D13);
3. it rebuilds the canonical bytes in memory by undoing exactly
   `fe2c7c3e` (drop the import line, restore the Enter press) and requires
   SHA-256 `354f8f2c…`. It also requires the rebuilt text, with the two lines
   re-applied, to equal the pinned blob line for line. This proves that the
   difference is exactly those two lines, at those positions.

The canonical bytes are the parity source: every span, site and line pin
below uses canonical numbering. The guard never needs Git history older than
`dd0cb53c`, which CI already fetches.

The guard also pins these shared sources:

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`              | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts`          | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |
| `e2e/support/message-composer.mts` | `4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d` |

`message-composer.mts` is pinned because the working tree's
`sendComposerDraft` reaches its line 53 (D5, open question 2). All three
hashes were recomputed for this design and match the issue and the #750
guard.

| Canonical span | Working tree | Role                                                                                       |
| -------------- | ------------ | ------------------------------------------------------------------------------------------ |
| 37             | 38           | `const session = synapseSession();`                                                        |
| 39–40          | 40–41        | the JSDoc and `READER_DISPLAY_NAME = 'Zephyrine'`                                          |
| 42–58          | 43–59        | `loginApi`: password login for a REST token (replaced; D1)                                 |
| 39–58          | 40–59        | the issue's "display-name constant and API-login helper" span                              |
| 63–173         | 64–174       | the definition `a quoted display name gives the reader no highlight`                       |
| 68             | 69           | ``runId = `${testResourceId('run')}qm` ``                                                  |
| 69–72          | 70–73        | `qmw-${runId}`, `qmr-${runId}`, `${runId}-pass`, `Quote mentions ${runId}`                 |
| 74–79          | 75–80        | `registerUser` ×2, `loginApi` ×2, both `Bearer` headers                                    |
| 82–85          | 83–86        | the reader's display name is set to `READER_DISPLAY_NAME`                                  |
| 87–96          | 88–97        | the writer creates the `private_chat` Room inviting the reader; the reader joins           |
| 100–104        | 101–105      | `named`, sent **by the reader** with txn `${runId}-src`                                    |
| 106–116        | 107–117      | UI `login` as the writer, `rail-rooms`, `.channel` by name (30 s `waitFor`), open          |
| 123–125        | 124–126      | the `isAndroidE2E` branch: `openMessageActionSheet`, then `sheet-quote`                    |
| 126–128        | 127–129      | the desktop `else`: `clickRowMenuItem(… 'msg-quote')`: **excluded**                        |
| 132–134        | 133–135      | `answer = on it ${runId}`, `pressSequentially`, `press('Enter')` (working tree: Send)      |
| 142–145        | 143–146      | the reader's full `sync?timeout=0` for `next_batch`                                        |
| 146–149        | 147–150      | the writer's REST probe `poke ${runId}`, txn `${runId}-probe`                              |
| 151–168        | 152–169      | the incremental-sync poll (`expect.poll`, 30 s)                                            |
| 172            | 173          | `expect(counts.highlight_count).toBe(0)`                                                   |
| app 214–222    | —            | `openMessageActionSheet`: touch long press, then `expect(sheet).toBeVisible` at 220 (10 s) |
| app 202–211    | —            | `clickRowMenuItem`: its `expect(…).toPass` starts at **206**, reached only from 127        |
| composer 45–55 | —            | `sendComposerDraft`: on mobile, `expect(send).toBeEnabled` at **53** (20 s), then click    |

The app and composer lines are AST-derived: the guard computes them with
`helperExpectLines` over the pinned sources, and the contract's values must
equal that output. No helper line in the contract is typed by hand and left
unchecked (the #757 `clickRowMenuItem` 207→206 defect).

## Parity records: 6 direct + 1 inherited = 7

A site is every `expect(…)` call **and every `expect.poll(…)` call** in the
definition's span, as the edit-history and message-action-sheet guards
count them. Line 152 is `await expect` followed by `.poll(` on 153. The
call expression starts at 152. An identifier-only counter finds 5 sites and
misses it; the guard proves that difference.

- The definition owns 6 direct sites: 117, 122, 131, 135, 152 and 172.
- The Android branch at 124 expands `openMessageActionSheet`'s one
  readiness site (app 220).
- The desktop `else` branch's `clickRowMenuItem` site (app 206, reached from 127) is excluded, as the message-quote and pinned-workflow guards exclude
  their desktop branches.
- The working tree's `sendComposerDraft` site (composer 53, reached from
  working-tree 135) is not in the canonical bytes. It is excluded from the
  ledger and realised as the receipt `send-enabled` (D5, open question 2).
- `login`, `registerUser`, `loginApi`, `synapseSession` and `touchLongPress`
  reach no site. The guard proves this by binding resolution.
- The `waitFor` at 115 is not an `expect` site. It becomes a polled
  precondition (D4).

Identities are `quote-notification.quoted-display-name.<suffix>`:

| #   | Source  | Kind      | Predecessor claim                                                         | Suffix                  |
| --- | ------- | --------- | ------------------------------------------------------------------------- | ----------------------- |
| 1   | 117     | direct    | `composer-input` visible (15 s)                                           | `composer-visible`      |
| 2   | 122     | direct    | the `.scroll .msg` row with `named` is visible (30 s)                     | `source-row-visible`    |
| 3   | 220@124 | inherited | the `Message actions` sheet is visible (10 s)                             | `sheet-ready`           |
| 4   | 131     | direct    | the composer value is exactly `> ${named}\n\n` (10 s)                     | `composer-quote`        |
| 5   | 135     | direct    | the `.scroll .msg` row with the answer is visible (30 s)                  | `answer-visible`        |
| 6   | 152     | direct    | the reader's incremental-sync `notification_count` is above 0 (30 s poll) | `notification-positive` |
| 7   | 172     | direct    | that same response's `highlight_count` is exactly 0                       | `highlight-zero`        |

The stage `quoted-display-name` is titled after the predecessor,
`a quoted display name gives the reader no highlight`, with 7 records. The
helper table has one entry, `openMessageActionSheet` (module
`e2e/support/app.mts`, `expectLines: [220]`, role
`action-sheet-readiness`, call 124). A naive expansion that follows every
support call finds 8 sites in the canonical bytes (+206) and 9 in the
working tree (+206, +53). The guard asserts both numbers, and neither equals
the contract's 7.

## Selected architecture

| Unit      | File                                            | Responsibility                                                                                                              |
| --------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Guard     | `scripts/quote-notification-migration.spec.mjs` | Pins and reconstruction, AST site map, bindings and exclusions, action bans, simulated app, negative controls, wiring       |
| Contract  | `e2e/android/quote-notification-contract.mts`   | One stage, 7 identities, texts, sheet/composer asserters, arrangement, answer-event and sync decision asserters             |
| Artifacts | `e2e/android/quote-notification-artifacts.mts`  | Secrets, the publication marker and abort revocation                                                                        |
| Journeys  | `e2e/android/quote-notification-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, the stage, `finishQuoteNotificationStage`, redacted rethrows                   |
| Fixture   | `e2e/android/account-workspace-fixtures.mts`    | **One additive member**, `roomUnreadSync` (open question 3), with its test in `scripts/account-workspace-fixtures.spec.mjs` |

There is no local observer: every renderer read the suite needs already
exists. Reused unchanged, by import (open question 4):

- `account-workspace-client.mts`: `reset`, `login`, `hideKeyboard`,
  `tapCurrent`, `longPressCurrent`, `visible`, `capture`, `record`,
  `close`. There is no `SharedStageAccount`: the suite has one stage.
- `account-workspace-fixtures.mts`: `account`, `setDisplayName`,
  `createRoom` (with `invite`), `join`, `sendMessage`, `roomMessages`, and
  the new `roomUnreadSync`.
- `message-quote-observer.mts`: `readComposer`, `readTimeline`, `readSheet`
  and `readAppliedProfile`, with their pure expression builders.
- `message-quote-contract.mts`: `assertRoomReady`, `assertSameRow`,
  `assertServerEcho`, `assertSendEnabled`, `assertDraftSent`,
  `assertSheetClosed` and `authoritativeRoomMessages`, plus the types
  `ComposerObservation`, `TimelineObservation` and `SheetObservation`.
- `message-quote-journeys.mts`: `appendNativeLine`. It is the
  sentinel-guarded native paragraph append through
  `flows/message-quote-append.yaml`.
- `pinned-message-panel-artifacts.mts`: `redactDiagnosticText`,
  `scrubPinnedPanelArtifacts`, `scanPinnedPanelArtifacts`,
  `runPinnedPanelStageCleanup` and the type `PinnedPanelPublicationSafety`.
  These are the stage-free helpers #757 already imports.

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
  its `qmr-` user. Their fixture sessions replace `loginApi` (42–58) and the
  two `Bearer` headers, and their tokens never leave the fixture closure.
- Only the writer signs in on the device, through the one-flow
  `client.login(writer)`, then `client.hideKeyboard()`. The reader never
  signs in, because the predecessor's reader side is the homeserver's
  decision, read through REST (D6).

### D2. Arrangement

All of it goes through real Synapse, in the predecessor's order, before any
UI step:

- `run` is `${resources.aliasLocalpart('quote-notification')}qm` (68);
- `fixtures.setDisplayName(reader, 'Zephyrine')` (82–85) runs **before**
  the Room exists, so the invite and join member events carry the name that
  `.m.rule.contains_display_name` matches (probe 1);
- the writer creates the Room `Quote mentions <run>` with
  `preset: 'private_chat'` and `invite: [reader.userId]` (87–93), and the
  reader joins it (94–96);
- **the reader** sends `Zephyrine, can you look at this?` with txn
  `<run>-src` (100–104). The fixture's content is exactly the predecessor's
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
   30 s (the 115 `waitFor`);
4. `hideKeyboard`, then
   `longPressCurrent('.scroll .msg[data-mid^="$"]', { text: SOURCE_BODY })`,
   after the record-2 read proves exactly one such reconciled row, and that
   it is the arranged event;
5. tap `[data-testid="sheet-quote"]`, which is visible and unobstructed
   without a swipe (probe 1.3);
6. `appendNativeLine(client, QUOTED_COMPOSER, answer)` (D5);
7. `hideKeyboard`, then tap `[data-testid="composer-send"]`.

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
| Room row visible (115 `waitFor`)           | poll-until-true                     | 30 s      | the `rail-rooms` tap's return                               |
| 1 `composer-visible`                       | poll-until-true                     | 20 s      | the Room-row tap's return                                   |
| `composer-empty` (receipt)                 | single read                         | —         | the read that satisfied record 1                            |
| 2 `source-row-visible`                     | poll-until-true                     | 30 s      | the read that satisfied record 1                            |
| 3 `sheet-ready`                            | poll-until-true                     | 20 s      | the long press's return                                     |
| `quote-offered` (receipt)                  | single read                         | —         | the read that satisfied record 3                            |
| `quote-picked` (receipt): no sheet remains | poll-until-true                     | 20 s      | the `sheet-quote` tap's return                              |
| 4 `composer-quote`                         | poll-until-true                     | 20 s      | the `sheet-quote` tap's return                              |
| `quote-caret` (receipt)                    | single read                         | —         | the read that satisfied record 4                            |
| `answer-native-draft` (receipt)            | `appendNativeLine`'s own 15 s reads | 15 s each | each native key's return                                    |
| `send-enabled` (receipt)                   | poll-until-true                     | 20 s      | the `hideKeyboard` return                                   |
| `answer-sent` (receipt): composer empty    | poll-until-true                     | 20 s      | the Send tap's return                                       |
| answer row reconciled (echo)               | poll-until-true                     | 30 s      | the Send tap's return                                       |
| `answer-event` (receipt, REST)             | poll-until-true                     | 30 s      | the Send tap's return                                       |
| 5 `answer-visible`                         | single read                         | —         | justified by the echo poll, compared to the proved event id |
| `sync-token` (receipt, REST)               | single read                         | —         | after record 5                                              |
| `probe-sent` (receipt, REST)               | single send                         | —         | after `sync-token`                                          |
| 6 `notification-positive`                  | poll-until-true (REST)              | 30 s      | the probe send's return                                     |
| 7 `highlight-zero`                         | single read                         | —         | **the same response** that satisfied record 6               |

Server polls use `left(bound, anchor) = max(bound − (now − anchor), 1)`, as
#757's `server()` does. A convergence that beats a fresh bound measured from
the poll's own start, but misses the bound measured from the anchor, fails.

### D5. The composer: Quote insertion, native answer and send

- **Quote ownership.** The `composer-empty` receipt proves that the
  composer was empty after the Room opened. Only the native `sheet-quote`
  tap can then produce the record-4 value. The `quote-picked` receipt
  proves that the tap closed the sheet.
- **Exact value (131).** Record 4 requires the composer's value to be
  exactly `QUOTED_COMPOSER` = `> Zephyrine, can you look at this?\n\n`: one
  `> ` line, the source verbatim, and a trailing blank line. Focus and caret
  are not part of the predecessor's claim. They are the `quote-caret`
  receipt: focused, caret collapsed at the value's length (36). Probe 1.3
  observed exactly that, and the native append needs it.
- **Native answer (133).** `pressSequentially(answer)` becomes #750's
  `appendNativeLine(client, QUOTED_COMPOSER, 'on it <run>')`. Android
  capitalises a lowercase letter that starts a paragraph, so the flow types
  `1on it <run>` (the digit sentinel `PARAGRAPH_SENTINEL`, one sentinel per
  typed value). It then walks the caret back with `arrowLeft` ×
  `answer.length`, deletes the sentinel with Backspace, and restores the
  caret with Ctrl+End. After every key, it waits for the exact value and
  caret. It never erases the quote and never sends Back. The
  `answer-native-draft` receipt records `QUOTED_COMPOSER + answer` exactly,
  with the caret at its end.
- **Send (134).** The canonical `composer.press('Enter')` cannot send on
  Android: since `d3b27323`, Enter inserts a new line on mobile. That is why
  `fe2c7c3e` changed this line to `sendComposerDraft`, whose mobile branch
  waits for `composer-send` to be enabled (composer 53, 20 s) and clicks it.
  The suite dismisses the keyboard, then polls the `send-enabled` receipt:
  exactly the draft, one Send button, enabled. This is the working tree's
  53 wait as a **receipt**, not a parity record, because the canonical bytes
  hold no such site (open question 2). The suite then taps Send natively.
  `answer-sent` proves the composer cleared.
- **Answer visible (135).** First, the echo poll: exactly one visible row
  carrying the answer, with a `$` id. The id is registered at once. Next,
  `answer-event` reads the writer's `/messages` until that id is an
  `m.room.message` from the writer whose body is exactly
  `QUOTED_COMPOSER + answer`. It records `namesReader` (the body contains
  `Zephyrine`), and records, **without asserting**, `mentionsKey` and
  `relation: false`. Record 5 is then `assertSameRow(timeline, answer,
answerId)`: the one visible answer row is the proved server event. The
  body check fails closed, because the zero-highlight decision means
  something only if the quoted display name is in the body the server
  evaluated.

### D6. The server decision (records 6 and 7)

- **Token (142–145).** After record 5, `fixtures.roomUnreadSync(reader,
room.id)` makes the predecessor's exact `sync?timeout=0` as the reader's
  fixture session. Its `nextBatch` becomes `since`. The `sync-token`
  receipt records `{ established: true, baseline }`, where `baseline` is
  the Room's counts in that response or `null`. It is recorded, never
  asserted (probe 1.6).
- **Probe (146–149).** `fixtures.sendMessage(writer, room.id, 'poke <run>',
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
- **Record 6 (152).** `roomUnreadSync(reader, room.id, since)` is polled
  within `left(30 s, probeSentAt)` until one response satisfies
  `assertNotificationPositive(sync, { since, probeId })`. That response must
  echo the exact `since` (an incremental read, never a full sync), carry the
  Room, report `notificationCount > 0`, and hold the probe's event id in the
  Room's timeline. The last condition is the predecessor's own intent at
  150 ("Poll until the probe lands in the reader's incremental sync").
- **Record 7 (172).** `assertHighlightZero(decided)` runs on **that same
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
8. `hideKeyboard`, then the `send-enabled` receipt. Tap Send, then the
   `answer-sent` receipt.
9. The echo poll, then the `answer-event` receipt, then record
   `answer-visible`.
10. The `sync-token` receipt, the probe and the `probe-sent` receipt.
11. Poll and record `notification-positive`, then record `highlight-zero`
    from the same response.
12. Teardown (D10).

### D8. Documented reinterpretations

- **Sign-in and REST sessions (42–58, 74–80, 107–112).** Fixture Accounts
  and their closure-private sessions replace `registerUser`, `loginApi` and
  the `Bearer` headers. The writer signs in through the native one-flow
  sign-in.
- **Action sheet (123–125).** Playwright's synthetic touch long press
  becomes a native Maestro long press on the reconciled source row, and
  `sheet-quote` is tapped natively.
- **Answer entry (133).** `pressSequentially` becomes the sentinel-guarded
  native append (D5).
- **Send (134).** The canonical Enter press becomes the native tap on the
  composer's Send button, the path the working tree takes since `fe2c7c3e`.
  Its enabled-wait is a receipt (open question 2).
- **Stronger row identity (122, 135).** The rows are the arranged source
  event and the proved answer event, compared by id in Node and never
  printed.
- **Answer on the wire.** A fail-closed receipt proves the server event's
  exact body, which includes the reader's display name, before any
  decision.
- **Incremental sync (151–168).** The accepting response must echo the
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

- 1 stage and 7 records, in contract order;
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
  74 minutes and shard 4 88 minutes in run 36436865291 (open question 5).

- **Budget.** The estimate is 4 minutes, from probe 1's 3 min 03 s plus
  provenance and captures. That gives 81 + N, and 81 + N + 60 ≤ 240 for any
  N ≤ 99. The acceptance task replaces the estimate with the measured local
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

- the source paragraph: the issue pin `354f8f2c…` (canonical bytes,
  reconstructed from the `dd0cb53c` blob by undoing `fe2c7c3e`), the
  working tree and blob `5186fc3b…`, the two-line difference, the spans,
  and the three shared pins;
- the sentence
  `The suite records 7 ordered, unique identities: 6 direct + 1 inherited (the action-sheet readiness of openMessageActionSheet, app line 220, reached from line 124).`,
  and the 7-row table;
- the arrangement and native-ownership paragraph;
- the decision paragraph (D6), including the no-read-before-the-probe rule;
- the protection paragraph, ending exactly: "a failed teardown step is
  rethrown through `redactStageFailure`, and a failed guarded cleanup is
  rethrown through `redactCleanupFailure`, never as the raw error.";
- `Documented reinterpretations of the predecessor:` with the D8 bullets;
- known-limitation bullets:
  - **Desktop path.** The hover `⋯` menu (`clickRowMenuItem`, `msg-quote`, 127) is not exercised on Android;
  - **Server rule sensitivity.** The suite does not re-prove, on each run,
    that the display-name rule would fire without `m.mentions`. Probe 2.9
    showed it does on Synapse 1.161 (open question 7);
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

The definition holds a desktop `else` branch (126–128). So under #839 the
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
pin and switches its retention assertions to the desktop-only state. It
never touches the canonical reconstruction, which reads `dd0cb53c`
(open question 6).

## Negative-control plan

Each control names its fault exactly. The guard models that fault, not a
neighbouring one. Each control must fail when its protection is removed:

- **Sources and ledger.**
  - The six hashes: the canonical reconstruction, the `dd0cb53c` blob, the
    working tree, `app.mts`, `account.mts` and `message-composer.mts`.
    A one-byte flip of each fails.
  - The exact two-line difference. A third changed line, or the import at
    another index, fails.
  - Every text pin under a one-character in-memory mutation, including
    `READER_DISPLAY_NAME`, the `qm`, `qmw-` and `qmr-` templates, the Room
    name, the `private_chat` and `invite` line, the reader's `-src` send,
    the `isAndroidE2E` branch, `sheet-quote`, the exact `toHaveValue`, the
    answer template, `press('Enter')`, both `sync` URLs, the writer's
    `-probe` send, the `poke` body, `unread_notifications`, the 30 s poll
    bound, `.toBeGreaterThan(0)` and `toBe(0)`.
  - The site map: the identifier-only counter finds 5, not 6.
  - A shadowing local `openMessageActionSheet` does not expand.
  - The naive expansion counts 8 (canonical) and 9 (working tree).
  - Each AST-derived helper line (220, 206, 53) differs from the contract
    under mutation.
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
- **Native answer.** The stage fails on a capitalised `On it` (the sentinel
  kept or dropped), an erased quote prefix, and a Send button that never
  enables.
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
  - 6 records;
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
   - 1/1 stage and 7/7 records at attempt 1, with zero retries;
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

## Open questions for the coordinator

1. **Predecessor pin versus the working tree.** The issue pins `354f8f2c…`,
   the bytes before `fe2c7c3e`. The working tree and `dd0cb53c` hold
   `5186fc3b…`. **Recommendation:** treat the issue's bytes as canonical,
   rebuilt in memory from the `dd0cb53c` blob by undoing exactly
   `fe2c7c3e`'s two lines, and proved by hash and line equality. Take every
   span and site from them, and pin the working tree separately. This keeps
   the issue's spans (63–173, 39–58) and counts verbatim, and needs no Git
   history older than `dd0cb53c`. **If instead** the working tree is ruled
   canonical (the #748/#750 precedent), every span moves down by one
   (64–174, 40–59), and question 2 must be answered "8 records". The cost is
   the contract spans, `LINE_PINS` and the MIGRATION table (plan Task 2
   Steps 1 and 3, and Task 4 Step 4). Reading `d3b27323` directly through Git
   would need full history in every job that runs the guard.
2. **The Send-readiness site.** The working tree's `sendComposerDraft`
   reaches `expect(send).toBeEnabled` (composer 53) on Android. The
   canonical bytes do not contain it. **Recommendation:** 7 records, as the
   issue states, with the 53 wait kept as the fail-closed `send-enabled`
   receipt (same predicate and bound). **If instead** the #750 precedent is
   followed (#750 grew its issue's 20 records to 23 for exactly this helper),
   a record `answer-send-enabled` (53@135 tree, inherited) is inserted
   after `composer-quote`, with 8
   records, 6 direct and 2 inherited. The cost is one identity in the
   contract, the helper table, the marker count, the MIGRATION table and the
   simulated action log. That is plan Task 2 Steps 3 and 6, Task 3 Step 5,
   Task 4 Steps 1 and 4, and Task 6.
3. **Reader sync access.** The reader's token is closure-private in the
   shared fixtures. **Recommendation:** add one read-only member,
   `roomUnreadSync(observer, roomId, since?)`, to
   `account-workspace-fixtures.mts`, following #751's `roomReceipts` and
   #750's `sendImageMessage`, with its own fixture test. It makes the
   predecessor's exact query and returns `since`, `nextBatch` and the Room's
   counts and timeline ids, never the token. **The alternative** is a
   suite-local password login, the predecessor's `loginApi`. It creates a
   second reader device and a token outside the fixture closure that the
   suite must log out and redact itself. Its cost is about 60 suite lines
   and one more registered secret, and it removes plan Task 1.
4. **Cross-suite reuse.** **Recommendation:** import #750's composer,
   timeline, sheet and profile readers, its asserters and
   `appendNativeLine`, and #756's stage-free artifact helpers. That saves
   about 600 duplicated lines, and the native append is exactly the one
   already accepted on the device. The cost is coupling: a change to
   `message-quote-*` or `pinned-message-panel-artifacts` also runs this
   guard, and the scan messages say "pinned-panel". Importing a journeys
   module has no precedent across capabilities. **The alternative** is a
   local observer and a local append (the #752–#756 pattern). It adds an
   observer module with jsdom tests to plan Task 2, roughly doubling it,
   and a local append to plan Task 3.
5. **Shard.** **Recommendation:** shard 3, last, after
   `pinned-message-panel`. It has the largest headroom (99 against shard
   4's 95), and it was the faster hosted shard (74 against 88 minutes in run
   36436865291). The alternative, shard 4 after `pinned-message-workflow`,
   costs one `ci.yml` line, one guard row and the budget sentence.
6. **Retirement scope.** **Recommendation:** after hosted acceptance, keep
   the file as a `desktopOnly` definition (D13): drop its Android branch,
   skip it on Android, and pin at `dd0cb53c`, as #839 and #750 do for
   definitions with a desktop `else`. Until then, the issue's "do not retire
   or edit" holds. The alternative, whole-file retirement, drops the only
   desktop coverage of the quote-notification decision, whose `else` path
   exercises the hover menu.
7. **Server sensitivity control.** **Recommendation:** do not add a
   per-run control that REST-sends the quoted body without `m.mentions` to
   prove that the rule can fire. The issue forbids seeding the writer's
   quoted answer, and a REST-sent quoted writer message sits on that
   boundary. The predecessor does not do it either. Probe 2.9 is the
   evidence, recorded as a known limitation. **The alternative** is one
   post-decision receipt (about 1 s, one REST send, one
   `roomUnreadSync`). It would make a Synapse that disabled the rule fail
   rather than pass silently. Its cost is plan Task 3 Steps 1 and 5, one simulated
   fault, and the issue owner's sign-off on the boundary.
