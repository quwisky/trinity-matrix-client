import { Injectable, NgZone, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import {
  MatrixEventEvent,
  RoomEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { TimelineService } from '@trinity/data-access-timeline';
import { SessionStorageService } from '@trinity/platform-native';
import { getTrinityDesktopBridge } from '@trinity/platform-native';

/** Max characters of message body shown in a notification. */
const PREVIEW_LIMIT = 140;

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
 * the **desktop + web/PWA** path — on mobile (iOS/Android) push notifications handle
 * delivery, so this is a no-op there (`isNativePlatform()`).
 *
 * Two delivery backends, selected at runtime:
 *  - **Desktop (hand-rolled Electron):** the preload `trinityDesktop` bridge is
 *    present, so notifications are routed through the MAIN process
 *    (`showNotification`). Renderer Web `Notification`s from Electron are
 *    unreliably surfaced/attributed by the OS (notably macOS), so the main
 *    process owns them; clicks come back over `onNotificationClick`.
 *  - **Web / PWA:** the renderer Web `Notification` API (with permission prompt).
 *
 * Either way it only fires for **live** events (not backfill), from someone other
 * than us, when the user isn't looking at that room (the window is unfocused, a
 * different room is open, or the event is on a background account), and only when
 * that account's push rules say to notify (`getPushActionsForEvent().notify` —
 * respects mutes / mentions-only). A click switches to the owning account, focuses
 * the window, and opens the room.
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
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly timeline = inject(TimelineService);
  private readonly storage = inject(SessionStorageService);

  /** Whether {@link connect} has enabled us (and thus reconcile may attach). */
  private enabled = false;

  /** Per-account listeners, keyed by user id, so switches/sign-outs re-bind cleanly. */
  private readonly notifiers = new Map<string, AccountNotifier>();

  /** Unsubscribe for the desktop notification-click bridge, when on Electron. */
  private notificationClickUnsubscribe: (() => void) | null = null;

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
    // connect() (e.g. a background account finishing its warm start) and drops ones
    // signed out. No-ops until connect() enables us.
    effect(() => this.reconcile(this.matrix.accountIds()));
  }

  /** Attach to every account's live timeline + request permission. Idempotent; pair
   * with {@link disconnect}. Call once the clients are live (from the rooms shell). */
  connect(): void {
    if (this.enabled) {
      return;
    }
    if (!this.canNotify() || !this.matrix.isInitialized) {
      return;
    }
    this.enabled = true;

    const desktop = getTrinityDesktopBridge();
    if (typeof desktop?.showNotification === 'function') {
      // Desktop (Electron): the main process surfaces the toast and forwards the
      // clicked room id + account back over this bridge. No Web permission concept
      // applies (Electron auto-grants), so we don't prompt here.
      if (typeof desktop.onNotificationClick === 'function') {
        this.notificationClickUnsubscribe = desktop.onNotificationClick(
          (roomId, userId) => this.openFromNotification(roomId, userId),
        );
      }
    } else if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    ) {
      // Web / PWA: ask once for permission (never reached inside Electron).
      void Notification.requestPermission();
    }

    this.reconcile(this.matrix.accountIds());
  }

  disconnect(): void {
    this.enabled = false;
    this.notificationClickUnsubscribe?.();
    this.notificationClickUnsubscribe = null;
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
    const live = new Set(ids);
    for (const [userId, notifier] of this.notifiers) {
      if (!live.has(userId)) {
        this.detach(notifier);
        this.notifiers.delete(userId);
        this.forgetAccount(userId);
      }
    }
    for (const userId of ids) {
      if (this.notifiers.has(userId)) {
        continue;
      }
      const client = this.matrix.clientFor(userId);
      if (!client) {
        continue; // not fully started yet; a later accountIds tick re-checks it
      }
      const notifier = this.buildNotifier(userId, client);
      this.attach(notifier);
      this.notifiers.set(userId, notifier);
    }
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

  /** Skip on native mobile (push owns delivery there). Otherwise we can notify
   * when the Electron desktop bridge is present, or when the Web Notification API
   * is available. */
  private canNotify(): boolean {
    if (Capacitor.isNativePlatform()) {
      return false;
    }
    if (typeof getTrinityDesktopBridge()?.showNotification === 'function') {
      return true;
    }
    return typeof Notification !== 'undefined';
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
    if (event.getSender() === client.getUserId()) {
      return; // our own message
    }
    // Suppress only when the user is actually looking at THIS room on THIS account:
    // the window is focused, this is the active account, AND that room is open in the
    // timeline. A message to any other room, or to a background account, still notifies.
    const focused = typeof document !== 'undefined' && document.hasFocus();
    const isActiveAccount = this.matrix.activeUserId() === userId;
    if (
      focused &&
      isActiveAccount &&
      room.roomId === this.timeline.openRoomId
    ) {
      return;
    }
    // The Web permission gate only applies to the Web backend; the desktop
    // bridge has no permission concept (the main process owns delivery).
    const onDesktop =
      typeof getTrinityDesktopBridge()?.showNotification === 'function';
    if (!onDesktop && Notification.permission !== 'granted') {
      return;
    }
    // Respect the account's push rules (mute / mentions-only / etc.).
    // `forceRecalculate` is set on the decrypted path so the rules score the
    // cleartext (mentions) rather than a cached ciphertext result.
    if (!client.getPushActionsForEvent(event, forceRecalculate)?.notify) {
      return;
    }
    // Notify each event at most once per account (Timeline + Decrypted can both fire).
    const id = event.getId();
    if (id) {
      const key = this.key(userId, id);
      if (this.notified.has(key)) {
        return;
      }
      this.notified.add(key);
      this.evictOldest(this.notified, NotificationService.NOTIFIED_CAP);
    }

    const sender = event.sender?.name ?? event.getSender() ?? 'Someone';
    const raw = (event.getContent()?.['body'] ?? '') as string;
    const preview =
      typeof raw === 'string' && raw.trim()
        ? raw.trim().slice(0, PREVIEW_LIMIT)
        : 'New message';
    const title = room.name ? `${sender} · ${room.name}` : sender;
    this.show(title, preview, room.roomId, userId);
  }

  private show(
    title: string,
    body: string,
    roomId: string,
    userId: string,
  ): void {
    // Collapse per account+room: a newer message from the same room on the same
    // account replaces the previous still-open toast, while the same room on another
    // account stays a separate toast.
    const tag = `${userId} ${roomId}`;
    const desktop = getTrinityDesktopBridge();
    if (typeof desktop?.showNotification === 'function') {
      // Desktop (Electron): hand off to the main process. The click is delivered
      // back via onNotificationClick (subscribed in connect()) with the userId so a
      // tap can switch accounts before opening the room.
      desktop.showNotification({ title, body, tag, roomId, userId });
      return;
    }

    const options: NotificationOptions = {
      body,
      tag,
      data: { roomId, userId },
    };

    // Mobile browsers (Android Chrome, etc.) only allow notifications through
    // the service worker's registration — `new Notification()` throws there.
    // When a SW controls the page, show via the registration; otherwise use the
    // renderer constructor (desktop browsers), falling back if the SW path fails.
    if (
      typeof navigator !== 'undefined' &&
      navigator.serviceWorker?.controller
    ) {
      void navigator.serviceWorker.ready
        .then((registration) => registration.showNotification(title, options))
        .catch(() => this.showViaConstructor(title, options, roomId, userId));
      return;
    }

    this.showViaConstructor(title, options, roomId, userId);
  }

  /**
   * Renderer Web `Notification` constructor path (desktop browsers). A throw
   * here means the browser doesn't support constructor notifications (mobile),
   * so it's swallowed as "unsupported" rather than bubbling to the sync loop.
   */
  private showViaConstructor(
    title: string,
    options: NotificationOptions,
    roomId: string,
    userId: string,
  ): void {
    let notification: Notification;
    try {
      notification = new Notification(title, options);
    } catch {
      return; // unsupported (e.g. mobile browser) — nothing more to do
    }
    notification.onclick = (): void => {
      // The OS-notification click fires outside Angular's zone.
      this.openFromNotification(roomId, userId);
      notification.close();
    };
  }

  /**
   * Handle a notification click: switch to the account it belongs to (if any),
   * bring the window forward, and route into the room. Runs inside Angular's zone —
   * both the Web `onclick` and the desktop IPC callback fire outside it. On desktop
   * the main process has already focused the OS window.
   */
  private openFromNotification(roomId: string, userId?: string): void {
    this.zone.run(() => {
      try {
        window.focus();
      } catch {
        /* focus may be blocked — ignore */
      }
      if (
        userId &&
        userId !== this.matrix.activeUserId() &&
        this.matrix.accountIds().includes(userId)
      ) {
        this.matrix.setActive(userId);
        this.storage.setActive(userId).subscribe({ error: () => undefined });
      }
      void this.router
        .navigate(['/rooms'], { queryParams: { room: roomId } })
        .catch(() => undefined);
    });
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
