import { Injectable, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import {
  RoomEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { MatrixClientService } from './matrix-client.service';
import { getTrinityDesktopBridge } from '../platform/trinity-desktop-bridge';

/** Max characters of message body shown in a notification. */
const PREVIEW_LIMIT = 140;

/**
 * Surfaces incoming messages as native OS notifications, driven by the live sync
 * stream. This is the **desktop + web/PWA** path — on mobile (iOS/Android) push
 * notifications handle delivery, so this is a no-op there (`isNativePlatform()`).
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
 * than us, while the window is **unfocused**, and only when the user's push rules
 * say to notify (`getPushActionsForEvent().notify` — respects mutes /
 * mentions-only). A click focuses the window and opens the app.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);

  /** The client the listener is attached to, so disconnect targets the same one. */
  private connectedClient: MatrixClient | null = null;

  /** Unsubscribe for the desktop notification-click bridge, when on Electron. */
  private notificationClickUnsubscribe: (() => void) | null = null;

  private readonly onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    _toStartOfTimeline: boolean | undefined,
    _removed: boolean | undefined,
    data?: IRoomTimelineData,
  ): void => {
    // This runs inside the SDK's sync emit loop — a throw must never disrupt it.
    try {
      this.maybeNotify(event, room, data);
    } catch {
      /* a notification failure is non-fatal */
    }
  };

  /** Attach to live timeline events + request permission. Idempotent; pair with
   * {@link disconnect}. Call once the client is live (from the rooms shell). */
  connect(): void {
    if (!this.canNotify() || !this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    if (this.connectedClient === client) {
      return;
    }
    this.disconnect();
    this.connectedClient = client;

    const desktop = getTrinityDesktopBridge();
    if (typeof desktop?.showNotification === 'function') {
      // Desktop (Electron): the main process surfaces the toast and forwards the
      // clicked room id back over this bridge. No Web permission concept applies
      // (Electron auto-grants), so we don't prompt here.
      if (typeof desktop.onNotificationClick === 'function') {
        this.notificationClickUnsubscribe = desktop.onNotificationClick(
          (roomId) => this.openFromNotification(roomId),
        );
      }
    } else if (Notification.permission === 'default') {
      // Web / PWA: ask once for permission (never reached inside Electron).
      void Notification.requestPermission();
    }

    client.on(RoomEvent.Timeline, this.onTimeline);
  }

  disconnect(): void {
    this.notificationClickUnsubscribe?.();
    this.notificationClickUnsubscribe = null;
    this.connectedClient?.off(RoomEvent.Timeline, this.onTimeline);
    this.connectedClient = null;
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
    event: MatrixEvent,
    room: Room | undefined,
    data?: IRoomTimelineData,
  ): void {
    const client = this.connectedClient;
    if (!client || !room) {
      return;
    }
    if (data?.liveEvent !== true) {
      return; // backfill / scrollback — not a fresh event
    }
    if (event.getSender() === client.getUserId()) {
      return; // our own message
    }
    if (typeof document !== 'undefined' && document.hasFocus()) {
      return; // the user is already looking at the app
    }
    // The Web permission gate only applies to the Web backend; the desktop
    // bridge has no permission concept (the main process owns delivery).
    const onDesktop =
      typeof getTrinityDesktopBridge()?.showNotification === 'function';
    if (!onDesktop && Notification.permission !== 'granted') {
      return;
    }
    // Respect the account's push rules (mute / mentions-only / etc.).
    if (!client.getPushActionsForEvent(event)?.notify) {
      return;
    }

    const sender = event.sender?.name ?? event.getSender() ?? 'Someone';
    const raw = (event.getContent()?.['body'] ?? '') as string;
    const preview =
      typeof raw === 'string' && raw.trim()
        ? raw.trim().slice(0, PREVIEW_LIMIT)
        : 'New message';
    const title = room.name ? `${sender} · ${room.name}` : sender;
    this.show(title, preview, room.roomId);
  }

  private show(title: string, body: string, roomId: string): void {
    const desktop = getTrinityDesktopBridge();
    if (typeof desktop?.showNotification === 'function') {
      // Desktop (Electron): hand off to the main process. `tag` (= roomId)
      // collapses repeated notifications from the same room; the click is
      // delivered back via onNotificationClick (subscribed in connect()).
      desktop.showNotification({ title, body, tag: roomId, roomId });
      return;
    }

    // Web / PWA: the renderer Web Notification API. `tag` collapses repeated
    // notifications from the same room.
    const notification = new Notification(title, { body, tag: roomId });
    notification.onclick = (): void =>
      // The OS-notification click fires outside Angular's zone.
      this.zone.run(() => {
        try {
          window.focus();
        } catch {
          /* focus may be blocked — ignore */
        }
        void this.router.navigate(['/rooms']).catch(() => undefined);
        notification.close();
      });
  }

  /**
   * Handle a desktop notification click forwarded by the main process (which has
   * already focused the OS window). Runs inside Angular's zone — the IPC callback
   * fires outside it. Brings the renderer to the foreground and routes into the
   * room list; `roomId` rides along (and is the collapse key on desktop) for
   * future per-room deep-linking.
   */
  private openFromNotification(roomId: string): void {
    this.zone.run(() => {
      try {
        window.focus();
      } catch {
        /* focus may be blocked — ignore */
      }
      void this.router
        .navigate(['/rooms'], { queryParams: { room: roomId } })
        .catch(() => undefined);
    });
  }
}
