import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import {
  ClientEvent,
  MatrixEventEvent,
  RoomEvent,
  SyncState,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NativePushDeliveryService,
  NativePushRegistrationService,
  SessionStorageService,
} from '@trinity/platform-native';
import {
  parseTrinityPushPayload,
  resolvePushAccountRoute,
} from '@trinity/util/push-client';
import { PushGatewayService } from './push-gateway.service';
import { NotificationSoundService } from './notification-sound.service';
import {
  Observable,
  Subscriber,
  Subscription,
  defer,
  catchError,
  of,
  switchMap,
  map,
  take,
  timeout,
} from 'rxjs';
import { normalizeNotificationEvent } from './matrix-notification-event.adapter';
import type {
  NotificationIntent,
  NotificationRuntimeEvent,
} from './notification-intent';
import type { HostOperationOutcome } from '@trinity/runtime/host';
import { NotificationPolicy } from './notification-policy';
import { NotificationPresenterService } from './notification-presenter.service';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';
import type {
  CapabilityContext,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { NotificationPresentationHealthTracker } from './notification-presentation-health';

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
}

/**
 * Surfaces incoming messages as native OS notifications, driven by the live sync
 * stream of **every signed-in account** at once (not just the active one). This is
 * the host notification-presentation capability; Web, Capacitor and Electron adapters
 * implement the same typed intent and activation contract.
 *
 * The capability layer selects one of two delivery backends at composition time:
 *  - **Desktop (hand-rolled Electron):** the preload `trinityDesktop` bridge is
 *    present, so notifications are routed through the MAIN process
 *    (`showNotification`). Renderer Web `Notification`s from Electron are
 *    unreliably surfaced/attributed by the OS (notably macOS), so the main
 *    process owns them; clicks come back over `onNotificationClick`.
 *  - **Capacitor:** Local Notifications, with explicit plugin/permission availability.
 *  - **Web / PWA:** the renderer Web `Notification` API (with permission prompt).
 *
 * Either way it only fires after the Account's first successful sync and for **live**
 * events (not backfill), from someone other than us, when the user isn't looking at
 * that room (the window is unfocused, a
 * different room is open, or the event is on a background account), and only when
 * that account's push rules say to notify (`getPushActionsForEvent().notify` —
 * respects mutes / mentions-only). Activation emits an exact semantic destination;
 * the application Workspace owns account switching, repair, focus, and navigation.
 *
 * Because several accounts sync concurrently, listeners are attached per account and
 * reconciled against the live account set; push scoring, own-message suppression, and
 * the per-event dedupe are all keyed by account. The collapse `tag` folds in the
 * user id so the same room on two accounts stays two distinct toasts.
 *
 * For E2EE rooms the `RoomEvent.Timeline` emit carries ciphertext (the preview
 * would be generic and push rules would run against the encrypted payload, so
 * mentions are missed). Those live events are deferred and re-evaluated on
 * `MatrixEventEvent.Decrypted` with `getPushActionsForEvent(event, true)`; a
 * dedupe set guarantees each event notifies at most once per account.
 *
 * That multi-account shape is also why this is not a `projectFromClient` projection: the
 * primitive models one active client, whereas this binds per account. The account-set
 * effect in the constructor is this service's equivalent.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly matrix = inject(MatrixClientService);
  private readonly sessions = inject(SessionStorageService);
  private readonly gateway = inject(PushGatewayService);
  private readonly nativePush = inject(NativePushRegistrationService);
  private readonly nativeDelivery = inject(NativePushDeliveryService);
  private readonly sound = inject(NotificationSoundService);
  private readonly visibility = inject(NOTIFICATION_VISIBILITY);
  private readonly policy = inject(NotificationPolicy);
  private readonly presenter = inject(NotificationPresenterService);
  private readonly destroyRef = inject(DestroyRef);

  /** Whether a current {@link run} subscription owns listener reconciliation. */
  private enabled = false;
  private presentationReady = false;
  private presentationPreparing = false;

  /** Per-account listeners, keyed by user id, so switches/sign-outs re-bind cleanly. */
  private readonly notifiers = new Map<string, AccountNotifier>();

  private connection: Subscription | null = null;
  private presentationConnection = new Subscription();
  private runtimeSubscriber: Subscriber<NotificationRuntimeEvent> | null = null;
  private readonly health = new NotificationPresentationHealthTracker();

  /**
   * Live, still-encrypted events seen on the timeline that we deferred until
   * `MatrixEventEvent.Decrypted`, keyed `userId\0eventId`. Backfill never lands
   * here, so the Decrypted handler won't notify for scrollback that happens to
   * decrypt.
   */
  private readonly pendingDecryption = new Set<string>();

  /** Keys (`userId\0eventId`) already notified, so an event notifies at most once. */
  private readonly notified = new Set<string>();

  /** Bound on {@link notified} so it can't grow without limit on a long session. */
  private static readonly NOTIFIED_CAP = 500;

  /** Bound on {@link pendingDecryption}: permanent UTDs (a megolm session that
   * never arrives) are kept pending on purpose for a later retry, so evict the
   * oldest past this cap rather than letting the set grow for the whole session. */
  private static readonly PENDING_DECRYPTION_CAP = 500;

  constructor() {
    // Re-bind listeners to the live account set: attaches to accounts added after
    // run() (e.g. a background account finishing its warm start) and drops ones
    // signed out. No-ops until a session subscription enables us.
    effect(() => {
      const accountIds = this.matrix.accountIds();
      // Reconciliation can synchronously emit a warning to Application Runtime. Its
      // subscriber reads and writes runtime state; allowing those reads to become
      // dependencies of this effect turns a rejected permission into a self-sustaining
      // warning loop. Account membership is the only trigger this effect owns.
      untracked(() => this.reconcile(accountIds));
    });
    this.destroyRef.onDestroy(() => this.stop());
  }

  /**
   * Own notification delivery for one Application Runtime session.
   *
   * Cold and long-lived: subscribing negotiates presentation and attaches every live
   * Account; teardown releases host activation and SDK listeners. Emissions are typed
   * activations or warning diagnostics; the application Workspace alone decides how to
   * open or repair a destination.
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

  /** Present a gateway event using the same account/event ledger as sync notifications. */
  receivePush(data: Readonly<Record<string, unknown>>): Observable<void> {
    return defer(() => {
      const owner = this.connection;
      if (!this.enabled || !owner || !this.presentationReady)
        return of(undefined);
      const payload = parseTrinityPushPayload(data);
      if (!payload || payload.kind !== 'event') return of(undefined);
      return new Observable<void>((subscriber) => {
        // The command belongs to this Runtime session as well as its caller.
        // Stopping either cancels pending storage and presentation observations.
        owner.add(subscriber);
        subscriber.add(() => owner.remove(subscriber));
        return this.sessions
          .getPushAccountRoutes()
          .pipe(
            take(1),
            switchMap((routes) => {
              if (
                !this.enabled ||
                this.connection !== owner ||
                owner.closed ||
                !this.presentationReady
              )
                return of(undefined);
              const route = resolvePushAccountRoute(
                routes,
                payload.accountRoute,
              );
              if (!route || !this.matrix.accountIds().includes(route.accountId))
                return of(undefined);
              const client = this.matrix.clientFor(route.accountId);
              if (!client) return of(undefined);
              const key = this.key(route.accountId, payload.eventId);
              const room = client.getRoom(payload.roomId);
              const decision = this.policy.decide({
                event: {
                  accountId: route.accountId,
                  roomId: payload.roomId,
                  eventId: payload.eventId,
                  senderId: '',
                  senderName: 'New message',
                  roomName: room?.name || null,
                  body: null,
                  kind: 'message',
                },
                viewerId: client.getUserId() ?? route.accountId,
                rules: {
                  notify: true,
                  silent: !payload.sound || !this.sound.isOn(route.accountId),
                },
                visibility: this.visibility.snapshot(),
                duplicate: this.notified.has(key),
              });
              if (decision.kind !== 'present') return of(undefined);
              this.notified.add(key);
              this.evictOldest(this.notified, NotificationService.NOTIFIED_CAP);
              return this.present({
                ...decision.intent,
                title: 'Trinity',
                body: 'New message',
              }).pipe(
                take(1),
                map((outcome) => {
                  if (outcome.kind !== 'completed')
                    this.health.incident(
                      'presentation-command',
                      'notification-presentation-failed',
                    );
                }),
              );
            }),
            catchError(() => {
              this.health.incident(
                'presentation-command',
                'notification-presentation-failed',
              );
              return of(undefined);
            }),
          )
          .subscribe(subscriber);
      });
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
    this.pendingDecryption.clear();
    this.notified.clear();
  }

  /** Attach to accounts that appeared and detach from ones that are gone. */
  private reconcile(ids: readonly string[]): void {
    if (!this.enabled) {
      return;
    }
    if (ids.length === 0) {
      // Stay dormant under the Application Runtime session. This avoids asking for Web
      // permission on the signed-out screen while still allowing a later login to attach
      // without relying on a page component to restart a root capability.
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
        // Same user id can get a NEW client object (re-adding an already signed-in account
        // stops and re-creates it). Holding the old one strands the listener on a stopped
        // client and that account silently stops updating.
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
                    this.presentationPreparing = true;
                    this.presentationConnection.add(
                      this.nativeDelivery
                        .foreground('presentation')
                        .pipe(timeout({ first: 10_000 }))
                        .subscribe({
                          next: () => {
                            if (
                              connection.closed ||
                              this.connection !== connection
                            )
                              return;
                            this.presentationPreparing = false;
                            this.presentationReady = true;
                            this.health.publish(
                              'available',
                              'notification-presentation-ready',
                              'acknowledged',
                              true,
                            );
                            this.reconcile(this.matrix.accountIds());
                          },
                          error: () => this.presentationOwnershipReleased(),
                        }),
                    );
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
    return {
      userId,
      client,
      onSync: (state): void => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          firstSyncCompleted = true;
        }
      },
      onTimeline: (event, room, _toStart, _removed, data): void => {
        // This runs inside the SDK's sync emit loop — a throw must never disrupt it.
        try {
          if (data?.liveEvent !== true) {
            return; // backfill / scrollback — not a fresh event
          }
          if (!firstSyncCompleted) {
            // matrix-js-sdk labels the first /sync batch as live while it is still
            // applying stored room state and history. PREPARED is emitted afterwards.
            return;
          }
          if (this.isAwaitingDecryption(event)) {
            // E2EE: this emit is ciphertext. Defer to MatrixEventEvent.Decrypted so
            // the preview and push rules run against the cleartext.
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
          this.maybeNotify(userId, client, event, room);
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
            return; // not a live event we deferred (e.g. backfill decryption)
          }
          if (event.isDecryptionFailure()) {
            return; // keep it pending for a possible later retry
          }
          this.pendingDecryption.delete(key);
          const room = client.getRoom(event.getRoomId() ?? '') ?? undefined;
          this.maybeNotify(userId, client, event, room, /* force */ true);
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
    notifier.client.off(ClientEvent.Sync, notifier.onSync);
    notifier.client.off(RoomEvent.Timeline, notifier.onTimeline);
    notifier.client.off(MatrixEventEvent.Decrypted, notifier.onDecrypted);
  }

  /** Drop a signed-out account's dedupe entries so a re-add starts clean. */
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

  /** A live encrypted event whose cleartext isn't available yet — wait for the
   * `Decrypted` emit rather than previewing/scoring the ciphertext. */
  private isAwaitingDecryption(event: MatrixEvent): boolean {
    return event.isEncrypted?.() === true && event.getClearContent?.() == null;
  }

  private maybeNotify(
    userId: string,
    client: MatrixClient,
    event: MatrixEvent,
    room: Room | undefined,
    forceRecalculate = false,
  ): void {
    if (!room) {
      return;
    }
    // Respect the account's push rules (mute / mentions-only / etc.).
    // `forceRecalculate` is set on the decrypted path so the rules score the
    // cleartext (mentions) rather than a cached ciphertext result.
    const normalized = normalizeNotificationEvent(userId, event, room);
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
      duplicate: this.notified.has(key),
    });
    if (decision.kind === 'suppress') return;
    this.notified.add(key);
    this.evictOldest(this.notified, NotificationService.NOTIFIED_CAP);
    const intent =
      this.nativePush.platform === 'android' && this.gateway.configured()
        ? { ...decision.intent, title: 'Trinity', body: 'New message' }
        : decision.intent;
    const subscription = this.present(intent)
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

  /** Share Android presentation ownership with the native process-absent path. */
  private present(
    intent: NotificationIntent,
  ): Observable<HostOperationOutcome> {
    const owner = this.connection;
    const { accountId, eventId } = intent.destination;
    const client = this.matrix.clientFor(accountId);
    const isCurrent = () =>
      !!owner &&
      !owner.closed &&
      this.connection === owner &&
      this.enabled &&
      this.presentationReady &&
      !!client &&
      this.matrix.clientFor(accountId) === client &&
      this.matrix.accountIds().includes(accountId);
    const suppressed = (): Observable<HostOperationOutcome> =>
      of({ kind: 'completed' });

    return defer(() => {
      if (!isCurrent()) return suppressed();
      const claim =
        this.nativePush.platform === 'android' && this.gateway.configured()
          ? this.sessions.getPushAccountRoutes().pipe(
              take(1),
              switchMap((routes) => {
                const route = routes.find(
                  (entry) => entry.accountId === accountId,
                );
                // Before a device token exists this Account has no gateway route, so
                // native delivery cannot own its events. Keep normal sync alerts working.
                return route
                  ? this.nativeDelivery.claimPresentation(
                      route.route,
                      eventId,
                      intent.silent === true,
                    )
                  : of(true);
              }),
            )
          : of(true);
      return claim.pipe(
        take(1),
        switchMap((claimed) =>
          claimed && isCurrent()
            ? this.presenter.present(intent)
            : suppressed(),
        ),
      );
    });
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

  /** Namespace a dedupe key by account so two accounts don't share event ids. */
  private key(userId: string, eventId: string): string {
    return `${userId} ${eventId}`;
  }

  /** Drop the oldest entry once a bounded set exceeds its cap (FIFO). */
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
