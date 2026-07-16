# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Sign in with next-generation Matrix auth (OIDC).** On homeservers that delegate
  authentication to an OpenID provider (MSC3861 / Matrix Authentication Service — as
  matrix.org now does), the login screen offers a **Continue** button that signs you in
  through your provider using OAuth 2.0 + PKCE, plus a **Create account** button where the
  provider supports it. Sessions refresh silently in the background, so the short-lived
  tokens these providers issue don't sign you out, and the flow works on web, iOS, Android,
  and desktop (the provider opens in your system browser and returns to the app, even after
  a cold start). For these accounts, password and session management live at the provider —
  the account settings page links out to it instead of showing an in-app password form —
  and signing out revokes the session there.

### Changed

- **Desktop tray icon now matches the app icon.** The system tray / menu-bar icon uses the
  Trinity mark (three connected nodes) instead of the old "T" glyph, so it matches the app
  icon everywhere. On macOS it stays a monochrome template image that follows the light/dark
  menu bar.

### Fixed

- **Pinned messages keep updating after the app catches up on a room.** Pins added or
  removed by someone else — and gaining or losing permission to pin — could silently stop
  appearing in a room you had open, leaving the pinned panel frozen until you switched
  rooms and back. This happened once the app resynced a room's history, such as after a
  spell offline.

## [0.1.0] - 2026-07-13

### Added

- **Room activity in the timeline.** Membership and room changes now appear inline as compact
  system lines — who joined, left, was invited, removed, banned or unbanned; and when someone
  sets or changes the room name, topic, avatar, main address, join rules, history visibility,
  guest access, or turns on end-to-end encryption. No-op changes are omitted to keep it quiet.
- **Voice messages.** A microphone button in the composer records a voice message and sends
  it (MSC3245 `m.audio` with a waveform); recordings are encrypted in E2EE rooms like any
  other attachment. Received voice messages render as a compact player with a play control,
  the waveform, and a running time.
- **Browse public spaces.** The Explore directory now has a **Rooms / Spaces** toggle, so
  you can discover and join public Spaces (not just rooms) from your homeserver's directory;
  a joined space appears in the rail and is selected, a joined room opens in the Rooms view.
- **Share your location.** A location button in the composer sends your position as an
  `m.location` message, rendered as a card with the coordinates and an "Open in maps" link
  (no embedded map tiles, so the strict content-security policy stays intact). On the
  desktop app — where the browser can't read a device position without a bundled Google API
  key — you pick the point in a small dialog by pasting an OpenStreetMap/Google Maps link or
  typing `lat, lng`, with an optional one-tap approximate (IP-based) estimate.
- **Mark rooms as read.** A room's ⋮ menu now has **Mark as read** (when it has unread),
  and the channel-list header gains a **Mark all as read** action — both clear unread badges
  without opening the rooms.
- **See who read a message.** Clicking the read-receipt avatars on a message now expands
  a "Seen by …" list of who has read up to it (also available as a hover tooltip).
- **Message context actions.** A message's ⋯ menu now has **Copy link** (a `matrix.to`
  permalink to the message) and **View source** (the event's raw JSON, in a dialog).
- **Room-upgrade banner.** When a room has been upgraded to a new version, the old room
  now shows a banner with **Go to the new room** — which joins and opens the successor.
- **Slash commands.** The composer now understands IRC-style commands: **/me** (send an
  emote), **/shrug** (append ¯\\_(ツ)_/¯), **/plain** (send without markdown), and **/spoiler**
  (hide text behind a spoiler). Anything else starting with `/` is sent as-is.
- **Link previews.** Messages with a link now show an Open-Graph preview card (title,
  site, description, thumbnail), fetched through your homeserver. They're suppressed in
  encrypted rooms by default — so a link in an E2EE message is never disclosed to the
  server — but you can opt in per device via **Settings → Privacy → Show link previews in
  encrypted rooms** (with a clear warning), and turn previews off entirely from the same
  section. If your homeserver doesn't provide previews (Synapse ships them off), that same
  section now says so instead of leaving you guessing.
- **Verify another user.** A member's info panel now has a **Verify** action that starts
  emoji-SAS verification with them over a direct message — establishing cross-user trust
  (previously you could only verify your own other sessions).
- **Per-message authenticity shields.** Encrypted messages now show a shield when their
  authenticity is in question — sent from an unverified or unknown device, by an unverified
  user, or with a key whose origin can't be guaranteed — with a tooltip explaining why. The
  shields update live as device/user trust changes.
- **Export / import room keys.** The Security section can now save your message keys to a
  passphrase-protected file (the interoperable Matrix megolm `.txt` format that Element
  reads/writes) and import them back — a key backup independent of the server.
- **Security settings.** A new **Security** section in Settings surfaces your end-to-end
  encryption posture — whether encryption/secure backup is set up, whether this session is
  verified, and whether key backup is on — and launches the recovery-setup, recovery-key
  unlock, and device-verification flows to fix each.
- **Notification settings.** A new **Notifications** section in Settings has account-level
  toggles for what notifies you — a master switch plus per-category rules (mentions, @room,
  invitations, calls, direct chats, rooms, and their encrypted variants). They map to your
  homeserver's push rules and sync across every device on your account.
- **Explore public rooms.** The Home **+** menu now has **Explore public rooms** — a
  directory browser that searches your homeserver's public rooms, paginates with **Load
  more**, and lets you **Join** one straight from the results (it then opens in your list).
- **Manage a room's addresses.** The room settings dialog now has an **Addresses** section
  (for anyone whose power level lets them) to publish or remove local aliases
  (`#address:server`) in the homeserver directory and choose which one is the room's main
  (canonical) address.
- **View and lift room bans.** The room settings dialog now shows a **Banned members** list
  (with each ban's reason) for anyone whose power level lets them ban, each with an **Unban**
  action that lets the member be re-invited or rejoin.
- **Control who can join and read history.** The room settings dialog now has **Who can
  join** (invite-only or public) and **Who can read history** (from all history down to
  world-readable) controls, gated by your power level. They write `m.room.join_rules` and
  `m.room.history_visibility` and sync across clients.
- **Stop sending read receipts.** A new **Privacy** section in Settings has a **Send read
  receipts** toggle. Turn it off and reading a message still clears your own unread badge,
  but privately (`m.read.private`) — other people no longer see when you've read their
  messages. It's a per-device choice and applies to both the main timeline and threads.
- **Change your account password.** Settings now has an **Account** section to change your
  password: enter your current password, a new one (confirmed), and the change is applied
  server-side. Your other signed-in sessions stay logged in, and a wrong current password
  is reported clearly rather than as a raw error.
- **Report a message.** The message ⋯ menu now has **Report message** — flag a message to
  the room's server administrators, with an optional reason (`reportEvent`), from the main
  timeline or a thread.
- **Block (ignore) a member.** A member's info panel now has a **Block** / **Unblock**
  action that ignores them account-wide (`m.ignored_user_list`) — hiding their messages
  everywhere and syncing across your devices. It needs no room-admin rights, so it works
  even where you can't moderate.
- **Promote or demote members.** A member's info panel now lets you change their role —
  Member, Moderator, or Admin — for any role at or below your own power level (you can't
  raise someone above yourself, or act on a peer/superior). Written to the room's
  `m.room.power_levels`.
- **Kick and ban members.** From a member's info panel, a moderator or admin can now
  **Remove from room** (kick) or **Ban** them, with an optional reason. The actions show
  only when your power level out-ranks the member and meets the room's kick/ban
  requirement, so you can't act on someone at or above your own rank.
- **Member info panel.** Clicking a member in the member list now opens a panel showing
  their name, ID, live online status, and role (Admin / Moderator / Member), with
  **Message** (start or reuse a direct message) and **Copy user ID** actions — the launch
  surface for further per-member actions.
- **Edit a room's name, topic, and photo.** A new ⚙ button in the room header opens a
  **Room settings** dialog to change the room's name, topic, and avatar. Fields you don't
  have permission to change (by power level) are read-only. Changes save to `m.room.name`
  / `m.room.topic` / `m.room.avatar` and sync across clients.
- **Moderators can delete others' messages.** If your power level in a room meets its
  redaction requirement (a moderator or admin), the message ⋯ menu now offers **Delete
  message** on other people's messages too, not just your own — redacting them for
  everyone. Regular members still only see it on their own messages.
- **Leave a room.** Each room's ⋮ menu in the channel list now has a **Leave room**
  action: confirm, and you leave the room and it drops out of your list. Previously you
  could unlink a room from a space or decline an invite, but there was no way to exit a
  joined room. If the room you leave is the one open, the timeline pane clears.
- **App version and commit in Settings.** The Settings screen now shows the running
  build's version and git commit in a small footer (e.g. `Trinity v0.0.1 · a1b2c3d`),
  regenerated from `package.json` + git at build time — handy for bug reports.
- **Polls.** Create a poll from the composer (a question with two to eight answers),
  and it renders in the timeline with a share bar per option and a live vote tally.
  Tap an answer to vote (or change your vote); the poll's creator can end it, after
  which the results are final. Built on the Matrix poll events (MSC3381), so it
  interoperates with other clients.
- **Forward messages to another conversation.** The message overflow menu now has a
  **Forward** action: pick a room or direct message from the switcher and the message
  is re-sent there as a standalone message. Works for text and media (including in
  encrypted rooms, since an attachment carries its own key), from rooms and threads.
- **"Seen by" read receipts.** Messages now show small avatars of the members who have
  read up to them, updating live as people catch up — so you can tell who's seen what.
- **In-app navigation for Matrix links.** Clicking a `matrix.to` link in a message now
  stays in Trinity: a room link opens that room (resolving an alias and jumping to a
  linked message), and a person link (including a mention) opens a small profile card —
  avatar, name, online status, and a **Message** button to start a direct message.
  Ordinary web links open in a new tab instead of navigating away from the app.
- **Per-room notification level.** Each room's ⋮ menu in the channel list has a
  **Notifications** submenu to set how a room notifies you — **All messages**, **Mentions &
  keywords only**, or **Mute** — persisted as Matrix push rules so it follows you across
  devices. Muting suppresses even mentions; mentions-only keeps highlight pings while
  silencing everything else.
- **"New messages" divider and jump-to-unread.** Trinity now persists a fully-read
  marker (`m.fully_read`) alongside the read receipt, so returning to a busy room shows a
  "New messages" divider at exactly where you left off — and, when that divider is
  scrolled out of view, a "↑ New messages" pill that jumps you straight to it. The
  divider stays put for the visit even as new messages are marked read, and the marker
  now survives reloads and syncs across your devices.
- **Set your own presence and status.** A new **Settings → Presence** section lets you
  publish your online state — Online, Away, or Offline — and an optional status message,
  the counterpart to the presence dots already shown for other people. Homeservers that
  disable or rate-limit presence are handled gracefully.
- **Spoilers are now hidden until you reveal them.** Messages containing spoiler
  content (`data-mx-spoiler`) previously showed it in the clear; it now renders as a
  black bar that you click — or focus and press Enter/Space — to uncover. A first click
  that lands on a link inside a spoiler only reveals it rather than following the link.
- **React with any emoji.** The message reaction popover kept only six quick emoji;
  a new "+" button now opens the full emoji picker (search included), so you can react
  with anything — in rooms and threads alike. The six one-tap reactions stay as a fast path.
- **Typing indicators.** The composer now tells the room when you're typing, and an
  "X is typing…" row appears under the timeline when other members type — naming up to
  three of them and summarising beyond that. It clears the moment they send or stop, and
  Trinity stops advertising your own typing as soon as you send or leave the room.
- **@-mention people from the composer.** Type `@` and a name to pick a room member
  from an autocomplete menu; the sent message links them and, crucially, carries
  `m.mentions` so they're actually notified — including replies, which now ping the
  message's author. Works in rooms and threads, for new messages, replies, and edits.
- **Message drafts are kept per conversation.** A half-typed message now stays with
  its room (or thread) when you switch away and comes back when you return, and it
  survives a reload or app restart. Previously the composer was shared across rooms,
  so an unsent message bled into the next room you opened and was lost on reload.
- **Settings, reorganised into a browsable submenu.** The settings screen is now a
  menu of sections — **Profile**, **Appearance**, **Devices**, **GIFs**, and
  **Experimental** — each on its own page. On desktop the menu and the selected
  section sit side by side (two-pane); on mobile the menu is the entry point and
  tapping a section opens it, with a back button returning to the list. Deep links and
  reloads land on the exact section, and back leaves settings in one press rather than
  retracing the sections you visited. The profile picture is now changed from a camera
  badge tucked into the corner of the avatar rather than a separate button.
- **Multiple accounts, signed in at once.** Sign into several Matrix accounts and keep
  them all syncing concurrently. Switch the active account from the user panel in the
  channel sidebar (which lists each account with its own unread count and marks the
  active one), add another via **Add account**, and sign accounts out individually. The
  app-icon badge now sums unread across every account, and desktop/web notifications
  fire for background accounts too — tapping one switches to the owning account before
  opening the room. On mobile, each account registers its own push pusher tagged with
  its user id (full per-account push delivery also needs a push-gateway change — see
  `docs/PUSH.md`). Each account gets an isolated encryption (crypto) store, so accounts
  never share keys.
- **Graceful handling of a revoked session, with re-authentication.** If a homeserver
  signs one account out (its access token is revoked server-side), the other accounts
  keep running: a soft logout keeps that account's data, and it appears in the account
  switcher as "Signed out — Sign in" so you can re-authenticate it in place (reusing its
  existing device, so no re-verification), while a hard logout wipes it. Losing your last
  account returns you to the login screen instead of a broken shell.
- **Persistent local storage.** Trinity now asks the browser to keep its on-device
  data (each account's message-sync and encryption stores) persistent so it isn't
  evicted under storage pressure — which matters more as accounts add up, since an
  evicted encryption store would force that account to re-verify.
- **Send GIFs from the composer.** A new GIF button (beside the emoji picker) opens a
  searchable GIF grid — trending on open, live search as you type — and sends the chosen
  GIF as an image message in rooms and threads (encrypted rooms included). Search is
  powered by **Tenor** or **GIPHY**: pick a provider and paste a free API key in
  Settings → GIFs. The GIF button stays hidden until a key is configured.
- **Online status for members and direct messages.** The room member list now
  reflects each member's Matrix presence: a coloured dot on their avatar (green
  online, amber away, grey offline), with online members ordered first and offline
  members dimmed. Each direct-message row in the sidebar also shows the other
  person's status on their avatar. All updating live. The presence dot is built
  into the shared avatar component.
- **Role sections in the member list.** The room member list now groups members
  under **Admin**, **Moderator**, and **Member** headers (derived from each member's
  power level, the same 100/50 convention Element uses), each header showing that
  role's count. The panel leads straight into these sections. Empty roles are hidden,
  online-first ordering and the offline dimming are kept within every section, and a
  promotion or demotion re-sorts the list live.

### Changed

- **Restructured the Nx workspace into typed, per-domain libraries.** The monolithic
  `@trinity/core` lib was dissolved into `@trinity/util-matrix` (pure DI-free models/
  helpers), `@trinity/platform-native` (Capacitor/native capabilities), and per-domain
  `@trinity/data-access-*` libs over the shared `@trinity/data-access-matrix-client`
  foundation. The app shell moved to `@trinity/feature-shell`, leaving `apps/trinity` as
  bootstrap + routing only. `@nx/enforce-module-boundaries` now enforces a typed
  dependency ladder (`app → feature → {data-access, ui} → {util, platform}`, features
  never depend on features) plus a `scope:shared` / `scope:matrix` split so the kernel
  stays domain-agnostic. Consumers import the specific lib instead of `@trinity/core`.
- Migrated the unit test suite to `@testing-library/angular` (`render`) + `ng-mocks`
  (`MockProvider`/`MockComponent`).
- Slimmed oversized component input/output surfaces (channel-sidebar, message-row +
  message-toolbar, media-bubble, server-rail) — grouping related inputs into view-model
  objects, reading core signals directly, and collapsing the message-action outputs into
  one typed event.
- Moved all inline component templates into sibling `.html` `templateUrl` files.

### Fixed

- **Mention notification toggles now work on every homeserver.** The "When someone mentions
  my name" and "When someone posts @room" switches were bound to the legacy push-rule ids
  (`.m.rule.contains_display_name` / `.m.rule.roomnotif`); on homeservers that use the newer
  intentional-mention rules (`.m.rule.is_user_mention` / `.m.rule.is_room_mention`) the switch
  couldn't be turned on. Each toggle now reads and writes whichever of those rules the server
  actually defines (both, where a server ships both), so it always reflects and controls your
  real setting.
- **"Mark as read" now respects your read-receipt privacy.** Marking a room (or all rooms)
  read sent a public read receipt even when you'd turned read receipts off — leaking your
  read position to other members. It now acks privately when the setting is off, like the
  automatic on-view path.
- **Authenticity shields and link previews now show on grouped messages.** A shield (or an
  Open-Graph preview) only rendered on the first message of a Discord-style group, so a
  suspicious — or link-bearing — continuation message showed neither. Both now render on
  every message.
- **Polls and shared locations can no longer be "edited".** They offered a text-edit
  affordance that would have corrupted the poll/location; only text messages are editable.
- **Voice recording is more robust.** A recording is now cancelled when you switch rooms
  (so the mic doesn't stay open and a later send can't post to the wrong room), a double-tap
  can't open two microphone streams, and a torn-down composer no longer leaves the mic on.
- **Link previews recover from a hiccup.** A one-off homeserver error while fetching a
  preview was cached for the whole session, permanently hiding that link's card; a transient
  failure now retries on the next view.
- **Copied message links are resolvable.** A copied `matrix.to` permalink to a room-by-ID now
  includes a `?via=` server hint, so recipients not already in the room can open it.
- **Thread replies understand slash commands** (`/me`, `/shrug`, `/plain`, `/spoiler`), and
  the thread composer no longer shows poll/location/voice buttons that would have
  posted to the main room instead of the thread. `/me` now also carries @-mentions.
- **Searching the public directory no longer reloads the app.** The Explore directory's
  search form performed a native browser submit (it had no Angular form binding), which
  navigated away and closed the dialog instead of running the search. It now searches in
  place.
- **Links in messages are now clickable.** A bare URL in a message rendered as plain
  text — because a plain-text message (no HTML formatting) wasn't linkified. URLs are
  now turned into links when a message is displayed, so they're clickable regardless of
  whether the sender's client included formatted HTML, and they open in a new tab.
- New sessions now register with the device name **Trinity** instead of the stale
  **Trinity (Ionic)** — the app no longer runs on Ionic, so the label shown in
  Settings → Devices (and to other Matrix clients) shouldn't advertise it.
- Hardened the room and thread send paths (messages, attachments, edits, replies,
  reactions, redactions): each now resolves the active account and the open room at the
  moment the send runs, rather than when it is created. Nothing in the app could trigger
  the old behaviour today, but it closed a latent path for a send to land on an account
  you had just switched away from — or to upload unencrypted bytes into a room that had
  become encrypted in the meantime.
- Clearing your GIF API key no longer forgets which GIF provider you had chosen. Settings
  → GIFs stored the provider and the key together, so **Clear** discarded both and the next
  time you opened the app the provider had silently reverted to Tenor. GIPHY users now stay
  on GIPHY after clearing their key.
- Signing an account out and then logging back in failed with a crypto error ("the account
  in the store doesn't match the account in the constructor"), leaving that account unable to
  sign back in. Sign-out wiped the account's message cache but deleted the wrong encryption
  store, so its real one was left behind; because the store was keyed only by user, the next
  login (which gets a fresh device from the server) reopened that stale store and refused to
  start. Two fixes: sign-out now deletes the correct encryption store, and each login's
  encryption store is now scoped to its device, so a fresh login always starts clean instead
  of reopening an old device's store. This also recovers accounts that were already stuck.
  Re-logging in on a new device without signing out first now also cleans up the previous
  device's leftover encryption store instead of leaving it on disk, and on startup any
  encryption stores orphaned by earlier versions are swept away to reclaim disk space.
- OnPush re-render regression on the message timeline: per-row caps are now memoized so
  scrolling/typing no longer re-renders every visible row and its toolbar.

### Removed

- Leftover Ionic `--ion-*` CSS custom properties (dead since the UI moved to spartan-ng);
  the dark-mode class `.ion-palette-dark` was renamed to `.dark`.
