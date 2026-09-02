import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import {
  MatrixEventEvent,
  RoomEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { NotificationSoundService } from './notification-sound.service';
import { Observable, Subscriber, Subscription, take } from 'rxjs';
import { normalizeNotificationEvent } from './matrix-notification-event.adapter';
import type { NotificationRuntimeEvent } from './notification-intent';
import { NotificationPolicy } from './notification-policy';
import { NotificationPresenterService } from './notification-presenter.service';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';

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
 * Either way it only fires after the Account's first sync transition and for **live**
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
  private runtimeSubscriber: Subscriber<NotificationRuntimeEvent> | null = null;

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
      this.reconcile(this.matrix.accountIds());
      return () => this.stop(connection);
    });
  }

  private stop(owner = this.connection): void {
    if (owner !== this.connection) return;
    this.connection?.unsubscribe();
    this.connection = null;
    this.runtimeSubscriber = null;
    this.enabled = false;
    this.presentationReady = false;
    this.presentationPreparing = false;
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
    const connection = this.connection;
    connection.add(
      this.presenter
        .support()
        .pipe(take(1))
        .subscribe({
          next: (support) => {
            if (connection.closed) return;
            if (support.kind === 'unavailable') {
              this.presentationPreparing = false;
              if (
                support.reason !== 'not-supported' &&
                support.reason !== 'not-implemented'
              ) {
                this.warn('notification-presentation-unavailable');
              }
              return;
            }
            connection.add(
              this.presenter.activated.subscribe({
                next: (destination) =>
                  this.runtimeSubscriber?.next({
                    kind: 'activated',
                    destination,
                  }),
                error: () =>
                  this.warn('notification-activation-listener-failed'),
              }),
            );
            connection.add(
              this.presenter
                .requestPermission()
                .pipe(take(1))
                .subscribe({
                  next: (outcome) => {
                    this.presentationPreparing = false;
                    if (connection.closed) return;
                    if (outcome.kind !== 'completed') {
                      if (
                        outcome.kind === 'rejected' ||
                        (outcome.reason !== 'not-supported' &&
                          outcome.reason !== 'not-implemented')
                      ) {
                        this.warn('notification-permission-failed');
                      }
                      return;
                    }
                    this.presentationReady = true;
                    this.reconcile(this.matrix.accountIds());
                  },
                  error: () => {
                    this.presentationPreparing = false;
                    this.warn('notification-permission-failed');
                  },
                }),
            );
          },
          error: () => {
            this.presentationPreparing = false;
            this.warn('notification-presentation-negotiation-failed');
          },
        }),
    );
  }

  private buildNotifier(userId: string, client: MatrixClient): AccountNotifier {
    return {
      userId,
      client,
      onTimeline: (event, room, _toStart, _removed, data): void => {
        // This runs inside the SDK's sync emit loop — a throw must never disrupt it.
        try {
          if (data?.liveEvent !== true) {
            return; // backfill / scrollback — not a fresh event
          }
          if (client.getSyncState() === null) {
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
    notifier.client.on(RoomEvent.Timeline, notifier.onTimeline);
    notifier.client.on(MatrixEventEvent.Decrypted, notifier.onDecrypted);
  }

  private detach(notifier: AccountNotifier): void {
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
    const subscription = this.presenter
      .present(decision.intent)
      .pipe(take(1))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'completed') {
            this.warn('notification-presentation-failed');
          }
        },
        error: () => this.warn('notification-presentation-failed'),
      });
    this.connection?.add(subscription);
  }

  private warn(code: string): void {
    this.runtimeSubscriber?.next({ kind: 'warning', diagnostic: { code } });
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
