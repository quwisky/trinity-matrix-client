# Trinity — Element Parity & Completeness Roadmap

A prioritized plan for the gaps that make Trinity feel _unfinished_ next to Element: **moderation &
room admin**, **verification & security breadth**, and **notification / account / privacy settings**.
Grounded in a codebase audit (what's already shipped vs. genuinely missing).

> **Status (2026-07).** The moderation / room-admin cluster, the account & privacy settings, and a
> Security section are **shipped** (see the ✅ rows below). What remains is captured — re-prioritized
> into execution tracks — in [**Execution plan — next tracks**](#execution-plan--next-tracks) at the
> bottom. That section is the live to-do list; the tables above are the audit it came from.

Companion tracks: everyday UX polish ([UX-POLISH-PLAN.md](UX-POLISH-PLAN.md)), calls
([CALLS-PLAN.md](CALLS-PLAN.md)), native/ship-readiness ([NATIVE-READINESS-PLAN.md](NATIVE-READINESS-PLAN.md)),
and the master [PLAN.md](PLAN.md).

Effort: **S** = <1 day · **M** = a few days · **L** = ~1–2 weeks.

## Cross-track "table stakes" first

If you build parity roughly in ROI order, these are the highest-value, mostly-cheap wins:

1. **Leave a room** — ✅ **shipped** (menu action → `RoomsService.leave`).
2. **Redact others' messages as a moderator** — ✅ **shipped** (power-gated delete on others' rows).
3. **Room settings panel** — ✅ **shipped** (name / topic / avatar, power-gated dialog).
4. **Member info panel** — ✅ **shipped** (click a member → info + Message/Copy, and the launch
   surface for kick/ban/power-level).
5. **Cross-user verification** (M) — the single biggest hole in a "security-first" client.
6. **Per-room notification level** — ✅ **shipped** (mute / mentions-only, via the UX track).

---

## A. Moderation & Room Admin

**Already shipped:** create room/DM, invite, spaces (create/manage/hierarchy/join/leave), favourites,
pin, role **display** (Admin/Moderator/Member sections), **leave a room**, **redact others' messages
as a moderator**, a **room settings dialog** (edit name/topic/avatar), a **member info panel**, and
acting on members from it — **kick / ban** and **promote / demote** (power-level editing). What's
still missing is the wider room-config and directory surface.

| Feature                                                  | Size | Value |
| -------------------------------------------------------- | ---- | ----- |
| ✅ Leave a normal room (Forget-after-leaving: follow-up) | S    | High  |
| ✅ Redact other users' messages as a moderator           | S    | High  |
| ✅ Room settings / info panel: edit name, topic, avatar  | M    | High  |
| ✅ Member info panel with per-member actions             | M    | High  |
| ✅ Kick / ban + **unban + ban-list view**                | M    | High  |
| ✅ Promote / demote members (power-level editing)        | M    | Med   |
| ✅ Ignore / block a user (account-wide)                  | M    | Med   |
| ✅ Join rules / history visibility (guest access: n/a)   | M    | Med   |
| ✅ Directory publish + canonical/local aliases           | M    | Med   |
| ✅ Report a message / room to server admins              | S    | Med   |
| ✅ Public room directory browsing + join by alias        | L    | Med   |
| Space directory + nested-rail nav + child reorder        | L    | Med   |
| Knock-to-join + approve/deny knocks                      | M    | Low   |
| Room upgrade + follow tombstones                         | L    | Low   |

**Notes on the key items**

- **Leave a room (S) — ✅ done:** a "Leave room" action in each room's ⋮ menu →
  `RoomsService.leave` (cold `defer/from(client.leave)`); the room drops off the list via the
  join-membership filter, and leaving the open room tears its panes down. Forget-after-leaving is a
  small follow-up (the room only lingers in the SDK store, not the joined list).
- **Redact others' (S) — ✅ done:** `TimelineService.canRedactOthers` compares the user's power level to
  the room's `redact` threshold (`hasSufficientPowerLevelFor`), and `MessageListBase`/`ThreadViewComponent`
  widen the delete cap to `(isOwn || canRedactOthers)` so the existing ⋯ → Delete affordance shows on
  others' rows for moderators.
- **Room settings panel (M) — ✅ done:** a ⚙ button in the room header opens `RoomSettingsComponent`, a
  power-gated dialog editing name/topic (`setRoomName`/`setRoomTopic`) and avatar
  (`uploadContent` → `sendStateEvent(m.room.avatar)`) via `RoomSettingsService`. This is the container
  that now unblocks join-rules, aliases, ban-list, and power-level editing.
- **Member info panel (M) — ✅ done:** clicking a member opens a room-scoped `MemberInfoComponent`
  (avatar, id, live presence, role) via `MemberInfoService`, offering Message (→ DM) and Copy user id,
  and — when the viewer's power permits — the kick / ban / role actions below. The launch surface the
  rest of the member features hang off.
- **Kick/ban (M) — ✅ done:** `RoomModerationService.kick/ban` (cold `client.kick/ban`, optional reason)
  gated by `canModerate` (strictly out-ranks the target AND meets the room's kick/ban power). Shown in
  the member panel; the homeserver enforces the real rule. _Unban + a ban-list view remain a follow-up._
- **Power-level editing (M) — ✅ done:** `RoomModerationService.setPowerLevel` + a "Make <role>" control
  in the member panel offering presets at or below the viewer's own level (can't raise anyone above
  yourself). Gated on `maySendStateEvent(m.room.power_levels)` + out-ranking the target.

**Sequencing:** ~~Leave + Redact-others~~ ✅ → ~~Room settings panel~~ ✅ → ~~Member info panel~~ ✅ →
~~Kick/ban + Power-levels~~ ✅ → **join-rules/aliases/report + Ignore/block (next)** → directory browsing
(larger, discovery-focused).

---

## B. Verification & Security

**Already shipped:** Rust crypto + 4S, cross-signing setup, key backup, **emoji-SAS self-verification**,
device management (list/rename/sign-out), encryption banner, recovery-key unlock.

| Feature                                           | Size | Value |
| ------------------------------------------------- | ---- | ----- |
| Cross-**user** verification (verify other people) | M    | High  |
| Per-message authenticity shields                  | M    | High  |
| Recovery/identity **reset** escape hatch          | M    | High  |
| ✅ Security settings section + key-backup status  | L    | High  |
| Surface recovery-**passphrase** unlock            | S    | Low   |
| Member-list trust badges + verify-user action     | M    | Med   |
| New-/unverified-session security alert            | M    | Med   |
| Encrypted room-key export / import to a file      | M    | Med   |
| QR-code verification (show + scan)                | L    | Med   |
| "Never send to unverified devices" toggle         | S    | Low   |
| Verify / mark a specific device from the list     | S    | Low   |

**Notes on the key items**

- **Cross-user verification (M):** `VerificationService` is hard-coded to self only (explicit "cross-user
  out of scope" at line 53). Add a "Verify \<user\>" flow over `requestVerificationDM(userId, roomId)`,
  reusing the existing SAS UI (`VerificationView` already carries `otherUserId`). The single biggest missing
  capability for a security-first client; unblocks trust badges + shields.
- **Per-message shields (M):** timeline only shows decrypt-success vs. failure. `getEncryptionInfoForEvent`
  returns shield colour/reason; project it into `MessageView` (needs an async per-event projection that
  re-renders on trust changes) and render a shield + tooltip on the message row.
- **Recovery reset (M):** a user who lost their recovery key with no verified device is **permanently stuck**
  at the unlock page (key-only, Close button). `resetEncryption()` re-bootstraps cross-signing + 4S + backup.
  Key loss currently = a broken account — this is the escape hatch.
- **Security settings section (L):** Settings has no security surface. Natural container for backup
  status/version, "this device verified", restore-all-from-backup, reset, export/import, and the blacklist
  toggle. Pairs well with the new settings submenu (add a "Security" section).

**Sequencing:** Cross-user verify → per-message shields + trust badges (build on it) → recovery reset →
Security settings section (absorbs export/import, blacklist, backup mgmt) → QR (nice, but SAS already covers
the core need and QR carries camera/encoder cost).

---

## C. Notifications, Account & Privacy

**Already shipped:** local + push notification delivery (engine respects push rules), profile, appearance,
device management, GIF config, feature flags, presence **display**, **per-room notification level**
(mute / mentions-only / all), and **setting your own presence + status** (both via the UX track).

| Feature                                               | Size | Value |
| ----------------------------------------------------- | ---- | ----- |
| ✅ Per-room notification level (mute / mentions-only) | M    | High  |
| ✅ Global Notifications settings screen               | L    | High  |
| ✅ Ignore / block users + management list             | M    | High  |
| ✅ Change account password                            | S    | Med   |
| ✅ Set your own presence + status message             | S    | Med   |
| Deactivate account (with erase)                       | M    | Med   |
| Email & phone (3PID) management                       | L    | Med   |
| ✅ Toggle to stop sending read receipts               | S    | Low   |

**Notes on the key items**

- **Per-room notification level (M) — ✅ done:** each room's ⋮ menu has a **Notifications** submenu
  (All / Mentions & keywords only / Mute) backed by `RoomNotificationsService` over `setRoomMutePushRule`
  and an override `dont_notify` rule; the checked level reflects the persisted push rules.
- **Global Notifications screen (L):** no Notifications section in Settings. Master enable/disable, all vs.
  DMs-only vs. mentions-only defaults, and **keyword highlights** (a signature Matrix power-user feature).
  Main work is a reactive read model projecting push-rules account data into signals.
- **Ignore/block (M):** no ignore anywhere; a core safety control that works without room-admin rights.
  `setIgnoredUsers` (the SDK auto-hides ignored users) + a settings list + a per-member action.
- **Change password / Deactivate (S / M):** standard account hygiene + an app-store review expectation.
  Both reuse the existing `runPasswordUia` helper; deactivate must reuse the hard-logout teardown to clean
  the local multi-account session/crypto store.

**Sequencing:** Per-room mute (quick, high-value) → Ignore/block → Change password → global Notifications
screen (larger, keyword rules) → deactivate + 3PIDs (account-management cluster).

---

## Execution plan — next tracks

The moderation / room-admin cluster, account & privacy settings, and a Security section are all
shipped. What remains, re-prioritized into execution tracks. Each item ships on its own commit with
unit **and** e2e tests, passing `nx test` + `nx lint` + `pnpm build` (e2e specs `tsc`-checked).

**Environment note.** The e2e harness is one browser + a disposable Synapse. Items needing real
hardware (camera, push credentials), a second physical device, or irreversible account actions can't
be reliably e2e-tested here — flagged ❌ / ⚠️ below.

Effort: **S** ≤ half-day · **M** ~1 day · **L** multi-day.

### Track 1 — Encryption UX (extends the Security section)

| #   | Feature                     | Summary                                                                                                                                                 | Effort | e2e |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 1a  | Export / import room keys   | Passphrase-encrypted `.txt` of E2EE room keys (`exportRoomKeysAsJson` + `encryptMegolmKeyFile` / decrypt on import).                                    | M      | ✅  |
| 1b  | Per-message trust shields   | Shield / warning from `getEncryptionInfoForEvent` (unverified device, unencrypted-in-E2EE); projected into `MessageView`, re-rendered on trust changes. | M      | ⚠️  |
| 1c  | Cross-user verification     | Verify another user via SAS over `requestVerificationDM`; reuses the SAS UI + the 2-client `e2e:verify` harness.                                        | L      | ✅  |
| 1d  | Recovery reset escape hatch | `resetEncryption()` re-bootstraps cross-signing + 4S + backup when the recovery key is lost.                                                            | M      | ⚠️  |

### Track 2 — Timeline richness

| #   | Feature                         | Summary                                                                                         | Effort | e2e |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------- | ------ | --- |
| 2a  | URL / link previews             | `getUrlPreview` → a preview card; suppressed in E2EE rooms by default, behind a privacy toggle. | M      | ✅  |
| 2b  | Slash commands                  | `/me`, `/shrug`, `/spoiler`, `/plain`, `/join`, `/invite`; render `m.emote`.                    | M      | ✅  |
| 2c  | Room-upgrade / tombstone banner | `m.room.tombstone` → a banner that joins/opens the successor.                                   | S–M    | ✅  |
| 2d  | Message context actions         | Copy text, copy `matrix.to` permalink, view source (raw event JSON).                            | S      | ✅  |
| 2e  | "Seen by" detail                | Expand the read-receipt cluster into a who-read list.                                           | S      | ✅  |
| 2f  | Mark room as read               | `setRoomReadMarkers` on the latest event, from the room menu + a global mark-all-read.          | S      | ✅  |

### Track 3 — Rich content

| #   | Feature                 | Summary                                                                                        | Effort | e2e |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------- | ------ | --- |
| 3a  | Location sharing        | `m.location` via geolocation; render coords + "open in maps" (no map tiles → CSP-safe).        | M      | ✅  |
| 3b  | Public space directory  | Browse public _spaces_ — extends `PublicRoomsService` with a `room_type` filter.               | M      | ✅  |
| 3c  | Stickers / custom emoji | Image packs (MSC2545) from account-data/room-state; a picker sending `m.sticker`.              | L      | ✅  |
| 3d  | Voice messages          | `MediaRecorder` → `m.audio` + MSC3245 voice metadata + waveform; reuses the media upload path. | L      | ⚠️  |

### Blocked here (Tier C)

QR verification (camera), voice/video calls (TURN + signalling), deactivate account (irreversible),
3PID email/phone (real delivery), multi-account push fan-out (Sygnal creds), native on-device
verification (real devices). Revisit when the environment allows.

**Recommended order:** Track 1 (1a → 1b → 1c → 1d) → Track 2 (2a → 2b → 2c → 2d → 2e → 2f) →
Track 3 (3a → 3b → 3c → 3d).
