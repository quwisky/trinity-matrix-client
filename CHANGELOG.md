# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Mix the accounts you choose into one view.** With more than one account signed in, the
  account menu gains a **Show accounts** picker: tick whichever accounts you want to see
  together and every view mixes just those — Recent activity, your direct messages, the Rooms
  list, and the left rail's spaces. So you can blend work and personal while leaving a third
  account out of it. Each item is marked with a small badge showing its account's own profile
  picture, so you can tell apart the same person reached through two of your accounts, and the
  user panel shows the mixed accounts' avatars stacked so you always know what you're looking
  at. Opening a conversation from another account switches to it automatically, so everything
  you do there (sending, receipts, reactions) happens as the right account — including the
  room menu's Leave, Favourite, Mute and Mark-as-read, which act on the account that owns the
  room rather than whichever one you happen to be using. The account you're acting as is
  always shown, your picks are remembered between launches (and survive an account being
  temporarily signed out), and with one account signed in nothing changes. A room both of your
  accounts have joined is listed once, not twice.
- **Customise your keyboard shortcuts.** Settings now has a **Keyboard shortcuts** section
  listing every shortcut and its keys — so you can finally see what's available — and you can
  rebind any of them: click one, press the new combination, done. If the combination is
  already used elsewhere it's taken over (the old shortcut is left unset, with a note), and a
  chord your browser reserves is flagged as desktop-app only. A **Reset all to defaults**
  button (and a per-shortcut reset) puts things back. Your choices are saved on the device.
- **Keyboard shortcuts to hop between rooms.** Press **Ctrl/Cmd+'** to jump to the room you
  were just in, and again to keep stepping further back through the rooms you've visited —
  alt-tab style; **Shift** with it steps forward again. **Alt+↑/↓** walks up and down the
  room list, and **Alt+Shift+↑/↓** jumps to the previous/next room with unread messages. In
  the desktop app you also get **Ctrl/Cmd+1–9** to jump straight to one of your recent rooms
  and **Ctrl+Tab** to hop; those particular keys are reserved by browsers, so they're
  desktop-only.
- **A Recent activity view that answers "what happened?" in one place.** A new first entry
  in the left rail, above Home and Rooms, shows every conversation — direct messages and
  rooms together, including rooms inside your spaces — in one list, favourites at the top
  and the most recently active first. It's where the app opens now, so the latest activity
  is in front of you on launch; Home (direct messages) and Rooms are still a click away and
  scoped exactly as before.
- **See who reacted, not just how many.** Pointing at a reaction says who is behind it —
  "👍 reacted by You, Alice and 4 others" — and the small people button at the end of the
  reactions opens the full list, with a tab per emoji and everyone who picked it. Tapping
  a reaction still adds or removes your own, as before.
- **See what a message used to say.** An edited message has always been marked "(edited)",
  but the earlier wording was out of reach. That marker is now a button: click it (or tab to
  it and press Enter) to see every version of the message, oldest first, with the time each
  was sent. It works for anyone's messages, not just your own — the versions are kept by the
  homeserver and any Matrix client can read them, so this shows what is already there rather
  than anything new. Each version highlights what that edit changed — added words marked,
  replaced words struck through beside them — so you can see the change at a glance
  instead of comparing two paragraphs by eye; **Highlight changes** turns that off if you
  came to read an old version rather than compare. Formatting is kept either way. A message
  you deleted offers no history: its edits do survive on the server, but Trinity won't put
  them back in front of you. You can also **remove** any version of your own message from
  the list — that really deletes it from the server, and the message falls back to the
  version before it.
- **Set your own mobile push gateway.** Settings → Notifications now has a **Push gateway**
  section where you can point mobile notifications at a gateway you run or trust, instead
  of relying on one built into the app. Paste its URL — a bare address is completed for you
  and an obviously wrong one is caught before saving — and Trinity explains, before you
  commit, exactly what the gateway's operator can and cannot see. The setting is specific
  to the device you set it on. After saving, the screen tells you whether your homeserver
  accepted the registration (it can't promise a notification will actually arrive — only
  your gateway and Apple/Google can). Advanced users can also set a custom app ID. This
  applies on iOS and Android; on desktop and web, Trinity notifies you over its live
  connection instead.
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
- **Jump back to the latest message.** When you scroll up through a conversation, a button
  now appears at the bottom to jump straight back to the newest message, instead of having
  to scroll all the way down by hand.
- **Show or hide what you type in password fields.** The sign-in password field and all
  three change-password fields now have an eye toggle to reveal the characters, so you can
  catch a typo before submitting.
- **Retry a failed GIF search.** When the GIF picker can't reach its provider, a **Try
  again** button now re-runs the search instead of leaving you stuck on the error.
- **Pinning a message now confirms.** Pinning or unpinning from a message's menu shows a
  brief confirmation — and tells you if it didn't go through (for example when you no longer
  have permission) instead of failing silently.
- **The room header adapts to small screens.** On a phone, the room's Invite, Room settings
  and Pinned actions collapse into a single **⋮** overflow menu so the room name is no
  longer squeezed out — Search and Threads stay one tap away, and the pinned count still
  shows on the menu button. The desktop layout is unchanged.
- **Bigger touch targets.** On phones and tablets, buttons, reaction chips and list rows now
  meet the ~44px minimum tap size, so they're easier to hit accurately. Desktop (mouse)
  sizing is unchanged.
- **The room list is its own page on phones.** Instead of sliding the channel list over your
  conversation, phones now show the room list as a full screen; tapping a room opens the
  chat, and a back button returns to the list. The desktop two-column layout is unchanged.
- **Choose a colour palette.** Appearance settings now has a **Palette** picker alongside the
  light/dark control, with an **Amethyst** violet theme in addition to the default. The two
  are independent — any palette works in light or dark — and your choice is remembered.

- **Desktop installers are built for every platform on a version tag.** Pushing a `vX.X.X`
  tag now packages the desktop app on Linux (AppImage + deb), macOS (dmg + zip), and Windows
  (installer), and attaches all of them to a **draft** GitHub release for review before
  anything is published. The Linux `.deb` had never actually been buildable — the packaging
  metadata it requires was missing, so that target failed the build; it works now. Installers
  are unsigned until signing credentials are configured.

### Changed

- **Continuous integration moved to GitHub Actions, and now checks more.** Every pull
  request, and every push to `develop` or `master`, runs the existing gates (lint, stylelint, formatting, unit tests, production
  build) plus two things nothing checked before: the Electron desktop main process is
  unit-tested rather than only compiled, and the Playwright end-to-end journeys run against a
  disposable Matrix homeserver. The end-to-end job deliberately **fails** if that homeserver
  cannot start, because the alternative — the behaviour it had locally — is a green run that
  quietly tested almost nothing. This replaces the previous Crow CI pipeline.
- **The authenticity shield now sits at the edge of the message, and explains itself.** The
  warning icon on a message whose sender couldn't be fully authenticated used to trail the
  timestamp on one kind of row and the message text on another, so it moved around and read
  as part of the text. It now sits at the far right of the row, level with the message's
  first line, in the same place for every message. Pointing at it (or tabbing to it) now
  opens a tooltip that names what was found — say, that the message came from a device its
  owner hasn't verified — and, below that, explains what it means for you and who can clear
  it. Previously it relied on the browser's own tooltip, which said only the first half,
  never appeared on a touchscreen, and couldn't be reached from the keyboard.
- **Two serious warnings are no longer described in vague terms.** A message from someone
  whose verified identity has since changed, or one whose sender doesn't match the device
  that encrypted it, used to fall back to a generic "authenticity couldn't be verified".
  Each now says plainly what happened and what to do about it.
- **Device verification says when it's waiting on the other device.** After you answer
  "They match", verification isn't finished — the other device still has to answer too.
  The emoji screen used to sit there unchanged, as if the tap hadn't registered, inviting
  you to press it again. It now replaces the answer buttons with a spinner and "Waiting for
  the other device to confirm", while the emoji stay on screen so you can still read them
  off. Cancel remains available, and if sending your answer fails the buttons come back so
  you can try again.
- **Room for the message box.** Seven buttons used to crowd the message field, leaving
  almost nothing to type in on a narrow window and overflowing the row entirely on a small
  phone. Attach, GIF, poll, location and voice message now gather behind the **+** button as
  a single **Add to message** menu at every window size, leaving the field flanked by just
  **+**, emoji and send. On a phone the typing area goes from unusable to about ten times its
  old width, and the composer looks the same whatever the screen.
- **The send button is always there.** It used to appear only on touchscreens, on the
  assumption that Enter sends everywhere else. Enter isn't always unambiguous — a draft with
  line breaks, or typing through an input method editor — so the send button now sits beside
  the message box at every size, on every device. (While you are recording a voice message
  the recording bar's own send button takes over, so there is never a pair of them.)
- **Desktop tray icon now matches the app icon.** The system tray / menu-bar icon uses the
  Trinity mark (three connected nodes) instead of the old "T" glyph, so it matches the app
  icon everywhere. On macOS it stays a monochrome template image that follows the light/dark
  menu bar.
- **Upgraded the build toolchain to Angular 22, Nx 23.1, and TypeScript 6.** A maintenance
  upgrade with no change to how the app behaves; it keeps the project on supported framework
  versions and current security patches.
- **Adopted Angular's zoneless change detection.** Trinity no longer ships `zone.js` (~30 kB),
  so it loads a little leaner and drives UI updates straight from signals. Behaviour is
  unchanged.
- **Dark mode looks more cohesive.** Dialogs, menus and pop-ups were rendering near-black —
  darker than the app itself — so overlays stood out as a different, blacker surface. They
  now use the app's grey palette, matching the window behind them.
- **A more consistent, tidier UI.** Corner radii were consolidated into one scale (dropdown
  menus and reaction/badge chips in particular look more consistent), and muted secondary
  text — timestamps, captions, descriptions, empty states — now follows one size scale
  instead of a mix of five, so the same kind of text is the same size everywhere.
- **Reworked the design tokens so themes are easy to add.** All colours and radii now live in
  one place, split into a colour palette and an independent light/dark mode, so a new theme is
  a single self-contained block. No visible change to the default look. See docs/THEMING.md.

### Fixed

- **"Jump to…" and in-room search open ready to type.** Both dialogs put the cursor in
  their search field on open, instead of quietly parking it on the Cancel/Close button
  and swallowing whatever you typed until you clicked into the field. Open-and-type is
  the point of a quick switcher, so Ctrl/Cmd+K now works in one flow again.
- **Replies in a thread you start off your newest message no longer vanish.** Opening
  "Reply in thread" on a message that was still being sent rooted the thread on a
  placeholder id the homeserver never had: the thread opened normally, but every reply
  typed into it was silently dropped. Threading — and pinning, which had the same flaw and
  would have written that placeholder into the room's pinned list — now wait the moment it
  takes for the message to land, so both always act on the real message.
- **Voting in a poll right after you create it works.** Clicking an answer while the poll
  itself was still on its way to the server failed outright with "Could not cast your
  vote", because the vote pointed at a poll the server hadn't seen yet. Answers (and "End
  poll") are held for those few hundred milliseconds instead of failing.
- **"View source" is readable again.** The message-source window had no background of its
  own, so its JSON was drawn straight over the conversation behind it — two sets of text on
  top of each other. It now sits on a card like every other dialog.
- **Consecutive messages line up again.** When you sent several messages in a row, the
  first sat a few pixels to the left of the rest, so a group of your own messages looked
  subtly ragged instead of forming one clean column. The follow-on rows now start exactly
  where the first one does. (The gap varied with the time of day, which is why it looked
  inconsistent.)
- **Mobile push is registered for every account on the same server.** With two or more
  accounts signed in on one homeserver, registering each account's push cancelled the one
  before it, so only the most recently registered account kept a pusher the server could
  route notifications to. Each account now registers without disturbing the others. (Push
  still needs a configured gateway to deliver anything — see docs/PUSH.md.)
- **Warnings and alerts are readable in dark mode again.** Danger indicators were painted in
  a very dark maroon that all but disappeared against the dark chat background — the
  "not verified" encryption shield, the retry prompt on a message that failed to send, and
  kick/ban labels were effectively invisible, and unread mention badges were a near-black
  dot rather than a red one. Alert text and filled mention badges now use separate, measured
  reds, so both stay clearly legible in light and dark and on every palette.
- **Error messages are readable in dark mode again.** The same dark maroon was used for error
  text throughout the app — a failed sign-in, encryption setup and unlock errors, device
  verification failures, the room directory's search error, and the profile, presence and
  account settings warnings — leaving those messages nearly invisible against a dark
  background at the moment they mattered most. They now use the measured alert red. Colours
  were also re-checked against _hovered_ rows, not just resting ones, since a row you are
  pointing at is usually the one you are reading.
- **Destructive buttons and menu items are legible again.** "Delete", "Leave room", "Kick"
  and similar destructive controls — along with invalid form fields — drew their label in a
  maroon so dark it disappeared against the tinted background behind it, worst of all in dark
  mode. Their labels now use the measured alert red, while the button's own background tint
  is unchanged, so the controls look the same but can actually be read.
- **Components follow the colour palette consistently.** Several hand-authored components
  used fixed colours or undefined tokens: the link-preview and location cards rendered a
  near-invisible border and background in light mode, and the mention badge and various
  "danger" reds didn't change with light/dark or the palette. They now use themed tokens, so
  everything re-colours together. The jump-to-latest pill and accent banner also use the
  on-accent text colour, keeping their labels legible on light-accent palettes. Attachment
  cards follow the palette too — image placeholders, file cards and the "couldn't load"
  card were painted a fixed near-white and glared out of a dark timeline.
- **More readable icons and initials.** The server rail's Home/Rooms buttons, the voice-note
  play button and unread badges now use the on-accent text colour so their glyphs stay legible
  on light-accent palettes; and default avatars now pick a dark or light initial by measuring
  it against the circle behind it, so the green, red, pink and amber avatars are all readable
  (previously every initial was white, which only suited half of them). The Explore rooms/spaces toggle and
  the mention picker's search field also announce their state/label correctly to screen readers.
- **The member list is reachable on phones and tablets.** Below 1100px the room's member
  list was hidden with no way to open it. It now slides in as a drawer — from the **Members**
  button on tablets, or the room's **⋮** overflow menu on a phone — and closes by tapping
  outside it. The wide-screen layout, where it stays a side column, is unchanged.
- **Confirmation messages (toasts) appear again.** Actions that report success or failure
  with a small pop-up notification — changing your password, exporting/importing encryption
  keys, reporting a message, renaming a room, updating a room photo, unbanning a member, and
  more — silently showed nothing. The pop-ups now appear as intended.
- **Signing out no longer risks another account's encrypted history.** With more than one
  account signed in, signing out could delete a second account's saved session — and the
  encryption keys that went with it — if that account had been signed out by its server or
  had failed to start up. Its message history could then be permanently unreadable. Signing
  out now only clears everything when it really is the last account.
- **Switching accounts no longer shows the previous account's messages.** With a room open,
  switching accounts left that room on screen still showing the previous account's view of
  it, and reopening the room didn't help — only restarting the app did. The room now closes
  cleanly on a switch.
- **A verification request from another person now says so.** Requests from other users were
  labelled as coming from one of your own sessions, and never named who was asking — while
  the emoji comparison only protects you if you know who you're comparing with. Both screens
  now name the other user and distinguish them from your own devices.
- **Busy rooms are faster to open and scroll.** Loading older messages and opening an
  encrypted room re-processed the whole loaded timeline once per message; a burst of
  activity is now handled in a single pass.
- **A reopened poll updates again.** If a moderator removed a poll's closing event, the poll
  kept showing as closed with stale results until something else in the room changed.
- **Pinned messages keep updating after the app catches up on a room.** Pins added or
  removed by someone else — and gaining or losing permission to pin — could silently stop
  appearing in a room you had open, leaving the pinned panel frozen until you switched
  rooms and back. This happened once the app resynced a room's history, such as after a
  spell offline.
- **Message authenticity shields are readable without colour.** The caution and warning
  shields on encrypted messages used the same icon and differed only by colour; they now
  have distinct shapes, so colourblind users can tell a caution from a warning.
- **Screen readers now announce the offline and encryption banners.** The "You're offline"
  and encryption-setup banners are now read out when they appear, instead of being added to
  the page silently.

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
