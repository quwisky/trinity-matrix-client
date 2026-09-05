# Personalize Trinity

Open **Settings** from the user menu. On web and desktop it normally appears over the current
room; mobile uses a full-page flow. Settings contains account, preference, app and developer
sections. A setting can be tied to the Matrix account, to this Trinity installation, or to both
an account and this device, so check the scope before expecting it on another device.

## Choose the setting you need

| Section                                    | Main task                                              | Scope                                                                  |
| ------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Profile and Presence                       | Change the name, avatar or presence others see         | Account                                                                |
| Devices, Account and Security              | Manage sessions, password and encrypted access         | Account                                                                |
| Appearance                                 | Tune display, type, timeline and composer              | This device, except Room order in spaces is per account on this device |
| Privacy                                    | Choose receipt and preview behaviour                   | This device                                                            |
| Notifications                              | Edit account rules; configure the local push gateway   | Mixed; see [notifications](notifications.md)                           |
| Server                                     | Inspect the current homeserver connection              | Current account                                                        |
| GIFs, Stickers & emoji, Keyboard shortcuts | Configure message tools                                | Mostly this device; packs are account data                             |
| Experimental and Advanced                  | Opt in to a test setting or manage local configuration | This device                                                            |

## Change appearance and reading preferences

Settings → Appearance controls light, dark or system mode, theme, density, text size, code size,
date and time format, room ordering inside spaces, timeline system lines, the composer toolbar and
message gestures. The preview shows the current combination before you leave the page.

Use **Room order in spaces** to select recent activity, the space's own order or alphabetical as
the default. A space ordered individually keeps its own choice, and favourites remain grouped
first. This is saved per account on this device.

If Trinity reports that an Appearance preference could not be restored, use **Restore affected
defaults**. Other choices remain unchanged. If an individual change cannot save, use its
**Retry** action.

## Decide what you share

Settings → Privacy controls read receipts and link previews. Turning off receipts stops sharing
your read position with other participants; Trinity still sends private read markers so your own
unread state can clear. Link previews depend on homeserver support.

Previews in encrypted rooms are off by default. Enabling them sends each previewed link to your
homeserver's preview service. If the server cannot provide previews, Trinity says so instead of
showing an empty result.

## Manage your account and devices

- **Profile:** edit the display name and select **Save**. Choosing an avatar uploads and publishes
  it immediately; leaving without Save does not undo it. Avatar uploads are limited to 8 MB.
- **Presence:** choose Online, Away or Offline, optionally add a status message, then save.
- **Devices:** rename a session, sign it out, or verify it. Removing a session may require
  homeserver authentication.
- **Account:** change the Matrix password where the homeserver supports it.
- **Security:** set up, recover or verify encryption, and export or import room keys. Follow
  [encryption, trust and recovery](encryption.md) for the consequences and recovery limits.
- **Server:** review connection details for the active account. This does not change which
  homeserver the account uses.

Actions in these sections target the account selected in Trinity, not every account visible in a
combined room list. For account switching and combined-list exceptions, see
[using more than one account](index.md#using-more-than-one-account).

## Configure message tools

### GIFs

Open Settings → GIFs, select the provider available to you and save that provider's API key.
Trinity ships no shared search key. Until a valid key is saved, the GIF action does not appear in
the composer. The key is stored on this device.

### Stickers & emoji

Open Settings → Stickers & emoji to manage image packs for the active account:

1. Enter the source room's Matrix ID or alias.
2. Select **Find packs**. If you are not already a member, this joins the source room.
3. Select **Install** beside a usable pack, then choose the sticker or custom-emoji usages it
   supports.

Current-room packs are also usable within that room without installation. Trinity displays received
custom emoji but does not compose them; an emoji usage selection does not enable custom emoji
in the `:` suggestions. See [Messaging](messaging.md#sending-more-than-text) for that boundary.

Removing a pack removes the account's reference to it; it does not leave the source room, delete
the room state or delete media. A broken or unavailable source remains listed so you can remove
it. Other Matrix clients may not honour Trinity's per-usage choices.

Install only packs whose publishers you trust. Their images can change after installation and are
ordinary homeserver media. See [sending more than text](messaging.md#sending-more-than-text) for
using a pack in a conversation.

### Keyboard shortcuts

Open Settings → Keyboard shortcuts to browse bindings and rebind supported ones. Select a row,
press a combination with Ctrl, Cmd or Alt, then confirm it. A binding can replace another
rebindable binding; fixed browser or operating-system shortcuts are refused. Custom shortcuts are
stored on this device.

## Use experimental and advanced settings cautiously

The Experimental page contains opt-in features, including the virtualized timeline. Turn an
experiment off if it causes a problem; the change is remembered on this device.

Advanced lets you copy, export, import and edit local settings JSON. Review the proposed changes
before confirming an import. A settings export can include the GIF API key, and it does not move
Matrix account data, encrypted keys or push registrations.

**Reset** requires typing `DEFAULTS` and has no undo. Copy or export the document first if you
might need its values again. It resets the exported preferences, including the GIF provider/key
and push gateway. Clearing the gateway also removes this device's push registrations from the
homeservers: mobile push notifications stop until you configure a gateway again. You stay signed
in and keep unsent drafts. This does not delete your account or reset its encryption identity.

## When settings do not work

| Symptom                                                 | Action                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A change is missing on another device                   | Check its scope. Reconfigure device settings there; account data arrives after Matrix sync.             |
| A room order or notification differs in a combined list | Check the active account and the accounts represented by the row. See the multi-account guide.          |
| A browser or system permission blocks a feature         | Change the permission in the host, then reopen Trinity.                                                 |
| Encryption, sign-in or recovery needs attention         | Use [signing in](signing-in.md) or [encryption, trust and recovery](encryption.md), not Advanced reset. |
| A host-specific feature is absent                       | Read the relevant [platform guide](../platforms/index.md).                                              |
