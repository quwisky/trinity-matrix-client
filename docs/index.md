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

> [!WARNING]
> **Early development.** Check [Installing Trinity](users/install.md) for current availability,
> host requirements and source-build instructions before starting. Then follow
> [signing in](users/signing-in.md) and [encrypted access](users/encryption.md).

## Choose your task

| If you want to…    | Start here                                  | Then follow                                                                            |
| ------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Use Trinity        | [Using Trinity](users/index.md)             | Install, sign in, messaging, encryption and settings guides for the app you are using. |
| Develop Trinity    | [Developing Trinity](contributing/index.md) | Workspace setup, commands, validation and coding conventions.                          |
| Maintain Trinity   | [Maintaining Trinity](maintaining/index.md) | CI, releases, platform delivery, dependency upkeep and validation diagnostics.         |
| Work with an agent | [Working with agents](agents/index.md)      | Repository skills, role handoffs and the project Codex configuration.                  |

The [architecture](architecture/index.md), [platform](platforms/index.md),
[stack](reference/stack.md) and [troubleshooting](reference/troubleshooting.md) references
support each journey when its task reaches those areas.

Source lives at
[github.com/quwisky/trinity-matrix-client](https://github.com/quwisky/trinity-matrix-client).
