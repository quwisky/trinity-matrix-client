# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
  online, amber away, grey offline), online members sorted to the top, offline
  members dimmed, and an "N of M online" count in the header. Each direct-message
  row in the sidebar also shows the other person's status on their avatar. All
  updating live. The presence dot is built into the shared avatar component.

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
