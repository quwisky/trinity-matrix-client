# Settings

Settings is a two-pane screen: a list of fourteen sections beside the section you have open.
Below 768 pixels wide the list is the page, and opening a section swaps to it with a back
button.

!!! warning "Preferences do not follow your account"

    Everything that is a *preference* — theme, palette, date and time format, timeline
    density, privacy toggles, keyboard shortcuts, GIF configuration, drafts, the experimental
    flags, the push gateway — is stored on the device that set it. Sign in on a second device
    and you start from the defaults there.

    This is not an oversight; it is where the data lives. These values go into the local
    key-value store (browser `localStorage` on web, the native equivalent on device), never
    into Matrix account data and never into secure storage, which is reserved for your access
    token. Some of them, like which gateway this device's push token is registered with, are
    physically meaningless on another device.

    The sections that *are* account-scoped, and therefore do follow you, are Profile,
    Presence, Devices, Account, Security, Notifications and Stickers & emoji.

## The fourteen sections

| Section            | What it holds                                                          |
| ------------------ | ---------------------------------------------------------------------- |
| Profile            | Avatar and display name.                                               |
| Presence           | Your own online state and status message.                              |
| Appearance         | Theme, palette, date and time format, room ordering, timeline density. |
| Devices            | Your signed-in sessions: rename, verify, sign out.                     |
| Account            | Change your password.                                                  |
| Security           | Encryption posture and room-key export or import.                      |
| Notifications      | Account-wide push rules, keywords, and this device's push gateway.     |
| Server             | What each account's homeserver is running, and where it is reached.    |
| Privacy            | Read receipts and link previews.                                       |
| GIFs               | Which GIF provider to use, and its API key.                            |
| Stickers & emoji   | Account-wide MSC2545 image-pack installation and removal.              |
| Keyboard shortcuts | Every shortcut, its binding, and rebinding.                            |
| Experimental       | Opt-in feature flags.                                                  |
| Advanced           | Every setting on this device as one document: copy, edit, import.      |

## Profile

Your avatar and display name, as everyone else sees them. Both are account-wide.

An avatar uploads as soon as you pick it, rather than on a Save button, and is rejected
above 8 MB on the client so the message names the real problem instead of relaying a server
error.

## Presence

Set yourself Online, Away or Offline, with an optional status message of up to 60
characters. Matrix has no "invisible" state, so Trinity does not offer one.

## Appearance

**Theme.** Light, Dark, or follow the system setting. The page states which one is currently
resolved, which matters when you have chosen "system".

**Palette.** The accent colour scheme, independent of light and dark. Two ship: Trinity
(blurple) and Amethyst (violet). Mode and palette are genuinely orthogonal — each palette
defines both a light and a dark set.

**Text size.** Small, Default, Large or Larger. It is a proportion of whatever your browser
or device is already set to, so if you have raised your default text size there, this adds to
it rather than replacing it. Message text and everything written around it scales; parts of
the app's chrome still keep a fixed size for now.

**Code size.** Smaller, Default or Larger, for code inside messages — both code written
inside a sentence and whole blocks. It is _relative_ to Text size, so the two work together
instead of one overriding the other: raising Text size still enlarges code, and this shifts
code up or down within that. Code shown elsewhere in the app, such as your recovery key, is
deliberately left alone.

Code blocks are already set slightly smaller than the text around them. That is not a
preference but a correction: a monospace face looks bigger than the surrounding font at the
same size, so without it a pasted listing dominates the conversation.

**Line numbers.** Off, Blocks over 5 lines (the default), or Always. "Always" has two
limits worth knowing, because they are the cases you are most likely to try it on: a block
longer than 500 lines is left unnumbered — the gutter would cost more than it is worth on a
listing nobody is counting by eye — and so is a block whose sender put formatting inside it,
where the lines cannot be identified reliably enough to number honestly. Numbering every snippet
would put a gutter beside two-line pastes, which is noise, so by default numbers appear only
once a block is long enough to be worth pointing at by line. The numbers are never part of
the message: selecting or copying a block gives you the code alone, and they never appear in
what you send.

**Time format.** Match system, 12-hour, or 24-hour.

**Date format.** Match system, Day first, Month first, or ISO. Every option is previewed
against the same fixed sample instant, so the options differ only by their format and not by
the moment you happened to open the page.

Both formats go through the browser's own `Intl` implementation rather than a bundled
locale table, which is what lets "Match system" honour any locale your device is actually
set to.

**Room order in spaces.** How rooms are listed inside a space: Recent activity (the default,
and what every other list uses), Space order (the arrangement the space itself defines), or
Alphabetical. This is saved per account on this device, and it is the _default_ — a space
you have ordered individually keeps its own choice. Favourites always form their own group,
so the ordering applies within each group.

**Timeline.** Three checkboxes control which system lines appear in a room:

- Joins and leaves, including invites, knocks, kicks and bans.
- Display name and avatar changes.
- Room changes — name, topic, avatar, address and access changes, plus the notices for room
  creation and encryption being switched on.

In busy or bridged rooms this churn can drown out the conversation. Hiding a category removes
those lines entirely; it does not change your unread counts, and the lock in the room header
still shows whether a room is encrypted.

**Composer.** Whether the formatting toolbar shows above the message box. Hiding it takes
away the buttons only — the keyboard shortcuts still work and Shift+Enter still continues a
list. See [messaging](messaging.md#the-formatting-toolbar).

## Devices

Every session signed in to your account, with badges for the current one and for sessions
that have been cross-signing verified. You can rename a session, sign one out — the
homeserver may demand your password to authorise that — and start a verification against
one. See [encryption and verification](encryption.md).

## Account

Change your password. The form requires the current password and a new one of at least eight
characters. All three fields are masked, so a single message covers every incomplete case
rather than naming which of three hidden boxes is short.

## Security

Reports this account's end-to-end encryption posture — whether encryption is set up, whether
this session is verified, whether key backup is on — and launches the flow that fixes each.
It also exports and imports room keys as a passphrase-encrypted file. Covered in full on
[encryption and verification](encryption.md).

## Notifications

Nine account-wide push-rule toggles, your keyword list, and the push gateway for this device.
See [notifications](notifications.md).

## Privacy

Three device-scoped toggles.

| Toggle                                | Default | Effect                                                       |
| ------------------------------------- | ------- | ------------------------------------------------------------ |
| Send read receipts                    | On      | Off still acks messages so your badges clear, but privately. |
| Show link previews                    | On      | Turns preview cards off entirely.                            |
| Show link previews in encrypted rooms | Off     | Only consulted when previews are on at all.                  |

The encrypted-room toggle is off by default for a specific reason: fetching a preview sends
the URL from an otherwise-encrypted message to your homeserver's preview service, disclosing
a link the server could not otherwise see. In an unencrypted room the server already has it.

Where the homeserver does not offer previews at all, the page says so rather than leaving you
to wonder why the toggle does nothing.

Note that ignoring or blocking a user is done from that person's member card in a room, not
from this page.

## GIFs

Pick KLIPY or GIPHY and paste that provider's API key. Until a key is saved, the composer
does not offer a GIF option at all — Trinity ships no shared key, so there would be nothing
to search with.

Trinity used to offer Tenor. Google shut the Tenor API down on 30 June 2026, so if you had
chosen it you will find KLIPY selected and the key box empty, with a note saying why: a Tenor
key cannot authenticate against a different service, and leaving it in place would have looked
like a working setup that failed every search. Paste a KLIPY key to switch GIF search back on.

The key is third-party configuration rather than a credential of yours, so it is stored
alongside the other preferences, on this device.

## Stickers & emoji

This section manages image packs for the **currently active Matrix account**. Installed pack
references are Matrix account data, so they follow that account to another device; they are
not a preference belonging only to this installation.

To install one:

1. Enter the source room's Matrix ID or alias.
2. Choose **Find packs**. Entering the address alone does nothing. If the account is not
   already a member, this action joins the room with normal, participant-visible Matrix
   membership.
3. Choose **Install** beside the intended pack. A room may publish several state keys. Trinity
   lists usable packs and empty packs; an empty pack is described but cannot be installed.

A successful room join is not undone when the room turns out to contain no usable pack.
Removing a pack later also does not leave the source room. It removes only the account
reference: it does not edit the published pack, remove room state, or delete homeserver media.

Installed rows remain visible when their source becomes inaccessible, is left, is deleted, or
contains missing or malformed pack state. That is intentional: a broken reference must still
have a **Remove** action. The status line distinguishes available, empty, unavailable, missing,
and malformed sources.

The **Stickers** and **Custom emoji** badges are capabilities declared by the publisher, not
switches stored by Trinity. MSC2545 has no per-user field for enabling one usage while disabling
the other. Trinity currently sends sticker-capable entries and displays custom emoji received in
messages; composing a new message with a pack's custom emoji is not yet supported.

Trinity writes only stable `m.image_pack.rooms` account data. It can read the older
`im.ponies.emote_rooms` form when stable data does not exist, and migrates valid legacy
references on the first change. If another device changes the same account data during a write,
Trinity retries a bounded server read, merge and verification. Matrix provides no atomic
compare-and-swap here, so a repeated conflict is shown and the action asks you to try again.

Install only from a room whose publishers you trust. Installing saves a reference, not a copy:
people with permission to change that room's pack state can change its names and images later.
Pack media is ordinary homeserver media rather than an encrypted attachment, so the relevant
homeservers can see it even when the sticker event itself is sent in an encrypted room. See
[Messaging](messaging.md#sending-more-than-text) for picker and sending behavior.

## Keyboard shortcuts

The full list of shortcuts, grouped into Navigation and Formatting. This section is the
discoverability surface as much as the configuration one: nothing else in the app enumerates
the bindings.

| Category   | Shortcut                                            |
| ---------- | --------------------------------------------------- |
| Navigation | Open the quick switcher                             |
| Navigation | Hop back and forward through recently visited rooms |
| Navigation | Move up and down the room list                      |
| Navigation | Jump to the next and previous unread room           |
| Navigation | Jump straight to one of your 9 most recent rooms    |
| Formatting | Bold, Italic, Strikethrough, Inline code, Link      |

Twelve of the thirteen are **rebindable**: click the row and press the combination you want,
or Esc to cancel. The combination has to include a modifier — Ctrl, Cmd or Alt. Reset
restores one row; "Reset all to defaults" appears once you have customised anything.

Rebinding onto a combination that another rebindable shortcut already holds **steals** it.
The previous holder is left explicitly unbound, and a message says which one lost it — first
match wins at dispatch time, so leaving two shortcuts on one chord would make one of them
quietly dead. A combination held by one of the fixed shortcuts is refused outright and
nothing changes.

The formatting chords only do anything while the message box has focus. Everywhere else they
fall through to the browser.

Two rows carry platform notes. The numbered room jump is **desktop app only** and is the one
shortcut that is fixed rather than rebindable, because a browser claims those chords for its
own tabs. The room-hop shortcuts list a Ctrl+Tab alias that likewise only works in the
desktop app.

!!! note "Why Link is not the usual chord"

    Ctrl or Cmd plus K is the conventional shortcut for inserting a link, but here it is the
    quick switcher, which is reached far more often. The other obvious candidate, adding
    Shift, is Firefox's Web Console on every platform and never reaches the page. Link
    therefore defaults to Ctrl or Cmd plus Shift plus U, which is what Slack uses for the same
    action. If you want the conventional chord, rebind it — the switcher will be left unbound
    and you can give it something else.

Custom bindings are stored on this device.

## Experimental

Opt-in flags. Currently one: the **virtualized timeline**, which renders only the messages
currently on screen instead of every message loaded.

It is **on by default**. The non-windowed list has no retention cap: filling the viewport
alone can pull several hundred rows, every scroll to the top adds another page for the rest
of the session, and each row is a heavy subtree of avatar, toolbar, reactions, receipts and
previews. Turning the flag off is supported and remembered; it is not the recommended
setting for long-lived rooms.

## Accounts

Signing in to more than one account at a time, and choosing which of them the room list draws
from, is not in Settings — it lives in the user panel at the bottom of the sidebar (and, on a
narrow layout, in a dedicated account dialog, because a flyout there would land on top of the
menu that opened it).

Two ideas are distinct there. The **active** account is the one every action runs as: sending,
creating rooms, sending receipts. The **mixed** set is which accounts contribute rooms to the
list, rail and space pills. The active account is always included and its row is locked —
hiding its rooms while still posting as it would be incoherent — and everything else is
opt-in.

Your mix is remembered on this device. An account you sign out of stops contributing but is
not forgotten, so signing it back in restores it to the mix. See
[signing in](signing-in.md).
