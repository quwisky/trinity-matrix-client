# Trinity domain language

Trinity lets a person participate in Matrix communication from several saved identities and host applications. This glossary names the concepts that cross product-capability boundaries.

## Accounts

**Account**:
A saved Matrix login identified by its user, device, homeserver, and persisted credentials.
_Avoid_: Session, profile, login

**Account Runtime**:
The live presence of one Account while Trinity is running, including its connection, encryption state, and current projections.
_Avoid_: Client, session

**Active Account**:
The Account whose content is currently visible and receives foreground interaction. Other Accounts may remain connected without being active.
_Avoid_: Current session, selected client

**Authentication Attempt**:
A temporary sign-in flow that may produce permission to establish an Account but is not itself an Account.
_Avoid_: Account, session

## Communication

**Room**:
A Matrix room identity and its durable protocol state, independent of which Account is viewing it.
_Avoid_: Chat, channel

**Conversation**:
The messaging behaviour of one Room as experienced by one Account. A Conversation is identified by the pair of Account and Room.
_Avoid_: Room, chat session, timeline

**Conversation Runtime**:
The keyed lifecycle owner for immutable Conversation handles. Workspace focus and blur change visibility, while the runtime bounds warm retention and permanently retires evicted handles.
_Avoid_: Current room service, route state, timeline singleton

**Room Library**:
An Account's relationship to Rooms and Spaces, including membership, invitations, ordering, favourites, hierarchy, and unread summaries.
_Avoid_: Room store, sidebar

**Room Administration**:
Governance inside one Room, including members, roles, bans, aliases, power levels, and configuration.
_Avoid_: Room Library, moderation service

## Application

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
