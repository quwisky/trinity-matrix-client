# Notifications

Trinity decides whether something should notify you in one place — your Matrix account's
push rules, which every client and every device you sign in with shares — and then delivers
it in a way that depends entirely on the platform you are on. Those two halves fail
independently, which is why they are described separately here.

## What notifies you

Three layers stack, in this order.

### Account-wide rules

**Settings → Notifications** exposes nine predefined rules. They live on your account, so
changing one here changes it on every device and in every Matrix client you use.

| Toggle                                | What it governs                               |
| ------------------------------------- | --------------------------------------------- |
| Enable notifications for this account | The master switch. Off suppresses everything. |
| When I'm invited to a room            | Room invites.                                 |
| When someone mentions my name         | Direct mentions of you.                       |
| When someone posts @room              | Room-wide announcements.                      |
| Call invitations                      | Incoming call events from other clients.      |
| Messages in direct chats              | One-to-one conversations.                     |
| Messages in encrypted direct chats    | The encrypted equivalent.                     |
| Messages in rooms                     | Ordinary rooms.                               |
| Messages in encrypted rooms           | The encrypted equivalent.                     |

The encrypted and unencrypted variants are genuinely separate rules in the Matrix
specification, not a presentation choice — a server evaluates a different rule depending on
whether it can see the event type.

!!! note "Trinity has no call UI"

    "Call invitations" is a standard Matrix push rule that your account carries whatever
    client wrote it. Trinity does not implement voice or video calls, so the toggle only
    affects call invitations placed by your other clients.

The mention rule is worth one more sentence. Matrix moved from "does this message contain my
display name" to explicit, sender-declared mentions (MSC3952). Servers expose the old rule,
the new one, or — as current Synapse does — both. Trinity's single "mentions my name"
toggle writes whichever ones your server actually has, so you do not end up with half a
preference applied.

### Keywords

Below the toggles is a keyword list. A keyword notifies you whenever that **whole word** is
said in any room you are in: `call` does not match `oncall`. Each keyword has its own
**Sound** checkbox, so you can have a word that badges quietly and a word that makes noise.

Keywords are account-wide too. Two constraints exist to stop a keyword from doing something
you did not intend:

- `*` and `?` are **rejected**, not escaped. Matrix keyword patterns are globs, so a stray
  `*` would silently become "notify me about every message in every room" — stored on your
  account, applied on every device and in every client, with nothing in any UI to say where
  it came from.
- A keyword cannot start with `.` or contain `/`. A leading dot is how the specification
  marks a _server_-defined rule, so such a keyword would be created, would notify, and would
  then be invisible and unremovable in the list.

Trinity also hides your server's own built-in rules from this list — otherwise you would see
your own username presented as a keyword you could delete.

**A muted room stays muted.** Keywords do not override a mute; see below for why.

### Per-room mode

Open the `⋮` menu on a room in the sidebar and choose **Notifications**:

| Mode                            | Behaviour                                                         |
| ------------------------------- | ----------------------------------------------------------------- |
| All messages                    | The default. Your account-wide rules decide.                      |
| Mute except mentions & keywords | Ordinary messages stop notifying; mentions and keywords still do. |
| Mute everything                 | Nothing from this room notifies, mentions included.               |

The difference between the last two is not cosmetic. "Mute except mentions & keywords" is a
room-scoped rule, and the rules that fire on a mention or a keyword are evaluated _ahead_ of
it, so they still win. "Mute everything" is written as an override rule that is itself
evaluated before those, so nothing gets past it. That is the mechanism behind "a muted room
stays muted".

Some Matrix clients, including FluffyChat's quick room action, call the first of those modes
simply **Mute**. Trinity recognizes the same standard room rule, shows a crossed-out bell in
the room list, and names the remaining mention behaviour explicitly so it is not confused
with silencing everything.

Per-room modes are push rules as well, so they follow your account to your other devices.
Changes made in another client appear as soon as sync delivers them, without reopening the
menu or reloading Trinity. If one part of a multi-step server update fails, Trinity restores
the exact previous server rules, including their priority; a merged multi-account row is
restored on every account rather than left with conflicting settings. Rapid choices—even in
different rooms—are applied in order because the homeserver returns one shared ruleset per
account, and custom rules Trinity does not recognize are left untouched. If another device makes
a newer change while Trinity is restoring a failed update, that newer state wins and Trinity asks
you to reopen the menu rather than overwriting it. If the accounts behind a merged row already
disagree, the room shows **Different across accounts** until you choose one mode to apply
everywhere.

## How a notification reaches you

This is where the platforms diverge sharply.

| Platform              | Mechanism                                               | Reaches you with the window shut |
| --------------------- | ------------------------------------------------------- | -------------------------------- |
| Web and installed PWA | Browser Notification API, driven by the live connection | No                               |
| Desktop app           | The Electron main process posts the OS notification     | Yes, while it sits in the tray   |
| iOS and Android       | APNs or FCM push, routed via a push gateway             | Yes, if a gateway is configured  |

### Web and desktop

On web and on the desktop app there is no push subscription at all. Trinity holds a live
sync connection to your homeserver and raises a notification when an event arrives that your
push rules say should notify. Close the browser tab and notifications stop — there is
nothing running to receive them.

The desktop app is the exception: closing its window **hides it to the system tray** rather
than quitting, so the process, the sync connection and notifications all stay alive. Only an
explicit Quit stops them.

The browser asks for notification permission once, the first time the app connects. The
desktop app does not ask: notifications there are posted by Electron's main process rather
than by the page, because renderer-side web notifications are unreliably surfaced and
attributed by macOS.

A notification is **suppressed only when you are demonstrably already looking at it** — the
window is focused, that account is the one you are acting as, and that room is the one open.
A message to any other room, or to a background account, still notifies. Clicking one
focuses the window, switches to the owning account if needed, and opens the room.

For an encrypted room the event arrives as ciphertext, so notifying immediately would give
you a generic preview and would score your push rules against an encrypted payload — missing
your mentions. Trinity defers those events and re-evaluates them once they decrypt, with a
guard so each event notifies at most once.

Notifications collapse per account and room: a newer message from the same room replaces the
still-open toast, while the same room on a second signed-in account stays a separate toast.
The preview is truncated to 140 characters.

!!! warning "Unsigned macOS desktop builds cannot post notifications"

    Electron posts macOS notifications through `UNUserNotification`, which requires a stable
    code signature. An unsigned or ad-hoc-signed build fails silently with
    `UNErrorDomain error 1`. Trinity logs that failure so it is diagnosable rather than
    mysterious. See [desktop](../platforms/desktop.md).

### iOS and Android

Mobile is the only platform where a notification can reach you with the app closed, and it is
the only one that depends on infrastructure outside your homeserver.

The Matrix push path is: your homeserver → a **push gateway** → Apple's APNs or Google's FCM
→ your device. The gateway is a separate service, operated by whoever runs it. It is not part
of your homeserver, and Trinity's stock builds ship no default gateway — so unless a build
was configured with one, or you set one yourself, mobile push is off and the app only
notifies while it is open.

**Settings → Notifications → Push gateway** takes a gateway URL for this device. It applies
to this device only: the registration is keyed to this install's device token, so an iOS
gateway setting is meaningless to the Android install on the same account. Saving one
registers a pusher on **every account signed in on this device**.

Saving a gateway requires confirming a disclosure, because trusting one is the genuinely
dangerous step. The gateway's operator can see your Matrix ID, that every account on the
device belongs to one person, which room each message arrived in and exactly when, and your
device's notification token. They cannot read your messages: Trinity registers the pusher in
`event_id_only` format, so only a reference to each message is sent and the client fetches
the content itself.

The settings page reports how many accounts a pusher was accepted for. That is deliberately
worded as "the pushers were accepted, not that a notification has arrived" — the gateway to
APNs or FCM to device leg cannot be observed from the client at all.

For the operator side of this — deploying a gateway, FCM and APNs credentials, app ids —
see [push notifications](../reference/push-notifications.md).

## App icon badges

The unread total, summed across every signed-in account, is mirrored onto whatever app-icon
badge the platform offers: the dock or taskbar on the desktop app, the launcher badge on iOS
and Android, and the W3C Badging API on an installed PWA. A plain browser tab has no badge to
set, so nothing happens there.
