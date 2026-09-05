# Sign in to a Matrix account

Trinity has no separate Trinity account. You sign in to a Matrix homeserver, and that server
chooses the authentication method. Start with the homeserver your organisation, community or
contact gave you; `matrix.org` is prefilled as a common public example.

## 1. Find the homeserver

On the first screen, enter a homeserver domain. You can also paste a Matrix ID such as
`@you:example.org`; Trinity uses the domain portion. Select **Continue**.

Trinity asks Matrix discovery for the server address before it asks for credentials. The address
shown after discovery can differ from the name you entered. That is normal: a Matrix domain can
delegate its client API to another address.

If discovery fails, check the spelling with your server administrator and try again. Do not work
around an error by entering a password at a different address unless that administrator has told
you to use it.

## 2. Use the method your server offers

The next screen shows only the methods the resolved homeserver supports.

| What you see                                                       | What to do                                                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Username**, **Password**, and **Sign in**                        | Enter the Matrix username and password for that homeserver. A full Matrix ID is accepted where a username is requested.                                           |
| **Continue with SSO**                                              | Continue to the homeserver's sign-in page. Your organisation may use a company account, hardware key or another provider there.                                   |
| **Continue**                                                       | The homeserver delegates sign-in to an OpenID Connect provider. Continue in that provider's flow; it owns your credentials and may offer account creation itself. |
| **Create account**                                                 | The homeserver has explicitly allowed account creation. Follow the server's requested registration steps.                                                         |
| “This homeserver doesn't offer a sign-in method Trinity supports.” | The server offers no supported password, SSO or delegated sign-in route. Contact its administrator or use another homeserver.                                     |

For SSO and delegated sign-in, Trinity opens the provider through the host's authentication
handoff. Web returns to the app in the browser; the mobile and desktop hosts return through the
operating system after the provider flow completes. Return promptly and do not start a second
attempt while one is open: an abandoned or reused authorization state is rejected and you must
start again from the sign-in screen.

## Create an account only when the server allows it

**Create account** appears only after the server reports that registration is open. Trinity then
collects your username and password and presents any registration steps the homeserver requires,
such as terms, email confirmation, a registration token, or a hosted challenge. The homeserver,
not Trinity, decides whether registration exists and which proof it needs.

For delegated sign-in, account creation belongs to the identity provider. Trinity offers its
provider-hosted account-creation action only when that provider advertises one.

After a new legacy account is established, Trinity moves to encryption setup. Save the recovery
key before continuing; it is the route back to encrypted history on another device. Existing
accounts enter the workspace and show the appropriate encryption action when that device still
needs setup, recovery, or verification.

## Reach the workspace safely

After a successful sign-in, Trinity opens the room workspace. You can add another account later
without signing out of the current one. Before sending or expecting older encrypted messages on
a new device, follow the banner or visit Settings → Security:

- The encryption banner's **Set up** action starts encryption setup for an account without
  recovery.
- **Use recovery key** unlocks encrypted access on this device.
- **Verify another device** lets an already trusted session vouch for this one.

The next page explains what those actions prove and what they cannot recover:
[encryption and verification](encryption.md).

## When sign-in needs help

| Symptom                                                          | Useful next action                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The address after **Continue** is unexpected                     | Stop before entering credentials and confirm the homeserver with its administrator. Delegation can be normal, but an unexpected destination deserves confirmation.                                          |
| Your password form is absent                                     | Use the SSO or delegated button the server provides. Trinity does not add a password route when the server has not offered one.                                                                             |
| The provider flow returns to a refused or expired attempt        | Start again from Trinity and complete one attempt without leaving a second sign-in in progress.                                                                                                             |
| A server requires a registration step Trinity cannot complete    | Follow the hosted step shown by the server, or ask its administrator what registration route it supports.                                                                                                   |
| A previously working account asks you to sign in again           | Reauthenticate that account. When the server retains the device, Trinity reuses its local device identity; if the server removed the device, encrypted access may need recovery or verification again.      |
| Trinity opens but ordinary sign-in or sign-out cannot recover it | When the sign-in screen still opens, use **Erase all data on this device** only as a last resort and read its consequences below first.                                                                     |
| Trinity cannot reach the sign-in screen                          | Use the relevant [web](../platforms/web.md), [desktop](../platforms/desktop.md) or [mobile](../platforms/mobile.md) troubleshooting first. The local-data action is available only from the sign-in screen. |

## Starting over when Trinity will not work

**Erase all data on this device** removes Trinity's local accounts, encryption keys, settings,
drafts and cached messages, then restarts the app. It requires typing `ERASE`.

Be online before using this action. It also removes the Web/PWA offline cache; an offline web
app may not open again until connectivity returns.

Use it only when normal sign-in or sign-out cannot recover the installation. It does not delete
your Matrix account, rooms or messages from the homeserver. It can, however, make messages
permanently unreadable when their keys existed only on this device and no other device or server
backup can provide them. Signed-in devices can also remain listed on the homeserver when the
client cannot complete a network sign-out.

This is different from resetting a lost recovery key: that action concerns the encrypted backup
for an account and uses a separate `RESET` confirmation. Read [lost recovery key](encryption.md#lost-recovery-key)
before choosing either destructive action.
