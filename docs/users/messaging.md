# Send and manage messages

Use [rooms and spaces](rooms-and-spaces.md) to find or join a conversation. This guide covers
what you can do after a room is open. Trinity does not provide voice or video calling.

## Write and send

Type in the message box and select **Send message**. Press Enter to send; press Shift+Enter for a
new line. Your unsent text is kept as a draft for that room on this device.

Trinity sends Markdown. Select **Aa** beside the message box to open **Format message**.
Choose bold, italic, strikethrough, inline code, a link, a quote, a bulleted list, a task list,
or a code block. Select text first to format it, or place the cursor where you want to insert
Markdown. You can also write Markdown directly or use your formatting keyboard shortcuts.

Choose **Preview** from Format message to see the rendered draft. Open Aa again and choose
**Edit message** to return to the same editing position. Cancel closes the formatting menu
without changing your draft. On mobile, formatting opens in an action sheet.

At the start of a message, these commands have a special meaning:

| Type                      | Result                                                      |
| ------------------------- | ----------------------------------------------------------- |
| /me followed by text      | Send an action-style message.                               |
| /shrug followed by text   | Append a shrug.                                             |
| /spoiler followed by text | Hide the text behind a spoiler until the reader reveals it. |
| /plain followed by text   | Send the text without Markdown formatting.                  |

Other slash-prefixed text is sent normally.

### Mention and react

Type @ to choose a room member and : to choose an emoji. Select a suggestion rather than typing
only a display name when you want a real Matrix mention: that records the intended person for
their notification rules.

Use a message's reaction button to add one of the common emoji, or choose **More reactions** for
another emoji. Select an existing reaction to add or remove your own. Reactions are visible to
everyone in the room.

## Sending more than text

Use the insert button beside the message box to select one or more files. They are **staged**;
they do not upload until you add an optional caption and select **Send message**. One submitted
batch uploads and sends its files in order. You can remove a staged file before sending.

After a batch settles, successful files leave the strip while failed files remain marked **Not
sent**. Retry or remove each failed file individually. Only one media batch can upload from a
composer at a time; switch rooms only after checking that any staged files are either sent,
removed, or no longer needed.

The insert menu may also offer GIFs, stickers, polls, location sharing or a voice message. What is
available depends on the room, your host and configuration:

- GIF search requires an API key in [Settings → GIFs](settings.md#gifs).
- Stickers can come from packs published by the current room (**This room**) without installation,
  or account-installed packs available across conversations (**All rooms**). Manage installed
  packs in Settings → Stickers & emoji. Pack images are ordinary homeserver media and can change
  after installation; use publishers you trust.
- Received custom emoji can be displayed, but Trinity does not compose custom emoji. The `:`
  suggestions insert native emoji; enabling a pack's emoji usage does not add a composing control.
- Voice, location and polls appear only when the current host and room support them.

A message's media remains subject to the room's encryption and the recipient's ability to obtain
the necessary keys. For first-device setup, recovery and verification, use
[encryption, trust and recovery](encryption.md).

## Read a busy conversation

The room header provides message search, pinned messages, threads and members. Search finds text
this device can access; in encrypted rooms that is limited to history the device has already
decrypted. Open or scroll older history when you need it, but missing message keys cannot be
recreated by a search.

Unread markers divide earlier messages from new ones. Opening a room normally acknowledges what
you have read; use the room row's overflow menu to mark it unread when you need a reminder to
return. Settings → Privacy can stop sharing your read position with other participants while private
receipts still clear your own unread state.

Link previews depend on your homeserver and Settings → Privacy. Enabling previews for encrypted
rooms sends the link to the homeserver's preview service, so it is off by default.

## Reply, edit, forward or remove a message

Hover a message on desktop or long-press it on touch devices to open its actions. The available
actions depend on the event, the room and your permissions:

- **Reply** quotes context in the current conversation; **Reply in thread** opens a thread rooted
  at that message so you can start or continue its discussion.
- **Edit message** is available for your own editable messages. Editing a mention does not send a
  new notification. Select a message's **(edited)** label to inspect its edit history.
- **Copy text**, **Copy link**, **Forward** and **View source** do not change the original.
- **Report message** sends a report to the homeserver.
- **Pin message** or **Unpin message** is shown only to members with the room permission.
- **Delete message** is shown only when Matrix permissions allow redaction. Confirming it removes
  the message content from the normal timeline view, which may retain a deletion marker. It
  cannot guarantee deletion from recipients' local history, backups or homeserver records.

Threads with replies show a preview beneath their parent message: reply count, unread status,
latest reply author and text, and how recently it arrived. Select anywhere on the preview to
open the thread. On phones the reply text stays on one line and the entire preview is a tap
target; no hover action is needed. Long author names truncate according to the available
message width, consistently across short and long replies.
The connector continues back to the group's existing avatar even when other messages
appear between the avatar and the thread.
Inside the thread, ordinary messages do not repeat an automatic quoted reply. Explicitly
replying to a particular message still shows its quote, which you can select to jump to it.

Use **Cancel reply** or **Cancel edit** in the composer banner when you opened the wrong action.

## When something does not work

| Symptom                           | Action                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Send or upload remains failed     | Check the connection, then use the attachment retry or remove it and try again.                                           |
| A message is unreadable           | Complete recovery or verification first. If no device or backup has the key, the message remains unavailable.             |
| A menu action is missing          | The event type, room permissions or host may not support it. Ask a room administrator about moderation or pinning rights. |
| A GIF or sticker option is absent | Configure a GIF provider or install an eligible image pack in Settings.                                                   |
| Search misses encrypted history   | Open the history on a trusted device; server-side search cannot read encrypted ciphertext.                                |

For room membership, invitations and notification modes, continue with
[rooms and spaces](rooms-and-spaces.md) and [notifications](notifications.md).
