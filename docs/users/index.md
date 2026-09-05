# Use Trinity

Start here to get into Trinity, choose the right account and find the guide for your next task.
A **Room** is a Matrix conversation you can join; a **Space** groups Rooms and other Spaces.
The **Workspace** is the navigation and conversation area you use after signing in.

## Getting in

1. [Choose a host and install Trinity](install.md). Check the browser, desktop or mobile
   requirements and follow the available installation route.
2. [Sign in or create a Matrix account](signing-in.md). Your homeserver determines which
   sign-in and registration methods are available.
3. [Set up or restore encrypted access](encryption.md). Save your recovery key and verify
   new devices before relying on them for encrypted history.

## Choose your next task

| I want to…                                                         | Follow this guide                               |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| Find a public Room, accept an invitation or start a direct message | [Rooms and Spaces](rooms-and-spaces.md)         |
| Organize Spaces, favourites and unread Rooms                       | [Rooms and Spaces](rooms-and-spaces.md)         |
| Send text, attachments or reactions; reply, edit or use threads    | [Messaging](messaging.md)                       |
| Choose which messages notify me and diagnose missing notifications | [Notifications](notifications.md)               |
| Change my profile, appearance, privacy or keyboard shortcuts       | [Personal settings](settings.md)                |
| Verify a device, recover encrypted history or export message keys  | [Encryption, trust and recovery](encryption.md) |

## Find your way around

The navigation rail chooses a scope; the adjacent list shows its Rooms; opening a Room displays
its conversation. Narrow layouts show fewer panes at once, so use Back to return to the list
or navigation.

- **Recent activity** is the starting view and includes joined Rooms and direct messages,
  including Rooms inside Spaces.
- **Home** shows direct messages.
- **Rooms** shows non-direct-message Rooms outside Spaces.
- A **Space** shows its own Rooms and hierarchy. Joining a Space does not automatically join
  all of its Rooms.

Use the Room list's filter to narrow that list. The quick switcher opens with `Ctrl`/`Cmd` + `K`
by default; it can find joined conversations, Spaces, invitations and people. Room discovery
and message search are different tasks: [Rooms and Spaces](rooms-and-spaces.md) owns finding
places and people, while [Messaging](messaging.md) explains searching conversation history.

## Using more than one account

An **Account** is one signed-in Matrix identity. Trinity can keep several Accounts connected,
but one is active for the Workspace. Open your account menu near Settings to see the full
Matrix IDs; display names alone may be identical across different homeservers.

- Choose **Add account** to sign in to another identity while the existing accounts remain
  connected. Follow [signing in](signing-in.md).
- Choose an account row to make that Account active.
- Choose **Show accounts** to include other signed-in Accounts in the room list, rail and
  quick switcher. The active Account is always included. On a narrow layout this selection
  opens in a dialog; select **Done** to return.
- Clear the other selections to return to the active Account's content alone. The selection
  is saved on this installation; hiding an Account does not sign it out.

In a mixed view, account badges identify which Account owns an item. A Room joined by several
selected Accounts appears once, with the highest unread count among them. If the active Account
has joined that Room, it owns the combined row; otherwise the row identifies another participating
Account. Invitations remain separate for their receiving Accounts.

Opening another Account's Room switches to that Account before entering its conversation. Check
the acting identity before sending, inviting or changing Room settings. Mixed-row read and
notification actions, as well as favourites, can apply to every selected Account represented by
that row; the
[Room guide](rooms-and-spaces.md) and [notification guide](notifications.md) explain these actions.
Account settings apply to the selected identity, while device preferences such as appearance
have the scope described in [Personal settings](settings.md).

If an Account is shown as **Signed out**, select its **Sign in** action to reconnect it. The
account menu's **Sign out** action concerns the active Account on this installation; it does not
deactivate the Matrix account. Before signing out or clearing local data, check your
[encrypted-access recovery options](encryption.md).

## When an action is unavailable

Room and Space permissions belong to the homeserver and the Account performing the action.
A hidden or disabled editing or moderation action can mean you lack permission. Check the acting
Account and the explanation in [Rooms and Spaces](rooms-and-spaces.md) before retrying.

Media, camera, microphone and notification behavior also depends on the host and its permissions.
Follow the symptom guidance in the task guide, then the [web](../platforms/web.md),
[desktop](../platforms/desktop.md) or [mobile](../platforms/mobile.md) guide for that host.
Trinity's built-in messaging does not provide voice or video calls; a call-invitation notification
setting does not add calling controls.
