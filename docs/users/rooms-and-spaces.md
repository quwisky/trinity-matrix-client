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

**Organise rooms** opens Space settings → **Rooms & spaces**. People with permission can move each
direct child up or down in the order shared by the Space and mark it **Suggested** for members.
Those changes save immediately; there is no section Save button, and Trinity waits for the synced
Space update before accepting another shared change. Creating a subspace has two server changes:
Trinity creates it first and then links it to the parent. If linking fails, the new space still
exists; add it to the parent later through **Add existing rooms**.

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

| Tab       | What it changes                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------- |
| General   | Room avatar, name and topic.                                                                             |
| For you   | Notification mode, Favourite and Low priority for the opening Account.                                   |
| Access    | Who can join and who can read earlier history. A restricted room must retain at least one allowed Space. |
| Members   | Current and banned members, search, member details, invitations, roles and moderation.                   |
| Addresses | Primary and local Matrix addresses for finding and joining the Room.                                     |
| Widgets   | Third-party widgets declared for the room.                                                               |

**General**, **For you** and **Access** save independently. A partial failure keeps only the fields
that did not save as drafts, so retry sends only what remains. For you first confirms the opening
Account's current homeserver notification rule instead of showing a guessed default; it names
loading, unavailable and failed-read states explicitly. Its Favourite and Low priority values come
from that Account's synced Matrix Room tags. Avatar selection, member administration, address
actions and widget publication/removal use their own immediate actions; discarding a draft does
not undo those completed actions. An unfinished widget name or URL is also a protected draft, and a
failed publication retains both values for correction or retry. In **Addresses**, the primary and
local addresses remain readable and copyable for every member. Administrators can add a local
address, make one primary, or remove one after confirming the exact address and its effect on
joining and links. Each action reports its own progress and result; a failed add retains the entered
value for correction or retry. Removing an address never deletes the Room or Space. Leaving a
section, closing Room settings, or using browser or device Back asks before discarding a draft. A
remote update refreshes untouched General and Access fields without overwriting fields you are
editing.

General details, Access policy, Members, Addresses and Widgets remain bound to the Account and Room
that opened Room settings even if another Account becomes active. Widget declarations and expanded
URL identity come from that Account, and Add or Remove resolves its client again when the action is
started. If that Account signs out, the target becomes unavailable instead of falling through to
the newly active Account. Matrix permissions are checked live and per action, so a member may be
able to read a section or edit an avatar but not change the access rule, aliases, widgets or
membership.
Losing a role while Room settings is open disables the affected controls without hiding readable
information or erasing drafts. Access and history choices affect other people and can expose
earlier messages or allow new members; confirm the Room's policy before saving. A restricted join
rule controls which Space members may join, not whether you yourself remain in the Room. Trinity
keeps unfamiliar server policy readable and preserves restricted allow-list entries it does not
understand when an administrator saves the Spaces it does understand.

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
device-local Room ordering; Access changes who can join; **Rooms & spaces** lists and curates the
Space's direct children; Members combines the searchable roster, member details, invitations,
roles, moderation and banned list; and Addresses manages published Space links. The Space Members
and Organise rooms shortcuts open this same destination rather than separate dialogs.

Every member who can inspect the Space may read **Rooms & spaces**, including each child's Matrix
identity, whether it is a Room or nested Space, and whether the opening Account has joined it.
People with live Space-curation permission can search the opening Account's joined Rooms and Spaces,
add an existing one, create an encrypted Room, create a nested Space, or remove a direct child after
an exact-name confirmation. Each row also offers Suggested and boundary-aware Move up and Move down
controls. These are immediate actions: there is no section-wide Save or Cancel. While a shared
change is saving, Trinity disables conflicting row actions until that Account receives the synced
Space state. A rejected change returns to the authoritative value and keeps a **Try again** action.
Each operation reports its own pending and completed result. Removing a child only replaces the
parent Space's child link; it never leaves or deletes the child. Creating also writes only that
parent-owned link. If creation succeeds but linking fails, Trinity keeps the new Room or Space,
shows its Matrix ID, and offers a link-only retry so recovery cannot create a duplicate.

The Space header's create, add and Organise rooms shortcuts continue through the same exact-Account
parent policy and destination. Shared order and Suggested state affect everyone in the Space, while
the **For you** choice only decides whether this Account uses Recent activity, Space order,
Alphabetical, or its default on this device. Neither workflow overwrites the other.

Space Addresses has the same exact-Account behavior and explicit actions as Room Addresses. Long
addresses wrap on phones, while copy and Matrix-link actions remain available when the opening
Account can read but cannot administer the Space.

General, For you and Access have independent Save and Discard actions. For you names loading,
failed-read, pending and failed-save states explicitly and protects a staged choice on section,
Back and Close navigation. Its four choices are Use my default, Recent activity, Space order and
Alphabetical. Successful General and Access fields stay saved when another field fails, and retry
sends only the remaining field. A live permission change disables the affected write without
erasing its readable value or local draft. Existing unfamiliar or restricted access rules remain
visible, but Space settings does not offer a new restricted rule until its full policy workflow
exists. Space settings never shows Room history, widgets, or Room notification inheritance: a
Space's access rule controls the Space itself, while child Rooms keep their own access and history
settings. Use **Rooms & spaces** directly, or its **Organise rooms** shortcut, for shared child
ordering and Suggested status; personal Space order never calls that shared Matrix workflow.

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
names the declaration and confirms that it changes the shared Room state for every member and
Matrix client. Add and Remove show their pending result explicitly; closing settings does not undo
a completed action. Long names, templates and disclosures wrap within the phone section rather than
hiding its controls. Space settings has no Widgets section.

## Members and moderation

Open **Members** in Room or Space settings to see the target's participants grouped by role and to
search by name or Matrix ID. Select a person to message them, copy their Matrix ID, or administer
their membership. Banned people are a second list inside the same section. Ordinary members can
still read the roster, member detail and bans; administration controls appear only where their
live role and the target's rules allow them. The Conversation member panel additionally offers
ignore and verification actions.

- invite a person;
- assign an allowed Member, Moderator or Admin role;
- remove a person from the room; or
- ban and later unban a person.

A Room owner cannot be reassigned through these role presets. Consequence confirmations name the
person, Room or Space, Account and effect. The homeserver remains authoritative: a permission
change made while a picker or confirmation is open can cause the later action to be refused while
the same target remains visible for retry. A Space invitation joins only that Space, never its
child Rooms. The same membership rules apply to a Space because a Matrix Space is a Room.

## Account scope in combined lists

The active Account performs combined-list actions such as creating and joining. Rooms joined by
more than one displayed Account share one row. Favourite tags, read-state changes and notification
modes from that row apply to every Account represented by it. A favourite can therefore change
another Account's synchronized Room tags as well. Room and Space settings instead stay bound to
the Account and target that opened them, including member administration. Space governance from
the sidebar remains targeted to the active Account. See
[using more than one account](index.md#using-more-than-one-account) before relying on a combined
view for administrative work.

Continue with [send and manage messages](messaging.md) for conversation actions, or
[notifications](notifications.md) for the room notification modes.
