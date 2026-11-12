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
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NativePushRegistrationService,
  type NativePushRegistrationEvent,
} from '@trinity/platform-native';
import { DEFAULT_APP_ID, PUSH_CONFIG } from './push-config';

type AccountClient = ReturnType<MatrixClientService['all']>[number];

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
 * carries the homeserver's message from the first account that failed. A discriminated
 * union, so "succeeded and failed" is unrepresentable; don't split it into two signals.
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

/**
 * Best human-readable message from a rejected pusher call: a `MatrixError`'s `data.error`,
 * then the Error message, then a generic line.
 */
function pushErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const data = (err as { data?: { error?: unknown } }).data;
    if (data && typeof data.error === 'string' && data.error) {
      return data.error;
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) {
      return message;
    }
  }
  return 'Could not reach the homeserver.';
}

/** Shown when the OS/FCM/APNs side of registration fails, rather than the homeserver. */
const DEVICE_REGISTRATION_FAILED =
  'The device could not register for push notifications.';

/** Best text from a rejected `PushNotifications.register()`: a plugin/OS failure, so not
 * {@link pushErrorMessage}, whose fallback blames the homeserver. */
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
 * {@link unregister} (one account on sign-out, or all on full logout). An account that was
 * unregistered gets no pusher again while its client stays live: see {@link unregister}.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly matrix = inject(MatrixClientService);
  private readonly nativePush = inject(NativePushRegistrationService);
  /** The build's gateway (`environment.push`); null builds without native push. */
  private readonly config = inject(PUSH_CONFIG, { optional: true });

  /** The device push token (FCM/APNs), shared by every account's pusher. */
  private currentPushkey: string | null = null;
  /** Guards the one-time OS-registration flow (permission + token request). */
  private registered = false;
  /** Clients whose own sign-out removed their pusher. Never given one again. */
  private readonly signingOut = new WeakSet<object>();
  /** Clients live at a full teardown. Only {@link register} takes them back. */
  private released = new WeakSet<object>();
  /**
   * The token each client's pusher was last set with, so a later round posts only what is
   * missing. The rest of a pusher is fixed per client: gateway, app id, user id, device id.
   */
  private applied = new WeakMap<object, string>();
  /** The pusher rounds, one at a time: {@link unregister} removes only after the last one. */
  private round: Promise<void> = Promise.resolve();

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

  /**
   * Whether the app's own sync is what notifies while it is in the background: on Android
   * until push delivers there. iOS is suspended in the background and always relies on push.
   */
  readonly notifiesFromBackgroundSync = computed(
    () =>
      this.nativePush.platform === 'android' &&
      this.backgroundDelivery() === 'app',
  );

  runtimePrerequisite():
    'ready' | 'unsupported' | 'not-configured' | 'no-account' {
    if (!this.nativePush.supported()) return 'unsupported';
    if (!this.config) return 'not-configured';
    if (!this.matrix.isInitialized) return 'no-account';
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
      this.released = new WeakSet();
      this.applied = new WeakMap();
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

  /**
   * Give the accounts that became live after the device token arrived their pusher.
   *
   * Unlike {@link register} it never asks the OS: with no token, a registration is in
   * progress, was denied or failed, or was torn down, and none of those is restarted by a
   * change of the account list. It posts only pushers that are not already applied.
   */
  registerNewAccounts(): Observable<void> {
    return defer(async () => {
      if (this.canPush() && this.currentPushkey) {
        await this.setPushers(this.currentPushkey);
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
   *
   * The clients it covers are left out of every later pusher round, so an account that is
   * signing out or being replaced cannot get its pusher back while its client is still
   * live. After a full teardown {@link register} takes the surviving clients back (an
   * abandoned replacing sign-in); a single account's sign-out is final.
   */
  unregister(userId?: string): Observable<void> {
    return defer(async () => {
      const pushkey = this.currentPushkey;
      const appId = this.pusherAppId();
      if (userId) {
        const client = this.matrix.clientFor(userId);
        if (!client) return;
        this.signingOut.add(client);
        this.applied.delete(client);
        await this.round;
        if (pushkey) {
          await client.removePusher(pushkey, appId).catch(() => undefined);
        }
        return;
      }
      const accounts = this.matrix.all();
      for (const account of accounts) this.released.add(account.client);
      this.applied = new WeakMap();
      this.currentPushkey = null;
      this.registered = false;
      // Every pusher is going away, so "applied to N accounts" would be stale.
      this._registration.set({ status: 'idle' });
      this._runtimeStatus.set({
        status: 'idle',
        code: 'push-registration-idle',
      });
      await this.round;
      if (pushkey) {
        for (const account of accounts) {
          await account.client
            .removePusher(pushkey, appId)
            .catch(() => undefined);
        }
      }
    });
  }

  private canPush(): boolean {
    // Gate on the concrete mobile platforms: on web, and inside the Electron desktop shell
    // (where `getPlatform()` is also `'web'`), there is no push plugin.
    return (
      this.config !== null &&
      this.matrix.isInitialized &&
      this.nativePush.supported()
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
        if (!this.config) return EMPTY;
        this.currentPushkey = event.token;
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

  /** Queue a pusher round behind the one in flight. */
  private setPushers(pushkey: string): Promise<void> {
    const round = this.round.then(() => this.applyPushers(pushkey));
    this.round = round.catch(() => undefined);
    return round;
  }

  /**
   * Register a pusher with `pushkey` for every signed-in account that is staying and does
   * not have it yet.
   *
   * `event_id_only` keeps message content off the gateway; `trinity_user_id` tags the
   * pusher so the gateway can fan out to the right account and a tap can switch to it;
   * `trinity_render: "device"` makes the gateway send a push the device renders itself.
   * Built as a value, not an inline literal: the Matrix spec allows extra `data` keys but
   * the SDK types the field narrowly (`{ url, format, brand }`).
   */
  private async applyPushers(pushkey: string): Promise<void> {
    const config = this.config;
    if (!config) {
      return;
    }
    const appId = this.pusherAppId();
    // The first failure's message, kept so diagnostics can say why registration failed.
    let failure: string | null = null;
    let accounts = 0;
    const posted: AccountClient[] = [];

    for (const account of this.matrix.all()) {
      const client = account.client;
      if (this.signingOut.has(client) || this.released.has(client)) continue;
      accounts++;
      if (this.applied.get(client) === pushkey) continue;
      const data = {
        url: config.gatewayUrl,
        format: 'event_id_only',
        [ACCOUNT_DATA_KEY]: account.userId,
        [RENDER_DATA_KEY]: DEVICE_RENDER,
      };
      await client
        .setPusher({
          app_id: appId,
          pushkey,
          kind: 'http',
          app_display_name: 'Trinity',
          device_display_name: client.getDeviceId() ?? 'Trinity',
          lang: 'en',
          data,
          // `append` governs pushers belonging to *other users*; the homeserver always
          // replaces this user's own pusher for the same (app_id, pushkey). It must be true:
          // every account shares one device token, so `false` makes each account in this
          // loop delete the previous one's pusher when two accounts share a homeserver
          // (Synapse).
          append: true,
        })
        .then(
          () => {
            this.applied.set(client, pushkey);
            posted.push(account);
          },
          (e: unknown) => (failure ??= pushErrorMessage(e)),
        );
    }

    // Every account is on its way out: the teardown's state stands.
    if (accounts === 0) return;
    if (failure === null) {
      this._registration.set({ status: 'applied', accounts, at: Date.now() });
      this._runtimeStatus.set({
        status: 'available',
        code: 'push-registration-ready',
      });
      await this.verifyPushers(posted, pushkey, appId);
    } else {
      this._registration.set({ status: 'error', message: failure });
      this._runtimeStatus.set({
        status: 'degraded',
        code: 'push-pusher-registration-failed',
      });
    }
  }

  /**
   * Read the pushers back and confirm the ones just registered are actually there.
   *
   * Catches a homeserver that accepts the POST (200) but does not persist the pusher, a
   * risk on non-Synapse homeservers. It confirms registration, never delivery: the gateway
   * → FCM/APNs → device leg is invisible from here.
   *
   * Matching is on the `(app_id, pushkey)` identity tuple, not the URL, since a homeserver
   * may canonicalise the URL. Only a definitive *absence* downgrades the state; if the
   * readback GET itself fails, the registration stands.
   */
  private async verifyPushers(
    accounts: readonly AccountClient[],
    pushkey: string,
    appId: string,
  ): Promise<void> {
    for (const account of accounts) {
      let pushers: readonly { app_id: string; pushkey: string }[];
      try {
        pushers = (await account.client.getPushers()).pushers;
      } catch {
        return; // Inconclusive — leave the applied state as it stands.
      }
      const present = pushers.some(
        (p) => p.app_id === appId && p.pushkey === pushkey,
      );
      if (!present) {
        this.applied.delete(account.client);
        this._registration.set({
          status: 'error',
          message: `${account.userId} accepted the pusher but the homeserver did not keep it.`,
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
      ...(userId && this.matrix.accountIds().includes(userId)
        ? { accountId: userId }
        : {}),
      ...(roomId ? { roomId } : {}),
      ...(eventId ? { eventId } : {}),
    };
  }
}
