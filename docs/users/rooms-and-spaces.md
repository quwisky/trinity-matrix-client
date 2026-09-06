# Find, organize and govern rooms

A **room** is a Matrix conversation. A **space** groups rooms and can also contain subspaces.
The room list shows the account you are acting as. For the canonical explanation of active and
mixed accounts, see [using more than one account](index.md#using-more-than-one-account).

## Find or start a conversation

Use the sidebar's **+** menu to choose one of these paths:

| Task                          | What to do                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a direct message        | Choose **Start a direct message**, find the person by Matrix ID or directory name, then open the result. An existing direct message is reused.            |
| Create a private room         | Choose **Create a room**, give it a name and confirm. Trinity-created rooms are encrypted.                                                                |
| Browse public rooms or spaces | Choose **Explore public rooms**, select **Rooms** or **Spaces**, search if needed, then select **Join**. Use **Load more** for another result page.       |
| Open a room link              | Open the Matrix link and use the join or knock action it offers. A restricted room may require membership of an allowed space; a knock requires approval. |

A public listing or link only tells you how to request access. The homeserver decides whether a
join succeeds. See [sign in to a Matrix account](signing-in.md) if the account itself needs
attention.

## Accept invitations

Invitations appear at the top of the room list. Select accept to join, or decline to refuse.
The row changes after the homeserver confirms the new membership. Invitations belong to their
specific account; they are not merged when multiple accounts show the same room.

## Use the rail and room list

The rail contains:

| View                | It shows                                                 |
| ------------------- | -------------------------------------------------------- |
| **Recent activity** | Joined rooms and direct messages, ordered by activity.   |
| **Home**            | Direct messages.                                         |
| **Rooms**           | Joined non-direct rooms that are outside a space.        |
| A space pill        | That space's joined rooms and its discoverable children. |

Unread badges summarize each view or space and display 99+ above that count. A space's badge
counts its child rooms; a room may also appear in Recent activity. Use **Mark all as read** in a
list or space when it is offered, or a room's overflow menu to mark just that room read or
unread.

A space can expose rooms you have not joined under **More Channels**, and subspaces under
**Spaces**. Select **Join** for a room, or open/join a subspace. Not every published child is
visible: Trinity bounds very large or cyclic hierarchies rather than following them indefinitely.

## Organize your rooms

Open a room row's overflow menu to:

- add or remove **Favourite**. Favourites are a Matrix room tag, so the change can appear in
  other Matrix clients;
- choose a notification mode;
- remove a room from the current space when you have curation permission; or
- leave the room after confirmation.

Leaving a space leaves the space only. Its rooms remain on your account. Removing a room from a
space unlinks it from that space; it does not make you leave the room.

Choose the default order for rooms within spaces in Settings → Appearance → **Room order in
spaces**: recent activity, the space's own order, or alphabetical. A space can have its own
override, and favourites remain in a separate group. Use the Space header shortcut for a quick
change, or Space settings → **For you** for staged Save and Discard. **Use my default** removes the
override instead of copying today's default, so the Space follows later default changes. Every
choice is kept separately for that Account and Space on this device; it never rewrites the
Space's shared child order.

## Create and curate a space

Use the rail's **+** to create a space. In a space, use the header menu to create a channel,
add an existing joined room or space, invite people, leave the space, or organize its children.
Creating a channel adds an encrypted room to that space.

**Organise rooms** changes the space for its members. Use it to place child rooms and mark them
suggested. Creating a subspace has two server changes: Trinity creates it first and then links it
to the parent. If linking fails, the new space still exists; add it to the parent later through
**Add existing rooms**.

Some actions remain visible but disabled with an explanation. Read that explanation: you may
need permission or may need to switch to the Account that owns the selected Space. A later
server rejection can also mean permissions changed while the menu was open.

## Change Room and Space settings

Open **Room settings** from a room header or its overflow menu. On a wide screen, the Room
identity and section directory stay beside the current section in a centred dialog. On a phone,
Room settings is a full-screen master-detail flow: **Back** returns from a section to the section
directory. The header always names the Account that opened the Room so a similarly named Room on
another Account cannot be mistaken for the target.

The hub has these sections:

| Tab     | What it changes                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| General | Room avatar, name and topic.                                                                                                          |
| For you | Notification mode, Favourite and Low priority for the opening Account.                                                                |
| Access  | Who can join, who can read earlier history, and the room's local addresses. A restricted room must retain at least one allowed space. |
| Widgets | Third-party widgets declared for the room.                                                                                            |
| Bans    | The list of banned members, with unban actions where allowed.                                                                         |

**General**, **For you** and **Access** save independently. A partial failure keeps only the fields
that did not save as drafts, so retry sends only what remains. For you first confirms the opening
Account's current homeserver notification rule instead of showing a guessed default; it names
loading, unavailable and failed-read states explicitly. Its Favourite and Low priority values come
from that Account's synced Matrix Room tags. Avatar selection, address add/remove actions, widget
publication/removal and unbanning use their own immediate actions; discarding a draft does not undo
those completed actions. Leaving a section, closing Room settings, or using browser or device Back
asks before discarding a draft. A remote update refreshes untouched General and Access fields
without overwriting fields you are editing.

General details and Access policy remain bound to the Account and Room that opened Room settings
even if another Account becomes active. If that Account signs out, the target becomes unavailable
and pending results cannot write into the newly active Account. Local-address, Widgets and Bans
actions still use their established active-Account projections during the incremental hub
migration, so those panels explain that you must switch back to the opening Account instead of
risking a redirected write. Matrix permissions are checked live and per action, so a member may be
able to read a section or edit an avatar but not change the access rule, aliases, widgets or bans.
Losing a role while Room settings is open disables the affected controls without hiding readable
information or erasing drafts. Access and history choices affect other people and can expose
earlier messages or allow new members; confirm the Room's policy before saving. A restricted join
rule controls which Space members may join, not whether you yourself remain in the Room.

For you is also bound to the opening Account and remains editable by ordinary Room members because
notification rules and Room tags are personal rather than Room-governance state. In a combined
Room Library row, this settings section changes only that opening Account. The row's sidebar
shortcuts deliberately keep their broader behavior and change every Account represented by the
combined row. Read receipts and link previews remain installation-scoped Privacy settings; Room
settings does not create per-Room overrides for them.

Open **Space settings** from the Space header's overflow menu. Like Room settings, it keeps the
opening Account and Space visible and uses a directory beside the editor on a wide screen. On a
phone it opens full screen; **Back** returns from a section to the directory before Close leaves
the hub. General changes the Space avatar, name and topic; **For you** stages the opening Account's
device-local Room ordering; Access changes who can join; Addresses manages published Space links;
and Bans lists barred members. Each working destination stays reachable while the remaining
Space-specific sections are added.

General, For you and Access have independent Save and Discard actions. For you names loading,
failed-read, pending and failed-save states explicitly and protects a staged choice on section,
Back and Close navigation. Its four choices are Use my default, Recent activity, Space order and
Alphabetical. Successful General and Access fields stay saved when another field fails, and retry
sends only the remaining field. A live permission change disables the affected write without
erasing its readable value or local draft. Existing unfamiliar or restricted access rules remain
visible, but Space settings does not offer a new restricted rule until its full policy workflow
exists. Space settings never shows Room history, widgets, or Room notification inheritance: a
Space's access rule controls the Space itself, while child Rooms keep their own access and history
settings. Use **Organise rooms** for shared child ordering and suggested status; personal Space
order never calls that shared Matrix workflow.

**Leave space** confirms both the Space and acting Account. Cancelling makes no membership change;
confirming leaves only the Space itself. You remain joined to its Rooms, which continue to appear
where their own membership and organisation place them.

If Save is unavailable, the opening Account lacks every relevant permission, is no longer
available, or a required access choice is incomplete. The controls update when another
administrator changes the power level or Room state; a later server rejection still leaves the
affected draft available to retry.

In the Widgets tab, people with the required permission can choose **Add widget**, give it a name
and HTTPS URL, then publish it for the room. Existing widgets are third-party websites: inspect
the stated destination and disclosure before opening one in Trinity or a browser. **Remove widget**
changes the room's shared declaration, so it affects other participants as well.

## Members and moderation

Open **Members** in the room header to see participants. Select a person to message them, copy
their Matrix ID, ignore them, or begin verification. Moderation controls are offered only where
your role and the room's rules allow them:

- invite a person;
- assign an allowed Member, Moderator or Admin role;
- remove a person from the room; or
- ban and later unban a person.

A room owner cannot be reassigned through these role presets. The homeserver remains authoritative:
a permission change made while a menu is open can cause a later action to be refused. The same
membership rules apply to a space because a Matrix space is a room.

## Account scope in combined lists

The active account performs actions such as creating, joining and moderation. Rooms joined by
more than one displayed account share one row. Favourite tags, read-state changes and notification
modes from that row apply to every Account represented by it. A favourite can therefore change
another Account's synchronized room tags as well. Space
governance remains targeted to the active account. See
[using more than one account](index.md#using-more-than-one-account) before relying on a combined
view for administrative work.

Continue with [send and manage messages](messaging.md) for conversation actions, or
[notifications](notifications.md) for the room notification modes.
