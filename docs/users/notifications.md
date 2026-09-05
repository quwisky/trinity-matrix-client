# Control notifications

Matrix push rules decide **whether** an event should notify you. Trinity and the host decide
**how** to show it. A successful rule change does not prove that a browser, operating system or
push gateway can deliver the alert.

## Choose account rules

Open Settings → Notifications. The account rules apply to every Matrix client signed in to that
account. You can enable or disable notifications for the account, invitations, direct mentions,
room-wide mentions, direct chats, rooms, and their encrypted equivalents.

**Play a sound** is a Trinity setting for notifications shown by this client. It does not choose
the sound of a mobile operating-system push notification.

Trinity has no voice or video calling UI. The **Call invitations** rule remains available because
it is a standard Matrix account rule and can affect call events from another Matrix client.

## Add a keyword

In Settings → Notifications, add a keyword and optionally enable its sound. Keywords match whole
words, so a keyword such as “call” does not match “oncall”. They are account-scoped.

Trinity refuses wildcard characters and keywords that would conflict with server-managed Matrix
rules. If a keyword cannot be saved, change the word rather than repeatedly retrying the same
pattern.

## Set a room's mode

Open a room row's overflow menu and choose **Notifications**:

| Mode                                | Result                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| **All messages**                    | Account-wide rules decide.                                                   |
| **Mute except mentions & keywords** | Ordinary messages stay quiet; direct mentions and keywords can still notify. |
| **Mute everything**                 | Nothing from that room notifies, including mentions.                         |

Room modes are Matrix push rules and follow the account to other Matrix clients. In a combined
multi-account row, choosing a mode applies it to every account represented by that row. If those
accounts already differ, the row says **Different across accounts** until you choose a mode.

## Know how delivery works

| Host                     | Delivery                                               | When the app is closed                                                |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------- |
| Browser or installed PWA | Browser notifications over Trinity's live connection   | No; closing the tab ends the connection.                              |
| Desktop                  | The Electron host posts operating-system notifications | Yes while the app remains in the system tray; explicit Quit stops it. |
| iOS and Android          | APNs or FCM through a configured push gateway          | Yes when gateway registration and the operating system both allow it. |

The browser asks for permission after an authenticated account is available. If you denied it,
change the permission in the browser or operating system and reopen Trinity. A focused window
viewing the active room suppresses its own notification; other rooms and background accounts may
still notify.

Encrypted events are evaluated after Trinity decrypts them, so a mention is not reduced to an
unhelpful ciphertext notification. Notification previews and timing still depend on the host.

> [!WARNING]
> Unsigned or ad-hoc-signed macOS desktop builds cannot reliably post notifications. Use a signed
> build or follow the [desktop guide](../platforms/desktop.md).

## Configure mobile push carefully

On iOS or Android, open Settings → Notifications → **Push gateway** and enter the gateway URL
provided by your project or organisation. Use HTTPS unless the gateway is on a trusted local
network. Leave the App ID blank unless that provider gave you a different value, then select
**Save** and accept the disclosure.

The URL is stored on this device, but saving it registers a pusher for every Trinity account
signed in on that device. The gateway receives a device delivery token and event metadata; its
operator can learn which rooms receive activity, when it occurs, and correlate Accounts registered
through that device. Trinity requests event-reference delivery rather than message text. This is
ongoing metadata access, not just a registration disclosure; read the displayed trust explanation
before accepting a provider.

“Registered on N accounts” confirms that homeservers accepted the registrations. It cannot prove
that APNs or FCM delivered an alert. **Clear** removes this device's pushers before clearing the
local gateway override, so mobile push stops until a gateway is configured again. Gateway
deployment and credentials are maintained separately; see
[push-notification reference](../reference/push-notifications.md).

## Recover from a missing or failed notification

| Symptom                                        | What to check                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser permission was denied                  | Allow notifications for the Trinity site in the browser or operating-system settings, then reopen Trinity.                                                                                                                                                                             |
| Web or desktop notifications stop              | Keep the client connected. A closed browser tab cannot receive live-connection notifications; an explicitly quit desktop app cannot either.                                                                                                                                            |
| No alert appears while reading a room          | This is expected for the focused active room. Switch rooms or background the window only if you need an alert for later activity.                                                                                                                                                      |
| Changing a room mode fails                     | If Trinity says the previous setting was restored, retry. Otherwise reopen the room menu to inspect the server's current setting before retrying.                                                                                                                                      |
| Mobile gateway Save reports an error           | Follow the displayed error. Allow OS notifications if permission was denied; resolve a native token error with the device/platform guidance. Correct URL/App ID only when configuration is wrong. A homeserver registration failure may need a connection check or administrator help. |
| Mobile says it registered but no alert arrives | Registration is not delivery. Check device notification permissions, battery or background restrictions, the gateway operator and APNs or FCM.                                                                                                                                         |

Trinity's capability status keeps these failures separate. **Room notification settings are
unavailable** means the cached rule value may be stale while delivery continues independently.
**Device notifications are unavailable** concerns local host presentation. **Mobile push
registration is unavailable** concerns notifications while the app is closed. The displayed Retry
action targets only that function and keeps the current room and the rest of the session open.

## Use badges as a summary

Trinity mirrors the total unread count across its supported app-icon badges: desktop dock or
taskbar, Android and iOS launcher, and an installed PWA where the browser supports badges. A plain
browser tab has no app icon badge.

For unread markers and room-level recovery, see [rooms and spaces](rooms-and-spaces.md). For
browser, desktop and mobile host troubleshooting, see [platform guides](../platforms/index.md).
