# Android Matrix Links Maestro Migration Design

- Issue: #747, part of #660; blocked by #746 until #746's original-attempt hosted evidence is accepted
- Status: Synthesized from a three-design judge panel; implementation in progress on a local branch while #746 completes acceptance
- Branch: `test/676-android-sidebar-filter`, PR #677 (draft, unmerged)

This document records the design for the installed-Android `android.message-links`
suite. Implementation and acceptance evidence will be tracked in
`e2e/android/MIGRATION.md`. The hosted audit must pass before #747 can close.
The worktree still carries uncommitted #746 edits to the message-linkify
journeys, artifacts, contract and guard. None of the new modules import those
files. Any linkify line number cited below must be checked again after #746 lands.

## Intent and source boundary

Migrate all six Android-applicable definitions of the canonical Matrix
room/user-link journey to one serial, six-stage, installed-Android Node/Maestro
suite. The suite runs against the real primary Synapse server and the federated
secondary one. The Playwright predecessor stays enabled and unchanged.

The source of truth is
`e2e/browser/journeys/conversations/message-links.spec.mts` (605 lines) at SHA-256
`513b7f01b026991d316479edf06caef9754e70cc0df157a37436a67982aeb400`.

| Span    | Definition / role                                                                                                                | Direct `expect` sites                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 22–147  | helpers `loginApi`, `registerRemote`, `createRoom`, `sendRoomLink`, `localScenario`, `openRoom`, `activateRoomLinkPrimary`       | 37, 58, 76, 100, 129                             |
| 156–230 | `a joined room previews before an explicit Open`                                                                                 | 214, 215, 217, 218, 225                          |
| 232–321 | `previews and joins a public room across real federation`                                                                        | 274, 277, 280, 283, 291, 295, 296, 304, 308, 316 |
| 323–362 | `shows a useful unavailable state for an inaccessible remote room`                                                               | 359, 360, 361                                    |
| 364–424 | `keeps a rejected federated Join open and retryable`                                                                             | 399, 413, 418, 421, 422, 423                     |
| 433–504 | `keeps the sheet and its action footer reachable` (`test.use` 427–431; `isAndroidE2E` skip 437)                                  | 465, 466, 469, 492, 493, 494, 497, 500, 501      |
| 507–587 | Android branch of `clicking a mention shows a user card, not an empty room` (line 578 `if (isAndroidE2E) {`, line 587 `return;`) | 573, 574, 579, 582, 583                          |
| 588–604 | web-only popover tail (**excluded**)                                                                                             | 591, 595, 596, 597, 598, 600                     |

The issue says "lines 507–604", but that span cannot be used as written. It
contains 11 `expect` sites, which would make 44 direct sites instead of 38. The
Android boundary is 507–587, pinned by the `return;` at 1-based line 587
(`source.split('\n')[586]`).

The guard also pins these shared sources:

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `e2e/support/app.mts`              | `60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3` |
| `e2e/support/account.mts`          | `ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594` |
| `e2e/browser/support/contrast.mts` | `5c5561a7cd599679a95735fe82cbe14b95faf93c359f3f4ef7e85aa386b2b7f3` |
| `e2e/fixtures.mts`                 | `7358d2f7ddcac9c9b6bec9531cef12cc1d097ac7a6199897a21dc524978b8396` |
| `e2e/support/navigation.mts`       | `6ee2fc9fb014bf39d92fe88ffb7c0afafccbed3219575a480da404efe1f93c15` |

The issue's "application login/Preferences" pin refers to `app.mts`.

## Selected architecture

| Unit                         | File                                       | Responsibility                                                                                                                                                      | Boundary                                                                                       |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Guard                        | `scripts/message-links-migration.spec.mjs` | Source pins, AST site maps, binding-resolved helper expansion, contract/fixture/observer/artifact negative controls, source rules, wiring                           | Runs in-process under Vitest. No emulator, no network                                          |
| Contract                     | `e2e/android/message-links-contract.mts`   | 6 stages, 63 identities, profiles, pure parsers/asserters                                                                                                           | Pure; no I/O                                                                                   |
| Two-server fixture           | `e2e/android/message-links-fixtures.mts`   | API login, remote registration and Rooms, formatted sends, federation probes, join-rule change, membership on both servers, local leave, bounded two-server cleanup | REST arranges, alters and observes only. Tokens are closure-private. `fetchImpl` is injectable |
| Observer                     | `e2e/android/message-links-observer.mts`   | `evaluateNative` read-only expressions: preview, placeholder, anchors, applied mode, contrast, portrait geometry, dialog model, navigation marker                   | No click, focus, key, scroll, class, style, attribute or location write                        |
| Artifacts                    | `e2e/android/message-links-artifacts.mts`  | Per-stage secrets (raw/encoded/double-encoded/base64url/`slice(1)`), scrub/scan, multi-stage pass-only publication, abort revocation, stage cleanup runner          | Self-contained. Does not import the in-flux linkify artifacts                                  |
| Journeys                     | `e2e/android/message-links-journeys.mts`   | Runner, proof-first `record()`, `receipt()`, native helpers, six stage functions                                                                                    | Maestro owns every product action                                                              |
| Client (one additive method) | `e2e/android/account-workspace-client.mts` | `nativeRect(rect)`: maps CSS corners through the existing private `owner.nativePoint`                                                                               | Read-only. Dispatches no input and writes no DOM                                               |

Nothing else in the shared harness changes. `account-workspace-fixtures.mts` (and
its `start.mjs` Vitest mock), `runtime-provenance.mts`, `maestro-viewport.mts`,
`maestro-session.mts` and every `flows/*.yaml` stay unchanged. No new Maestro YAML
is added: all actions use `accounts-current-point-tap.yaml` through
`client.tapCurrent`, plus the existing login fill flows.

## Decisions

### D1. Light/Dark success state: leave and rejoin the same federated Room

Two real native Joins of the **same** remote Room. A REST leave of the local
user between them resets the state.

- **Order.**
  1. Select Light, then Join. Record 291/295/296, then Light contrast (304).
  2. Close the preview.
  3. REST-leave the local user. Observe the leave on both servers and in the sidebar.
  4. Select Dark.
  5. Tap the link again. Receipts show `Join room`.
  6. Join again. Receipts cover success, `Open room` and focus. Record Dark contrast (308).
  7. Tap Open (316).
- **Rationale.**
  - `success` is a component-local signal (`room-link-preview.component.ts:80`). Only `actionSucceeded` sets it (212–233), and `load()` clears it (174–179).
  - The modal backdrop covers `open-settings`, and dialogs close on navigation (`trn-dialog.service.ts:165`, `closeOnNavigation: !dismissGuard`).
  - A reopened joined Room previews as `open` from local state and shows no notice (`room-link.service.ts:83–99, 155–173`).
  - So measuring the success notice under two real Appearance modes needs two successful Joins. After a leave, the local membership is `leave`, which sends the preview to the remote summary and gives `join` for a public Room.
  - The same alias, name, topic, Room id and link then back 274/277/308/316.
- **Rejected alternatives.**
  - Class toggle: forbidden.
  - Reopen: gives no notice.
  - `cmd uimode` under `system` mode: this is adb, not the Settings path.
  - A second federated Room: it would split the identity behind 308 and 316 and add non-parity fixtures.
- **Membership tracking.**
  - Call `trackRoomMembership(local, remoteId)` right after membership proof #1, then `allowEndedMembershipCleanup(local, remoteId)`. Base cleanup then leaves and forgets the Room whatever state a failure leaves behind, and tolerates the 403 for an already-ended membership (`account-workspace-fixtures.mts:299–344, 1260–1282`).
  - The second Join's observations are **receipts**, never parity identities.

### D2. Viewport profile per stage

| Stages    | Profile                                                          | Value                                                                                    |
| --------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| S1–S4, S6 | `DESKTOP_ACCOUNT_PROFILE` (`account-workspace-client.mts:26–28`) | `{width:1280,height:720,isMobile:false,hasTouch:false,deviceScaleFactor:1}`              |
| S5        | `PORTRAIT_LINK_PROFILE` (contract)                               | `{width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:1}`, no `userAgent` |

**Parity.**

- The retained android-webview Playwright config runs the five non-portrait definitions at exactly 1280x720, non-mobile, without touch (`e2e/android/playwright.config.mts:14–19`).
- D5's `test.use` is 390x844 mobile+touch (427–431), and Playwright's default DPR is 1.
- D6's comment requires the dialog model "even under a wide emulated viewport" (576–577).
- `PIXEL_5_ACCOUNT_PROFILE` would change the layout: narrow shell, and the Settings drill-in taking two Backs.

**Tap feasibility at 1280x720 on pixel_6**, with a physical CSS width of 411.43:

- The scale is `min(1, 411.43/1280) = 0.3214` (`maestro-viewport.mts:410`).
- `nativePoint` maps each CSS px to `(1080/411.43)·0.3214 = 0.84375` physical px (451–455). All 720 CSS px land in the top 607.5 physical px, so every point passes the bounds assertion (457–463).
- Target sizes at that scale:
  - an inline anchor line box: about 24 CSS px, about 20 physical px;
  - `room-link-primary`: at least 32 CSS px, about 27 physical px;
  - `room-link-close` / `open-settings`: 28 CSS px, about 24 physical px.
- Every tap goes through `tapCurrent`:
  - `actionablePoint` requires exactly one visible, enabled target with an unobstructed centre (1364–1384);
  - the point is re-measured through `POINT_URL` immediately before the Maestro tap;
  - the capture-phase listener requires at least one trusted click on the target, and every click must land inside it (1498, 1577–1583).
- A mis-tap therefore fails the only attempt. It never passes silently.
- Hosted DESKTOP `tapCurrent` precedents exist: `security-settings-journeys.mts:131–139`, `room-profile-settings-journeys.mts:128–157`.

### D3. S5 physical footer proof

Keep the predecessor's nine CSS assertions unchanged (492–501, ±1 CSS px,
`visualViewport` bottom). Add these fail-closed receipts:

1. **Viewport fit, right after `reset(PORTRAIT_LINK_PROFILE)` and before login.**
   - `innerWidth===390`, `innerHeight===844`, `devicePixelRatio===1`, `(orientation: portrait)`.
   - `client.nativeRect({x:0,y:0,width:390,height:844})` succeeds, which proves the whole emulated viewport is inside the attached WebView.
   - Expected on pixel_6: scale 1, 844 CSS px equals 2215.5 physical px.
2. **IME hidden:** `client.hideKeyboard()`, which is Maestro and records its own receipt.
3. **Stable geometry:** two identical samples of the section and `.room-preview__actions` rects, taken 250 ms apart within 10 s. Records 492–501 are asserted on that sample.
4. **Physical reach.**
   - `nativeRect` of the footer, and of the rects of `[data-testid="room-link-primary"]` and of the footer `Close` button (`.room-preview__actions button`, exactText `Close`). Corners are inset by 0.5 CSS px.
   - Each mapped button bottom must be ≤ the top of the device-reported navigation-bar frame. That frame is parsed fail-closed from `adb shell dumpsys window`: the distinct `type=navigationBars frame=[l,t][r,b]` entries whose `r` equals the `wm size` width and whose `b` equals its height must reduce to exactly one frame.
   - `elementFromPoint` at both button centres must return the button.
   - Informational: `wm size`, `wm density`, and the footer's computed `padding-bottom` (which carries `env(safe-area-inset-bottom)`, `room-link-preview.component.scss:157`).
5. The primary action is never activated in S5.

This replaces both a fixed 48 dp constant, which can fail spuriously on an inset
WebView, and a bounds-only check, which cannot see the gesture area.

### D4. S6 dialog model, coarse pointer, no navigation

- **Profile:** DESKTOP.
- **Pre-tap receipt (fail-closed).**
  - `matchMedia('(pointer: coarse)').matches === true` and `Capacitor.getPlatform() === 'android'`.
  - Navigation marker `{href, timeOrigin: performance.timeOrigin, historyLength: history.length}`.
  - Exact placeholder `Message #${roomName}`.
  - Exactly one `.scroll a` whose trimmed text is `bobName` and whose href is `https://matrix.to/#/${bobId}`.
- **Positive model receipt**, attached to 582: exactly one visible `[role="dialog"][aria-label="User"]` (its `aria-modal` value is recorded but not required: Angular CDK defaults `ariaModal` to `false`, Trinity keeps that default, and the predecessor never asserts it) containing `[data-testid="user-card"]`, plus:
  - a `.cdk-global-overlay-wrapper` ancestor;
  - a visible `.cdk-overlay-dark-backdrop`;
  - zero `.cdk-overlay-transparent-backdrop`.
  - Sources: `trn-dialog.service.ts:104–109, 155, 161–163`; `user-card.service.ts:27`.
- **Not used:** `data-trn-layout`, because the card hard-codes `popover` (`user-card.component.html:1–8`).
- **No-navigation receipt**, attached to 583: the marker is unchanged, and the route is still `/rooms/<b64url(roomId)>`.
- **Display-name receipt** before any UI step: `base.setDisplayName(bob, bobName)`, then a primary `GET /profile/{bobId}/displayname` that must equal `bobName`. This stops a failed PUT from showing up as a misleading MXID fallback at 574.

### D5. Identity keying, ordering, receipts

- **Identity format:** `message-links.<stage>.<suffix>`.
- **Stage ids:** `joined-preview`, `federated-join`, `remote-unavailable`, `rejected-join`, `portrait-sheet`, `mention-user-card`.
- **Helper keys.** Helper-expanded identities are keyed by **call site**, so the two `createRoom` expansions in each of D2–D5 get distinct suffixes.
- **Contract site type:**
  `{line, suffix, kind:'direct'} | {line, suffix, kind:'inherited', helper, call, via?}`
  where `call` is the stage-body call line and `via` is the helper-internal line (for example 118/120 inside `localScenario`).
- **Load-time asserts:**
  - stage counts `[6,16,9,12,14,6]`;
  - direct `[5,10,3,6,9,5]` = 38;
  - inherited `[1,6,6,6,5,1]` = 25;
  - 63 total, all unique.
- **`record(ctx, suffix, assertion, observation)`** follows the edit-history pattern (`edit-history-journeys.mts:77–89`).
  1. Resolve the identity.
  2. `assert.equal(identity, entry.assertions[records.length])`.
  3. Run the proof.
  4. `client.record(identity, {assertion: identity, observation})`.
  5. Push to `records`.
     The runner adds each identity to a suite-wide unique set.
- **`receipt(ctx, name, value)`** writes `receipt-<nn>-<name>.json`. `name` must match `^[a-z0-9-]+$` and must never start with `message-links.`.

### D6. Two-server fixture, readiness, rate limits, cleanup

- **Separate module.** The base fixtures are hard-wired to `SYNAPSE_HTTP` (`account-workspace-fixtures.mts:4`), and their spec mocks `start.mjs` (`scripts/account-workspace-fixtures.spec.mjs:8–11`). The new module follows `edit-history-fixture.mts:41–124`.
- **Federation readiness** is probed before any UI step in every federated stage. Probes are bounded (1 s poll, 60 s deadline) and tolerate only 404, 502, 503 and 504. `start()` never exercises federation, and alias resolution can return 502 while keys are fetched (`start.mjs:322–326`).
- **Rate-limit budget.**
  - Secondary: 3 `/register` calls (S2, S3, S4; within the default `rc_registration` burst of 3), no remote `/login`, fewer than 10 remote writes.
  - Primary: 3 remote join attempts (2 successful in S2, 1 rejected in S4), each by a different fresh local user.
  - Any 429 fails the stage with `M_LIMIT_EXCEEDED` recorded. It is never retried.
- **Cleanup order.**
  1. Register the message-links cleanup **before** `createAccountFixtures(resources, signal)`. Namespace cleanups run last-in-first-out (`namespace.mts:59–78`), so the base cleanup runs first: local leave/forget of every tracked Room, including the UI-joined remote Room, then base logouts.
  2. The message-links cleanup follows: primary API-session logouts first.
  3. Then, for each remote Room in reverse creation order: `DELETE /directory/room/{alias}` (404 tolerated), `PUT /directory/list/room/{id} {visibility:'private'}`, owner leave, owner forget.
  4. Then remote logouts.
  - Every step gets its own `AbortSignal.timeout(15_000)`, independent of the test signal. Every step runs even after an earlier failure. Failures aggregate into an `AggregateError`.
  - The cleanup is registered through `guardedCleanup`, so a failure sets `safety.cleanupFailed` and blocks publication.
- **Resources:** only `android-avd` + `synapse`, which includes the remote Synapse (`resources.mts:21–25`). Reverse ports stay 8448 and 5556 (`maestro-session.mts:535–542`). The device never reaches the secondary server directly.

### D7. Mode-only Appearance selection with the in-app Back

`selectAppearanceMode(client, mode, returnHref)` uses Maestro point taps only:

1. **Baseline**, read-only (`readAppliedMode`): `html.classList.contains('dark')`, `data-theme`, `data-density`, `data-code-lines`, inline root `font-size`, `--trinity-code-scale` (writers at `appearance-document.adapter.ts:16–38`), and the checked mode input. Record `before = surface().url`.
2. `tapCurrent('[data-testid="open-settings"]')`, then wait up to 30 s for a visible `[aria-label="Settings sections"]`.
3. `tapCurrent('[data-testid="settings-nav-appearance"]')`, then wait up to 30 s for pathname `/settings/appearance` and a visible `[data-testid="settings-detail"]`.
4. `scrollIntoViewIfNeeded('[data-testid="mode-<mode>"]', '[data-testid="settings-detail"]')`. This is a native swipe and a no-op when the control is already visible.
5. Wait up to 15 s for `[data-testid="mode-<mode>"] input:not(:disabled)` count 1, because hydration disables the radios.
6. `tapCurrent('[data-testid="mode-<mode>"]')`. The label hosts the test id (`appearance-settings.component.ts:73–77`).
7. Wait up to 15 s for all of these:
   - `[data-testid="mode-<mode>"] input:checked` count 1;
   - `html.dark === (mode==='dark')`;
   - every other baseline carrier unchanged, which proves the change was mode-only.
8. `tapCurrent('trn-page-header button[aria-label="Back"]')`. At wide width `goBack()` calls `location.back()` exactly once (`settings.page.ts:194–211`), because the redirect and section links use `replaceUrl` (`settings.page.ts:125–133`, `settings.page.html:46`).
9. Wait up to 30 s for `surface().url === before` (Light: `/rooms?account=…`; Dark: the exact source Room route). Then check `html.dark` again.

Every step records a receipt. There is no hardware Back, no devtools-hierarchy
flow and no viewport re-apply. The existing `native-shell-appearance-light/-dark`
flows are rejected because they also change theme, density and text scale.

### D8. Observation bounds and stability

Every wait is finite and at least as long as the predecessor's bound. These are
polling bounds, not parity semantics; `MIGRATION.md` documents them.

| Observation                                | Predecessor | Android               |
| ------------------------------------------ | ----------- | --------------------- |
| `#homeserver` after reset                  | —           | 60 s (existing)       |
| composer after Room open                   | 15 s        | 30 s                  |
| preview name / load error / `Join room`    | 20 s        | 30 s                  |
| success / action error                     | 30 s        | 45 s                  |
| navigation placeholder                     | 20/30 s     | 30 s                  |
| user card                                  | 15 s        | 30 s                  |
| federation probes                          | —           | 60 s                  |
| leave sync / membership proof              | —           | 30 s                  |
| other `visible` / `focused` / `toHaveText` | 5 s default | 15 s (client default) |

Geometry (S5) and contrast (S2) need two identical samples 250 ms apart,
within 10 s. The suite stops at the first failed stage, following the
edit-history precedent.

### D9. Provenance

- `installWithAndroidRuntimeProvenance` runs once, unchanged, with `DESKTOP_ACCOUNT_PROFILE`.
- The suite writes `profiles.json`: `{stageId: {requested, digest}}`, with `digest = sha256(JSON.stringify(profile))`, the same formula as `runtime-provenance.mts:71–74`.
- Each stage writes `<stage>/profile-applied.json`: `{innerWidth, innerHeight, devicePixelRatio, visualViewport:{offsetTop,height}, coarsePointer, maxTouchPoints, platform}`, plus the S5 fit receipt.
- The guarded shared module stays unchanged.

### D10. CI placement

- **Shard 4**: the last shard-4 suite line, directly after `security-settings` (`ci.yml:451`) and before `echo 'started=true'` (452) and the retained Playwright command (453).
- **Budget model:** native + 45 min retained Playwright + 15 min setup ≤ job limit (`ci.yml:319–327`; `ci-workflow.spec.mjs:160–183`).
  - Shard 4: 132 + about 30–40 = 162–172 native, within its 180 native (240 job).
  - Shards 1, 2, 5 and 6 would exceed 180 (the 120 native allowance).
  - Shard 3: 158 + 30 = 188 > 180.
- The plan's "shard 2 after message-linkify" contradicts itself, because linkify is the last shard-1 line (`ci.yml:405`).
- **Timeouts (provisional):**

  | Layer                     | Timeout      |
  | ------------------------- | ------------ |
  | Node `test()`             | 2 700 000 ms |
  | Nx project `--timeout-ms` | 3 000 000    |
  | `ci-run-command` wrapper  | 3 300 000    |

  After the three local acceptance runs, set the Node timeout to `max(2_700_000, ceil(1.5 × slowest local run))` and re-check the shard-4 sum. If the projected hosted time exceeds 48 min, move a light shard-4 suite out rather than raising the 240-minute job limit.

### D11. Focus parity (296, 422): observed, never produced

- After each native Join tap, `client.focused('[data-testid="room-link-primary"]')` checks read-only that `document.activeElement` is the primary button, within its 15 s bound.
- Focus is expected to persist because the `<button>` element survives `acting→open` and `acting→error`: only its text and `aria-disabled` change, never `disabled` (`room-link-preview.component.html:141–166`).
- No Tab, Enter, `focus()`, `focusCurrent` or `client.key` is used. `client.key` is adb `input keyevent` (`maestro-keyboard.mts:22–32`).
- If the device does not focus a tapped button, the failure is a product accessibility finding and is escalated. It is not worked around.

### D12. No CHANGELOG, no README

This is a test-only migration with no user impact
(`docs-internal/maintenance/ci-and-releases.md:186–187`). The #746 precedent
commit `85d246e7` touched neither file. This will be confirmed at review.

## Stage plans and all 63 identities

### Common stage mechanics

- **Setup.** For each `entry` of `MESSAGE_LINKS_STAGES`:
  1. `mkdir(<output>/<entry.id>)`.
  2. Create a new `AccountWorkspaceClient(device, root, dir, signal, APPLICATION_ID)`.
  3. Set `records=[]`. The stage report has `attempt:1`, `retries:0` and `status:'running'`.
- **Arrange.** REST arrangement happens in source order and emits the helper records. `safety.unsafeSecrets = true` from the first identifier-returning call until every identifier is registered in `secrets`.
- **Native part.**
  1. `client.reset(entry.profile)`, then write `profile-applied.json`.
  2. `client.login(local)`.
  3. `client.hideKeyboard()`.
  4. Run the stage actions.
  5. `client.capture('passed')`, or `capture('failed')` if the client was active.
- **`finally`:** `runMessageLinksStageCleanup([client.close, device.clearApplicationData])`. Any failure sets `safety.cleanupFailed`.
- **Run token:** `run = resources.aliasLocalpart('ml-' + entry.id)` plus the predecessor's suffix letter (`l f x r m u`).
- **Names follow the predecessor templates:** `Link Source ${run}`, `Federated Room ${run}`, `remote-${run}`, `federated-${run}` and so on.
- **`openRoom(ctx, name, suffix?)`:** `tapCurrent('[data-testid="rail-rooms"]')`, then `visible('.channel', {text:name}, 30_000)`, then `tapCurrent('.channel', {text:name})`, then `visible('[data-testid="composer-input"]', {}, 30_000)`.
  - Receipt: exact placeholder `Message #${name}`, read with `readComposerPlaceholder`, and the route `/rooms/<b64url(id)>?account=<userId>&view=rooms` via `assertRoomRoute`.
  - If `suffix` is given, it records that call-site identity.
- **`tapMessageLink(ctx, label, expected)`:**
  1. `readLinkAnchors(label)` must return exactly one `.scroll a` whose trimmed text is `label` and whose href parses to the expected target. That receipt also records the tap target's CSS rect × 0.84375.
  2. Then `tapCurrent('.scroll a', {exactText: label})`.
- **Preview actions:** `tapCurrent('[data-testid="room-link-primary"]')` and `tapCurrent('[data-testid="room-link-close"]')`.
- **Marks:** `[i]` is inherited (helper@call); `[d]` is direct.

### S1 `joined-preview` (DESKTOP; source 156–230; 6 records)

**Fixtures** (all receipts; the predecessor's inline login, create and send are unchecked):

- `local = base.account('ml-joined')`.
- `links.apiLogin(local)` as a receipt.
- `base.createRoom(local, {name:'Link Source <run>'})` and `{name:'Link Target <run>'}`.
- `links.sendFormatted(local, sourceId, {body:'open <targetName>', formattedBody:'open <a href="https://matrix.to/#/<targetId>">the target room</a>'}, 'link-<run>')`, with an event read-back.

**Native steps and records:**

1. `openRoom(source)`, then **`message-links.joined-preview.room-open`** [i 129@206].
2. `tapMessageLink('the target room', {roomId: targetId})`.
3. **`.preview-visible`** [d 214]: one visible `[data-testid="room-link-preview"]`.
4. **`.target-name`** [d 215]: `room-link-name` text === `targetName`.
5. **`.open-action`** [d 217]: `room-link-primary` text === `Open room`.
6. **`.source-still-active`** [d 218]: placeholder === `Message #<sourceName>`, and the route is still `b64url(sourceId)`, which shows the preview is not navigation.
7. `tapCurrent(primary)`, then **`.target-opened`** [d 225]: within 30 s, placeholder === `Message #<targetName>`, route === `b64url(targetId)`, and the preview count is 0.

### S2 `federated-join` (DESKTOP; source 232–321; 16 records)

**Fixtures:**

1. `local = base.account('ml-federated')`, then `links.apiLogin(local)` → **`message-links.federated-join.api-login`** [i 37@118←237]. Asserts `user_id` and the token.
2. `base.createRoom(local, {name:'Link Source <run>'})` with an `m.room.name` read-back → **`.source-room-created`** [i 76@120←237].
3. `links.registerRemote('remote-<run>')` → **`.remote-registered`** [i 58@239]. Asserts `user_id === @remote-<run>:<secondary.serverName>`.
4. `links.createRemoteRoom(remote, {name:'Federated Room <run>', topic:'Served by <serverName>', preset:'public_chat', visibility:'public', aliasLocalpart:'federated-<run>'})` → **`.remote-room-created`** [i 76@248]. Receipt read-back covers name, topic, `join_rule` public, alias→id and directory `public`.
5. `links.sendRoomLink(local, sourceId, 'https://matrix.to/#/' + encodeURIComponent(alias), 'open the federated room', 'link-<run>')` → **`.link-sent`** [i 100@255], plus an event read-back of the exact `formatted_body`.
6. Receipt `federation-alias`: `links.awaitAliasFederation(local, alias, remoteId)` through the primary.

**Native steps and records:** 7. Login, then `selectAppearanceMode('light', …)` with its receipts (baseline, checked, `html.dark=false`, mode-only, one in-app Back to `/rooms`). 8. `openRoom(source)` → **`.room-open`** [i 129@270]. 9. `tapMessageLink('open the federated room', {alias})`. 10. **`.remote-name`** [d 274]: `room-link-name` === `remoteName` (30 s). 11. **`.remote-topic`** [d 277]: `room-link-topic` === `remoteTopic`. Receipt: `room-link-address` === alias. 12. **`.join-action`** [d 280]: primary === `Join room`. 13. **`.source-still-active`** [d 283]: source placeholder and route. 14. `tapCurrent(primary)` → **`.joined-notice`** [d 291]: `room-link-success` contains `Room joined` (45 s). Receipt: the exact text is `Room joined. It is ready to open.` 15. **`.open-action`** [d 295]: primary === `Open room`. 16. **`.open-focused`** [d 296]: observed with `client.focused`. 17. Receipt `membership-1`, within 30 s: - secondary `m.room.member/<localUserId>` read as the owner is `join`; - `base.joinedRoomIds(local)` includes `remoteId`. - Then `trackRoomMembership` and `allowEndedMembershipCleanup`. 18. Stable `readSuccessContrast()`: `htmlDark === false`, checked mode `light` → **`.light-contrast`** [d 304]: ratio ≥ 4.5. 19. `tapCurrent('[data-testid="room-link-close"]')`. Receipt: preview count 0. 20. `links.leaveLocal(local, remoteId)`. Receipt `leave-sync`, within 30 s: - secondary membership is `leave`; - `joinedRoomIds` excludes `remoteId`; - `.channel` with `{text: remoteName}` count is 0. 21. `selectAppearanceMode('dark', sourceHref)` with its receipts (`html.dark=true`; Back returns to the exact source Room route). 22. `tapMessageLink` again. Receipts: name === `remoteName`, topic === `remoteTopic`, primary === `Join room`. `Join room` proves the leave reached local state. 23. `tapCurrent(primary)`. Receipts: success text exact, `Open room`, focused, and `membership-2` (join on both servers). 24. Stable contrast: `htmlDark === true`, checked mode `dark` → **`.dark-contrast`** [d 308]: ratio ≥ 4.5. 25. `tapCurrent(primary)` → **`.remote-opened`** [d 316], within 30 s: - placeholder === `Message #<remoteName>`; - route === `b64url(remoteId)`; - membership re-proved on both servers.

### S3 `remote-unavailable` (DESKTOP; source 323–362; 9 records)

**Fixtures:**

1. **`message-links.remote-unavailable.api-login`** [i 37@118←328].
2. **`.source-room-created`** [i 76@120←328].
3. `registerRemote('private-<run>')` → **`.remote-registered`** [i 58@329].
4. `createRemoteRoom(remote, {name:'Private <run>', preset:'private_chat'})` → **`.remote-room-created`** [i 76@334]. Receipt: `join_rule` is `invite`.
5. `sendRoomLink(…, 'https://matrix.to/#/' + remoteId + '?via=' + encodeURIComponent(serverName), 'open a private remote room')` → **`.link-sent`** [i 100@338].
6. Receipt `federation-profile`: `links.awaitProfileFederation(local, remote.userId)`.

**Native steps and records:** 7. Login, then `openRoom(source)` → **`.room-open`** [i 129@353]. Then `tapMessageLink`. 8. **`.load-error-visible`** [d 359]: one visible `[data-testid="room-link-load-error"]` (30 s). 9. **`.load-error-guidance`** [d 360]: text matches `/Room (not found|unavailable)/`. Receipt: the `h3`/`p` pair is exactly (`Room not found`, `This room address is unknown or no longer exists.`) or (`Room unavailable`, `This room does not allow its information to be previewed.`) (`room-link.service.ts:112–121`). There is no Retry button in the error block. 10. **`.no-primary-action`** [d 361]: `room-link-primary` count is 0. Receipt: the local user is not `join` on either server.

### S4 `rejected-join` (DESKTOP; source 364–424; 12 records)

**Fixtures:**

1. **`message-links.rejected-join.api-login`** [i 37@118←369].
2. **`.source-room-created`** [i 76@120←369].
3. `registerRemote('retry-<run>')` → **`.remote-registered`** [i 58@370].
4. `createRemoteRoom(remote, {name:'Join Retry <run>', preset:'public_chat'})`, with no alias and no publication → **`.remote-room-created`** [i 76@375]. Receipt: `join_rule` is `public`.
5. `sendRoomLink(…, 'matrix:roomid/' + remoteId.slice(1) + '?via=' + encodeURIComponent(serverName), 'open a room whose join will fail')` → **`.link-sent`** [i 100@379].
6. Receipt `federation-profile`.

**Native steps and records:** 7. Login, then `openRoom(source)` → **`.room-open`** [i 129@394]. The anchor receipt accepts the original `matrix:` URI or its `matrix.to` rewrite; either must resolve to exactly `remoteId` with `via=serverName`. Then tap. 8. **`.join-action`** [d 399]: primary === `Join room` (30 s). Receipt: preview name === `Join Retry <run>`. 9. `links.setRemoteJoinRule(remote, remoteId, 'invite')` (PUT, then read-back) → **`.join-rule-invite`** [d 413]. 10. `tapCurrent(primary)` → **`.action-error`** [d 418]: `room-link-action-error` visible (45 s). 11. **`.join-retained`** [d 421]: primary === `Join room`, and `aria-disabled` is not `true`. 12. **`.join-focused`** [d 422]: observed. 13. **`.preview-retained`** [d 423]: preview visible and the name is unchanged. Receipts: - the secondary membership of the local user is absent or not `join`; - `join_rule` is still `invite`; - `joinedRoomIds` excludes `remoteId`. - The Room is never tracked.

### S5 `portrait-sheet` (PORTRAIT_LINK_PROFILE; source 433–504; 14 records)

**Fixtures:**

1. **`message-links.portrait-sheet.api-login`** [i 37@118←439].
2. **`.source-room-created`** [i 76@120←439].
3. `base.createRoom(local, {name:'Portrait Target <run>'})` with a read-back → **`.target-room-created`** [i 76@441].
4. `sendRoomLink(…, 'https://matrix.to/#/' + targetId, 'open the portrait target')` → **`.link-sent`** [i 100@444].

**Native steps and records:** 5. `reset(portrait)`, then the viewport-fit receipt (D3.1). Login, then `openRoom(source)` → **`.room-open`** [i 129@459]. `tapMessageLink`, then `hideKeyboard()`. 6. **`.preview-visible`** [d 465]. 7. **`.sheet-class`** [d 466]: the `trn-room-link-preview` class list includes `room-link-preview--sheet`. 8. **`.open-action`** [d 469]: `Open room`. 9. One stable `readPortraitSheetGeometry()` (replica of 472–491), then **`.portrait`** [d 492]. 10. **`.left-edge`** [d 493]: `|surface.left| ≤ 1`. 11. **`.right-edge`** [d 494]: `|surface.right − innerWidth| ≤ 1`. 12. **`.bottom-edge`** [d 497]: `|surface.bottom − viewportBottom| ≤ 1`. 13. **`.footer-top`** [d 500]: `footer.top ≥ 0`. 14. **`.footer-bottom`** [d 501]: `footer.bottom ≤ viewportBottom + 1`. The physical-reach receipt (D3.4) is attached to 500 and 501. The primary is never tapped.

### S6 `mention-user-card` (DESKTOP; source 507–587; 6 records)

**Fixtures** (all receipts; the predecessor's inline steps are unchecked):

- `owner = base.account('ml-mention-user')`, `bob = base.account('ml-mention-bob')`.
- `bobName = 'Bobby<run>'`, set with `base.setDisplayName(bob, bobName)`; profile receipt === `bobName`.
- `base.createRoom(owner, {name:'Mention Room <run>'})`. Bob is not invited.
- `links.apiLogin(owner)` (receipt), then `links.sendFormatted(owner, roomId, {body:'hey <bobName>', formattedBody:'hey <a href="https://matrix.to/#/<bobId>"><bobName></a>'}, 'mention-<run>')`.

**Native steps and records:**

1. Login, then `openRoom(roomName)` → **`message-links.mention-user-card.room-open`** [i 129@566].
2. Pre-tap receipt (D4), then `tapCurrent('.scroll a', {exactText: bobName})`.
3. **`.card-visible`** [d 573]: `[data-testid="user-card"]` visible (30 s).
4. **`.card-name`** [d 574]: `[data-testid="user-card-name"]` === `bobName`.
5. **`.no-anchored-popover`** [d 579]: `.cdk-overlay-connected-position-bounding-box` count is 0.
6. **`.dialog-name`** [d 582]: exactly one visible `[role="dialog"]` whose text contains `bobName`, plus the positive model receipt.
7. **`.room-retained`** [d 583]: placeholder === `Message #<roomName>`, plus the no-navigation receipt.

### Identity ledger (for the contract and the `MIGRATION.md` table)

| Stage              | #    | Line (helper@call)                                       | Kind | Identity suffix                                                                                                                                     |
| ------------------ | ---- | -------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| joined-preview     | 1    | 129@206                                                  | i    | room-open                                                                                                                                           |
|                    | 2–6  | 214, 215, 217, 218, 225                                  | d    | preview-visible, target-name, open-action, source-still-active, target-opened                                                                       |
| federated-join     | 1–6  | 37@118←237, 76@120←237, 58@239, 76@248, 100@255, 129@270 | i    | api-login, source-room-created, remote-registered, remote-room-created, link-sent, room-open                                                        |
|                    | 7–16 | 274, 277, 280, 283, 291, 295, 296, 304, 308, 316         | d    | remote-name, remote-topic, join-action, source-still-active, joined-notice, open-action, open-focused, light-contrast, dark-contrast, remote-opened |
| remote-unavailable | 1–6  | 37@118←328, 76@120←328, 58@329, 76@334, 100@338, 129@353 | i    | api-login, source-room-created, remote-registered, remote-room-created, link-sent, room-open                                                        |
|                    | 7–9  | 359, 360, 361                                            | d    | load-error-visible, load-error-guidance, no-primary-action                                                                                          |
| rejected-join      | 1–6  | 37@118←369, 76@120←369, 58@370, 76@375, 100@379, 129@394 | i    | api-login, source-room-created, remote-registered, remote-room-created, link-sent, room-open                                                        |
|                    | 7–12 | 399, 413, 418, 421, 422, 423                             | d    | join-action, join-rule-invite, action-error, join-retained, join-focused, preview-retained                                                          |
| portrait-sheet     | 1–5  | 37@118←439, 76@120←439, 76@441, 100@444, 129@459         | i    | api-login, source-room-created, target-room-created, link-sent, room-open                                                                           |
|                    | 6–14 | 465, 466, 469, 492, 493, 494, 497, 500, 501              | d    | preview-visible, sheet-class, open-action, portrait, left-edge, right-edge, bottom-edge, footer-top, footer-bottom                                  |
| mention-user-card  | 1    | 129@566                                                  | i    | room-open                                                                                                                                           |
|                    | 2–6  | 573, 574, 579, 582, 583                                  | d    | card-visible, card-name, no-anchored-popover, dialog-name, room-retained                                                                            |

Totals: 6 + 16 + 9 + 12 + 14 + 6 = 63; 38 direct and 25 inherited.

## Module and file list

### New: `e2e/android/message-links-contract.mts` (pure)

**Constants and types:**

- `MESSAGE_LINKS_SOURCE`, `MESSAGE_LINKS_SOURCE_SHA256`, `MESSAGE_LINKS_SHARED_SOURCE_SHA256` (the 5 pins).
- `MESSAGE_LINKS_SPANS`: helpers `22–147`; definitions as in the source-boundary table; `androidReturnLine: 587`; `excludedTail: 588–604`.
- `PORTRAIT_LINK_PROFILE`, `MESSAGE_LINKS_STAGE_PROFILES: Record<StageId,'desktop'|'portrait'>`.
- `MESSAGE_LINKS_STAGES`: an ordered readonly array of `{id, source, title, profile, sites, expectedAssertionRecords, assertions}`.
- `MESSAGE_LINKS_ASSERTION_RECORDS = 63`, `MESSAGE_LINKS_DIRECT = 38`, `MESSAGE_LINKS_INHERITED = 25`. Module-load asserts cover counts, per-stage totals and uniqueness.
- `AA_NORMAL_TEXT = 4.5`; `SUCCESS_TEXT = 'Room joined. It is ready to open.'`; `UNAVAILABLE_COPY` (two exact pairs).

**Functions:**

- `messageLinksAssertion(stage, suffix)`, `assertMessageLinksRecords(stage, actual)`.
- `assertRoomRoute(url, roomId, userId)`: pathname `/rooms/<b64url>`, `account`, `view=rooms`. Local copy; no linkify import.
- `assertExactPlaceholder(obs, name)`.
- `parseRoomLinkPreview` / `assertRoomLinkPreview(obs, {name, topic?, address?, primary, focused?})`.
- `assertSourceStillActive(before, after)`.
- `assertUnavailableGuidance(obs)`.
- `assertJoinedMembership({secondary, primaryJoined}, roomId)`, `assertNotJoined(...)`.
- `assertRejectedJoinState(obs)`.
- `parseLinkHref(href)` → `{kind:'room'|'user', target, via[]}` (matrix.to and `matrix:`).
- `luminance`, `contrastRatio`, `assertAaSuccessContrast(obs, mode)`.
- `parseAppliedMode` / `assertModeOnlyChange(baseline, after, mode)`.
- `parsePortraitGeometry` / `assertPortraitSheetGeometry(obs)` (±1).
- `assertViewportFit(obs)`.
- `parseNavigationBarFrame(dumpsys, wmSize)` (fail-closed) and `assertPhysicalFooterReach(receipt)`.
- `assertAndroidUserCardDialog(obs, name)`, `assertNoNavigation(before, after)`.

### New: `e2e/android/message-links-fixtures.mts`

```ts
export interface SecondaryDescriptor {
  readonly hs: string;
  readonly serverName: string;
}
export function readSecondary(session?: E2ESessionDescriptor): SecondaryDescriptor; // fail-closed: non-empty hs, serverName, registrationSecret; hs === SECONDARY_HTTP
export interface RemoteAccount {
  readonly userId: string;
  readonly localpart: string;
}
export type MembershipState = 'join' | 'leave' | 'invite' | 'ban' | 'knock' | 'absent';
export function createMessageLinksFixtures(options: {
  readonly resources: MatrixTestResources; // cleanup registered here, BEFORE createAccountFixtures
  readonly signal: AbortSignal;
  readonly secondary?: SecondaryDescriptor;
  readonly fetchImpl?: typeof fetch;
}): {
  apiLogin(account: NodeWorkspaceAccount): Promise<{ userId: string }>; // parity 37
  registerRemote(localpart: string): Promise<RemoteAccount>; // parity 58
  createRemoteRoom(
    owner: RemoteAccount,
    content: {
      name: string;
      topic?: string;
      preset: 'public_chat' | 'private_chat';
      visibility?: 'public';
      aliasLocalpart?: string;
    },
  ): Promise<{ id: string; alias?: string; joinRule: string; name: string; topic?: string; published: boolean }>; // parity 76 (remote) + read-back
  sendRoomLink(account: NodeWorkspaceAccount, roomId: string, href: string, label: string, txnId: string): Promise<{ eventId: string }>; // parity 100
  sendFormatted(account: NodeWorkspaceAccount, roomId: string, content: { body: string; formattedBody: string }, txnId: string): Promise<{ eventId: string }>;
  event(account: NodeWorkspaceAccount, roomId: string, eventId: string): Promise<{ body: string; format: string; formattedBody: string }>;
  awaitAliasFederation(account: NodeWorkspaceAccount, alias: string, expectedRoomId: string): Promise<{ polls: number; ms: number }>;
  awaitProfileFederation(account: NodeWorkspaceAccount, remoteUserId: string): Promise<{ polls: number; ms: number }>;
  setRemoteJoinRule(owner: RemoteAccount, roomId: string, rule: 'invite'): Promise<{ status: number; readBack: string }>; // parity 413
  remoteMembership(owner: RemoteAccount, roomId: string, userId: string): Promise<MembershipState>;
  leaveLocal(account: NodeWorkspaceAccount, roomId: string): Promise<void>;
  displayName(observer: NodeWorkspaceAccount, userId: string): Promise<string | undefined>;
};
```

- **Transport.** One private `request(server:'primary'|'secondary', session, method, pathTemplate, params, body, signal?)`. Base URLs come from `SYNAPSE_HTTP` / `SECONDARY_HTTP`, imported from `start.mjs`. Server names come only from the session.
- **Signals.** Each request uses `AbortSignal.any([signal, AbortSignal.timeout(15_000)])`.
- **Errors** carry only method, path template and status. They never include ids, which could reach `journeys.json`.
- **Sessions.** Tokens live in closure maps keyed by user id. `sendRoomLink` and `sendFormatted` require an `apiLogin` session for the sender, matching the predecessor, which sends with `loginApi` auth.
- **Probes** poll every 1 s for up to 60 s and tolerate only 404/502/503/504. Any other status throws immediately.
- **Cleanup** follows D6.

### New: `e2e/android/message-links-observer.mts` (read-only)

Each reader is an exported pure expression builder (runnable in jsdom by the
guard) plus a thin `evaluateNative`/`waitForNativeShellState` wrapper with a finite
timeout:

- `previewExpression()` / `readRoomLinkPreview(client)`. Reads:
  - count and visibility;
  - name, topic and address;
  - primary text, `aria-disabled` and focus;
  - success, action-error and load-error title/message;
  - Retry presence;
  - host class list.
- `composerPlaceholderExpression()` / `readComposerPlaceholder(client)`. Uses `getAttribute('placeholder')`, which `elements()` does not whitelist (`account-workspace-client.mts:404`).
- `linkAnchorsExpression(label)` / `readLinkAnchors(client, label)`: text, href, class, rect, visibility.
- `appliedModeExpression()` / `readAppliedMode(client)`.
- `successContrastExpression()` / `readSuccessContrast(client)`. It ports the renderer colour resolution of `clear-all-data-observer.mts:165–243`, keyed on `[data-testid="room-link-success"]`, without `seedPreference`. It returns `{text, foreground, background, htmlDark, checkedMode}`. The ratio is computed in Node with the contract's `contrastRatio`.
- `portraitGeometryExpression()` / `readPortraitSheetGeometry(client)`: a replica of 472–491 plus applied metrics.
- `userCardDialogExpression(name)` / `readUserCardDialogModel(client, name)`. Reads:
  - dialog count;
  - role, `aria-label`, `aria-modal`;
  - wrapper, dark-backdrop and transparent-backdrop counts, and the connected-box count;
  - containment of the card and of the name;
  - pointer coarse and platform.
- `navigationMarkerExpression()` / `readNavigationMarker(client)`: `href`, `timeOrigin`, `history.length`.
- `appliedProfileExpression()` / `readAppliedProfile(client)`.
- `stableSample(read, {intervalMs:250, timeoutMs:10_000})`.

### New: `e2e/android/message-links-artifacts.mts`

- **`messageLinksSecrets(stage, ids)`** returns `SECRET_<STAGE>_*` entries for:
  - local, remote and Bob user ids, localparts and passwords;
  - `bobName`;
  - every Room id, with its `slice(1)` form, `encodeURIComponent` form and `b64url` route segment;
  - Room names and topics;
  - the alias, its localpart and its encoded form;
  - the full hrefs;
  - event ids;
  - `run`.
    Encoded forms are registered as their own values, so the encoder also covers the double-encoded `%25xx` form. The bare server name is never registered.
- **`encodedSecretPatterns`** (case-insensitive hex), **`scrubMessageLinksArtifacts`** (raster removal plus `redactMaestroArtifacts` plus encoded patterns), and **`scanMessageLinksArtifacts`**, which rejects:
  - any secret form;
  - `syt_`, `Bearer `, `X-Matrix`;
  - raster files;
  - Preferences XML.
- **`MessageLinksPublicationSafety`**: `{unsafeSecrets, cleanupFailed, scrubFailed}`.
- **`markMessageLinksDiagnosticsSafe(output, secrets, safety, signal, report)`** writes `publication-safe` only when all of these hold:
  - the report passed, with 6 stages in contract order, all passed;
  - per-stage assertions exactly equal the contract, 63/63 unique;
  - `attempt 1`, `retries 0`;
  - `runtime-provenance.json` and `profiles.json` exist and match the contract;
  - each stage has `profile-applied.json` and its passed captures (`passed*.json`);
  - the scan is clean and every safety flag is false.
- **`revokeMessageLinksPublicationOnAbort`** and **`runMessageLinksStageCleanup(actions, failures)`**. These copy the newest linkify generation's semantics, not its imports.

### New: `e2e/android/message-links-journeys.mts`

- **Exports:**
  - `record(ctx, suffix, assertion, observation)` and `receipt(ctx, name, value)`;
  - `openRoom`, `tapMessageLink`, `tapPreviewPrimary`, `closePreview`, `selectAppearanceMode`;
  - `runJoinedPreview`, `runFederatedJoin`, `runRemoteUnavailable`, `runRejectedJoin`, `runPortraitSheet`, `runMentionUserCard`;
  - `runMessageLinksSuite(testContext)`.
- **Entry point:** `if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void test('Android message-links journeys', { timeout: 2_700_000 }, runMessageLinksSuite)`.
- **Runner:** output `…/message-links/` and `journeys.json` with `expectedStages:6`, `expectedAssertionRecords:63`, `attempt:1`, `retries:0`. It adopts the linkify safety generation: `guardedCleanup` wrapping `matrixResources.cleanup`, scan/mark registered first and scrub second, then device close.
- **Order within the runner:**
  1. `const resources = new MatrixTestResources(namespace); resources.cleanup = guardedCleanup;`
  2. `const links = createMessageLinksFixtures({resources, signal})`
  3. `const base = createAccountFixtures(resources, signal)`
  4. provenance
  5. stage loop

### Modified files

| File                                                        | Change                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/android/account-workspace-client.mts`                  | Add `async nativeRect(rect: {x,y,width,height}): Promise<{topLeft,bottomRight}>`: `owner.apply()`, then `owner.nativePoint` on corners inset 0.5 CSS px. No flow runs, no DOM access                                                                                                                                                                                                                |
| `e2e/android/project.json`                                  | `message-links` target copied from `message-linkify` (893–906): `cache:false`, `parallelism:false`, `dependsOn trinity-android:build-prebuilt`, and `run-node.mts --suite=android.message-links --timeout-ms=3000000 --entrypoint=e2e/android/message-links-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse`                                            |
| `package.json`                                              | `"e2e:android:message-links": "node scripts/nx.mjs run trinity-e2e-android:message-links"`                                                                                                                                                                                                                                                                                                          |
| `e2e/registry/suites/runners.mts`                           | `android.message-links` entry copied from 1767–1796. `serializationKeys ['android-avd','synapse']`, `availabilityPolicy 'required'`, `ciTier 'pull-request'`, `cachePolicy 'never'`; `sourceEntrypoints` lists the five new modules                                                                                                                                                                 |
| `e2e/registry/commands.mts`                                 | Package script (as at 507–510) and CI entrypoint (as at 1064–1066), shard 4                                                                                                                                                                                                                                                                                                                         |
| `.github/workflows/ci.yml`                                  | Shard-4 line after 451 (below); gate step after the linkify gate (485–493); upload after 919–924; budget comment "shard 4 about 165 (240)"                                                                                                                                                                                                                                                          |
| `scripts/ci-workflow.spec.mjs`                              | Uploads 72→73 (242); lines 65→66 (1674); condition-chain branch `android-message-links` requiring started **and** safe (868–889); new order test "runs message-links after security-settings and before retained Playwright on shard 4"                                                                                                                                                             |
| `e2e/android/MIGRATION.md`                                  | "Matrix-link journeys" section with the 63-row table `\| Stage \| Source line (helper@call) \| Kind \| Canonical assertion \| Android parity identity \|` (identity is the last cell); prose "38 direct + 25 inherited; 6/16/9/12/14/6"; documented reinterpretations (native taps, Appearance path plus S2 rejoin, header Back, physical footer receipt, S6 coarse receipt, raised polling bounds) |
| `docs/superpowers/plans/2026-09-20-android-matrix-links.md` | Reconciled per the last section                                                                                                                                                                                                                                                                                                                                                                     |

The new ci.yml line mirrors the `security-settings` line directly above it: it
runs only on shard 4, writes `message-links-started=true`, and runs the
`trinity-e2e-android:message-links` target through `ci-run-command.mjs` with
`--timeout-ms 3300000`.

The new gate step:

```yaml
- name: Gate Android message-links diagnostics
  id: message-links-artifact-gate
  if: ${{ !cancelled() && steps.android.outputs.message-links-started == 'true' }}
  env:
    MESSAGE_LINKS_DIAGNOSTIC_ROOT: dist/.playwright/trinity-e2e-android
  run: |
    if [ -n "$(find "$MESSAGE_LINKS_DIAGNOSTIC_ROOT" -type f -name publication-safe -path '*/android.message-links/message-links/publication-safe' -print -quit)" ]; then
      echo 'message-links-safe=true' >> "$GITHUB_OUTPUT"
    fi
```

The upload has surface `android-message-links`, report path
`dist/.playwright/trinity-e2e-android/*/android.message-links/**`, and
`if: !cancelled() && …message-links-started == 'true' && steps.message-links-artifact-gate.outputs.message-links-safe == 'true'`.

## Guard spec (`scripts/message-links-migration.spec.mjs`), written RED first

### Source pins

- **Hashes:** the predecessor (605 lines) and the five shared sources. The predecessor file must exist and must not be listed in any skip or retirement list.
- **Line maps:** `assertionLines(source, from, to)` uses the house AST rule: an `Identifier` `expect` callee, keyed by start line (`scripts/message-forward-migration.spec.mjs:21–43`). It must return exactly:
  - the per-span lists in the source-boundary table;
  - `[591,595,596,597,598,600]` for 588–604.
    An explicit test shows that 507–604 yields 11 sites, and a 44 total must fail.
- **Line pins:**
  - `source.split('\n')[577].trim() === 'if (isAndroidE2E) {'`;
  - `[586].trim() === 'return;'`;
  - the six definition titles;
  - the describe-level skips 150–154;
  - the imports 1–16.
- **`test.use`** at 427–431 is parsed. It must equal `PORTRAIT_LINK_PROFILE` minus the implicit DPR 1. The skip at 437 names `isAndroidE2E`.
- **Link templates** at 195, 260, 343, 384, 449 and 560 are pinned verbatim, and the journey or fixture hrefs must reproduce them:
  - raw id;
  - `encodeURIComponent(alias)`;
  - raw id + `?via=` + encoded server;
  - `matrix:roomid/` + `slice(1)` + `via`;
  - raw id;
  - raw user id.
- **Replaced workarounds** are pinned so they cannot silently shift: `activateRoomLinkPrimary` 134–147 (focus 141, Enter 142), 289–290, 416–417, and the class mutations 298–313.

### Helper expansion by binding

- Use `ts.createProgram` with an in-memory host and `noResolve`, plus the TypeChecker. Calls resolved to module-level declarations inside 22–147 must be exactly:
  - `loginApi [118]`;
  - `localScenario [237,328,369,439]`;
  - `registerRemote [239,329,370]`;
  - module `createRoom [120,248,334,375,441]`;
  - `sendRoomLink [255,338,379,444]`;
  - `openRoom [206,270,353,394,459,566]`;
  - `activateRoomLinkPrimary [223,315]` (0 records).
- D1's `createRoom` calls at 183 and 184 resolve to the local arrow at 178. D6's `token` calls at 529 and 530 resolve to 519. Both are excluded.
- A naive identifier-count control proves the resolver matters.
- Expansion 4+3+8+4+6 = 25 must equal the contract's inherited sites, including each `call` and `via`.

### Contract checks

6 stages in order, `[6,16,9,12,14,6]`, 38/25/63, uniqueness, and the profile
map (5 desktop, 1 portrait). `record()` is exercised with:

- an out-of-order identity;
- a duplicate;
- an unproved (throwing) assertion;
- a receipt named `message-links.*`.

Each must fail.

### Source rules (journeys, observer, fixtures, artifacts)

**Forbidden:**

- DOM and interaction calls: `.focus(`, `focusFixture`, `focusCurrent`, `client.key(`, `pressAndroidKeyboardKey`, `keyevent`, `'enter'`, `.click(`, `dispatchEvent`, `scrollIntoView(`, `.submit(`, `navigate(`, `reload(`, `installDocumentScript`, `classList.`, `setAttribute`, `.style.` writes, `location =`, `location.assign`, `Input.dispatch`.
- Appearance shortcuts: `seedPreference`, `Preferences.set`, `emulateMedia`, `uimode`, `native-shell-appearance-(light|dark)`, `native-shell-back.yaml`.
- Literals and ports: reverse ports 8009 or 9448; the literals `caddy:9448`, `localhost:9448`, `localhost:8008` and `trinity-e2e-shared-secret`.
- Attempts: `retries:` other than 0; `waitForNativeShellState` or `waitElements` without a numeric bound.
- Observer: must pass the read-only regex (`edit-history-migration.spec.mjs:124–134`).

**Allow-list, asserted by name:**

- viewport emulation through `client.reset` / `client.resize` / `owner.apply`;
- the `nativeAction` capture-phase click listener;
- the observer's detached contrast canvas;
- `nativeRect`, which must contain no `runFlow` and no `evaluateNative`.

**Required, via `functionSource` order per stage:**

- **S1:** `tapMessageLink` → record `open-action` → `tapPreviewPrimary` → record `target-opened`.
- **S2:** `selectAppearanceMode(…'light')` → `tapMessageLink` → `tapPreviewPrimary` → record `light-contrast` → `closePreview` → `leaveLocal` → `selectAppearanceMode(…'dark')` → `tapMessageLink` → `tapPreviewPrimary` → record `dark-contrast` → `tapPreviewPrimary` → record `remote-opened`.
- **S4:** record `join-action` → `setRemoteJoinRule` → record `join-rule-invite` → `tapPreviewPrimary` → record `action-error`.
- **S5:** no `tapPreviewPrimary`.
- **S6:** the pointer receipt, then `tapCurrent('.scroll a'`.
- **Everywhere:** `tapCurrent` for `[data-testid="open-settings"]`, `settings-nav-appearance`, `mode-light`, `mode-dark` and `trn-page-header button[aria-label="Back"]`.

### Wiring checks

- The Nx target: resources, uncached, serial, timeout, entrypoint.
- The package script.
- The registry entry and its serialization keys.
- The commands entries.
- The ci.yml line: shard 4, after `security-settings`, before `pnpm e2e:android --`.
- The gate `-path`, and the upload gated on started && safe.
- ci-workflow counts 73/66.
- `MIGRATION.md`: exactly the 63 identities in the last table cell, plus the 38/25 prose.

## Negative controls mapped to acceptance

Every control is an effective mutation: it must fail, and the canonical input
must pass. Controls run through the pure asserters, the fetch-mocked fixtures,
jsdom-executed observer expressions, and source/wiring text.

**Acceptance bullet 1: contract guards (shape, 38+25, six definitions, native and theme replacements, registration, retention).**

A. A control fails when any of these holds:

- a pinned hash differs by 1 byte;
- the D6 span is 507–604 (44);
- the line-587 or 578 pin moves;
- a web-tail site is counted;
- a helper line is dropped;
- the shadowed 183/184 or 529/530 calls are counted;
- stage counts are perturbed (for example S2 = 15), or the total is 62 or 64;
- an identity is duplicated;
- the stage order is swapped;
- the portrait profile differs from `test.use`;
- an href template drifts;
- the predecessor is deleted or edited;
- any forbidden token, or a missing required native call, appears in any stage function.

**Bullet 2: effective negative controls.**

- **B. Joined-preview gating.**
  - The placeholder or route already names the target before Open.
  - The primary reads `Join room` for a joined target.
  - 225 is satisfied without a route change to `b64url(targetId)`.
  - The preview is still open after Open.
  - The target name differs by one character.
- **C. Local and federated identity, topic, membership.**
  - Wrong name or topic, or name and topic swapped.
  - Address ≠ alias.
  - Alias unencoded or double-encoded; `via` missing or unencoded; the `!` kept in `matrix:roomid`.
  - `registerRemote` posts to `SYNAPSE_HTTP`, or does not assert `user_id` (a `:localhost` id returned).
  - `readSecondary` accepts an empty `serverName` or `hs ≠ SECONDARY_HTTP`.
  - `createRemoteRoom` skips its read-back, or the read-back shows the wrong `join_rule`, alias→id or directory visibility.
  - A probe tolerates 403 or 500, or is unbounded.
  - Membership is taken from the `Room joined` text alone, from the primary only, or with the secondary showing `leave`/absent.
  - The `leave-sync` receipt is missing before the Dark rejoin.
  - The second-join receipts show a different name or topic.
  - 316 lands on the source or local Room.
- **D. Unavailable, no action.**
  - Load error present but not visible.
  - Title `Could not preview room`.
  - Mismatched title/message pair.
  - A Retry button present.
  - Primary count 1.
- **E. Join-rule race and retry.**
  - The join-rule PUT happens before 399.
  - The read-back is `public`.
  - No action error.
  - The primary reads `Joining…` or `Open room`, or has `aria-disabled="true"`.
  - Not focused, or focus produced in source.
  - Preview count 0, or the name changed.
  - The secondary shows `join`.
  - The race Room is tracked.
- **F. Light/Dark AA contrast.**
  - Ratio 4.49 in either mode.
  - `htmlDark` does not match the selected mode, or the wrong radio is checked.
  - Both measurements taken in one mode.
  - Theme, density, font-size or code carriers changed.
  - A selector other than `room-link-success`.
  - An unstable sample.
  - Dark measured on a Room id different from 316's.
  - Mode chosen by a text tap or a shortcut listed under J.
  - A Back without the route-equality check.
  - Contrast math disagrees with the fixed vectors (black/white = 21) that match `contrast.mts`.
- **G. Portrait sheet and footer.**
  - The sheet class is missing.
  - Landscape.
  - left 1.5; `|right−w|` 2; `|bottom−vb|` 2; footer.top −1; footer.bottom vb+2.
  - A profile other than 390x844 mobile/touch DPR 1.
  - The fit receipt is missing, or `innerHeight` is 843.
  - A `nativeRect` corner lies outside the WebView (tested with an injected owner).
  - A button bottom sits below the nav-bar top.
  - The nav-bar parse is ambiguous (two distinct frames) or empty.
  - A button fails `elementFromPoint`.
  - The IME is shown.
  - The primary is tapped in S5.
- **H. User dialog, no navigation.**
  - Connected box count 1.
  - A transparent backdrop.
  - No global wrapper.
  - `aria-label` ≠ `User`.
  - Two dialogs.
  - A modal without the user card inside.
  - Pointer coarse false, or platform not `android`.
  - href, `timeOrigin` or `history.length` changed.
  - The placeholder names another Room.
  - The MXID fallback is shown while the profile receipt says `bobName`.
  - The profile receipt is missing.
- **I. Two-server cleanup and redaction.**
  - The mock must observe base cleanup before the message-links cleanup (a namespace-order test), then primary logout, then alias DELETE (404 tolerated), directory PUT `private`, owner leave, forget and remote logout.
  - Any one step is dropped, stops the rest, or is swallowed without an `AggregateError`.
  - A cleanup step uses the aborted test signal.
  - A partial-setup failure skips remote cleanup.
  - The scan misses any of these:
    - a raw or JSON-escaped id;
    - a `%23`/`%21`/`%3A` form in mixed-case hex;
    - a double-encoded `%2523` form;
    - the `slice(1)` form;
    - a base64url segment;
    - the topic, `bobName` or a remote password;
    - `syt_`, `Bearer`, `X-Matrix`;
    - a `.png`;
    - Preferences XML.
  - The bare server name is registered as a secret.
  - The marker is written on a failed stage, at 62/63, with a missing `profile-applied.json` or `passed*.json`, with `unsafeSecrets` true, or it survives an abort.

**Bullet 3: three unchanged first attempts plus predecessors at retry 0.**

J. Run-time gates. The publication gate refuses `attempt≠1`, `retries≠0`, fewer
than 6 stages, or fewer than 63 records. The guard's wiring controls fail on a
cached or parallel target, missing resources, the wrong shard or line, a wrong
gate path, an ungated upload, or counts other than 73/66. The runs themselves
are evidence (next section).

**Bullet 4: full validation and hosted audit.** Covered by the evidence plan.
Not a guard test.

## Evidence and acceptance plan

1. **Guard RED, then GREEN in stages:**
   - contract and fixtures (injected fetch);
   - observers (jsdom) and artifacts;
   - journeys and wiring.
     Run `pnpm exec vitest run scripts/message-links-migration.spec.mjs` with `scripts/ci-workflow.spec.mjs`, the registry validator spec, `scripts/android-runtime-provenance.spec.mjs` and `scripts/e2e-shared-harness.spec.mjs`. Then the Android e2e typecheck and `pnpm nx test scripts`.
2. **Development shakedown** (not counted; only after any in-progress emulator run finishes). Inspect every `current-point-*` receipt. Confirm on the device:
   - the inline-anchor taps at scale 0.32;
   - focus after the Join tap (296/422);
   - pointer coarse under DESKTOP;
   - a single `location.back()` from the header Back;
   - sidebar row removal after the leave;
   - the `dumpsys` nav-bar parse on API 36 (capture a sample as a parser fixture);
   - the S5 fit;
   - the duration.
     Fix defects; never retry. Any change resets the run counter.
3. **Three sequential unchanged runs** of `pnpm nx run trinity-e2e-android:message-links --skipNxCache`, with `git diff` unchanged between runs. Each run must show:
   - 6/6 stages, 63/63 ordered unique identities, attempt 1, retries 0;
   - `publication-safe`;
   - identical APK, renderer and `profiles.json` digests;
   - every mandatory receipt: federation probes, membership 1/2, leave sync, join-rule read-back, mode baselines, contrast ratios, fit and reach, pointer, no-navigation, and two-server cleanup.
     Record invocation ids and per-stage durations, then re-derive the D10 timeouts.
4. **Predecessor coexistence**, sequential, with `--workers=1 --retries=0`:
   - android-webview: `pnpm e2e:android -- e2e/browser/journeys/conversations/message-links.spec.mts --workers=1 --retries=0`. All six definitions pass; D5 runs under `isAndroidE2E`. Confirm the file-filter passthrough of `trinity-e2e:e2e-android` before counting.
   - browser: `pnpm nx run trinity-e2e-browser:e2e -- e2e/browser/journeys/conversations/message-links.spec.mts --workers=1 --retries=0`. Five pass; D5 skips.
   - Re-hash all six pinned sources.
5. **Redaction audit** of every retained file from the three runs: all encoded forms, tokens, rasters, and Preferences XML.
6. **Full repository validation** selected by the change: typecheck, lint, `format:check`, architecture, production renderer, Android APK/host, docs. Then review the complete diff.
7. **Hosted.** After #746 is accepted:
   - Commit only task-owned files (plus the plan reconciliation) and push to `test/676-android-sidebar-filter`.
   - Audit the original-attempt shard-4 `android-message-links` artifact, the retained android-webview predecessor at retry 0, the canonical browser run and the renderer manifest.
   - Post evidence to #747, #660, #653 and PR #677. PR #677 stays draft and unmerged.
   - Then close #747 and continue with #748.

## Failure, teardown and diagnostics

- **Attempts:** one attempt, zero retries. The suite stops at the first failed stage.
- **Bounds:** every native action, REST call, observation, probe and cleanup is bounded.
- **Reports:** started-stage reports and passed/failed text captures exist in both outcomes. They carry:
  - the source revision, renderer manifest and APK digest;
  - `profiles.json` and per-stage `profile-applied.json`;
  - sanitized receipts;
  - ordered records;
  - attempt and retry counts;
  - cleanup status.
- **Publication:** credentials, tokens, bearer/X-Matrix authorization and rasters never reach published diagnostics. A cleanup, scrub or scan failure fails the suite and blocks publication. It never produces a partial pass.

## Open risks

1. **Device inferences** that only the shakedown can confirm:
   - native anchor taps at 0.32 scale (no Android precedent taps an inline message anchor);
   - focus after a tapped `<button>` (296/422);
   - `(pointer: coarse)` with touch emulation disabled;
   - a single `location.back()` from the header Back at 1280;
   - sidebar removal after a REST leave;
   - the API-36 `dumpsys window` nav-bar format.
     Each fails closed with an explicit message. A profile or mechanism change is a documented reinterpretation, never a silent swap.
2. **S2 cost and sync.** The second Join adds about 1–2 min, and stale local state after the leave is possible. The leave-sync receipts and the `Join room` receipt catch the stale-state case.
3. **Duration.** Estimates:

   | Stage | Minutes |
   | ----- | ------- |
   | S1    | ≈4      |
   | S2    | ≈9      |
   | S3    | ≈4      |
   | S4    | ≈5      |
   | S5    | ≈4      |
   | S6    | ≈4      |

   That is about 30 local, 35–45 hosted. A hosted time above 48 min needs a shard-4 rebalance.

4. **Rate limits.** Synapse defaults were not re-read for v1.161. A 429 is recorded verbatim; there is no retry.
5. **Room version ids.** v12 ids may carry no server part. Nothing may assume `:<server>` inside an id; `via` stays mandatory.
6. **#746 in flux.** Its hosted acceptance blocks the start. Linkify files and line numbers are still changing, so re-check every cited linkify precedent line after it lands.
7. **Predecessor flake.** A flake on android-webview at retry 0 blocks acceptance independently of the installed suite. Report it separately.
8. **Shared-file change.** `nativeRect` changes a shared file. The guard enforces that it stays read-only.

## Existing plan reconciliation

`docs/superpowers/plans/2026-09-20-android-matrix-links.md` is a preparatory
plan, not implementation permission. Before execution, the writing-plans step
must reconcile it with this design:

- Change "shard 2 immediately after message-linkify" to shard 4 after `security-settings`.
- Change the D6 span "507–604" to 507–587 with the line-587 `return;` pin.
- Replace "Reopen the same preview" with the S2 leave/rejoin sequence, keeping the second Join's observations as receipts.
- Key identities per stage and per call site.
- Build the Settings round trip from test-id taps plus the in-app header Back.
- Add the S5 physical-reach and S6 dialog-model/pointer receipts.
- Leave `runtime-provenance.mts` unchanged and add the suite-owned `profiles.json`.
- Add the two-server cleanup order.
- Add no CHANGELOG entry.

Do not execute the older plan unchanged.
