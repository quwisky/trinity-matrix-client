import { Injectable, InjectionToken, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Observable, defer } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { SessionStorageService } from '@trinity/platform-native';

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

/** Pusher `data` key carrying the owning account's user id (see docs/PUSH.md). The
 * gateway must forward this from `devices[].data` into the delivered push payload so
 * a tap can switch to the right account. */
const ACCOUNT_DATA_KEY = 'trinity_user_id';

/**
 * Registers the device for OS push (FCM/APNs via `@capacitor/push-notifications`)
 * and a matching **Matrix pusher on every signed-in account** so each account's
 * homeserver routes its notifications through the configured push gateway. All
 * accounts share the one device token (pushkey); each pusher tags itself with its
 * account's user id in `data` so the gateway can fan out to the right account and a
 * tap can switch to it. Native-only and config-gated: a no-op on web/desktop or when
 * no {@link PushConfig} is provided.
 *
 * Pair {@link register} (called once the shell is live — it also re-applies pushers
 * for accounts added later) with {@link unregister} (a single account on per-account
 * sign-out, or all on full logout) to delete the pusher(s).
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly matrix = inject(MatrixClientService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly storage = inject(SessionStorageService);
  private readonly config = inject(PUSH_CONFIG, { optional: true });

  /** The device push token (FCM/APNs), shared by every account's pusher. */
  private currentPushkey: string | null = null;
  private listenersAttached = false;
  /** Guards the one-time OS-registration flow (permission + token request). */
  private registered = false;

  /**
   * Request OS push permission, register for a device token, and register a Matrix
   * pusher on every account. Idempotent + best-effort: once the token is known a
   * repeat call just re-applies pushers for all accounts (covering any added since),
   * so the authenticated shell can call it on every mount. No-op when push isn't
   * available/configured.
   */
  register(): Observable<void> {
    return defer(async () => {
      if (!this.canPush()) {
        return;
      }
      // Token already in hand (e.g. a shell re-mount after adding an account):
      // (re)register a pusher for every account, covering any newly-added ones.
      if (this.currentPushkey) {
        await this.setPushers(this.currentPushkey);
        return;
      }
      if (this.registered) {
        return; // the OS-registration flow is already in progress
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
   * Delete pusher(s). With a `userId`, remove just that account's pusher (on
   * per-account sign-out) while the others keep theirs. Without one, tear everything
   * down — remove every account's pusher and detach listeners (full logout / reset).
   * Run before the access token is invalidated so the gateway stops delivering.
   */
  unregister(userId?: string): Observable<void> {
    return defer(async () => {
      const pushkey = this.currentPushkey;
      if (userId) {
        if (pushkey && this.config) {
          await this.matrix
            .clientFor(userId)
            ?.removePusher(pushkey, this.appId())
            .catch(() => undefined);
        }
        return;
      }
      this.currentPushkey = null;
      this.registered = false;
      if (this.listenersAttached) {
        // Never let teardown reject — logout chains on this and must complete.
        await PushNotifications.removeAllListeners().catch(() => undefined);
        this.listenersAttached = false;
      }
      if (pushkey && this.config) {
        for (const account of this.matrix.all()) {
          await account.client
            .removePusher(pushkey, this.appId())
            .catch(() => undefined);
        }
      }
    });
  }

  private canPush(): boolean {
    // Gate on the concrete mobile platforms. On web — and inside the hand-rolled
    // Electron desktop shell, where `getPlatform()` is also `'web'` — there is no
    // push plugin, so this keeps push a no-op everywhere except real iOS/Android.
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
      void this.setPushers(token.value).catch(() => undefined);
    });
    await PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action) => {
        // Plugin callbacks fire outside Angular's zone — run navigation inside it.
        const data = action?.notification?.data as
          Record<string, unknown> | undefined;
        this.zone.run(() => this.openFromPush(data));
      },
    );
  }

  /** Register (or refresh) a pusher for every signed-in account with `pushkey`. */
  private async setPushers(pushkey: string): Promise<void> {
    if (!this.config) {
      return;
    }
    this.currentPushkey = pushkey;
    for (const account of this.matrix.all()) {
      // `event_id_only` keeps message content off the gateway; the client fetches the
      // event after sync. `trinity_user_id` tags the pusher so the gateway can fan out
      // to the right account and a tap can switch to it (see docs/PUSH.md). Built as a
      // value, not an inline literal: the Matrix spec allows extra `data` keys but the
      // SDK types the field narrowly (`{ url, format, brand }`).
      const data = {
        url: this.config.gatewayUrl,
        format: 'event_id_only',
        [ACCOUNT_DATA_KEY]: account.userId,
      };
      await account.client
        .setPusher({
          app_id: this.appId(),
          pushkey,
          kind: 'http',
          app_display_name: 'Trinity',
          device_display_name: account.client.getDeviceId() ?? 'Trinity',
          lang: 'en',
          data,
          // `append: false` replaces a stale pusher for this key on this account.
          append: false,
        })
        .catch(() => undefined);
    }
  }

  /** Tap on a delivered push: switch to the owning account (if tagged) and open. */
  private openFromPush(data: Record<string, unknown> | undefined): void {
    const userId =
      typeof data?.[ACCOUNT_DATA_KEY] === 'string'
        ? (data[ACCOUNT_DATA_KEY] as string)
        : null;
    const roomId =
      typeof data?.['room_id'] === 'string'
        ? (data['room_id'] as string)
        : null;

    if (
      userId &&
      userId !== this.matrix.activeUserId() &&
      this.matrix.accountIds().includes(userId)
    ) {
      this.matrix.setActive(userId);
      this.storage.setActive(userId).subscribe({ error: () => undefined });
    }
    const navigate = roomId
      ? this.router.navigate(['/rooms'], { queryParams: { room: roomId } })
      : this.router.navigate(['/rooms']);
    void navigate.catch(() => undefined);
  }
}
