# Signing in

Trinity does not have a Trinity account. It signs you in to a Matrix homeserver, and that
homeserver decides how you prove who you are. The sign-in screen is therefore two steps:
first name the server, then use whichever method that server offers.

## Step one, finding the homeserver

The first field is labelled **Homeserver** and starts pre-filled with `matrix.org`. It
accepts three shapes and treats them identically:

- `@you:example.org`
- `you:example.org`
- `example.org`

Everything after the first colon is taken as the domain, so pasting your full Matrix user
id works.

Trinity then runs Matrix `.well-known` auto-discovery against that domain. Three outcomes
are possible:

- The domain publishes a client configuration. Trinity uses the `base_url` from it, which
  is frequently a different host from the one you typed. Typing `matrix.org` is normal and
  correct even though the API lives elsewhere.
- The domain publishes nothing. Trinity falls back to `https://<domain>`.
- The domain publishes something invalid or unreachable. Discovery fails and you get an
  error, rather than a silent fallback that would send your password to the wrong place.

Press **Continue** and Trinity asks the resolved server what it supports.

## Step two, the method the server offers

Trinity queries two things in parallel: the server's legacy login flows, and its delegated
authentication metadata. They are asked for independently on purpose. A homeserver built
around next-generation auth may not serve the legacy login-flows endpoint at all, and a
conventional homeserver has no auth metadata. A failure on either side must not hide what
the other found.

What appears next depends on the answer.

### Password

If the server advertises password login you get **Username** and **Password** fields and a
**Sign in** button.

The username field accepts either the localpart (`you`) or your full user id
(`@you:example.org`); Trinity strips it down to the localpart before sending. The new
session appears in your account's device list under the name `Trinity`.

### Single sign-on

If the server advertises SSO you get **Continue with SSO**. Trinity hands you to the
homeserver's own SSO page, where the identity provider takes over. What you see there —
a corporate login, a social provider, a hardware key — is entirely the server's business.

Where that page opens differs by platform, and it matters:

| Platform        | Where the provider page opens | How the answer comes back                                             |
| --------------- | ----------------------------- | --------------------------------------------------------------------- |
| Web             | The same tab                  | A redirect back to the app's own origin                               |
| iOS and Android | The system browser            | The `eu.qwky.trinity` URL scheme, handed to the running app by the OS |
| Desktop         | An external browser window    | The same URL scheme, routed into the app by the Electron shell        |

On mobile and desktop the sign-in genuinely happens outside the application. That is
deliberate: it means the provider's page runs in a real browser with its own cookies and
password manager, and Trinity never sees your credentials.

### Next-generation auth with OIDC

If the server delegates authentication to an OIDC provider, Trinity shows a single
**Continue** button and suppresses the password and SSO buttons entirely — even if the
server still advertises them. A homeserver part-way through migrating often keeps
advertising the old flows for compatibility, but the provider is now the authority on your
credentials, so offering the legacy paths would just be a way to fail.

Trinity registers itself with the provider the first time you sign in, using OAuth dynamic
client registration, and uses PKCE for the authorization code exchange. As with SSO, the
provider's page opens in the system browser on mobile and in an external window on desktop.

!!! warning "Finish within ten minutes"

    The state Trinity keeps while you are away at the provider is deliberately short-lived
    and single-use. If you leave the provider's page open longer than ten minutes, or start
    a second sign-in while one is in flight, the callback will be refused and you will need
    to start again from the sign-in screen.

### If none of the three are offered

If discovery finds no OIDC provider and no password or SSO flow, Trinity says so plainly
rather than leaving you on an empty card: "This homeserver doesn't offer a sign-in method
Trinity supports."

## Creating an account

Trinity cannot register a Matrix account. There is no registration form, no captcha
handling, and no registration-token flow anywhere in the client.

There is exactly one exception. When the homeserver delegates to an OIDC provider and that
provider advertises support for a registration prompt, Trinity shows a **Create account**
button next to **Continue**. Pressing it sends you to the provider's own sign-up page. The
account is created there, by the provider, under its rules; Trinity only receives the
result.

For every other homeserver, register through that server's own web page or another client
first, then sign in to Trinity with the account you have.

## What happens after you sign in

You land in the room list. Trinity does not force you through an encryption wizard, but if
this account or this device is not ready for encrypted messages, a banner appears above the
room list with the action that applies:

- **Set up** when the account has no recovery set up yet. This is the first-device path,
  and it ends by showing a recovery key exactly once.
- **Use recovery key** or **Verify another device** when the account already has encryption
  set up but this device is not yet trusted.

Both are explained in [Encryption and verification](encryption.md).

## Adding another account

Trinity keeps several accounts signed in at the same time rather than switching between
them. Adding one returns you to this same sign-in screen with the existing accounts left
running, so you go through homeserver discovery again for the new account. See
[Using more than one account](index.md#using-more-than-one-account).

## When a session is dropped

If your homeserver revokes your access token but keeps the device — a "soft logout" —
Trinity does not throw the account away. It stops that account's client, drops the dead
token, and marks the account as needing to sign in again. Your other accounts keep running.

Signing in again from that prompt reuses the same device id. That matters more than it
sounds: the device keeps its existing encryption store, its cross-signing trust and its
message keys, so you come back without re-verifying anything. A hard logout, where the
homeserver has deleted the device outright, does discard the local stores, because the
device they belong to no longer exists.
