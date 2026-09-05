# Trinity documentation

Choose the task you want to complete. Trinity shares one Matrix client across a
Web/PWA renderer, Electron desktop, and Capacitor Android/iOS hosts; host-specific
requirements and unavailable operations are described with each workflow.

The project is in early development. Check [installation and availability](users/install.md),
then follow [signing in](users/signing-in.md) and [encrypted-access recovery](users/encryption.md)
before relying on a new installation for message history.

## Choose your reader path

| I want to…         | Start here                                  | What the path covers                                                                                    |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Use Trinity        | [Using Trinity](users/index.md)             | Install, sign in, manage Accounts/Rooms/Spaces, message, change settings, and recover encrypted access. |
| Develop Trinity    | [Developing Trinity](contributing/index.md) | Set up the workspace, find the change owner, run meaningful checks, and prepare review.                 |
| Maintain Trinity   | [Maintaining Trinity](maintaining/index.md) | Diagnose CI, prepare and recover releases, handle dependencies, and maintain documentation.             |
| Work with an agent | [Working with agents](agents/index.md)      | Select roles and skills, reuse accepted decisions, hand off verified work, and maintain the catalog.    |

## Reach for a reference when needed

| Question                                                      | Reference                                           |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Which capability owns this behavior, dependency, or lifetime? | [Architecture](architecture/index.md)               |
| What changes between Web, Electron, Android, and iOS?         | [Platforms](platforms/index.md)                     |
| Which dependency versions and integration constraints apply?  | [Stack](reference/stack.md)                         |
| What explains a build, runtime, or testing symptom?           | [Troubleshooting](reference/troubleshooting.md)     |
| How does the notification transport connect to the client?    | [Push integration](reference/push-notifications.md) |
| Where should a documentation change live?                     | [Documentation ownership](documentation-map.md)     |

Current guides describe the implementation in this checkout. [Decision records and
historical validation](architecture/index.md#current-design-and-historical-material)
retain their original context; they do not certify a new revision or every host.
