import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import {
  ClientEvent,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  SyncState,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { injectHostAppName } from '@trinity/runtime/host';
import { RoomEncryptionFlags } from '@trinity/util/matrix';
import {
  LEGACY_NOTIFICATION_SOUND_EVENT,
  NOTIFICATION_SOUND_EVENT,
  NotificationSoundService,
} from './notification-sound.service';
import { copyLegacyAccountData } from './legacy-account-data';
import { Observable, Subscriber, Subscription, take, timeout } from 'rxjs';
import { normalizeNotificationEvent } from './matrix-notification-event.adapter';
import type { NotificationRuntimeEvent } from './notification-intent';
import { NotificationPolicy } from './notification-policy';
import { NotificationPresenterService } from './notification-presenter.service';
import { NOTIFICATION_TEXT } from './notification-text.port';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';
import { PushService } from './push.service';
import type {
  CapabilityContext,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { NotificationPresentationHealthTracker } from './notification-presentation-health';
import { ReactionNotificationBatch } from './reaction-notification-batch';
import {
  LEGACY_REACTION_NOTIFICATION_EVENT,
  REACTION_NOTIFICATION_EVENT,
  ReactionNotificationSettingsService,
} from './reaction-notification-settings.service';
import { RoomNotificationsService } from './room-notifications.service';
import type {
  NotificationIntent,
  ReactionNotificationEvent,
} from './notification-intent';

/** One account's client plus its bound timeline / decrypted listeners. */
interface AccountNotifier {
  readonly userId: string;
  readonly client: MatrixClient;
  readonly onTimeline: (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline?: boolean,
    removed?: boolean,
    data?: IRoomTimelineData,
  ) => void;
  readonly onDecrypted: (event: MatrixEvent) => void;
  readonly onSync: (state: SyncState) => void;
  readonly reactions: ReactionNotificationBatch;
}

/** One account's account-data listener that copies retired names to current ones. */
interface LegacyAccountDataCopy {
  readonly client: MatrixClient;
  readonly onAccountData: () => void;
}

/**
 * Copy each retired account-data event to its current name when only the old one exists.
 * Runs inside the SDK's emit loop, so a throw must never escape.
 */
function copyRetiredAccountData(client: MatrixClient): void {
  try {
    copyLegacyAccountData(
      client as never,
      NOTIFICATION_SOUND_EVENT,
      LEGACY_NOTIFICATION_SOUND_EVENT,
    );
    copyLegacyAccountData(
      client as never,
      REACTION_NOTIFICATION_EVENT,
      LEGACY_REACTION_NOTIFICATION_EVENT,
    );
  } catch {
    /* the old value stays readable; the next account-data event retries */
  }
}

/**
 * Surfaces incoming messages as OS notifications for every signed-in account at once,
 * so listeners, push scoring and dedupe are keyed by account. That is also why this is
 * not a `projectFromClient` projection, which models one active client.
 *
 * On desktop the main process presents them: Electron renderer `Notification`s are
 * unreliably surfaced and attributed by the OS, notably on macOS.
 *
 * Only live events after the account's first sync notify, from someone else, when the
 * user isn't viewing that room, and when push rules say `notify`. Opted-in reactions use
 * client-side ownership checks instead, but keep the master rule and room mutes.
 *
 * In E2EE rooms the timeline emit carries ciphertext, so the preview would be generic and
 * push rules would miss mentions. Those events wait for `MatrixEventEvent.Decrypted` and
 * are rescored with `getPushActionsForEvent(event, true)`.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly matrix = inject(MatrixClientService);
  private readonly sound = inject(NotificationSoundService);
  private readonly reactionSettings = inject(
    ReactionNotificationSettingsService,
  );
  private readonly roomNotifications = inject(RoomNotificationsService);
  private readonly visibility = inject(NOTIFICATION_VISIBILITY);
  /** App lock's Notification text, composed by the application; absent means Show. */
  private readonly text = inject(NOTIFICATION_TEXT, { optional: true });
  private readonly appName = injectHostAppName();
  private readonly push = inject(PushService);
  private readonly policy = inject(NotificationPolicy);
  private readonly presenter = inject(NotificationPresenterService);
  private readonly destroyRef = inject(DestroyRef);

  private enabled = false;
  private presentationReady = false;
  private presentationPreparing = false;

  private readonly notifiers = new Map<string, AccountNotifier>();

  /** Bound for every account whatever the notification permission or host support. */
  private readonly legacyCopies = new Map<string, LegacyAccountDataCopy>();

  private connection: Subscription | null = null;
  private presentationConnection = new Subscription();
  private runtimeSubscriber: Subscriber<NotificationRuntimeEvent> | null = null;
  private readonly health = new NotificationPresentationHealthTracker();

  /** Live events only, so scrollback that later decrypts never notifies. */
  private readonly pendingDecryption = new Set<string>();

  private readonly notified = new Set<string>();

  private static readonly NOTIFIED_CAP = 500;

  /** Permanent UTDs stay pending for a later retry, so the set needs a cap. */
  private static readonly PENDING_DECRYPTION_CAP = 500;

  constructor() {
    effect(() => {
      const accountIds = this.matrix.accountIds();
      // Reconciliation can emit a warning whose subscriber reads runtime state; tracking
      // those reads turns a rejected permission into a self-sustaining warning loop.
      untracked(() => this.reconcile(accountIds));
    });
    this.destroyRef.onDestroy(() => this.stop());
  }

  /**
   * Own notification delivery for one Application Runtime session; teardown releases it.
   * Cold and long-lived; only the application Workspace decides how to open or repair a
   * destination.
   */
  run(): Observable<NotificationRuntimeEvent> {
    return new Observable((subscriber) => {
      if (this.enabled || (this.connection && !this.connection.closed)) {
        subscriber.complete();
        return;
      }
      const connection = new Subscription();
      this.connection = connection;
      this.runtimeSubscriber = subscriber;
      this.enabled = true;
      this.health.start((event) => subscriber.next(event));
      this.reconcile(this.matrix.accountIds());
      return () => this.stop(connection);
    });
  }

  private stop(owner = this.connection): void {
    if (owner !== this.connection) return;
    this.connection?.unsubscribe();
    this.connection = null;
    this.presentationConnection.unsubscribe();
    this.presentationConnection = new Subscription();
    this.runtimeSubscriber = null;
    this.enabled = false;
    this.presentationReady = false;
    this.presentationPreparing = false;
    this.health.reset();
    for (const notifier of this.notifiers.values()) {
      this.detach(notifier);
    }
    this.notifiers.clear();
    this.reconcileLegacyCopies([]);
    this.pendingDecryption.clear();
    this.notified.clear();
  }

  private reconcile(ids: readonly string[]): void {
    if (!this.enabled) {
      return;
    }
    // Before the presentation gate: the copy must not wait on notification permission.
    this.reconcileLegacyCopies(ids);
    if (ids.length === 0) {
      // Stay dormant rather than complete: the signed-out screen never asks for Web
      // permission, and a later login attaches without a page restarting a root capability.
      for (const notifier of this.notifiers.values()) this.detach(notifier);
      this.notifiers.clear();
      this.pendingDecryption.clear();
      this.notified.clear();
      this.releasePresentation();
      this.health.publish(
        'not-applicable',
        'notification-presentation-not-demanded',
        'acknowledged',
        false,
      );
      return;
    }
    if (!this.presentationReady) {
      this.preparePresentation();
      return;
    }
    const live = new Set(ids);
    for (const [userId, notifier] of this.notifiers) {
      if (!live.has(userId)) {
        this.detach(notifier);
        this.notifiers.delete(userId);
        this.forgetAccount(userId);
      }
    }
    for (const userId of ids) {
      const client = this.matrix.clientFor(userId);
      const held = this.notifiers.get(userId);
      if (held) {
        // Re-adding a signed-in account re-creates its client; keeping the old one strands
        // the listener on a stopped client.
        if (held.client === client) {
          continue;
        }
        this.detach(held);
        this.notifiers.delete(userId);
      }
      if (!client) {
        continue; // not fully started yet; a later accountIds tick re-checks it
      }
      const notifier = this.buildNotifier(userId, client);
      this.attach(notifier);
      this.notifiers.set(userId, notifier);
    }
  }

  private reconcileLegacyCopies(ids: readonly string[]): void {
    const live = new Set(ids);
    for (const [userId, copy] of this.legacyCopies) {
      if (live.has(userId) && this.matrix.clientFor(userId) === copy.client) {
        continue;
      }
      copy.client.off(ClientEvent.AccountData, copy.onAccountData);
      this.legacyCopies.delete(userId);
    }
    for (const userId of ids) {
      const client = this.matrix.clientFor(userId);
      if (!client || this.legacyCopies.has(userId)) continue;
      const onAccountData = (): void => copyRetiredAccountData(client);
      client.on(ClientEvent.AccountData, onAccountData);
      this.legacyCopies.set(userId, { client, onAccountData });
      // Account data may already be in the store (a restored session).
      onAccountData();
    }
  }

  private preparePresentation(): void {
    if (this.presentationPreparing || !this.connection) return;
    this.presentationPreparing = true;
    this.health.begin();
    const connection = this.connection;
    this.presentationConnection = new Subscription();
    connection.add(this.presentationConnection);
    this.presentationConnection.add(
      this.presenter
        .support()
        .pipe(take(1), timeout(10_000))
        .subscribe({
          next: (support) => {
            if (connection.closed) return;
            if (support.kind === 'unavailable') {
              this.presentationPreparing = false;
              const expected =
                support.reason === 'not-supported' ||
                support.reason === 'not-implemented';
              this.health.publish(
                expected ? 'not-applicable' : 'degraded',
                expected
                  ? 'notification-presentation-unsupported'
                  : 'notification-presentation-unavailable',
                expected ? 'acknowledged' : 'failed',
                true,
              );
              return;
            }
            this.presentationConnection.add(
              this.presenter.activated.subscribe({
                next: (destination) =>
                  this.runtimeSubscriber?.next({
                    kind: 'activated',
                    destination,
                  }),
                error: () => this.presentationOwnershipReleased(),
                complete: () => this.presentationOwnershipReleased(),
              }),
            );
            this.presentationConnection.add(
              this.presenter
                .requestPermission()
                .pipe(take(1), timeout(10_000))
                .subscribe({
                  next: (outcome) => {
                    this.presentationPreparing = false;
                    if (connection.closed) return;
                    if (outcome.kind !== 'completed') {
                      const denied =
                        outcome.kind === 'rejected' &&
                        outcome.diagnostic.code ===
                          'notification-permission-denied';
                      const unsupported =
                        outcome.kind === 'unavailable' &&
                        (outcome.reason === 'not-supported' ||
                          outcome.reason === 'not-implemented');
                      this.health.publish(
                        denied
                          ? 'disabled'
                          : unsupported
                            ? 'not-applicable'
                            : 'degraded',
                        denied
                          ? 'notification-presentation-disabled'
                          : unsupported
                            ? 'notification-presentation-unsupported'
                            : 'notification-presentation-unavailable',
                        denied || unsupported ? 'acknowledged' : 'failed',
                        true,
                      );
                      return;
                    }
                    this.presentationReady = true;
                    this.health.publish(
                      'available',
                      'notification-presentation-ready',
                      'acknowledged',
                      true,
                    );
                    this.reconcile(this.matrix.accountIds());
                  },
                  error: () => {
                    this.presentationPreparing = false;
                    this.health.publish(
                      'degraded',
                      'notification-presentation-unavailable',
                      'failed',
                      true,
                    );
                  },
                }),
            );
          },
          error: () => {
            this.presentationPreparing = false;
            this.health.publish(
              'degraded',
              'notification-presentation-unavailable',
              'failed',
              false,
            );
          },
        }),
    );
  }

  private buildNotifier(userId: string, client: MatrixClient): AccountNotifier {
    const currentSyncState = client.getSyncState();
    let firstSyncCompleted =
      currentSyncState === SyncState.Prepared ||
      currentSyncState === SyncState.Syncing;
    // A room counts as encrypted by its state OR by the crypto store. The store's answer is
    // async, so ask it once per room up front; a room first seen later is covered next sync.
    const encryption = new RoomEncryptionFlags();
    const reactions = new ReactionNotificationBatch({
      accountId: userId,
      client,
      allowed: (room, senderId) =>
        this.reactionAllowed(userId, client, room, senderId),
      present: (event) => this.presentReaction(userId, client, event),
      roomEncrypted: (room) => encryption.isEncrypted(room),
    });
    const warmEncryption = (): void => {
      const crypto = client.getCrypto();
      for (const room of client.getRooms()) {
        void encryption.refresh(crypto, room.roomId);
      }
    };
    if (firstSyncCompleted) {
      warmEncryption();
    }
    return {
      userId,
      client,
      reactions,
      onSync: (state): void => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          firstSyncCompleted = true;
          warmEncryption();
        }
      },
      onTimeline: (event, room, _toStart, _removed, data): void => {
        // This runs inside the SDK's sync emit loop — a throw must never disrupt it.
        try {
          if (data?.liveEvent !== true) {
            return;
          }
          if (!firstSyncCompleted) {
            // matrix-js-sdk labels the first /sync batch as live while it is still
            // applying stored room state and history. PREPARED is emitted afterwards.
            return;
          }
          if (this.isReaction(event) && room) {
            reactions.add(event, room);
            return;
          }
          if (this.isAwaitingDecryption(event)) {
            const id = event.getId();
            if (id) {
              this.pendingDecryption.add(this.key(userId, id));
              this.evictOldest(
                this.pendingDecryption,
                NotificationService.PENDING_DECRYPTION_CAP,
              );
            }
            return;
          }
          this.maybeNotify(userId, client, event, room, encryption);
        } catch {
          /* a notification failure is non-fatal */
        }
      },
      onDecrypted: (event): void => {
        // Also runs inside the SDK's emit loop — never let a throw escape.
        try {
          const id = event.getId();
          if (!id) {
            return;
          }
          const key = this.key(userId, id);
          if (!this.pendingDecryption.has(key)) {
            return;
          }
          if (event.isDecryptionFailure()) {
            return; // keep it pending for a later retry
          }
          this.pendingDecryption.delete(key);
          const room = client.getRoom(event.getRoomId() ?? '') ?? undefined;
          if (this.isReaction(event) && room) {
            reactions.add(event, room);
            return;
          }
          this.maybeNotify(
            userId,
            client,
            event,
            room,
            encryption,
            /* force */ true,
          );
        } catch {
          /* a notification failure is non-fatal */
        }
      },
    };
  }

  private attach(notifier: AccountNotifier): void {
    notifier.client.on(ClientEvent.Sync, notifier.onSync);
    notifier.client.on(RoomEvent.Timeline, notifier.onTimeline);
    notifier.client.on(MatrixEventEvent.Decrypted, notifier.onDecrypted);
  }

  private detach(notifier: AccountNotifier): void {
    notifier.reactions.dispose();
    notifier.client.off(ClientEvent.Sync, notifier.onSync);
    notifier.client.off(RoomEvent.Timeline, notifier.onTimeline);
    notifier.client.off(MatrixEventEvent.Decrypted, notifier.onDecrypted);
  }

  private forgetAccount(userId: string): void {
    const prefix = `${userId} `;
    for (const key of this.pendingDecryption) {
      if (key.startsWith(prefix)) {
        this.pendingDecryption.delete(key);
      }
    }
    for (const key of this.notified) {
      if (key.startsWith(prefix)) {
        this.notified.delete(key);
      }
    }
  }

  private isAwaitingDecryption(event: MatrixEvent): boolean {
    return event.isEncrypted?.() === true && event.getClearContent?.() == null;
  }

  private maybeNotify(
    userId: string,
    client: MatrixClient,
    event: MatrixEvent,
    room: Room | undefined,
    encryption: RoomEncryptionFlags,
    forceRecalculate = false,
  ): void {
    if (!room) {
      return;
    }
    // `forceRecalculate` makes the rules score the cleartext, not a cached ciphertext result.
    const normalized = normalizeNotificationEvent(
      userId,
      event,
      room,
      encryption.isEncrypted(room),
    );
    const key = this.key(userId, normalized.eventId);
    const decision = this.policy.decide({
      event: normalized,
      viewerId: client.getUserId() ?? userId,
      rules: {
        notify:
          client.getPushActionsForEvent(event, forceRecalculate)?.notify ===
          true,
        silent: !this.sound.isOn(userId),
      },
      visibility: this.visibility.snapshot(),
      backgroundDelivery: this.push.backgroundDelivery(),
      duplicate: this.notified.has(key),
      textMode: this.text?.mode() ?? 'show',
      appName: this.appName,
    });
    if (decision.kind === 'suppress') return;
    this.notified.add(key);
    this.evictOldest(this.notified, NotificationService.NOTIFIED_CAP);
    this.presentIntent(decision.intent);
  }

  private presentReaction(
    userId: string,
    client: MatrixClient,
    event: ReactionNotificationEvent,
  ): void {
    if (!this.reactionAllowed(userId, client, event.roomId, event.senderId)) {
      return;
    }
    const decision = this.policy.decide({
      event,
      viewerId: client.getUserId() ?? userId,
      rules: { notify: true, silent: !this.sound.isOn(userId) },
      visibility: this.visibility.snapshot(),
      backgroundDelivery: this.push.backgroundDelivery(),
      duplicate: false,
      textMode: this.text?.mode() ?? 'show',
      appName: this.appName,
    });
    if (decision.kind === 'suppress') return;
    this.presentIntent(decision.intent);
  }

  private presentIntent(intent: NotificationIntent): void {
    const subscription = this.presenter
      .present(intent)
      .pipe(take(1))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'completed') {
            this.health.incident(
              'presentation-command',
              'notification-presentation-failed',
            );
          }
        },
        error: () =>
          this.health.incident(
            'presentation-command',
            'notification-presentation-failed',
          ),
      });
    this.connection?.add(subscription);
  }

  private isReaction(event: MatrixEvent): boolean {
    return event.getType?.() === EventType.Reaction;
  }

  private reactionAllowed(
    userId: string,
    client: MatrixClient,
    room: Room | string | undefined,
    senderId: string,
  ): boolean {
    return (
      this.enabled &&
      this.presentationReady &&
      this.matrix.clientFor(userId) === client &&
      this.reactionSettings.isOn(userId) &&
      this.reactionAllowedForRoom(client, senderId) &&
      (!room ||
        this.roomNotifications.modeFor(
          typeof room === 'string' ? room : room.roomId,
          userId,
        ) !== 'mute')
    );
  }

  private reactionAllowedForRoom(
    client: MatrixClient,
    senderId: string,
  ): boolean {
    if (senderId === client.getUserId()) return false;
    if (client.isUserIgnored?.(senderId) === true) return false;
    const master = client.pushRules?.global?.override?.find(
      (rule) => rule.rule_id === '.m.rule.master',
    );
    return master?.enabled !== true;
  }

  recoverPresentation(
    context: CapabilityContext,
    generation: number,
  ): Observable<CapabilityRecoveryOutcome> {
    return this.health.recover(context, generation, () => {
      this.releasePresentation();
      this.preparePresentation();
    });
  }

  private releasePresentation(): void {
    this.presentationConnection.unsubscribe();
    this.presentationConnection = new Subscription();
    this.presentationReady = false;
    this.presentationPreparing = false;
    for (const notifier of this.notifiers.values()) {
      this.detach(notifier);
    }
    this.notifiers.clear();
  }

  private presentationOwnershipReleased(): void {
    if (!this.enabled) return;
    this.releasePresentation();
    this.health.publish(
      'degraded',
      'notification-activation-ownership-released',
      'failed',
      false,
    );
  }

  private key(userId: string, eventId: string): string {
    return `${userId} ${eventId}`;
  }

  private evictOldest(set: Set<string>, cap: number): void {
    if (set.size <= cap) {
      return;
    }
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}
