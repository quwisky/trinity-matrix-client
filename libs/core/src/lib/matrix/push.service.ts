import { Injectable, InjectionToken, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Observable, defer } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';

/**
 * Deployment-specific push config the app provides (see `environment.push`). Null
 * disables push entirely. `appId` is the base id registered with the push gateway
 * (Sygnal); the per-platform id (`<appId>.ios` / `.android`) is derived at runtime.
 */
export interface PushConfig {
  /** The gateway's notify endpoint, e.g. `https://push.example/_matrix/push/v1/notify`. */
  gatewayUrl: string;
  /** Base app id, e.g. `eu.qwky.trinity`. */
  appId: string;
}

export const PUSH_CONFIG = new InjectionToken<PushConfig | null>('PUSH_CONFIG');

/**
 * Registers the device for OS push (FCM/APNs via `@capacitor/push-notifications`)
 * and a matching **Matrix pusher** so the homeserver routes notifications through
 * the configured push gateway. Native-only and config-gated: a no-op on web/desktop
 * or when no {@link PushConfig} is provided (so the app degrades to in-app/sync
 * updates). Pair {@link register} (called once the client is live) with
 * {@link unregister} (on logout) to delete the pusher.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly config = inject(PUSH_CONFIG, { optional: true });

  /** The pushkey (device token) of the pusher we registered, for later removal. */
  private currentPushkey: string | null = null;
  private listenersAttached = false;
  /** Guards against re-running the OS-registration flow on every shell mount. */
  private registered = false;

  /**
   * Request OS push permission, register for a device token, and (on the token
   * callback) register a Matrix pusher. Idempotent + best-effort: callers can
   * subscribe-and-forget. No-op when push isn't available/configured.
   */
  register(): Observable<void> {
    return defer(async () => {
      if (this.registered || !this.canPush()) {
        return;
      }
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== 'granted') {
        return;
      }
      this.registered = true;
      // Android O+ silently drops notifications without a channel.
      if (Capacitor.getPlatform() === 'android') {
        await PushNotifications.createChannel({
          id: 'messages',
          name: 'Messages',
          importance: 5,
          visibility: 1,
        }).catch(() => undefined);
      }
      await this.attachListeners();
      // Fires the `registration` listener with the FCM/APNs token.
      await PushNotifications.register();
    });
  }

  /**
   * Delete the Matrix pusher and detach listeners. Run on logout BEFORE the access
   * token is invalidated so the gateway stops receiving pushes for this device.
   */
  unregister(): Observable<void> {
    return defer(async () => {
      const pushkey = this.currentPushkey;
      this.currentPushkey = null;
      this.registered = false;
      if (this.listenersAttached) {
        // Never let teardown reject — logout chains on this and must complete.
        await PushNotifications.removeAllListeners().catch(() => undefined);
        this.listenersAttached = false;
      }
      if (pushkey && this.config && this.matrix.isInitialized) {
        await this.matrix.instance
          .removePusher(pushkey, this.appId())
          .catch(() => undefined);
      }
    });
  }

  private canPush(): boolean {
    // NB: gate on the concrete mobile platforms, NOT `isNativePlatform()` —
    // `@capacitor-community/electron` reports `isNativePlatform() === true` but has
    // no push plugin, so the looser check would throw on desktop.
    const platform = Capacitor.getPlatform();
    return (
      !!this.config &&
      this.matrix.isInitialized &&
      (platform === 'ios' || platform === 'android') &&
      Capacitor.isPluginAvailable('PushNotifications')
    );
  }

  /** Per-platform app id the gateway is keyed by, e.g. `eu.qwky.trinity.ios`. */
  private appId(): string {
    return `${this.config?.appId}.${Capacitor.getPlatform()}`;
  }

  private async attachListeners(): Promise<void> {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    await PushNotifications.addListener('registration', (token) => {
      void this.setPusher(token.value).catch(() => undefined);
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', () =>
      // Plugin callbacks fire outside Angular's zone — run navigation inside it so
      // the view renders. Sygnal's `event_id_only` payload carries room_id/event_id;
      // for now a tap just opens the app (room-targeted routing is a follow-up).
      this.zone.run(
        () => void this.router.navigate(['/rooms']).catch(() => undefined),
      ),
    );
  }

  private async setPusher(pushkey: string): Promise<void> {
    if (!this.config) {
      return;
    }
    this.currentPushkey = pushkey;
    const client = this.matrix.instance;
    await client.setPusher({
      app_id: this.appId(),
      pushkey,
      kind: 'http',
      app_display_name: 'Trinity',
      device_display_name: client.getDeviceId() ?? 'Trinity',
      lang: 'en',
      // `event_id_only` keeps message content off the gateway; the client fetches
      // the event after sync. `append: false` replaces any stale pusher for this key.
      data: { url: this.config.gatewayUrl, format: 'event_id_only' },
      append: false,
    });
  }
}
