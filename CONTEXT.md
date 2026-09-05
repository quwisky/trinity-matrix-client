# Trinity domain language

Trinity lets a person participate in Matrix communication from several saved identities and host applications. This glossary names the concepts that cross product-capability boundaries. For implementation ownership and lifetimes, use the [architecture guides](docs/architecture/index.md); for the reasons behind the boundaries, use the [decision history](docs/architecture/target-architecture.md#decisions).

## Accounts

**Account**:
A saved Matrix login identified by its user, device, homeserver, and persisted credentials.
_Avoid_: Session, profile, login

**Account Runtime**:
The live presence of one Account while Trinity is running, including its connection, encryption state, and current projections.
_Avoid_: Client, session

**Active Account**:
The foreground Account used for the focused Conversation. Room Library can also show other Accounts, and an action keeps the Account or Accounts it targets.
_Avoid_: Current session, selected client

**Authentication Attempt**:
A temporary sign-in flow that may produce permission to establish an Account but is not itself an Account.
_Avoid_: Account, session

## Communication

**Room**:
A Matrix room identity and its durable protocol state, independent of which Account is viewing it.
_Avoid_: Chat, channel

**Space**:
A Matrix Room that organizes Rooms and other Spaces into a navigable hierarchy. Membership in a Space does not itself grant membership in its children.
_Avoid_: Folder, workspace

**Conversation**:
The messaging behaviour of one Room as experienced by one Account. A Conversation is identified by the pair of Account and Room.
_Avoid_: Room, chat session, timeline

**Conversation Runtime**:
The live presence of one Conversation, identified by its Account and Room, while Trinity presents or retains it.
_Avoid_: Current room service, route state, timeline singleton

**Room Library**:
An Account's relationship to Rooms and Spaces, including membership, invitations, ordering, favourites, hierarchy, and unread summaries.
_Avoid_: Room store, sidebar

**Room Administration**:
Governance inside one Room, including members, roles, bans, aliases, power levels, and configuration.
_Avoid_: Room Library, moderation service

## Application

**Startup preparation**:
The bounded Application Runtime work that negotiates the Host contract, restores Accounts,
prepares the required Room Library, repairs Workspace to a safe destination, and acknowledges
final readiness before live application work opens.
_Avoid_: Session startup, loading screen

**Capability health**:
The current availability of one capability operation in an opaque Account or Conversation
context, independent from whether its preparation completed or its lifetime remains owned.
_Avoid_: Global health, error log

**Workspace**:
The semantic presentation state that says which Account, Space, Room, panes, and application surfaces a person is using.
_Avoid_: Router state, layout state, shell

**Trust**:
The capability that establishes and explains confidence in Accounts, devices, keys, recovery, and encrypted communication.
_Avoid_: Crypto, encryption settings

**Identity**:
The capability that describes Matrix users through stable summaries, profiles, avatars, and presence, independent of Room membership.
_Avoid_: Member, profile service

**Discovery**:
The capability that finds remote homeservers, public Rooms, and users not already represented in the local Room Library.
_Avoid_: Search
