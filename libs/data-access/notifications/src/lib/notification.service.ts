import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { injectHostAppName } from '@trinity/runtime/host';
import { plainEqual } from '@trinity/util/matrix';
import { NotificationSoundService } from './notification-sound.service';
import { Observable, Subscriber, Subscription, take, timeout } from 'rxjs';
import type { IncomingNotification } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import type { NotificationRuntimeEvent } from './notification-intent';
import { NotificationPolicy } from './notification-policy';
import { NotificationPresenterService } from './notification-presenter.service';
import { NotificationSettingsStore } from './notification-settings.store';
import { NOTIFICATION_TEXT } from './notification-text.port';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';
import { PushService } from './push.service';
import type {
  CapabilityContext,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { NotificationPresentationHealthTracker } from './notification-presentation-health';
import { ReactionNotificationBatch } from './reaction-notification-batch';
import { ReactionNotificationSettingsService } from './reaction-notification-settings.service';
import { RoomNotificationsService } from './room-notifications.service';
import type {
  NotificationIntent,
  ReactionNotificationEvent,
} from './notification-intent';

interface LiveAccount {
  readonly accountId: string;
  readonly generation: number;
}

/** One account session's notification feed and reaction work. */
interface AccountNotifier {
  readonly userId: string;
  readonly generation: number;
  readonly feed: Subscription;
  readonly reactions: ReactionNotificationBatch;
}

/**
 * Surfaces incoming messages as OS notifications for every signed-in account at once,
 * so feeds and dedupe are keyed by account. That is also why this is not an
 * active-account projection.
 *
 * On desktop the main process presents them: Electron renderer `Notification`s are
 * unreliably surfaced and attributed by the OS, notably on macOS.
 *
 * The engine's `notifications` feed brings live messages the push rules notify (decrypted,
 * however late) and reaction annotations; this decides who sees them. Messages notify when the
 * user isn't viewing that room. Opted-in reactions use client-side ownership checks instead, but
 * keep the master rule and room mutes.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly settings = inject(NotificationSettingsStore);
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

  private connection: Subscription | null = null;
  private presentationConnection = new Subscription();
  private runtimeSubscriber: Subscriber<NotificationRuntimeEvent> | null = null;
  private readonly health = new NotificationPresentationHealthTracker();

  private readonly notified = new Set<string>();

  /** Each live account with its session generation: a re-auth bumps it and re-subscribes. */
  private readonly accounts = computed(
    (): readonly LiveAccount[] =>
      this.session.snapshot().accounts.map(({ accountId, generation }) => ({
        accountId,
        generation,
      })),
    { equal: plainEqual },
  );

  private static readonly NOTIFIED_CAP = 500;

  constructor() {
    effect(() => {
      const accounts = this.accounts();
      // Reconciliation can emit a warning whose subscriber reads runtime state; tracking
      // those reads turns a rejected permission into a self-sustaining warning loop.
      untracked(() => this.reconcile(accounts));
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
      this.reconcile(this.accounts());
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
    this.notified.clear();
  }

  private reconcile(accounts: readonly LiveAccount[]): void {
    if (!this.enabled) {
      return;
    }
    if (accounts.length === 0) {
      // Stay dormant rather than complete: the signed-out screen never asks for Web
      // permission, and a later login attaches without a page restarting a root capability.
      for (const notifier of this.notifiers.values()) this.detach(notifier);
      this.notifiers.clear();
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
    const live = new Set(accounts.map(({ accountId }) => accountId));
    for (const [userId, notifier] of this.notifiers) {
      if (!live.has(userId)) {
        this.detach(notifier);
        this.notifiers.delete(userId);
        this.forgetAccount(userId);
      }
    }
    for (const { accountId: userId, generation } of accounts) {
      const held = this.notifiers.get(userId);
      if (held) {
        // A re-auth replaces the account's session under the same id; keeping the old feed
        // strands it on a stopped client.
        if (held.generation === generation) {
          continue;
        }
        this.detach(held);
        this.notifiers.delete(userId);
      }
      this.notifiers.set(userId, this.attach(userId, generation));
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
                    this.reconcile(this.accounts());
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

  private attach(userId: string, generation: number): AccountNotifier {
    const reactions = new ReactionNotificationBatch({
      accountId: userId,
      allowed: (roomId, senderId) =>
        this.reactionAllowed(userId, generation, roomId, senderId),
      lookup: (roomId, targetEventId, reactionIds) =>
        this.engine.reactionTarget(userId, roomId, targetEventId, reactionIds),
      present: (event) => this.presentReaction(userId, generation, event),
    });
    const feed = this.engine.notifications(userId).subscribe((item) => {
      try {
        if (item.kind === 'reaction-annotation') reactions.add(item);
        else this.notify(item);
      } catch {
        /* a notification failure is non-fatal */
      }
    });
    return { userId, generation, feed, reactions };
  }

  private detach(notifier: AccountNotifier): void {
    notifier.reactions.dispose();
    notifier.feed.unsubscribe();
  }

  private forgetAccount(userId: string): void {
    const prefix = `${userId} `;
    for (const key of this.notified) {
      if (key.startsWith(prefix)) {
        this.notified.delete(key);
      }
    }
  }

  private notify(
    event: Exclude<IncomingNotification, { kind: 'reaction-annotation' }>,
  ): void {
    const key = this.key(event.accountId, event.eventId);
    const decision = this.policy.decide({
      event,
      viewerId: event.accountId,
      rules: { notify: true, silent: !this.sound.isOn(event.accountId) },
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
    generation: number,
    event: ReactionNotificationEvent,
  ): void {
    if (
      !this.reactionAllowed(userId, generation, event.roomId, event.senderId)
    ) {
      return;
    }
    const decision = this.policy.decide({
      event,
      viewerId: userId,
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

  private reactionAllowed(
    userId: string,
    generation: number,
    roomId: string,
    senderId: string,
  ): boolean {
    return (
      this.enabled &&
      this.presentationReady &&
      this.session.status(userId)?.generation === generation &&
      senderId !== userId &&
      this.reactionSettings.isOn(userId) &&
      !this.settings
        .settings(userId)
        .defaultRules.some(
          (rule) => rule.ruleId === '.m.rule.master' && rule.enabled,
        ) &&
      this.roomNotifications.modeFor(roomId, userId) !== 'mute'
    );
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
