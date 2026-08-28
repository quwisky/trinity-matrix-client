# Messaging

This page covers what happens inside a conversation: writing and sending, and everything
the timeline does with what arrives. Setting up an account is on
[signing in](signing-in.md); finding and joining conversations is on
[rooms and spaces](rooms-and-spaces.md).

One thing people expect from a chat app is genuinely absent, and is worth knowing up
front rather than hunting for: **voice and video calls are not supported.** There is no
call UI. You will still find a
"Call invitations" notification toggle, because that is one of the standard Matrix push
rules your account carries whatever client wrote it.

## Writing a message

Enter sends. Shift+Enter inserts a newline.

The message box takes **Markdown**, rendered before it is sent. A preview button on the
formatting toolbar swaps the input for the rendered result, so you can check a table or a
fenced code block before anyone else sees it.

### Code blocks

A fenced block is coloured when you tag it with a language, and Trinity ships grammars for
thirty-one:

`bash` (`sh`, `shell`, `zsh`) · `c` · `csharp` (`cs`) · `css` · `dart` · `diff` ·
`dockerfile` (`docker`) · `go` · `html` · `ini` · `java` · `javascript` (`js`) · `json` ·
`kotlin` (`kt`) · `lua` · `makefile` · `markdown` (`md`) · `perl` · `php` · `powershell`
(`ps1`) · `python` (`py`) · `ruby` (`rb`) · `rust` (`rs`) · `scala` · `shellsession` ·
`sql` · `swift` · `toml` · `typescript` (`ts`) · `xml` · `yaml` (`yml`)

An untagged block, or one tagged with a language not in that list, still renders exactly as
you wrote it — just without colour. The tag is shown in the corner of the block either way,
so a reader can tell what it was meant to be. C++ is deliberately not included: its grammar
alone is larger than the first thirteen put together, and every reader downloads it.

### The formatting toolbar

The toolbar above the message box carries Bold, Italic, Link and Inline code as buttons,
with Strikethrough, Code block, Quote, Bulleted list and Task list behind an overflow menu.
On a phone layout only Bold and Italic stay outside the overflow — the composer is
competing with the on-screen keyboard for width.

You can hide the toolbar entirely at **Settings → Appearance → Composer**. Hiding it only
removes the buttons: the keyboard shortcuts still work, and Shift+Enter still continues a
list or a quote onto the next line (an empty list item ends the list). The formatting
chords are listed and rebindable on the [settings page](settings.md).

### Slash commands

Four IRC-style commands are recognised at the start of a message:

| Command    | Effect                                                                |
| ---------- | --------------------------------------------------------------------- |
| `/me`      | Sends an emote. Any `@`-mentions in it still notify the people named. |
| `/shrug`   | Appends `¯\_(ツ)_/¯` to your text.                                    |
| `/spoiler` | Sends the text concealed behind a spoiler others click to reveal.     |
| `/plain`   | Sends the text verbatim, with no Markdown interpretation.             |

Anything else beginning with a slash is sent as an ordinary message.

### Emoji and mentions

Typing `:` followed by at least two characters opens a shortcode menu; typing `@` opens a
member menu. Both cap at eight suggestions, and both require a space or the start of the
line before the sigil. That is deliberate: without it, `http://` would open the emoji menu
and an email address would open the mention menu. `8:30` is inert for the same reason.

A completed mention inserts a `matrix.to` pill into the message **and** records the person
in the event's `m.mentions` list (MSC3952), which is what the recipient's server scores
their notification rules against.

An **edit** carries its mentions in the replacement content rather than at the top level,
so editing a message that already mentioned someone does not notify them a second time.

There is also a full emoji picker on the composer, and the same picker is what "react with
any emoji" opens on a message.

Custom emoji embedded by another MSC2545-capable client render inline. Trinity resolves
their `mxc://` media through the same authenticated-media path as attachments; remote,
`data:` and `blob:` image sources are rejected rather than loaded. The `:shortcode`
autocomplete currently searches Unicode emoji only, so choosing a custom emoji for a new
text message still needs another client.

### Drafts

What you type is kept per conversation and survives closing the app. A draft is keyed by
the room, or by the thread's root message for a thread composer, so the main timeline and a
thread in the same room hold separate drafts.

Drafts are stored on the device that typed them. They do not follow your account to another
device.

## Sending more than text

Attachments, GIFs, polls, location and voice all live behind the `+` button beside the
message box.

**Stickers.** Install MSC2545 packs under **Settings → Stickers & emoji**, or choose
**Manage** in the sticker picker. Manage carries the current room into Settings as a suggestion,
but does not search or join until you choose **Find packs**. The [Settings guide](settings.md#stickers--emoji)
covers joining, installation, removal, broken references and account scope in detail.

When either an account-installed pack or the current room publishes a sticker-capable pack,
**Sticker** appears in the `+` menu. Account packs are available in every room for that account;
current-room packs are available only in the room that publishes them and need not be installed.
The searchable picker removes duplicates when stable and legacy data name the same source.

Selecting an image sends a standalone `m.sticker` event. Pack media is ordinary homeserver
media, not an end-to-end encrypted attachment: the homeservers involved can see it even when the
room is encrypted. The sticker event that references the media is encrypted normally, and
Trinity warns about the distinction whenever you send a sticker in an encrypted room.

On iOS and Android, including the mobile website and an installed PWA, tapping the `+` opens
these insert actions in a bottom sheet sized for a thumb. Tap outside it, press Back or press
Escape with a keyboard to dismiss it and return focus to `+`. Desktop web and Electron show the
same ordered actions in an anchored menu instead.

**Files and images.** Attach a file, or paste an image straight into the message box. A
picked or pasted file is _staged_ rather than sent immediately, so you can type a caption
for it; the send goes out on the next Enter. Images get a client-side thumbnail, and an
upload in progress shows a progress bar. On iOS and Android the native gallery picker is
offered as well.

Received attachments are saved through the browser's download on web, and through the OS
share sheet on iOS and Android.

**Voice messages.** The `+` menu beside the message box starts a recording; the composer
turns into a recording bar with an elapsed timer, a cancel and a send. The clip goes out as
MSC3245 voice — an `m.audio` message carrying a duration and a 60-bucket waveform — so
voice-aware clients such as Element render it as a voice message rather than a file.
Recording needs the browser's `MediaRecorder`; where it is missing, the option is not
offered.

**Polls.** Two to eight answers, single choice, results visible to everyone as votes come
in. The poll also carries a plain-text fallback listing the question and the numbered
answers, so a client that cannot render polls still shows something meaningful.

**Location.** A shared location is an `m.location` message built from a `geo:` URI. It is
rendered **without a map**: the card links out to OpenStreetMap instead of loading tiles,
which is what keeps the app's network policy tight enough to forbid third-party requests
outright.

!!! note "Location on the desktop app"

    The Electron shell cannot resolve `navigator.geolocation` without an embedded Google
    API key, which Trinity does not ship. On desktop, location sharing opens a dialog where
    you paste a map link or type coordinates instead.

**GIFs.** The GIF option appears only once you have configured a provider and API key at
**Settings → GIFs**. Until then there is no key to search with, so it is hidden rather than
shown broken. See [settings](settings.md#gifs).

Stickers, polls, location and voice act on the room you have open, so the **thread composer
does not offer them** — there is no way to route them into a thread.

## Reading the timeline

Consecutive messages from the same person collapse into a group with one header, the way
Discord does it. A reply always shows its own header, because the quoted preview above it
breaks the visual run anyway.

Scrolling to the top loads another 30 events of history at a time.

### Day separators

A separator marks each new local calendar day, labelled "Today", "Yesterday", or the date.
The date's shape follows your **Settings → Appearance** choice.

The rollover is calendar arithmetic, not a fixed 24 hours — a room left open overnight
relabels itself at local midnight, and it does so correctly on the days when daylight
saving makes the local day 23 or 25 hours long. There is deliberately no "Tomorrow".
Messages whose timestamps fall outside a plausible range render no separator at all rather
than an absurd one; bridged archives backfilled at their original 1990s timestamps are the
reason the lower bound is set as early as it is.

### Unread messages

Marking a room read writes both a read receipt and a persistent read marker
(`m.fully_read`), so the boundary survives a restart and follows your account to other
devices.

That anchor drives two things: a **"New messages" divider** drawn above the first message
you have not seen, and a **jump-to-unread pill** that appears while the divider is
off-screen. A separate jump-to-latest button appears when you scroll away from the bottom.

The `⋮` menu on a room in the sidebar offers **Mark as read**, and **Mark as unread** to flag
a room to come back to (MSC2867, so the flag follows your account to other devices; a
flagged room with nothing new in it shows a dot rather than a count). The sidebar header has
a **Mark all as read**.

### Typing and read receipts

A "… is typing" line names up to three people and summarises beyond that, with three
pulsing dots after the name. The line keeps its place whether or not anyone is typing,
so the messages above it do not shift when someone starts or stops.

The same line appears above a thread's reply box, and typing there tells the room you are
typing. Matrix tracks typing per room rather than per thread, so the thread shows everyone
typing in the room — including people writing in the main timeline rather than the thread.

In the room list, a room where somebody is typing shows that in place of its last message,
in italics, until they stop.

Under a message you may see a small row of avatars — the people who have read up to it,
capped at five and excluding you. Your own receipts can be made invisible: **Settings →
Privacy → send read receipts**, when switched off, still acks messages so your own unread
badges clear, but sends them privately so nobody else sees where you are.

### Link previews

A preview card is fetched through your homeserver, and three separate conditions must all
hold for one to appear:

1. Link previews are on (**Settings → Privacy**, on by default).
2. For a message in an **encrypted** room, previews in encrypted rooms are also on
   (off by default — asking your server to preview a URL from an encrypted message hands it
   a link it could not otherwise see). Where the room's encryption state cannot be
   determined, Trinity treats it as encrypted.
3. The homeserver actually offers previews. Once a server answers that it does not, Trinity
   stops asking and the Privacy page says the toggle has no effect there.

### Trust shields

A small shield on a message reports the cryptographic provenance of that specific event.
See [encryption and verification](encryption.md).

## Replies, threads, edits and deletions

**Reply** quotes the message above your own; clicking the quote jumps to the original.

**Reply in thread** starts or continues a thread. The main timeline shows a "N replies"
indicator under the thread's root message; opening it slides in a panel that uses the same
message rows and the same composer, so a thread reads and writes exactly like the room.
Threads do not nest — inside a thread, "reply in thread" is not offered.

**Editing** your own message leaves an "(edited)" marker. Clicking that marker opens the
edit history: every revision, oldest first, with the changes highlighted and each revision
rendered the way the timeline would render it.

**Deleting** replaces the message with "(message deleted)". You can always delete your own;
deleting someone else's requires enough power in the room, and Trinity only offers it when
you have it.

## Reactions

Hovering a message reveals a toolbar with six one-tap reactions — 👍 ❤️ 😂 🎉 😮 😢 — plus a
button that opens the full emoji picker for anything else.

Reactions collect into pills under the message. A pill's tooltip names up to three reactors;
the trailing chip opens a dialog listing everyone who reacted, grouped by emoji. That list
is a snapshot taken when you open it, not a live tally — a list that re-ordered under your
finger while you were reading it would be worse than a slightly stale one.

## Pinned messages

Any message can be pinned by someone with permission to change the room's pinned events;
the pin appears in a side panel listing them in pin order. Unpinning rewrites the list.

A pinned message whose event is not loaded locally is skipped rather than fetched on the
spot; it appears in the panel once the timeline has loaded far enough back to include it.

## Per-message actions

The hover toolbar keeps React, Reply and Reply-in-thread inline. Everything else is behind
the `⋯` overflow:

| Action         | Notes                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| Pin or Unpin   | Only when you may change the room's pinned events.                                  |
| Copy text      | The message's plain-text body.                                                      |
| Copy link      | A `matrix.to` permalink to this message, with a routing hint for the room's server. |
| Forward        | Picks a destination through the quick switcher and re-sends the content there.      |
| View source    | The raw event JSON.                                                                 |
| Report message | Prompts for an optional reason and reports it to the room's server admins.          |
| Edit message   | Your own text messages only.                                                        |
| Delete message | Your own, or anyone's if you have the power level to redact.                        |

Two more actions live on the row rather than the toolbar: the "(edited)" marker opens the
edit history, and a failed send offers a retry.

!!! note "Forwarding is scoped to the account you are acting as"

    Opening a room belonging to a mixed-in second account switches to that account first.
    Forwarding does not — it sends through the account you are currently acting as, so the
    destination picker only lists that account's rooms. A room you are not a member of
    would be a 403 with no explanation.

Clicking a `matrix.to` link inside a message navigates inside the app. Any other link opens
in a new tab or window, so a navigation cannot discard your session.
