# Android Read-Receipt Maestro Migration Design

- Issue: #751, part of #660; blocked by #750 until #750's original-attempt hosted evidence is accepted
- Status: Design accepted for local implementation while #750 completes hosted acceptance
- Branch: local `wip/751-read-receipt` from `221ce915` (the locally accepted #750 quote suite on top of PR #677's `test/676-android-sidebar-filter`); PR #677 stays draft and unmerged

This document records the design for the installed-Android
`android.message-receipts` suite. Implementation and acceptance evidence are
tracked in `e2e/android/MIGRATION.md`. The hosted audit must pass before #751
can close. The #750 quote suite is the structural template: contract,
read-only observer, artifacts and journeys modules, a Vitest guard with
effective negative controls, and the same registry, Nx, package and CI
wiring. The #747 message-links suite supplies the multi-Account arrangement
and the wide desktop profile on the installed app; the authenticity-shield
suite supplies read-only receipt-cluster geometry.

## Intent and source boundary

Migrate the single canonical "seen by" read-receipt definition to one serial,
one-stage installed-Android Node/Maestro suite against real Synapse. The
Playwright predecessor stays enabled and unchanged.

The source of truth is
`e2e/browser/journeys/conversations/message-receipts.spec.mts` (166 lines) at
SHA-256 `5d4d757364c6b5b1a5a0e148c8c17adf173296bb2f435730d2803ed7854baa42`.
The issue pins the same hash, and this branch carries the file unchanged: the
mobile Send-button change `fe2c7c3e` did not touch it (the definition sends
through REST, not the composer), so no pin reconciliation and no
`sendComposerDraft` expansion apply.

| Span   | Definition / role                                  | Direct `expect` sites |
| ------ | -------------------------------------------------- | --------------------- |
| 17     | module-level `synapseSession()`                    | none                  |
| 19–38  | local API-token helper `apiToken(request, …)`      | none                  |
| 40–48  | local Room-opening helper `openRoom(page, name)`   | 45                    |
| 53–165 | `shows a reader's avatar on the message they read` | 122, 123, 164         |

The definition calls `registerUser` (60–62), the local `apiToken` (63, 69,
75), `login` (112) and the local `openRoom` (118). `registerUser`, `apiToken`
and `login` reach no `expect` site. The local `openRoom` reaches line 45 (the
composer is visible after the Room opens). The display-name `PUT` (78–81),
`createRoom` (84–90), the two joins (91–96), the author's message (100–106)
and the seer's receipt `POST` (107–110) are unchecked arrangement.

The guard also pins these shared sources:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`     | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts` | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |

The guard pins by exact line text: the run suffix `s` (57), the three roles
`rcpt-reader-`, `rcpt-author-` and `rcpt-seer-` (60–75), the seer name
`Cara${runId}` (77) and its `PUT …/profile/…/displayname` before `createRoom`,
the Room name `Receipts E2E ${runId}` (83) with `invite: [author.userId,
seer.userId]` (87), the joins of author and seer (91–96), the body
`read receipt target ${runId}` (99), the transaction `rcpt-${runId}` (102),
the `m.read` receipt for the exact `eventId` (108), the cluster locator
`.scroll [data-testid="read-receipts"]` (121), the `aria-label` matcher
`new RegExp(seerName)` (123–126), and the four-edge intersection (153–157).

## Parity records: 3 direct + 1 helper-expanded = 4

One stage, `seen-by`, owns every record. Identities are
`message-receipts.seen-by.<suffix>`, in source order. `45@118` reads as helper
line 45 reached from the call on line 118.

| #   | Source (helper@call) | Kind      | Canonical assertion                               | Suffix            |
| --- | -------------------- | --------- | ------------------------------------------------- | ----------------- |
| 1   | 45@118               | inherited | `openRoom`: composer visible                      | `room-ready`      |
| 2   | 122                  | direct    | first read-receipt cluster visible                | `cluster-visible` |
| 3   | 123                  | direct    | its `aria-label` names the seer                   | `seer-named`      |
| 4   | 164                  | direct    | the cluster does not intersect its message's text | `text-clear`      |

Helper expansion is resolved by binding, as the #748–#750 guards do: a call
expands only when the TypeChecker binds it to a named import from
`../../../support/` or to a module-level function declaration of the
predecessor. A shadowing local never expands. `apiToken` is such a
module-level function and is proved to add no site.

## Selected architecture

| Unit      | File                                          | Responsibility                                                                                                    | Boundary                                                                |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Guard     | `scripts/message-receipts-migration.spec.mjs` | Source pins, AST site map, binding-resolved expansion, simulated app, jsdom observation, controls, wiring         | Vitest in-process. No emulator, no network                              |
| Contract  | `e2e/android/message-receipts-contract.mts`   | One stage, 4 identities, receipt fields, pure parsers and asserters for Matrix state, cluster, label and geometry | Pure; no I/O                                                            |
| Observer  | `e2e/android/message-receipts-observer.mts`   | `evaluateNative` read-only expressions: composer, timeline rows, receipt clusters with measured boxes             | No click, focus, key, scroll, class, style, attribute or location write |
| Artifacts | `e2e/android/message-receipts-artifacts.mts`  | Secrets for three Accounts in every form, scrub/scan, pass-only publication marker, abort revocation, cleanup     | Self-contained copy of the #750 policy, keyed to this suite             |
| Journeys  | `e2e/android/message-receipts-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, arrangement, pre-launch Matrix proof, the stage                      | Maestro owns every product action                                       |

Shared change: `account-workspace-fixtures.mts` gains one additive read-only
REST fixture, `roomReceipts(observer, roomId)`. It runs one filtered
`/sync?timeout=0&set_presence=offline` as the observer's fixture session,
restricted to the one Room and to `m.receipt` ephemeral events, and returns
those events. Receipts are ephemeral and `/sync` is the only client-server
read of them; the access token stays in the closure. No other suite calls
it. Every other fixture (`account`, `setDisplayName`, `createRoom`, `join`,
`sendMessage`, `sendReadReceipt`, `roomMessages`, `roomMembership`) and
`account-workspace-client.mts` (`reset`, `login`, `hideKeyboard`,
`tapCurrent`, `visible`, `record`, `capture`) are reused unchanged.

## Decisions

### D1. Profile

The stage runs at `DESKTOP_ACCOUNT_PROFILE` (1280×720 CSS pixels, DPR 1, no
touch, not mobile), the profile the predecessor runs at: the browser project
uses Desktop Chrome and the retained Android Playwright project's canonical
wide shell is 1280×720 without touch. The geometry claim is about the row
this layout produces, so the migration keeps the same viewport rather than a
phone profile. The #747 suite ran its desktop stages the same way.

### D2. Three Accounts through real Synapse

- `reader`, `author` and `seer` are three fresh Accounts from
  `fixtures.account('rcpt-reader' | 'rcpt-author' | 'rcpt-seer')`, the same
  roles as lines 60–75 under the harness's disposable usernames and passwords.
- The seer's display name is set to exactly `Cara<run>` before the Room
  exists, as lines 77–81 do before `createRoom`.
- The reader creates the Room `Receipts E2E <run>` inviting author and seer
  (lines 84–90, no preset, as the predecessor sends none); author then seer
  join (91–96).
- The author sends one `m.text` with body `read receipt target <run>` and
  transaction `rcpt-<run>` (100–106); the seer posts its real `m.read`
  receipt for exactly that event id (107–110).
- No text is typed beyond login; Maestro owns login and Room navigation.

### D3. Authoritative Matrix proof before launch

Before `client.reset`, three bounded independent reads, as the reader's own
fixture session, must all pass (one finite poll, 20 s):

1. **Room timeline** (`/messages?dir=b&limit=50`): exactly one
   `m.room.message`, the author's original `m.text` with the exact body and
   the event id the send returned, no relation. The seer's member events are
   an invite from the reader and exactly one `join`; every seer member event
   that carries a `displayname` carries exactly `Cara<run>`, and the join
   carries it. A name set after the join would add a second seer join, so this
   proves the name was set before membership activity. Author and reader each
   hold one join; the message follows both joins.
2. **Current membership** (`roomMembership`): `join` for reader, author and
   seer.
3. **Receipt relation** (`roomReceipts`): an unthreaded `m.read` receipt maps
   the seer's user id to exactly the author's event id, with a numeric `ts`,
   and the seer holds no `m.read` receipt on any other event.

The relation is read again after the rendered records as a receipt, so the
rendering is proved against a relation that still holds.

### D4. Event-scoped cluster, label and geometry

All three direct records read the exact message row, never the first avatar
in the Room:

- The row is found read-only as the one reconciled `.scroll .msg[data-mid]`
  row whose `.msg__text` carries the body, and its `data-mid` must equal the
  proved event id.
- **122 `cluster-visible`.** The predecessor's `receipts.first()` is the first
  `.scroll [data-testid="read-receipts"]`. That first cluster must be owned by
  the exact row (its `.closest('.msg')`), be that row's first cluster, be a
  visible `button`, and carry at least one avatar.
- **123 `seer-named`.** The cluster's `aria-label` has the product form
  `Seen by <name>, <name>…`. It contains `Cara<run>` (the predecessor's
  `RegExp(seerName)`), and the parsed name list holds `Cara<run>` exactly
  once. Every listed name is the authoritative display name of a joined
  non-reader member (the author's join name or the seer's), never the reader
  and never a stranger, and the list has as many names as the cluster has
  avatars. A label without the D3 relation is never accepted.
- **164 `text-clear`.** The renderer's `getBoundingClientRect` of that cluster
  and of the exact row's first `.msg__text` (the predecessor's
  `bar.closest('.msg').querySelector('.msg__text')`) are read in one pure
  expression. Both boxes must be finite and non-zero; the four edge
  conditions are recomputed in Node from the measured numbers and
  `intersects` must be `false`. The renderer's own boolean is not trusted,
  and neither CSS declarations nor screenshots are consulted.

### D5. Selectors never carry identifiers

Native actions print their selector to stdout, which becomes the public job
log and `process.log`, outside the suite's artifact scan. Only two native
actions exist and neither carries an identifier:

| Action     | Selector and filter                   |
| ---------- | ------------------------------------- |
| Rooms rail | `[data-testid="rail-rooms"]`          |
| Room row   | `.channel` with `{ text: room.name }` |

The message row is never an action target; it is observed read-only. The
guard rejects any selector with `data-mid=`, `data-mid*=` or an interpolated
id, and any observation description that interpolates a value.

### D6. Identifier protection

Every stage identifier is registered before any UI step: the run token; for
each of the three Accounts the user id (raw and component-encoded), username
and password; the Room id (raw, `slice(1)`, component-encoded, base64url
route segment) and name; the seer display name; the message body and
transaction; and the event id as soon as the send returns. Records and
receipts store digests (`roomDigest`, `eventDigest`), counts and booleans,
never raw values or the label text. The scan also rejects `access_token`
values and `Bearer` authorization. Failure text rethrown to the job log keeps
only error names and messages, redacted.

### D7. CI placement and budgets

- **Shard 3**, the last shard-3 line, directly after `member-moderation`.
  Shard 3 has the most headroom (about 158 of its 180 native minutes in a
  240-minute job); shard 5 has 10 minutes and shards 1, 2 and 6 fewer.
- Budget: one stage of about 3–4 minutes with Synapse and the prebuilt APK,
  a provisional 5 minutes, so shard 3 becomes about 163 native minutes.
- Timeouts (provisional, re-derived from the acceptance runs):

  | Layer                     | Timeout    |
  | ------------------------- | ---------- |
  | Node `test()`             | 600 000 ms |
  | Nx project `--timeout-ms` | 900 000    |
  | `ci-run-command` wrapper  | 1 200 000  |

- The `ci.yml` budget comment and a `ci-workflow.spec.mjs` guard record the
  new shard-3 figure. The upload count rises from 76 to 77 and the emulator
  script from 69 to 70 lines, in every guard that pins them. The #750 guard's
  "quote section is last" rule becomes "the read-receipt section follows it".

### D8. No CHANGELOG, no README

This is a test-only migration with no user impact, like #747–#750.

## Stage plan: `seen-by`

1. **Arrange.** `run = aliasLocalpart('receipts-seen-by') + 's'`. Register the
   run, Room name, seer name, body and transaction, then create the three
   Accounts and register each; set the seer name; create the Room as reader
   and register its id; author and seer join; the author sends the body and
   the event id is registered; the seer posts its `m.read` receipt.
2. **Authoritative proof (D3)** as receipts `message-event`,
   `seer-membership` and `receipt-relation`, before any UI step.
3. **Native start.** `client.reset(DESKTOP_ACCOUNT_PROFILE)` and
   `profile-applied.json`; `client.login(reader)`; `client.hideKeyboard()`.
4. **Room.** Tap the Rooms rail and the exact Room row; read the composer:
   exactly one visible composer with placeholder `Message #<name>` and the
   exact Room route for the reader → `room-ready` (45@118).
5. **Cluster.** A bounded read (20 s, the predecessor's bound) until the
   exact row's first cluster is visible → `cluster-visible` (122); its label
   → `seer-named` (123); its measured boxes → `text-clear` (164).
6. **Relation retained.** D3's receipt read again → receipt
   `relation-retained`.
7. **Teardown.** `capture('passed')` (or `capture('failed')`), client close,
   application data clear; the three Accounts' Room leave/forget and logout,
   scrub and the fail-closed scan run as guarded cleanups.

## Observation plan

- `composerExpression()`: composer count, visibility, placeholder, route.
- `receiptsExpression()`: every `.scroll .msg[data-mid]` row (id, event flag,
  visibility, `.msg__text` texts, cluster count); the first
  `.scroll [data-testid="read-receipts"]` cluster (owning row id, whether it
  is that row's first cluster, tag, visibility, `aria-label`, avatar count,
  measured box) and the owning row's first `.msg__text` measured box.
- Every expression is a pure read evaluated with only `document` in scope, so
  the guard executes the exact text in jsdom against production-shaped markup.
- Every wait is finite: renderer reads through `waitForNativeShellState`, REST
  reads through the same bounded poller.

## Negative-control plan (guard, each must fail when its protection is removed)

- **Source shape.** A pinned hash differs by one byte; a line pin, a role,
  the seer name, Room name, body, transaction, receipt type or locator
  drifts; the display name moves after `createRoom`; a direct site is dropped
  or added; the helper call is removed or shadowed; the predecessor gains
  `test.only`/`fixme` or loses its single Synapse skip.
- **Authoritative relation.** The seer's receipt on another event, another
  user's receipt in its place, a threaded or private receipt, a second seer
  receipt, a missing or foreign message, a name set after the join, a missing
  join, or a stranger in the Room fails before `room-ready`.
- **Visible cluster.** No cluster, a hidden cluster, a cluster on another row,
  a Room-first cluster that is not the exact row's, or a pending local-echo
  row fails `cluster-visible`.
- **Exact accessible name.** A label without the seer, naming the reader, a
  stranger, a look-alike prefix of the seer name, the seer twice, or a name
  count unequal to the avatar count fails `seer-named`.
- **Non-overlap geometry.** Each of the four overlapping arrangements, a
  zero-size or non-finite box, or a text box from another row fails
  `text-clear`.
- **Cleanup and redaction.** Every raw, escaped, percent-encoded, sliced and
  base64url identifier and credential of all three Accounts is rejected by
  the scan and removed by the scrub; rasters are removed; a failed cleanup,
  scrub or scan blocks publication; an abort revokes the marker; stage
  failures rethrow redacted.
- **Journey rules.** Any DOM click, focus, value write, dispatch, navigation,
  `evaluateNative` in the journeys, a REST receipt or message after launch,
  retry, unbounded wait, id-bearing selector, missing record proof, or
  out-of-order step fails the source rules.
- **Wiring.** Cache or parallelism on, a missing resource, a wrong entrypoint,
  a missing package script, a wrong shard, timeout or order, a gate path or
  upload condition drift, or a stale upload/line count fails.

## Evidence and acceptance plan

1. Guard, typecheck (`e2e/tsconfig.json`), ESLint and Prettier on changed
   files, and the full `scripts/*.spec.mjs` suite.
2. Device development until the stage passes; each device finding is fixed at
   its root, never with a retry or a loosened assertion.
3. On the final unchanged commit, with a fresh production renderer and
   manifest: three consecutive `trinity-e2e-android:message-receipts` first
   attempts, each 1/1 stage, 4/4 records, attempt 1, retries 0,
   `publication-safe`, built APK digest equal to the installed digest,
   renderer `production` at the final commit and an empty identifier scan.
4. The exact browser predecessor at `--workers=1 --retries=0`.
5. Hosted: audit the original-attempt shard-3 `android-message-receipts`
   artifact, the retained predecessor and the renderer manifest before
   closing #751.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-message-receipts.md` is
preparatory. This design changes it as follows:

- CI placement is shard 3 after `member-moderation`, not shard 2 after
  message-quote (message-quote runs on shard 6, and shard 2 has about 3
  minutes of headroom).
- No separate fixture module: one additive read-only `roomReceipts` fixture
  in the shared fixtures reads the ephemeral receipt, because the access
  tokens are closure-private and every other arrangement already exists.
- The profile is the predecessor's wide desktop shell.
- Event ids and every Account identifier are registered secrets; records hold
  digests only.
