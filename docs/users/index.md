# Using Trinity

Trinity is shaped like Discord rather than like a mail client. A vertical rail on the left
holds navigation scopes and your Matrix Spaces, a sidebar lists the rooms in the selected
scope, and the rest of the window is one conversation. On a phone the same three surfaces
become a single pane you move between.

This section describes what the application does today. Everything listed here is in the
shipped code; the things that are not are listed at the bottom of this page.

## Getting in

- [Installing Trinity](install.md) covers each of the four platforms, what a packaged
  desktop build contains, and the current code-signing state.
- [Signing in](signing-in.md) covers homeserver discovery and the three sign-in paths a
  server may offer, the one thing Trinity deliberately does not do — create an account for
  you — and how to erase everything on the device when Trinity itself will not start.

## Talking

Sending a message goes through a composer that understands Markdown, with a live preview
toggle and a formatting toolbar. It also handles `:shortcode` emoji completion, `@mention`
completion that produces real Matrix mention pills, file attachments including
paste-to-attach, voice recording, polls, location sharing, GIF search, and per-conversation
drafts that survive a restart. Four slash commands are recognised: `/me`, `/shrug`,
`/plain` and `/spoiler`.

A message you have sent can be edited, deleted, pinned, forwarded, reported, quoted as a
reply, or opened as the root of a thread. Its raw JSON and its full edit history are both
viewable. Reactions have a six-emoji quick row and a full picker, and the reaction pills
open a list of who reacted.

Read the detail in [Messaging](messaging.md).

## Organising

Four scopes sit on the rail: **Recent activity** (every joined conversation by recency, and
the default on launch), **Home** (direct messages), **Rooms** (rooms that belong to no
space), then one pill per joined Space. The rail is flat: a subspace appears as its own
top-level pill rather than nesting.

Spaces can be created, nested, curated, browsed and left. Rooms carry name, topic, avatar,
join rule, history visibility, local addresses and a ban list, each field gated
independently by your power level in that room. Member moderation covers kick, ban, unban
and power-level changes.

Read the detail in [Rooms and spaces](rooms-and-spaces.md).

## Keeping messages private

Trinity sets up encryption for an account, unlocks it on a new device from a recovery key,
or lets you verify a new device against one you are already signed in on using the seven
emoji of the SAS protocol. Room keys can be exported to and imported from a
passphrase-encrypted file. Every message row can carry an authenticity shield, and a shield
probe that fails renders as a caution rather than as "verified".

Read the detail in [Encryption and verification](encryption.md).

## Being told about things

Notifications work at three independent levels: a per-room mode of all, mentions only, or
muted; nine account-level toggles covering invites, mentions, direct chats, encrypted
rooms and the rest; and a keyword list. Delivery differs by platform — the desktop shell
raises notifications from its own main process, the web build uses the browser Notification
API, and mobile uses push.

Read the detail in [Notifications](notifications.md), and
[Push notifications](../reference/push-notifications.md) for the gateway side.

## Searching

Two search surfaces exist. A quick switcher, opened with `Ctrl`/`Cmd` + `K`, ranks your
joined rooms, spaces, direct chats and pending invites locally and appends people from the
homeserver's user directory. In-room search scans the messages already loaded and decrypted
in the timeline, and tells you how many it scanned.

Full-history search on the server is offered only for unencrypted rooms. This is a property
of Matrix, not a gap in Trinity: the homeserver stores ciphertext for an encrypted room and
cannot search it.

## Using more than one account

Trinity runs several accounts at once rather than switching between isolated sessions. Once
you opt more than one account into "mixed" mode, the room list, the space rail, the invite
list and the quick switcher all show every selected account's content, with each row badged
by its owner. A room both accounts have joined appears once, and its badge shows the louder
of the two unread states.

Writes always run as the account you are currently acting as, so opening another account's
room switches to that account first.

## Settings

Thirteen sections: profile, presence, appearance, devices, account, security, notifications,
privacy, GIFs, keyboard shortcuts, an experimental flag, the server your account is on, and
an advanced view of everything Trinity keeps on this device. Appearance carries a
light/dark/system choice, a colour palette picker, time and date formats, and toggles for
the system lines in the timeline. Thirteen keyboard shortcuts are defined and every one is
rebindable.

Read the detail in [Settings](settings.md).

## Not yet supported

These are absent from the code, not merely unpolished. Knowing where the edge is saves you
looking for a button that is not there.

| Not available                       | Note                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Voice and video calls               | No call code exists. The notification settings do expose a "Call invitations" toggle, because that is an account-level Matrix push rule, but Trinity never places or answers a call. |
| Stickers and custom emoji packs     | MSC2545 is not implemented.                                                                                                                                                          |
| QR-code device verification         | Device verification is emoji-SAS only.                                                                                                                                               |
| Deactivating an account             | And no management of email addresses or phone numbers on an account.                                                                                                                 |
| Forgetting a room after leaving     | Leaving works; the follow-up "forget" call is not wired.                                                                                                                             |
| Approving or denying a knock        | The `knock` join rule can be set, and a knock renders as a system line, but there is no approval surface.                                                                            |
| Upgrading a room to a newer version | An upgraded room's tombstone is followed to its successor; nothing in Trinity creates one.                                                                                           |
| Two verifications at once           | A verification request arriving while another is live is ignored.                                                                                                                    |
| Creating an account                 | Except through an OIDC provider's own registration flow. See [Signing in](signing-in.md).                                                                                            |
