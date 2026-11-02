# Mention index

Use this private reference when changing the mentions inbox's on-device record, or when bumping
`matrix-js-sdk`. The user guide's [inbox section](../../apps/docs-users/src/content/docs/index.md#inbox)
states the behavior and limits people see.

## Store

| Item       | Value                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| Database   | `trinity-mention-index` (`MENTION_INDEX_DB_NAME`), version 1                   |
| Rows       | `mentions`, keyed by `[accountId, eventId]`, one database for all accounts     |
| Index      | `byTime` on `[accountId, ts, eventId]`                                         |
| Row fields | Exactly `accountId`, `eventId`, `roomId`, `ts`; no text, sender or key         |
| Limits     | Newest 2,000 rows per account, nothing past 1 year, pruned on each write       |
| Switches   | `trinity.inbox.show`, `trinity.inbox.keep-record`, per device, both default on |

`MentionIndexService` owns recording for every signed-in account at once. It starts in
`runPreferenceLifetime()`, not with the session's lifetimes, and attaches its listeners when
`MatrixClientService.accountIds` ticks after `startClient` resolves. The SDK's first `/sync` comes
after that, so it hasn't been seen to miss a first batch. The closed-period journey in
`e2e/browser/journeys/notifications/mention-record.spec.mts` checks this strictly.

A write or quota failure stops recording and logs a diagnostic with no IDs, once per run. It never
affects sync or notifications, and the inbox falls back to the server's list. A return to the
foreground (`HostLifecycleService`, `active`) clears the stop, because a single error on a write cut
off by suspending shouldn't silence a session that can last days. A store that fails again stops
again. Mentions that arrive while stopped aren't recorded, and re-attaching saves the sync store, so
a restart doesn't recover them either.

## Who clears it

| Trigger                                                          | Path                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Either switch turned off                                         | `deleteAll`, for every account. A failure shows Try again, and the next start retries                                             |
| Sign-out, removal, deletion of an account                        | `forgetAccount` through `AccountLifecycleAdapter`                                                                                 |
| Sign-in that makes a new device                                  | `forgetAccount`, after the new client has started                                                                                 |
| Account gone from the registry at start                          | `keepOnlyAccounts` sweep, or `deleteAll` with no accounts, which leaves no empty database. An unreadable registry deletes nothing |
| Installation reset                                               | The database is in `LocalDataWipeService`'s inventory                                                                             |
| Redaction, membership leave or ban, `M_FORBIDDEN`, `M_NOT_FOUND` | `forget` from `NotificationInboxService`, one row                                                                                 |

**A room missing from the client forgets nothing.** The SDK swallows errors while processing a
sync (`sync.ts`, around the cached-sync and `/sync` paths) and still emits `Prepared`, so a room can
be missing from a client that reads as synced. The row is hidden and its record stays. A room the
person really left, and never synced, keeps its row until the row or age limit prunes it, which is
harmless.

**A deleted row can't come back through catch-up.** A client catches up from its saved sync
position, which the SDK writes after its first sync and then at most every five minutes, and that
catch-up reads as live. So `forgetAccount` keeps the IDs it deleted, per account and for the session,
and each queued write checks them. It compares IDs, not times, because a sender's server sets
`origin_server_ts` and nothing caps it. A recorder attached to a client that's already `Syncing` also
calls `store.save(true)`. That writes the SDK's whole sync store, not just a position, as its own
periodic save does.

Two gaps are accepted:

- A crash before the new client's first batch is saved could bring a deleted row back.
- Attaching in `Prepared`, `Catchup`, `Reconnecting` or `Error` skips that save, and nothing retries
  it on return to `Syncing`. A restart before the next periodic save could then replay what came
  while the record was off, or what was deleted.

**Where a person is told first.** `MENTION_HISTORY_LOSS` is said only when there's history, and
`hasMentionHistory(accountId, true)` also says it when the count can't be read, on paths that delete
whatever is there:

| Path                                                  | Where it's said                                               | On an unread count |
| ----------------------------------------------------- | ------------------------------------------------------------- | ------------------ |
| Remove account, every route                           | `AccountRemovalLauncherAdapter`'s question                    | Said               |
| Startup recovery                                      | `ApplicationRecoveryPresenter`'s question, the device's total | Said               |
| Delete account in the app                             | `DeleteAccountDialogComponent`'s first step                   | Said               |
| Delete account at an OAuth provider                   | `DeleteAccountGroupComponent`, once the page has been opened  | Said               |
| Re-auth that moves device                             | The login page's subtitle                                     | Said               |
| Sign in again banner                                  | Its question, ahead of that page                              | Not said           |
| Sign-in to a stored account, keys not fully backed up | `NewDeviceSignInPresenter`'s question                         | Said               |
| Sign-in to a stored account, every key backed up      | The same question, which appears only for this                | Asks anyway        |

A server that ends a session by deleting the device can't be asked first. A password account's
hard logout drops its registry entry, so the next start's sweep deletes the rows, or the next
sign-in does, since with no record it reads as a new device and nothing asks. An OAuth re-auth where
the server returns a different device than requested also deletes without the subtitle having said
so.

## Why it isn't exported

It's excluded from settings export, and so are both switches (`export: 'excluded'`). The record
describes what one device saw and is metadata about the account's activity, and importing it could
restore history the person deleted, on any device.

## Accepted limits

- A first-ever sync records nothing, and neither does a start whose saved-sync read failed, since
  the sync state stays null until that sync ends. Those mentions show only if the server lists them.
- An encrypted mention whose keys arrive after a restart isn't recorded. `buildRecorder`'s `pending`
  set, which waits for `MatrixEventEvent.Decrypted`, is per session, and on the next start the
  event comes from the cached replay, which `onTimeline` skips while `getSyncState()` is null (or
  `liveEvent` is false). It shows only if the server lists it, which an encrypted mention in a
  mentions-only room never is.
- Scrolling back in a thread reads as live, so it can record a real old mention. Room scrollback
  doesn't.
- `limited` sync gaps, closed phone apps and browser eviction lose what the server doesn't list.
- A server deleting a device, or returning a different device on an OAuth re-auth, deletes history
  with no question first.
- Rows are keyed by account, so the count in the question covers every account, and removal
  clears only its own.

## When bumping `matrix-js-sdk`

Recording depends on these. Nothing pins them but the listed tests and journey, so recheck them in
the new version's `sync.ts` and `event-timeline-set.ts`:

- **`Prepared` before the first batch.** After a cached replay the SDK sets `Prepared`, then the
  first `/sync` batch arrives. The recorder skips events only while `getSyncState()` is null, which
  is what keeps a cached replay out. If `Prepared` moved after that batch, a normal restart's
  catch-up would stop being recorded. The closed-period journey fails if it does.
- **`liveEvent` false for `fromCache` events,** except threads, which is why the null-state check
  exists. `mention-index.service.spec.ts` covers this with a real client and room.
- **Processing errors are swallowed.** If that changes, a missing room could mean more, but keep
  forgetting only on a clear answer unless the SDK promises it.
- **`store.save(true)` still forces a write,** and `startClient` still resolves before the first
  `/sync` returns.
