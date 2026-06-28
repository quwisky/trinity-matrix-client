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

/** Max characters of message body shown in a notification. */
const PREVIEW_LIMIT = 140;

/**
 * Surfaces incoming messages as desktop/web OS notifications via the web
 * `Notification` API, driven by the live sync stream. This is the **desktop +
 * web/PWA** path — on mobile (iOS/Android) push notifications handle delivery, so
 * this is a no-op there (`isNativePlatform()`); in the hand-rolled Electron shell
 * `isNativePlatform()` is false, so it runs and maps to native OS notifications.
 *
 * Only fires for **live** events (not backfill), from someone other than us, while
 * the window is **unfocused**, and only when the user's push rules say to notify
 * (`getPushActionsForEvent().notify` — respects mutes / mentions-only). A tap
 * focuses the window and opens the app.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);

  /** The client the listener is attached to, so disconnect targets the same one. */
  private connectedClient: MatrixClient | null = null;

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
    if (Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    client.on(RoomEvent.Timeline, this.onTimeline);
  }

  disconnect(): void {
    this.connectedClient?.off(RoomEvent.Timeline, this.onTimeline);
    this.connectedClient = null;
  }

  /** Notifications use the web Notification API; skip on native mobile (push owns
   * delivery there) and where the API is unavailable. */
  private canNotify(): boolean {
    return typeof Notification !== 'undefined' && !Capacitor.isNativePlatform();
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
    if (Notification.permission !== 'granted') {
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
    // `tag` collapses repeated notifications from the same room.
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
}
