# Trinity — Element Parity & Completeness Roadmap

A prioritized plan for the gaps that make Trinity feel _unfinished_ next to Element: **moderation &
room admin**, **verification & security breadth**, and **notification / account / privacy settings**.
Grounded in a codebase audit (what's already shipped vs. genuinely missing).

Companion tracks: everyday UX polish ([UX-POLISH-PLAN.md](UX-POLISH-PLAN.md)), calls
([CALLS-PLAN.md](CALLS-PLAN.md)), native/ship-readiness ([NATIVE-READINESS-PLAN.md](NATIVE-READINESS-PLAN.md)),
and the master [PLAN.md](PLAN.md).

Effort: **S** = <1 day · **M** = a few days · **L** = ~1–2 weeks.

## Cross-track "table stakes" first

If you build parity roughly in ROI order, these are the highest-value, mostly-cheap wins:

1. **Leave a room** — ✅ **shipped** (menu action → `RoomsService.leave`).
2. **Redact others' messages as a moderator** — ✅ **shipped** (power-gated delete on others' rows).
3. **Room settings panel** — ✅ **shipped** (name / topic / avatar, power-gated dialog).
4. **Member info panel** (M) — the launch surface for DM/mention/ignore/kick/ban/power-level.
5. **Cross-user verification** (M) — the single biggest hole in a "security-first" client.
6. **Per-room notification level** — ✅ **shipped** (mute / mentions-only, via the UX track).

---

## A. Moderation & Room Admin

**Already shipped:** create room/DM, invite, spaces (create/manage/hierarchy/join/leave), favourites,
pin, role **display** (Admin/Moderator/Member sections), **leave a room**, **redact others' messages
as a moderator**, and a **room settings dialog** (edit name/topic/avatar). What's still missing is the
rest of the ability to _act_ on members.

| Feature                                                  | Size | Value |
| -------------------------------------------------------- | ---- | ----- |
| ✅ Leave a normal room (Forget-after-leaving: follow-up) | S    | High  |
| ✅ Redact other users' messages as a moderator           | S    | High  |
| ✅ Room settings / info panel: edit name, topic, avatar  | M    | High  |
| Member info panel with per-member actions                | M    | High  |
| Kick / ban / unban (with a ban list)                     | M    | High  |
| Promote / demote members (power-level editing)           | M    | Med   |
| Ignore / block a user (account-wide)                     | M    | Med   |
| Join rules / history visibility / guest access           | M    | Med   |
| Directory publish + canonical/local aliases              | M    | Med   |
| Report a message / room to server admins                 | S    | Med   |
| Public room directory browsing + join by alias           | L    | Med   |
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
- **Member info panel (M):** clicking a member does nothing today (`MemberListComponent` has no action
  output). This panel is the home for DM / mention / ignore / verify / kick / ban / power-level — build it
  early because most member-level features need a launch surface.
- **Kick/ban (M):** `client.kick/ban/unban` + power-level checks + a ban-list view (depends on room settings).
- **Power-level editing (M):** natural completion of the role-sections feature; `setPowerLevel` is unused
  today. Admin-only; hangs off the member panel.

**Sequencing:** ~~Leave + Redact-others~~ ✅ → ~~Room settings panel~~ ✅ → **Member info panel (next)** →
Kick/ban + Power-levels → join-rules/aliases/report → directory browsing (larger, discovery-focused).

---

## B. Verification & Security

**Already shipped:** Rust crypto + 4S, cross-signing setup, key backup, **emoji-SAS self-verification**,
device management (list/rename/sign-out), encryption banner, recovery-key unlock.

| Feature                                           | Size | Value |
| ------------------------------------------------- | ---- | ----- |
| Cross-**user** verification (verify other people) | M    | High  |
| Per-message authenticity shields                  | M    | High  |
| Recovery/identity **reset** escape hatch          | M    | High  |
| Security settings section + key-backup management | L    | High  |
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
| Global Notifications settings screen (+ keywords)     | L    | High  |
| Ignore / block users + management list                | M    | High  |
| Change account password                               | S    | Med   |
| ✅ Set your own presence + status message             | S    | Med   |
| Deactivate account (with erase)                       | M    | Med   |
| Email & phone (3PID) management                       | L    | Med   |
| Toggle to stop sending read receipts                  | S    | Low   |

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

## Recommended entry point

The **safety + control quick wins** are done — Leave-a-room, Redact-others, Per-room mute, and one of the
two unblocking containers (the **Room settings panel**). Next, build the second container — the **Member
info panel** — then layer the member actions it launches (Ignore/block, Kick/ban, power-level editing) and
**cross-user verification** on top.
