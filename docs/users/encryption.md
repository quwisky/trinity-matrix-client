# Encryption and verification

Every room and every direct message Trinity creates is end-to-end encrypted from its
first event. There is no switch to turn it on, and no way to create an unencrypted room
from the app. A lock icon next to the room name in the header marks an encrypted room.

End-to-end encryption means your homeserver stores ciphertext it cannot read. Only the
devices holding the right keys can. That is the point, and it is also the source of
every awkward moment in this page: a device that never received a key cannot read the
message, and neither can the server help it.

## What encryption changes for you

Three things behave differently in an encrypted room, and all three follow from the
server not being able to read anything.

| Behaviour             | In an encrypted room                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Message search        | Only the history this device has already loaded and decrypted is searched. The results panel tells you how many messages it scanned.  |
| Link previews         | Off by default. Turning them on in Settings sends the URL to your homeserver's preview service, so it is a separate, explicit opt-in. |
| Attachment thumbnails | Trinity encrypts and uploads its own thumbnail alongside the file, because the server cannot resize something it cannot decrypt.      |

Whole-history search inside an encrypted room is not something a homeserver can offer.
For unencrypted rooms Trinity does use server-side search, so the search panel behaves
differently depending on which room you are in. See [messaging](messaging.md).

## Your recovery key

When you set up encryption, Trinity generates a **recovery key**: a random string that
looks like `EsTx xxxx xxxx …`. It is not a passphrase you choose, and there is no
"forgot my passphrase" path, because there is no passphrase.

The recovery key unlocks your **secure backup** on the server. Secure backup holds two
things: your account's cross-signing identity, which is what lets one of your devices
vouch for another, and the key that opens your **message key backup**, the encrypted
store of room keys your devices upload as they go. A new device that can open secure
backup gets both, which is why one key is enough to bring a fresh device fully online.

The key is shown exactly once, behind a checkbox reading "I've saved my recovery key
somewhere safe". Copy it, or on web and desktop use Download. On iOS and Android there is
no Download button, because a native WebView has no reliable file download; copy it into
a password manager instead.

!!! warning "The key is shown once and is never recoverable"

    Trinity does not keep a copy and neither does your homeserver — a server that could
    hand you the key could also read your messages. If you lose it and have no other
    verified device, the only way forward is the [reset](#if-you-have-lost-your-recovery-key),
    which permanently destroys the server-side backup of your message keys.

Leaving the setup screen while the key is on display asks you to confirm first. The
back button would otherwise tear down the page silently, leaving you with an account
that reports itself as secured and a recovery key nobody has.

## Setting up encryption on your first device

Trinity does not force this during sign-in. Until you set it up, a banner sits above the
timeline offering **Set up**, and Settings shows **Set up recovery** under Security.

Setup does three things in one pass: it generates your recovery key, it creates your
cross-signing identity, and it turns on message key backup. Your homeserver will ask for
your account password partway through, because publishing a new signing identity is a
change it wants re-authenticated.

Pressing **Set up** on an account that already has recovery configured elsewhere does
nothing destructive. Trinity asks the server directly whether a recovery key exists
before it generates one, rather than trusting what this device happens to have synced.
Without that check, a second setup would mint a fresh key, orphan the valid one, and
delete every existing key backup version.

## Bringing a later device online

A device that has just signed in can decrypt nothing yet. The banner offers two ways
to fix that, and either one is sufficient.

**Use recovery key.** Enter the key you saved. Spaces do not matter. The device verifies
the key against the stored record, imports your cross-signing identity, and switches on
message key backup. A wrong key is rejected with "That recovery key is incorrect."
before anything changes.

**Verify another device.** Show or scan a QR code with a session that is already
verified, or compare emoji when QR is unavailable. No key typing, but you need the
other session in front of you.

Both routes are also in Settings under Security: **Enter recovery key** and **Verify
with another device**.

!!! note "History comes back gradually, not all at once"

    Unlocking a device does not download your whole message backup. Trinity switches key
    backup on and lets each message fetch its key when you scroll to it. A bulk restore
    of a long-lived account can take hours and would block the app for all of it, so old
    rooms fill in as you open them rather than in one wait.

## Verifying a session with emoji

Verification proves that two sessions are really the same person's, or really the two
people they claim to be. Trinity implements the emoji Short Authentication String: both
sides are shown the same seven emoji, each with its name underneath, and each side
answers **They match** or **They don't match**.

After you answer, Trinity waits for the other side. "Waiting for the other device to
confirm the emoji match…" is the normal state, not a stall.

Answering **They don't match** aborts the verification as a security failure. Do that if
the lists differ at all, in order or in content.

### Verifying your own sessions

Start from Settings under Devices with **Verify another session**, from Settings under
Security with **Verify with another device**, or from the room banner. Your other
session gets a request to accept. When both sessions support it, Trinity offers QR
verification: show the code on one device and scan it with the other. Keep the code
private and do not screenshot or screen-share it. Emoji comparison remains available as
a fallback when there is no camera or the other session does not support QR.

Incoming requests are handled anywhere in the app: a modal opens over whatever you are
looking at, so you do not need to be on a particular screen when your other device asks.

### Verifying another person

Open a member's profile from the member list and choose **Verify**. Trinity opens or
reuses a direct message with them and sends the request through it. The screen names the
user you are verifying, in both the accept step and the emoji step, because that name is
the entire security control: anyone who can message you can send a verification request,
and comparing emoji with the wrong person proves nothing.

Compare the emoji over a channel you already trust — in person, or on a call where you
recognise the voice. Comparing them inside the same Matrix chat you are trying to secure
is circular.

!!! warning "A limit worth knowing"

    Trinity handles one verification at a time. A second incoming request that arrives
    while one is in progress is ignored, so ask the other side to retry once the first
    finishes.

## What a message shield is telling you

A small shield icon at the trailing edge of a message means Trinity could not fully
attribute that message. Hovering or focusing it shows the finding and an explanation.

A shield never means the message was intercepted or read by anyone else. It means the
chain from "this account" to "this ciphertext" has a gap in it.

| What the shield says                                    | What it means                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Sent by a user you haven't verified                     | You have not verified this person, so their identity cannot be confirmed. Verify them.                                |
| Sent from a device its owner hasn't verified            | Their own account has not vouched for that device. Only they can fix it, from another of their sessions.              |
| Sent from an unknown or deleted device                  | There is no record of the device at all, so there is nothing to check against.                                        |
| The authenticity of this message can't be guaranteed    | The key that decrypted it did not come straight from the sender, a key backup for example.                            |
| Sent by a user whose verified identity has changed      | You verified this person before and their identity has since changed. Check with them another way, then verify again. |
| The sender doesn't match the device that encrypted this | The claimed sender is not the account that set up the encryption. Do not take the name at face value.                 |

Shields fail closed. If the authenticity check itself errors, Trinity shows a caution
shield rather than no shield, because no shield looks exactly like a fully verified
message.

## If you have lost your recovery key

Before using the reset, check whether you have any other signed-in session that is still
verified. If you do, verify this one from it and you lose nothing. The reset is only for
someone with no key and no verified device left.

The escape hatch is **I've lost my recovery key**, at the bottom of the recovery-key
screen and also in Settings under Security. It asks you to type the word `RESET`.
Cancelling and mistyping both count as no.

What a reset does, in the order Trinity states it:

- **Your message backup on the server is deleted.** Messages your devices cannot already
  read stay unreadable, forever. This is the irreversible part.
- **Your other devices lose their verified status and must be verified again.** They stay
  signed in. You are not logging anything out.
- **You get a new recovery key.** It is shown once, behind the same save-confirmation
  checkbox as first-time setup. Save it.

Nothing is touched until your homeserver has accepted your password. Trinity completes
the password challenge against a request that does nothing before it starts the
destructive work, so cancelling the password prompt, typing the wrong password, or being
on an account that cannot answer a password challenge all stop the reset with zero
changes made.

!!! danger "The reset cannot be undone once it has run"

    There is no way to recover messages whose keys were only in the deleted server
    backup. If you want a second copy of your message keys that survives a reset, export
    them to a file first, as described below.

### If your account signs in through an identity provider

Accounts that authenticate at an external provider rather than with a Matrix password
cannot answer the password challenge inside Trinity. The reset has to happen at the
provider. Trinity says so, and where the provider advertises a reset action it also
offers **Open my identity provider** as a link you can press. It is rendered as a link
rather than opening a window automatically because by then the browser no longer treats
the action as coming from your click and would block the popup.

### If the reset stops partway

If the homeserver stops responding while the last step is running, Trinity tells you the
reset may have completed only partly and asks you to check Settings under Security
before starting another one. Take that literally: check whether recovery is set up, then
decide.

## Exporting your keys to a file

Settings under Security has **Export room keys** and **Import room keys**. The export is
a passphrase-protected text file in the standard Matrix format, so Element and other
clients read and write the same thing. It is a backup of your message keys that does not
depend on your homeserver.

The file holds message keys only, not your account's cross-signing identity. Importing
it lets a device read the history those keys cover, but the device still needs verifying
before other people's clients will trust what it sends.

## Where encryption shows up in the app

| Surface                   | What it offers                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banner above the timeline | **Set up** when encryption is not configured; **Use recovery key** and **Verify another device** when this device is not yet trusted. Nothing when everything is in order. |
| Settings, Security        | Encryption status, this session's verification status, key backup status, verify, unlock, "I've lost my recovery key", key export and import.                              |
| Settings, Devices         | Every signed-in session, rename, sign out, and **Verify another session**.                                                                                                 |
| Member profile in a room  | **Verify** for cross-user verification.                                                                                                                                    |

On desktop and wide windows the unlock and verify flows open as dialogs; on phones they
are full pages. They are the same screens either way.

For how any of this is implemented, see
[Matrix and encryption](../architecture/matrix-and-encryption.md). For signing in,
sessions, and multiple accounts, see [signing in](signing-in.md).
