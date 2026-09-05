# Encryption, trust and recovery

Trinity encrypts the rooms and direct messages it creates. Your homeserver carries encrypted
data; devices that hold the right keys can read it. That protects message content, but it also
means a new device needs a trusted route to the keys before it can read encrypted history.

## What a new device needs

There are three related ideas:

| Term             | What it means for you                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recovery key** | A secret shown during encryption setup. It unlocks the account's server-side encrypted backup on a later device.                                                |
| **Verification** | A check between sessions, or with another person, that confirms the identity behind the encryption.                                                             |
| **Trust**        | The resulting confidence that this device belongs to the account it claims to represent. Trust lets the device participate normally in encrypted conversations. |

For a device that cannot yet read encrypted history, Trinity offers two routes: enter the
recovery key, or verify it from another session that is already trusted. Either route can make
the device usable; neither can recreate message keys that no device or backup still has.

## Set up your first device

After registering a new account, or from the encryption action in the workspace, choose
**Set up encryption**. Trinity creates the account's encryption identity and backup, then shows
a recovery key.

Save that key, select **I've saved my recovery key somewhere safe**, then select **Continue to
Trinity**. It is displayed once and Trinity does not retain a second copy to show later. Store it
in a password manager or another secure place that is separate from this device. Treat it as a
secret: anyone who obtains it may be able to unlock your encrypted backup.

If a password confirmation is requested during setup, complete it with the homeserver. It
authorizes the account-level encryption change; it is not a new Trinity password.

## Bring another device online

When you sign in on another device, use the action Trinity presents in the workspace or open
Settings → Security.

### Use the recovery key

Choose **Use recovery key** from the workspace banner, or **Enter recovery key** in Settings →
Security. Enter the key you saved and select **Unlock**. If Trinity rejects it, re-enter the saved
key; if it still fails, use a trusted session to verify this device instead. Once recovery
succeeds, older encrypted history becomes available as Trinity obtains the needed room keys; it
does not promise an immediate bulk restore of every room.

### Verify another device

Choose **Verify another device** from the workspace banner, or **Verify with another device** in
Settings → Security when you still have another trusted session for this Matrix account. Select
**Start verification**, then accept the request on the other device. Select **Start emoji
verification** or **Use emoji instead** when offered, and compare the displayed emoji on both
sessions. Confirm only when every emoji and its order match; reject the request if they differ. QR verification is offered when the participating
sessions and device capabilities support it, with emoji comparison as the fallback.

Keep QR codes and emoji comparisons out of the Matrix conversation you are trying to secure.
Scan a QR code only from another device physically in front of you: never share, screenshot or
show it during screen sharing. Use a channel you already trust for emoji comparison, such as
meeting in person or a recognised voice call.

Trinity handles one verification at a time. Finish or cancel the active request before asking
for another. If you have no other signed-in session, or no camera and no usable emoji route, use
the recovery key instead. Successful verification establishes trust; it cannot restore message
keys that no session or backup has retained.

## Verify another person

From a person's room profile, choose **Verify**. Trinity sends the request through a direct
message, but the comparison must happen somewhere independent of that chat. The verification
checks the person who completes it, so confirm their identity before accepting a matching emoji
sequence.

## Lost recovery key

First, look for another signed-in session that is already trusted. Verify the new device from
that session instead of resetting anything. If you have neither that session nor the recovery
key, Trinity offers **I've lost my recovery key** in Settings → Security and on the recovery-key
screen.

The reset requires typing `RESET` and authenticating with the homeserver when its flow requires
it. It deletes the account's existing server backup of message keys, creates a new recovery
identity, and shows a new recovery key once. Other devices remain signed in with their local
keys, but lose their trusted status and need verification again.

> [!WARNING]
> A recovery reset permanently loses messages whose keys exist only in the deleted server
> backup. Save the new key immediately. If the reset reports an incomplete or uncertain outcome,
> stop and inspect Settings → Security before retrying.

Accounts that authenticate through an external identity provider may not be able to complete a
Matrix-password confirmation in Trinity. Follow the recovery action Trinity offers or contact
the provider or homeserver administrator; do not assume that a password reset at a different
site restores encrypted message keys.

## Keep an additional key export when you need one

In Settings → Security, select **Export room keys**, choose a passphrase and save the generated
file separately from that passphrase. To use it later, select **Import room keys**, choose the
file and enter the same passphrase. A wrong passphrase or damaged file is rejected.

An export is an additional copy of room keys, not a replacement for a recovery key or device
verification. It can help another client read the history covered by the file, but it does not
restore the account's trust identity. Protect both the file and its passphrase.

## Understand warnings and limits

| What you see                                               | What it means                                                                 | Action                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A setup, recovery or verification banner                   | This account or device still needs an encryption action.                      | Follow the named action before relying on encrypted history.                                                                                   |
| A shield on a message                                      | Trinity could not fully establish the message's authenticity.                 | Read the shield explanation and verify the relevant person or device before treating the identity as confirmed.                                |
| Search finds only part of an encrypted room                | The device can search only history it has already loaded and decrypted.       | Open or scroll through the history you need; a homeserver cannot search encrypted ciphertext for you.                                          |
| A recovered or verified device still cannot read a message | No retained device or backup may hold that message's key.                     | Check another trusted session or a room-key export; verification does not recreate missing keys.                                               |
| You have no key and no trusted session                     | There is no nondestructive route back to backup-only history.                 | Consider the reset only after reading its permanent consequences above.                                                                        |
| You need to erase a broken installation                    | This removes all Trinity data on this device, not just the encryption backup. | Read [erase local data](signing-in.md#starting-over-when-trinity-will-not-work) and type `RESET TRINITY` only if you accept that broader loss. |

Encryption affects everyday messaging too: encrypted rooms have local-history search limits and
protect the contents of messages and attachments. Continue with [messaging](messaging.md) and
[settings](settings.md) for the actions you use after the first device is ready.
