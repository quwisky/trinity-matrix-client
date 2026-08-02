# Trinity

Trinity is a client for [Matrix](https://matrix.org), the open protocol for decentralised
communication. One Angular codebase produces four applications: a web build, iOS and
Android apps wrapped by Capacitor, and a Windows, macOS and Linux desktop app inside a
hand-rolled Electron shell.

"One codebase" is meant literally. The production web build emits into a single `www/`
directory, and Capacitor and Electron each wrap that directory unchanged. There is no
per-platform fork of the timeline, the room list, or the crypto. Where a platform genuinely
differs — the way a login redirect comes back, where a secret is stored, how a notification
is delivered — the difference is isolated behind a service, and
[Platforms](platforms/index.md) documents each one.

End-to-end encryption is not an optional extra bolted on later. Trinity runs the Matrix
Rust crypto stack compiled to WebAssembly on every target, and the surrounding trust
machinery is built out: cross-signing, secret storage with a recovery key, server-side key
backup, emoji-SAS device verification, per-message authenticity shields, encrypted
attachments, and an encrypted room-key export file. What that means in practice for a
person using the app is covered in [Encryption and verification](users/encryption.md); how
it is put together is in
[Matrix and encryption](architecture/matrix-and-encryption.md).

!!! warning "Early development"

    Trinity is at version 0.1.0 and there are no published releases yet. Every platform
    today means building from source. See [Installing Trinity](users/install.md).

## Where to go next

| Section                               | What is in it                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| [Using Trinity](users/index.md)       | What the app can do today, how to install it, sign in, and set it up           |
| [Contributing](contributing/index.md) | Workspace setup, the command surface, how a change is tested and shipped       |
| [Architecture](architecture/index.md) | The library graph, the signal state model, the Matrix layer, the design system |
| [Platforms](platforms/index.md)       | What is specific to web, desktop and mobile, and why                           |
| [Stack reference](reference/stack.md) | Pinned versions and the integration notes that go with them                    |

Source lives at
[github.com/quwisky/trinity-matrix-client](https://github.com/quwisky/trinity-matrix-client).
