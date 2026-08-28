# Rooms and spaces

Trinity organises conversations the way Discord does: a narrow rail of scopes down the
left edge, a room list beside it, and the open conversation filling the rest. Underneath
it is plain Matrix, so a Trinity space is a Matrix Space and a Trinity room is a Matrix
room.

## The rail and its four scopes

Top to bottom, the rail holds:

| Pill                | What it lists                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Recent activity** | Every joined room and direct message, including ones owned by a space, most recent first. This is what opens on launch. |
| **Home**            | Direct messages only.                                                                                                   |
| **Rooms**           | Rooms that are not direct messages and do not belong to any space.                                                      |
| One pill per space  | The rooms that space contains.                                                                                          |
| **+**               | Create a space.                                                                                                         |

Each pill carries an unread badge, exact up to 99 and then shown as `99+`.

The rail, room list and account dock follow the display density chosen under
**Settings → Appearance**. The message list and composer follow it too: Compact reduces unused
spacing across the whole conversation shell while keeping the same actions and never shrinking a
touch target. Space icons keep their squircle shape when selected; the indicator and background
carry the active state instead.

Replies, edit context, pending attachments and the message field now read as one composer. A
one-line Markdown preview occupies exactly the same field height as the text it replaces; expected
growth from multiple lines, attachment batches or the formatting bar leaves the newest message
pinned only when you were exactly at the bottom and leaves your reading position alone as soon as
you scroll away, even by one pixel. Edit mode includes a visible cancel action for touch devices;
voice recording moves keyboard focus to its Cancel control and returns it to the message field
when recording ends.

The rail is flat. A space nested inside another space gets its own top-level pill rather
than appearing as a second level of rail. Nested navigation inside the rail is not built.

## Starting a conversation

When you are not inside a space, the **+** in the sidebar header offers three choices.

**Create a room** asks for a name and creates a private, end-to-end encrypted room. Every
room and channel Trinity creates is encrypted from its first event; see
[encryption](encryption.md).

**Explore public rooms** opens the homeserver's directory. It has a Rooms and a Spaces
tab, a search box, and a Load more button for the next page. Joining a space selects it
in the rail. Joining a room switches to the Rooms view and opens it, so it is never
opened-but-invisible.

**Start a direct message** takes a user ID or a name from the homeserver's user
directory. If you already have a direct message with that person and have not left it,
Trinity reopens it rather than creating a second one.

## Invitations

Pending invitations sit at the top of the room list with a tick and a cross: accept
joins, decline leaves. There is no separate inbox. The result arrives back through the
normal sync, so the row disappears when the server confirms rather than when you press.

## Spaces

A space groups related rooms. Trinity offers everything from the space's overflow menu in
the sidebar header, though the destructive and structural entries appear only if your
power level in that space allows them.

| Action                    | Effect                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **Mark all as read**      | Acknowledges every unread room currently listed. Shown only when something is unread. |
| **Order rooms**           | Choose how this space's rooms are listed. See [ordering](#ordering-the-room-list).    |
| **Invite people**         | Invite someone to the space itself.                                                   |
| **Members**               | The space's member list, with the same moderation actions a room's has.               |
| **Add existing rooms**    | Link rooms you are already in, or another space, into this one.                       |
| **Organise rooms**        | Curate the space for everyone. See [curating](#curating-a-space-for-everyone).        |
| **Create a space inside** | Create a subspace nested under this one.                                              |
| **Space settings**        | Name, topic, avatar, join rule.                                                       |
| **Leave space**           | Leaves the space only. Its rooms stay on your account.                                |

Inside a space the sidebar header's **+** creates a new channel in it. Like every other
room Trinity creates, it is encrypted. Outside a space the header shows **Mark all as
read** directly instead of tucking it into a menu, whenever anything on the list is
unread.

Below your joined rooms, an open space also lists what it contains that you have not
joined yet: **More Channels** with a Join button on each, tagged **Suggested** where the
space has marked them so, and a **Spaces** group for subspaces with Open or Join. Trinity
reads at most 500 children of a space, so a very large or self-referencing hierarchy is
truncated rather than fetched forever.

!!! note "Creating a subspace is two steps, and the second can fail on its own"

    Trinity creates the space first and then links it into its parent, because the link
    needs an ID that does not exist until the space does. If the link fails you are left
    with a real, usable space that simply is not nested; add it to the parent from **Add
    existing rooms**.

## Curating a space for everyone

**Organise rooms** writes to the space itself, so it changes what every member sees. Two
things are editable per child: whether it is **suggested**, and where it sits in the
space's own order.

Moving a room is a single write. Matrix gives each child link its own order key, so
renumbering ten siblings to move one would post ten state events into the space. Trinity
instead mints a key that sorts between the two neighbours you dropped it between, and
only falls back to renumbering when no key fits.

The list is driven from what the server has confirmed rather than from optimistic local
edits, so a move you see on screen is a move that landed.

!!! warning "Order can differ between the sidebar and the curation dialog"

    The **Organise rooms** dialog and the sidebar's "Space order" mode sort order keys
    with different rules. Where a space's keys mix upper and lower case, the two lists
    can disagree about where a room sits. The curation dialog follows the Matrix
    specification; the sidebar does not.

## Ordering the room list

Rooms inside a space can be listed three ways.

| Mode                | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| **Recent activity** | Most recently active first, like every other list. Default. |
| **Space order**     | The order the space itself arranges its rooms in.           |
| **Alphabetical**    | By room name, A to Z.                                       |

You set a default for all spaces in Settings under Appearance, as "Room order in spaces",
and you can override it for one space from that space's **Order rooms** menu. Choosing
**Use my default** in the menu drops the override rather than freezing today's default,
so the space follows along if you change the default later.

This preference is stored per account on the device you set it on. It is not written to
your Matrix account, so it does not follow you to another device or another client.

Favourites are lifted into their own **Favourites** group at the top of the list before
any of these orderings applies, so an ordering only rearranges what is below that group.

## Per-room actions

Every room row has an overflow menu:

- **Favourite** or unfavourite. This writes the standard Matrix `m.favourite` tag, so
  favouriting in another client shows up here and the list re-partitions live.
- **Mark as read** or **Mark as unread**.
- **Notifications**: All messages, Mentions & keywords only, or Mute. See
  [notifications](notifications.md).
- **Remove from space**, when the row is a space child and you may curate the space.
- **Leave room**, behind a confirmation.

## Using several accounts at once

Trinity can sign in to more than one account and show them together. The **Show
accounts** picker chooses which signed-in accounts the room list, rail and spaces draw
from. The active account is always included and cannot be unticked: it is the account
every action runs as, so hiding its rooms while still posting as it would be incoherent.

Ticking a second account changes every list at once. Rooms, spaces, invitations and the
quick switcher all become cross-account, and each row is badged with the account it
belongs to.

Points worth knowing before you turn it on:

- A room both accounts have joined appears as **one** row, carrying whichever account's
  unread state is louder. Marking it read, muting it or favouriting it applies to both,
  because otherwise the merged badge could never be cleared.
- Opening another account's room switches the active account to it first. A chip beside
  the room name says which identity you are acting as, since on a narrow screen the
  sidebar that would otherwise tell you is off-screen.
- Space settings and space curation are hidden for a space belonging to another account.
  Those writes go through the active client, so they would be performed as the wrong
  account.
- An account that is signed out stops contributing to the lists but keeps its place in
  your selection, and returns to the mix if you sign back in.

## Room settings

**Room settings** is reachable from the room header and its overflow menu. Each field is
gated separately by your power level in that room; anything you cannot change renders
read-only rather than disappearing, and if you can change nothing the dialog says so.

**Name, topic and avatar.** The avatar uploads as soon as you pick it rather than on
Save, and is capped at 8 MB client-side so an oversized image is reported as an oversized
image rather than as a failed save.

**Join rule.** Always offered:

| Option          | Meaning                             |
| --------------- | ----------------------------------- |
| Invite only     | Members must be invited.            |
| Anyone can join | Anyone who finds the room can join. |

A third option, **Space members can join**, appears only when the room is in at least one
space _and_ the room's version supports the rule. Both conditions matter: restricting a
room with nothing allowed is a room nobody can join, and an older room accepts the rule
and enforces nothing. Ticking which spaces qualify is a separate list under the option,
and re-saving never silently drops a space that was already allowed.

**History visibility.** Who can read messages sent before they arrived:

| Option                           | Meaning                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| Members, all history             | Anyone who joins can read everything sent before they arrived. |
| Members, since they were invited | History from the moment they were invited.                     |
| Members, since they joined       | History from the moment they joined.                           |
| Anyone, even without joining     | The room's history is world-readable.                          |

**Addresses.** Viewers who may manage addresses can list, add and remove the room's local
`#alias:server` addresses in the homeserver directory, and pick which one is the main
one.

**Banned members.** Viewers who may ban see the room's ban list with an Unban action on
each entry.

Spaces get their own settings dialog with deliberately different wording. Its join-rule
choices are "Invite only" and "Anyone can find and join", because a public space is about
discoverability rather than a conversation being open. History visibility is absent: a
space has no timeline to show. Restricting a space to the members of another space is not
offered at all.

## Members and moderation

The member list groups joined members into role sections, highest first: Owner, Admin,
Moderator, Member. Within a section, members who are online sort above away and offline.
Owner means the room's creator, which is why it is a separate section rather than a
higher number: being the creator cannot be granted, transferred or revoked.

Selecting a member opens their profile panel, which offers:

- **Message**, opening or reusing a direct message with them.
- Copy their user ID.
- Ignore or unignore them.
- **Verify**, which starts cross-user emoji verification over a direct message. See
  [encryption](encryption.md).
- **Make Admin**, **Make Moderator** or **Make Member**, **Kick**, and **Ban from room**,
  where your own power level allows it.

Trinity only offers a moderation action when you strictly out-rank the target and meet
the room's own threshold for that action, and it only offers role presets at or below
your own level. Owner is never assignable. These checks decide what is shown; the
homeserver enforces the real rule, so an action can still be refused.

After a successful kick or ban, the profile panel returns to the member list with that
member removed immediately. Trinity keeps that local projection in place until the
homeserver's membership update arrives, so unrelated member updates cannot briefly bring
the removed row back.

The same profile panel and the same actions are used from a space's member list, because
a space is a room.

## Related pages

- [Messaging](messaging.md) for the timeline, composer, threads, media and search.
- [Encryption and verification](encryption.md) for keys, verification and shields.
- [Notifications](notifications.md) for per-room modes, account rules and keywords.
- [Settings](settings.md) for the appearance, privacy and shortcut preferences named
  above.
