import { Injectable, computed, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  finalize,
  firstValueFrom,
  ignoreElements,
  mergeMap,
  of,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { engineFailureMessage } from '@trinity/util/matrix';
import {
  NativePushRegistrationService,
  type NativePushRegistrationEvent,
} from '@trinity/platform-native';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { DEFAULT_APP_ID, PUSH_CONFIG } from './push-config';

/** Semantic destination emitted by a native notification tap. */
export interface NativePushActivation {
  readonly accountId?: string;
  readonly roomId?: string;
  readonly eventId?: string;
}

/** Pusher `data` key carrying the owning account's user id (see docs-internal/maintenance/push-notifications.md). The
 * gateway must forward it from `devices[].data` into the push payload so a tap can switch account. */
const ACCOUNT_DATA_KEY = 'trinity_user_id';
/** Pusher `data` key choosing the gateway's render mode (see the gateway README). */
const RENDER_DATA_KEY = 'trinity_render';
/** Data-only on Android, mutable-content on iOS: the device fetches and renders the event. */
const DEVICE_RENDER = 'device';

/**
 * Outcome of the most recent pusher-registration round, for the settings UI.
 *
 * `applied` counts the accounts a pusher was registered for and stamps when; `error`
 * carries why the first account failed. A discriminated union, so "succeeded and failed" is
 * unrepresentable; don't split it into two signals.
 *
 * `applied` means the homeservers accepted the pushers, not that a notification will
 * arrive: the gateway → FCM/APNs → device leg cannot be observed from the client, so the UI
 * must not present this as "push is working".
 */
export type PushRegistrationState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'applied';
      readonly accounts: number;
      readonly at: number;
    }
  | { readonly status: 'error'; readonly message: string };

/** Value-free runtime status; unlike settings copy, safe to copy into diagnostics. */
export type PushRuntimeStatus =
  | { readonly status: 'idle'; readonly code: 'push-registration-idle' }
  | { readonly status: 'available'; readonly code: 'push-registration-ready' }
  /** The host cannot request a token (an Android build without Firebase): not an error. */
  | {
      readonly status: 'unsupported';
      readonly code: 'push-registration-unsupported';
    }
  | {
      readonly status: 'disabled' | 'degraded';
      readonly code:
        | 'push-permission-disabled'
        | 'push-device-registration-failed'
        | 'push-pusher-registration-failed'
        | 'push-pusher-verification-failed';
    };

/** Shown when a pusher call faulted rather than failing with a reason. */
const PUSHER_FAULT = 'Could not reach the homeserver.';

/** Shown when the OS/FCM/APNs side of registration fails, rather than the homeserver. */
const DEVICE_REGISTRATION_FAILED =
  'The device could not register for push notifications.';

/** Best text from a rejected `PushNotifications.register()`: a plugin/OS failure, not the
 * homeserver's. */
function deviceErrorMessage(err: unknown): string {
  const message =
    err && typeof err === 'object'
      ? (err as { message?: unknown }).message
      : null;
  return typeof message === 'string' && message
    ? message
    : DEVICE_REGISTRATION_FAILED;
}

/**
 * Registers the device for OS push (FCM/APNs via `@capacitor/push-notifications`) and a
 * matching **Matrix pusher on every signed-in account**, so each homeserver routes its
 * notifications through the configured push gateway. All accounts share the one device
 * token (pushkey); each pusher tags its account's user id in `data`. Native-only and
 * config-gated: a no-op on web/desktop or when no `PushConfig` is provided.
 *
 * Pair {@link register} (which also re-applies pushers for accounts added later) with
 * {@link unregister} (one account on sign-out, or all on full logout).
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly nativePush = inject(NativePushRegistrationService);
  /** The build's gateway (`environment.push`); null builds without native push. */
  private readonly config = inject(PUSH_CONFIG, { optional: true });

  /** The device push token (FCM/APNs), shared by every account's pusher. */
  private currentPushkey: string | null = null;
  /** Guards the one-time OS-registration flow (permission + token request). */
  private registered = false;

  private readonly _registration = signal<PushRegistrationState>({
    status: 'idle',
  });
  /** The most recent registration outcome. Updated on every `setPushers()` round; reset to idle when all pushers are torn down. */
  readonly registration = this._registration.asReadonly();
  private readonly _runtimeStatus = signal<PushRuntimeStatus>({
    status: 'idle',
    code: 'push-registration-idle',
  });
  readonly runtimeStatus = this._runtimeStatus.asReadonly();
  /**
   * Who shows a notification while the app is in the background. On Android, once every
   * account's pusher carries this device's token, `push`: TrinityMessagingService renders
   * background and closed-app pushes itself, so the running app must not show a second
   * notification for the same message. Everywhere else (iOS, web, desktop, and Android
   * before registration succeeds or after it fails or is torn down) `app`.
   */
  readonly backgroundDelivery = computed<'app' | 'push'>(() =>
    this.nativePush.platform === 'android' &&
    this._runtimeStatus().status === 'available'
      ? 'push'
      : 'app',
  );

  runtimePrerequisite():
    'ready' | 'unsupported' | 'not-configured' | 'no-account' {
    if (!this.nativePush.supported()) return 'unsupported';
    if (!this.config) return 'not-configured';
    if (!this.signedIn()) return 'no-account';
    return 'ready';
  }

  /**
   * Own native callbacks for one Application Runtime session and expose only semantic
   * activation destinations. Listener setup precedes OS registration; teardown is tied to
   * the returned cold Observable.
   */
  run(): Observable<NativePushActivation> {
    return defer(() => {
      if (!this.nativePush.supported()) return EMPTY;
      return this.nativePush.listen().pipe(
        mergeMap((event) => this.handleNativeEvent(event)),
        finalize(() => {
          // A token callback after teardown is ignored; release the guard so a later
          // session can register afresh.
          this.registered = false;
        }),
      );
    });
  }

  /**
   * Request OS push permission, register for a device token, and register a Matrix
   * pusher on every account. Idempotent and best-effort: once the token is known a repeat
   * call just re-applies pushers for all accounts. No-op when push isn't
   * available/configured.
   */
  register(): Observable<void> {
    return defer(async () => {
      if (!this.canPush()) {
        return;
      }
      if (this.currentPushkey) {
        await this.setPushers(this.currentPushkey);
        return;
      }
      if (this.registered) {
        return; // the OS-registration flow is already in progress
      }
      // Claim the flow before the asynchronous permission request so simultaneous
      // startup/settings calls cannot both reach the native register command.
      this.registered = true;
      let permission: boolean;
      try {
        permission = await firstValueFrom(this.nativePush.requestPermission());
      } catch (error) {
        this.registered = false;
        this._registration.set({
          status: 'error',
          message: deviceErrorMessage(error),
        });
        this._runtimeStatus.set({
          status: 'degraded',
          code: 'push-device-registration-failed',
        });
        return;
      }
      if (!permission) {
        this.registered = false;
        // Mobile push is the only delivery path, so "denied" and "never attempted" must
        // not look the same in settings.
        this._registration.set({
          status: 'error',
          message:
            'Notifications are turned off for Trinity in system settings.',
        });
        this._runtimeStatus.set({
          status: 'disabled',
          code: 'push-permission-disabled',
        });
        return;
      }
      // Android O+ silently drops notifications without a channel.
      await firstValueFrom(this.nativePush.prepareChannel()).catch(
        () => undefined,
      );
      // Fires the `registration` listener with the FCM/APNs token, or `registrationError`.
      // A rejection means the OS flow never started: release the guard, or every later
      // register() would early-exit.
      const outcome = await firstValueFrom(this.nativePush.register()).catch(
        (e: unknown) => {
          this.registered = false;
          this._registration.set({
            status: 'error',
            message: deviceErrorMessage(e),
          });
          this._runtimeStatus.set({
            status: 'degraded',
            code: 'push-device-registration-failed',
          });
          return null;
        },
      );
      if (outcome === 'unavailable') {
        // Nothing was asked of the OS, so no token callback will settle this flow; treat
        // it like a platform without push, neither a failure nor a refused permission.
        this.registered = false;
        this._registration.set({ status: 'idle' });
        this._runtimeStatus.set({
          status: 'unsupported',
          code: 'push-registration-unsupported',
        });
      }
    });
  }

  /** Restart a registration attempt whose native callback never settled. */
  retryRegistration(): Observable<void> {
    return defer(() => {
      this.registered = false;
      return this.register();
    });
  }

  /**
   * Delete pusher(s). With a `userId`, remove just that account's pusher; without one, tear
   * everything down (full logout / reset). Run before the access token is invalidated so
   * the gateway stops delivering.
   */
  unregister(userId?: string): Observable<void> {
    return defer(async () => {
      const pushkey = this.currentPushkey;
      const appId = this.pusherAppId();
      if (userId) {
        if (pushkey) await this.removePusher(userId, appId, pushkey);
        return;
      }
      this.currentPushkey = null;
      this.registered = false;
      // Every pusher is going away, so "applied to N accounts" would be stale.
      this._registration.set({ status: 'idle' });
      this._runtimeStatus.set({
        status: 'idle',
        code: 'push-registration-idle',
      });
      if (pushkey) {
        for (const accountId of this.session.accountIds()) {
          await this.removePusher(accountId, appId, pushkey);
        }
      }
    });
  }

  /** Best effort: the account may be gone, or its homeserver unreachable. */
  private async removePusher(
    accountId: string,
    appId: string,
    pushkey: string,
  ): Promise<void> {
    await firstValueFrom(
      this.engine.removePusher(accountId, appId, pushkey),
    ).catch(() => undefined);
  }

  private signedIn(): boolean {
    return this.session.active() !== null;
  }

  private canPush(): boolean {
    // Gate on the concrete mobile platforms: on web, and inside the Electron desktop shell
    // (where `getPlatform()` is also `'web'`), there is no push plugin.
    return (
      this.config !== null && this.signedIn() && this.nativePush.supported()
    );
  }

  /**
   * Per-platform app id the gateway is keyed by, e.g. `dev.trinityproject.trinity.ios`.
   *
   * Falls back to {@link DEFAULT_APP_ID}: interpolating the optional field directly would
   * yield the literal `"undefined.ios"`.
   */
  private pusherAppId(): string {
    return `${this.config?.appId ?? DEFAULT_APP_ID}.${this.nativePush.platform ?? 'web'}`;
  }

  private handleNativeEvent(
    event: NativePushRegistrationEvent,
  ): Observable<NativePushActivation> {
    switch (event.kind) {
      case 'ready':
        return this.register().pipe(
          ignoreElements(),
          catchError((error: unknown) => {
            this.registered = false;
            this._registration.set({
              status: 'error',
              message: deviceErrorMessage(error),
            });
            this._runtimeStatus.set({
              status: 'degraded',
              code: 'push-device-registration-failed',
            });
            return EMPTY;
          }),
        );
      case 'registered':
        return defer(() => this.setPushers(event.token)).pipe(ignoreElements());
      case 'registration-failed':
        this.registered = false;
        this._registration.set({
          status: 'error',
          message: event.message || DEVICE_REGISTRATION_FAILED,
        });
        this._runtimeStatus.set({
          status: 'degraded',
          code: 'push-device-registration-failed',
        });
        return EMPTY;
      case 'activated':
        return of(this.activation(event.data));
    }
  }

  /**
   * Register (or refresh) a pusher for every signed-in account with `pushkey`.
   *
   * `event_id_only` keeps message content off the gateway; `trinity_user_id` tags the
   * pusher so the gateway can fan out to the right account and a tap can switch to it;
   * `trinity_render: "device"` makes the gateway send a push the device renders itself.
   */
  private async setPushers(pushkey: string): Promise<void> {
    const config = this.config;
    if (!config) {
      return;
    }
    this.currentPushkey = pushkey;
    const appId = this.pusherAppId();
    // The first failure's message, kept so diagnostics can say why registration failed.
    let failure: string | null = null;
    let accounts = 0;

    for (const accountId of this.session.accountIds()) {
      accounts++;
      const result = await firstValueFrom(
        this.engine.setPusher(accountId, {
          appId,
          pushkey,
          appDisplayName: 'Trinity',
          lang: 'en',
          url: config.gatewayUrl,
          format: 'event_id_only',
          data: {
            [ACCOUNT_DATA_KEY]: accountId,
            [RENDER_DATA_KEY]: DEVICE_RENDER,
          },
        }),
      ).catch(() => null);
      if (!result?.ok) {
        failure ??= result
          ? engineFailureMessage(result.failure)
          : PUSHER_FAULT;
      }
    }

    if (failure === null) {
      this._registration.set({ status: 'applied', accounts, at: Date.now() });
      this._runtimeStatus.set({
        status: 'available',
        code: 'push-registration-ready',
      });
      await this.verifyPushers(pushkey, appId);
    } else {
      this._registration.set({ status: 'error', message: failure });
      this._runtimeStatus.set({
        status: 'degraded',
        code: 'push-pusher-registration-failed',
      });
    }
  }

  /**
   * Read the pushers back and confirm the one just registered is actually there.
   *
   * Catches a homeserver that accepts the POST (200) but does not persist the pusher, a
   * risk on non-Synapse homeservers. It confirms registration, never delivery: the gateway
   * → FCM/APNs → device leg is invisible from here.
   *
   * Matching is on the `(app_id, pushkey)` identity tuple, not the URL, since a homeserver
   * may canonicalise the URL. Only a definitive *absence* downgrades the state; if the
   * readback GET itself fails, the registration stands.
   */
  private async verifyPushers(pushkey: string, appId: string): Promise<void> {
    for (const accountId of this.session.accountIds()) {
      const pushers = await firstValueFrom(
        this.engine.pushers(accountId),
      ).catch(() => null);
      // Inconclusive — leave the applied state as it stands.
      if (!pushers?.ok) return;
      const present = pushers.value.some(
        (p) => p.appId === appId && p.pushkey === pushkey,
      );
      if (!present) {
        this._registration.set({
          status: 'error',
          message: `${accountId} accepted the pusher but the homeserver did not keep it.`,
        });
        this._runtimeStatus.set({
          status: 'degraded',
          code: 'push-pusher-verification-failed',
        });
        return;
      }
    }
  }

  /** Normalize an OS payload into a Workspace-owned semantic destination. */
  private activation(
    data: Readonly<Record<string, unknown>>,
  ): NativePushActivation {
    const userId =
      typeof data?.[ACCOUNT_DATA_KEY] === 'string'
        ? (data[ACCOUNT_DATA_KEY] as string)
        : null;
    const roomId =
      typeof data?.['room_id'] === 'string'
        ? (data['room_id'] as string)
        : null;
    const eventId =
      typeof data?.['event_id'] === 'string' &&
      data['event_id'].startsWith('$') &&
      data['event_id'].length > 1
        ? (data['event_id'] as string)
        : null;

    return {
      ...(userId && this.session.accountIds().includes(userId)
        ? { accountId: userId }
        : {}),
      ...(roomId ? { roomId } : {}),
      ...(eventId ? { eventId } : {}),
    };
  }
}
