# Reaction notifications implementation plan

> **For agentic workers:** Use the accepted issue requirements and bounded file ownership below. Execute with Superpowers testing and review guidance; the user's request authorizes planning and implementation together. Keep changes uncommitted until publication is requested.

**Goal:** Notify an opted-in account when another person reacts to its own message while Trinity is running.

**Architecture:** Notifications owns the preference, bounded reaction batches, target lookup and immutable presentation intent. Existing host presentation and Workspace activation remain the delivery and navigation boundaries. Reaction eligibility is a client-side source alongside ordinary push-rule scoring; it does not change server push rules.

**Tech stack:** Angular 22.1, matrix-js-sdk 42.1, RxJS, Vitest, existing Nx targets and Synapse-backed Playwright journeys.

**Spec:** [Issue #486 — Notify me when someone reacts to my message](https://github.com/quwisky/trinity-matrix-client/issues/486), scope 1 (app running).

## Global constraints

- Default off; store `eu.qwky.trinity.reaction_notifications` account data as `{ enabled: boolean }`.
- The preference follows the owning account, including background accounts. It changes no push rules or push registration.
- Ignore own reactions, reactions to another person's message, malformed/redacted events, ignored senders, initial-sync history and backfill.
- Honor the account master disable, muted rooms, sound setting and visible-conversation suppression. An enabled personal-reaction preference still applies in mentions-only rooms.
- Batch by account, room and target message. Wait two seconds after the last reaction, with a ten-second maximum burst window. Count distinct people and display distinct reaction keys.
- Resolve targets locally first, fetch missing targets using the exact owning client, and decrypt before creating a preview. Suppress unavailable, redacted and undecryptable targets.
- Bound pending batches, queued events, lookup duration and deduplication state. Teardown and client replacement cancel queued work and prevent late notification delivery.
- Use a stable reaction-specific target tag, and put the original message ID in the activation destination.
- Scope 2 (closed-app push and gateway/iOS filtering) is deferred as the issue requests.

## Task 1: Account preference and settings toggle

**Files:**

- Create `libs/data-access/notifications/src/lib/reaction-notification-settings.service.ts` and its `.spec.ts`.
- Modify `libs/data-access/notifications/src/index.ts`.
- Modify `libs/feature/settings/src/lib/notifications/notifications-section.component.ts`, `.html` and `.spec.ts`.

**Interface:**

```ts
export const REACTION_NOTIFICATION_EVENT = 'eu.qwky.trinity.reaction_notifications';
export class ReactionNotificationSettingsService {
  readonly enabled: Signal<boolean>;
  connect(): void;
  disconnect(): void;
  isOn(accountId?: string): boolean;
  setOn(on: boolean): Observable<void>;
}
```

- [x] Add failing tests for absent/malformed data defaulting off, account-specific reads, cold writes, account switches during writes, and account-data projection updates.
- [x] Implement the service using the existing sound preference's account-data and projection patterns. Capture write ownership on subscription and prevent a late completion from changing another account's UI.
- [x] Add the labelled switch `When someone reacts to my message`, `data-testid="notif-reactions"`, with a short running-app/grouping explanation. Follow existing public switch and settings-row patterns.
- [x] Test optimistic pending state, write errors, external preference updates and lifecycle cleanup.
- [x] Run `pnpm nx test data-access-notifications -- reaction-notification-settings` and `pnpm nx test feature-settings -- notifications-section`.

## Task 2: Reaction batches and presentation

**Files:**

- Create `libs/data-access/notifications/src/lib/reaction-notification-batch.ts` and its `.spec.ts`.
- Create `libs/data-access/notifications/src/lib/reaction-notifications.integration.spec.ts`.
- Modify `libs/data-access/notifications/src/lib/notification.service.ts`.
- Modify `libs/data-access/notifications/src/lib/notification-intent.ts`, `notification-policy.ts` and `notification-policy.spec.ts`.

**Interfaces:**

```ts
// One queue belongs to one exact AccountNotifier/client lifetime.
new ReactionNotificationBatch({
  accountId,
  client,
  allowed: (room, senderId) => boolean,
  present: (event: ReactionNotificationEvent) => void,
});
batch.add(event, room);
batch.dispose();
```

`ReactionNotificationEvent` carries the original message destination/preview, first reactor identity, distinct sender count and reaction keys; it is SDK-free and discriminated by `kind: 'reaction'`.

- [x] Write failing queue tests for a burst of five people, duplicate events, multiple emojis from one person, independent targets, fetched/encrypted targets, malformed/other-author/redacted targets, and teardown during a fetch.
- [x] Implement two-second trailing batching with a ten-second maximum window, bounded state and finite target lookup. Use `findEventById`, then `fetchRoomEvent` and `getEventMapper({ decrypt: false })`, then `decryptEventIfNeeded`.
- [x] Add a policy branch producing a title such as `Alice and 4 others reacted 👍 · General`, a bounded original-message preview, and a reaction-specific stable tag.
- [x] Route live reactions to their notifier's queue before ordinary push-rule scoring. Reuse the same policy/presenter health handling; retain existing message behavior.
- [x] Cancel the queue when its notifier detaches, on account/client replacement, session stop or presentation ownership release. Recheck exact ownership and eligibility before delivery.
- [x] Add integration tests for default-off, master disable/mute/ignore, visibility, sound, backfill, account isolation, target activation and teardown. Existing notification tests remain regression coverage for Web, Electron and Capacitor adapters.
- [x] Run the notifications test, typecheck and lint targets.

## Task 3: Browser proof, documentation and final verification

**Files:**

- Extend `e2e/browser/journeys/notifications/notifications.spec.mts` with a reaction journey; reuse the registered suite.
- Update `docs/users/notifications.md` and `docs/reference/push-notifications.md`.
- Update the unreleased changelog according to repository convention.

- [x] Exercise the default-off toggle, enable/persistence, one grouped notification for reactions to the reader's message, no alert for own/other-author reactions, and click navigation to the original message through the real application.
- [x] Explain the opt-in, grouping, room mute behavior and running-app scope in user/reference docs.
- [x] Run affected project tests, separate typechecks and lint, renderer build for the changed Angular template, relevant source guards, formatting and link checks.
- [x] Run the existing Synapse-backed notification browser suite sequentially with other Synapse harnesses; report any unavailable host prerequisites accurately.
- [x] Obtain an independent review of the full uncommitted artifact, fix material findings, and rerun affected checks.

## Publication

Publish the reviewed task branch as a pull request targeting `develop`, as authorized
after implementation. Keep the worktree available for follow-up and leave merging
to the user.

## Verification results

- `pnpm nx run-many -t test,typecheck,lint -p data-access-notifications`: passed,
  289 tests. The final same-ID account-isolation assertion also passed the focused
  10-test integration rerun and typecheck after review.
- `pnpm nx run-many -t test,typecheck,lint -p feature-settings`: passed, 306 tests.
- `pnpm nx run trinity-e2e:typecheck` and ESLint for the changed browser journey
  and assertion inventory: passed.
- `pnpm nx test scripts`: passed, 537 tests. After the last browser-test update,
  `pnpm nx test scripts -- e2e-suite-registry` passed all 42 registry checks.
- `pnpm architecture:check`: passed; the final browser inventory was also
  revalidated by the registry checks above.
- `pnpm nx build trinity`: passed. Existing room-component stylesheet budget
  warnings remain; this change adds no stylesheet.
- `pnpm nx run trinity-e2e-browser:e2e -- notifications/notifications.spec.mts`:
  final run passed all 3 Chromium journeys against disposable Synapse.
  Two earlier runs exposed test-fixture errors: the Home rail retained the visible
  conversation, and a reused Matrix transaction ID returned the prior message.
  The fixture now opens a separate room, uses distinct send IDs, and bounds sync waits.
- Independent runtime and follow-up test review: no outstanding findings.
- `pnpm format:check`: passed across the workspace.
- Local documentation links and `git diff --check`: passed. Graft context refreshed.

Native Electron, Android and iOS delivery was not exercised on installed hosts.
Closed-app reaction push remains outside this implementation's scope.
