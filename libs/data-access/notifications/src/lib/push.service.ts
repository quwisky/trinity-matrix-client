import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  finalize,
  firstValueFrom,
  from,
  ignoreElements,
  mergeMap,
  of,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NativePushRegistrationService,
  SessionStorageService,
  type NativePushRegistrationEvent,
} from '@trinity/platform-native';
import { DEFAULT_APP_ID } from './push-config';
import { PushGatewayService } from './push-gateway.service';
import {
  pushAppId,
  parseTrinityPushPayload,
  resolvePushAccountRoute,
  TrinityPushRegistrationCoordinator,
} from '@trinity/util/push-client';

/** Semantic destination emitted by a native notification tap. */
export interface NativePushActivation {
  readonly accountId: string;
  readonly roomId: string;
  readonly eventId: string;
}
export type NativePushEvent =
  | {
      readonly kind: 'received';
      readonly data: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'activated'; readonly destination: NativePushActivation };

/** Pusher metadata carries the opaque account route used for delivery attribution. */

/**
 * Outcome of the most recent pusher-registration round, for the settings UI.
 *
 * `applied` counts the accounts a pusher was registered for and stamps when; `error`
 * carries the homeserver's message from the first account that failed. Deliberately a
 * discriminated union rather than separate `lastAppliedAt` / `lastError` signals, so the
 * "succeeded *and* failed" state is unrepresentable.
 *
 * Note what `applied` does NOT mean: the pushers were accepted by the homeservers, not
 * that a notification will actually arrive. The gateway → FCM/APNs → device leg cannot
 * be observed from the client, so the UI must not present this as "push is working".
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
  | {
      readonly status: 'disabled' | 'degraded';
      readonly code:
        | 'push-permission-disabled'
        | 'push-device-registration-failed'
        | 'push-pusher-registration-failed'
        | 'push-pusher-verification-failed';
    };

/** Diagnostics and settings copy never include server or native error payloads. */
const REGISTRATION_FAILED =
  'Push registration could not finish. Retry to recover the saved registration.';
const CLEANUP_FAILED =
  'Some push registrations could not be removed. Retry to finish cleanup.';
const DEVICE_REGISTRATION_FAILED =
  'The device could not register for push notifications. Retry to try again.';

/**
 * Registers the device for OS push (FCM/APNs via `@capacitor/push-notifications`)
 * and a matching **Matrix pusher on every signed-in account** so each account's
 * homeserver routes its notifications through the configured push gateway. All
 * accounts share the one device token (pushkey); each pusher carries its opaque
 * Account Route in `data` so the gateway can fan out to the right account and a
 * tap can switch to it. Native-only and config-gated: a no-op on web/desktop or when
 * no `PushConfig` is provided.
 *
 * Pair {@link register} (called once the shell is live — it also re-applies pushers
 * for accounts added later) with {@link unregister} (a single account on per-account
 * sign-out, or all on full logout) to delete the pusher(s).
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly matrix = inject(MatrixClientService);
  private readonly nativePush = inject(NativePushRegistrationService);
  private readonly sessions = inject(SessionStorageService);
  /**
   * Resolves the gateway to use — the user's setting, else the build-time
   * `PUSH_CONFIG`. Injected rather than reading the token directly so a change
   * made in settings takes effect on the next `register()` without a restart.
   */
  private readonly gateway = inject(PushGatewayService);
  /** The shared lifecycle owns durable progress and platform-independent recovery. */
  private readonly registrationCoordinator =
    new TrinityPushRegistrationCoordinator({
      load: (accountId) => this.gateway.loadRegistration(accountId),
      save: (accountId, state) =>
        this.gateway.saveRegistration(accountId, state),
      list: (accountId) =>
        defer(async () => {
          const client = this.pusherClient(accountId);
          const { pushers } = await client.getPushers();
          return pushers.map((pusher) => ({
            appId: typeof pusher.app_id === 'string' ? pusher.app_id : '',
            pushkey: typeof pusher.pushkey === 'string' ? pusher.pushkey : '',
            deviceDisplayName:
              typeof pusher.device_display_name === 'string'
                ? pusher.device_display_name
                : '',
            appDisplayName:
              typeof pusher.app_display_name === 'string'
                ? pusher.app_display_name
                : undefined,
            kind: typeof pusher.kind === 'string' ? pusher.kind : '',
            url: typeof pusher.data?.url === 'string' ? pusher.data.url : '',
            format:
              typeof pusher.data?.format === 'string'
                ? pusher.data.format
                : undefined,
            version:
              pusher.data &&
              'trinity_push_version' in pusher.data &&
              typeof pusher.data.trinity_push_version === 'string'
                ? pusher.data.trinity_push_version
                : undefined,
            accountRoute:
              pusher.data &&
              'trinity_account_id' in pusher.data &&
              typeof pusher.data.trinity_account_id === 'string'
                ? pusher.data.trinity_account_id
                : undefined,
          }));
        }),
      register: (route, descriptor) =>
        defer(async () => {
          const client = this.matrix.clientFor(route.accountId);
          if (
            !client ||
            !this.acceptsRegistrationTokens ||
            this.retiringClients.has(client)
          )
            throw new Error(REGISTRATION_FAILED);
          await client.setPusher({
            app_id: descriptor.appId,
            pushkey: descriptor.pushkey,
            kind: descriptor.kind,
            app_display_name: 'Trinity',
            device_display_name: client.getDeviceId() ?? 'Trinity',
            lang: 'en',
            data: { ...descriptor.data, url: descriptor.url },
            append: descriptor.append,
          });
        }),
      remove: (accountId, identity) =>
        defer(async () => {
          await this.pusherClient(accountId).removePusher(
            identity.pushkey,
            identity.appId,
          );
        }),
    });

  /** The device push token (FCM/APNs), shared by every account's pusher. */
  private currentPushkey: string | null = null;
  private pusherMutations: Promise<void> = Promise.resolve();
  private registrationGeneration = 0;
  private readonly removingAccounts = new Map<
    string,
    NonNullable<ReturnType<MatrixClientService['clientFor']>>
  >();
  /** Prevent late registration for a departing lifetime without retaining its credentials. */
  private readonly retiringClients = new WeakSet<
    NonNullable<ReturnType<MatrixClientService['clientFor']>>
  >();
  private acceptsRegistrationTokens = false;
  /** Guards the one-time OS-registration flow (permission + token request). */
  private registered = false;

  private readonly _registration = signal<PushRegistrationState>({
    status: 'idle',
  });
  /**
   * The most recent registration outcome, for the settings gateway UI to surface
   * instead of the failures being swallowed. Updated on every `setPushers()` round;
   * reset to idle when all pushers are torn down.
   */
  readonly registration = this._registration.asReadonly();
  private readonly _runtimeStatus = signal<PushRuntimeStatus>({
    status: 'idle',
    code: 'push-registration-idle',
  });
  readonly runtimeStatus = this._runtimeStatus.asReadonly();

  runtimePrerequisite():
    'ready' | 'unsupported' | 'not-configured' | 'no-account' {
    if (!this.nativePush.supported()) return 'unsupported';
    if (!this.gateway.configured()) return 'not-configured';
    if (!this.matrix.isInitialized) return 'no-account';
    return 'ready';
  }

  /**
   * Own native callbacks for one Application Runtime session and expose only semantic
   * activation destinations. Listener setup precedes OS registration, and teardown is
   * tied to the returned cold Observable rather than hidden behind a finite command.
   */
  run(): Observable<NativePushEvent> {
    return defer(() => {
      if (!this.nativePush.supported()) return EMPTY;
      return this.nativePush.listen().pipe(
        mergeMap((event) => this.handleNativeEvent(event)),
        finalize(() => {
          // A token callback that arrives after teardown is intentionally ignored. Let a
          // later session issue a fresh registration request instead of retaining a stale
          // in-progress guard forever.
          this.registered = false;
        }),
      );
    });
  }

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
        if (
          this.nativePush.supported() &&
          this.gateway.disabled() &&
          this.matrix.isInitialized
        )
          await firstValueFrom(this.unregister());
        return;
      }
      this.acceptsRegistrationTokens = true;
      // Token already in hand (e.g. a shell re-mount after adding an account):
      // (re)register a pusher for every account, covering any newly-added ones.
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
      } catch {
        this.registered = false;
        this._registration.set({
          status: 'error',
          message: DEVICE_REGISTRATION_FAILED,
        });
        this._runtimeStatus.set({
          status: 'degraded',
          code: 'push-device-registration-failed',
        });
        return;
      }
      if (!permission) {
        this.registered = false;
        // Say so instead of returning silently: mobile push is the only delivery path
        // there is, so "denied" and "never attempted" must not look the same in settings.
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
      // Fires the `registration` listener with the FCM/APNs token — or `registrationError`.
      // A rejection here means the OS flow never started, so release the one-time guard:
      // holding it would make every later register() early-exit for the process lifetime.
      await firstValueFrom(this.nativePush.register()).catch(() => {
        this.registered = false;
        this._registration.set({
          status: 'error',
          message: DEVICE_REGISTRATION_FAILED,
        });
        this._runtimeStatus.set({
          status: 'degraded',
          code: 'push-device-registration-failed',
        });
      });
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
   * Delete pusher(s). With a `userId`, remove just that account's pusher (on
   * per-account sign-out) while the others keep theirs. Without one, tear everything
   * down — remove every account's pusher and detach listeners (full logout / reset).
   * Run before the access token is invalidated so the gateway stops delivering.
   */
  unregister(userId?: string): Observable<void> {
    return defer(() => {
      const platform = this.nativePush.platform;
      if (platform !== 'android' && platform !== 'ios') return of(void 0);
      this.registrationGeneration += 1;
      const targets = userId
        ? [userId]
        : [
            ...new Set([
              ...this.matrix.accountIds(),
              ...this.removingAccounts.keys(),
            ]),
          ];
      if (userId) {
        const client = this.matrix.clientFor(userId);
        if (client) {
          this.removingAccounts.set(userId, client);
          this.retiringClients.add(client);
        }
      }
      if (!userId) {
        this.acceptsRegistrationTokens = false;
        this.currentPushkey = null;
        this.registered = false;
      }
      return this.serializePusherMutation(async () => {
        try {
          const routes = await firstValueFrom(
            this.sessions.getPushAccountRoutes(),
          );
          const report = await firstValueFrom(
            this.registrationCoordinator.unregister({
              platform,
              accounts: targets.map((accountId) => ({
                accountId,
                route: routes.find((route) => route.accountId === accountId)
                  ?.route,
                deviceDisplayName:
                  this.pusherClient(accountId).getDeviceId() ?? '',
              })),
              legacyAppIds: this.ownedAppIds(),
            }),
          );
          for (const accountId of report.applied)
            this.removingAccounts.delete(accountId);
          if (report.failed.length) throw new Error(CLEANUP_FAILED);
          if (!userId) {
            this._registration.set({ status: 'idle' });
            this._runtimeStatus.set({
              status: 'idle',
              code: 'push-registration-idle',
            });
          }
        } catch {
          this._registration.set({ status: 'error', message: CLEANUP_FAILED });
          this._runtimeStatus.set({
            status: 'degraded',
            code: 'push-pusher-registration-failed',
          });
          throw new Error(CLEANUP_FAILED);
        }
      });
    });
  }

  private pusherClient(
    accountId: string,
  ): NonNullable<ReturnType<MatrixClientService['clientFor']>> {
    const client =
      this.matrix.clientFor(accountId) ?? this.removingAccounts.get(accountId);
    if (!client) throw new Error(CLEANUP_FAILED);
    return client;
  }

  /** Only identifiers written by this installation may participate in legacy discovery. */
  private ownedAppIds(): readonly string[] {
    const ids = new Set([
      this.platformAppId(undefined),
      this.appliedPlatformAppId(DEFAULT_APP_ID),
    ]);
    const applied = this.gateway.appliedAppId();
    if (applied) ids.add(this.appliedPlatformAppId(applied));
    for (const id of this.gateway.legacyAppIds())
      ids.add(this.appliedPlatformAppId(id));
    return [...ids];
  }

  private canPush(): boolean {
    // Gate on the concrete mobile platforms. On web — and inside the hand-rolled
    // Electron desktop shell, where `getPlatform()` is also `'web'` — there is no
    // push plugin, so this keeps push a no-op everywhere except real iOS/Android.
    return (
      this.gateway.configured() &&
      this.matrix.isInitialized &&
      this.nativePush.supported()
    );
  }

  /** Fixed gateway identifier; native package identities remain independent. */
  private platformAppId(baseId: string | undefined): string {
    const platform = this.nativePush.platform;
    return platform === 'android' || platform === 'ios'
      ? pushAppId(platform)
      : `${baseId ?? DEFAULT_APP_ID}.web`;
  }

  /** App id recorded by an older registration, retained solely for cleanup. */
  private appliedPlatformAppId(baseId: string): string {
    return baseId === this.platformAppId(undefined)
      ? baseId
      : `${baseId}.${this.nativePush.platform ?? 'web'}`;
  }

  private handleNativeEvent(
    event: NativePushRegistrationEvent,
  ): Observable<NativePushEvent> {
    if (event.kind === 'received') {
      return of({ kind: 'received', data: event.data });
    }
    switch (event.kind) {
      case 'ready':
        return this.register().pipe(
          ignoreElements(),
          catchError(() => {
            this.registered = false;
            this._registration.set({
              status: 'error',
              message: DEVICE_REGISTRATION_FAILED,
            });
            this._runtimeStatus.set({
              status: 'degraded',
              code: 'push-device-registration-failed',
            });
            return EMPTY;
          }),
        );
      case 'registered':
        if (!this.acceptsRegistrationTokens) return EMPTY;
        return defer(() => this.setPushers(event.token)).pipe(ignoreElements());
      case 'registration-failed':
        this.registered = false;
        this._registration.set({
          status: 'error',
          message: DEVICE_REGISTRATION_FAILED,
        });
        this._runtimeStatus.set({
          status: 'degraded',
          code: 'push-device-registration-failed',
        });
        return EMPTY;
      case 'activated':
        return defer(() => from(this.activation(event.data))).pipe(
          mergeMap((destination) =>
            destination
              ? of({ kind: 'activated' as const, destination })
              : EMPTY,
          ),
        );
      default:
        return EMPTY;
    }
  }

  /** Keep pusher removal and registration in one transaction order. */
  private serializePusherMutation(action: () => Promise<void>): Promise<void> {
    const task = this.pusherMutations.catch(() => undefined).then(action);
    this.pusherMutations = task.catch(() => undefined);
    return task;
  }

  private setPushers(pushkey: string): Promise<void> {
    const generation = this.registrationGeneration;
    return this.serializePusherMutation(() =>
      generation === this.registrationGeneration
        ? this.setPushersNow(pushkey, generation)
        : Promise.resolve(),
    );
  }

  private async setPushersNow(
    pushkey: string,
    generation: number,
  ): Promise<void> {
    const config = this.gateway.effective();
    const platform = this.nativePush.platform;
    if (!config || (platform !== 'android' && platform !== 'ios')) return;
    this.currentPushkey = pushkey;
    try {
      const routes = await firstValueFrom(
        this.sessions.ensurePushAccountRoutes(),
      );
      for (const [accountId, client] of this.removingAccounts) {
        if (this.matrix.clientFor(accountId) !== client)
          this.removingAccounts.delete(accountId);
      }
      const live = this.matrix
        .all()
        .filter(({ client }) => !this.retiringClients.has(client));
      const accounts = live.map(({ userId, client }) => {
        const route = routes.find((entry) => entry.accountId === userId)?.route;
        if (!route) throw new Error(REGISTRATION_FAILED);
        return {
          accountId: userId,
          route,
          deviceDisplayName: client.getDeviceId() ?? '',
        };
      });
      const report = await firstValueFrom(
        this.registrationCoordinator.register({
          platform,
          pushkey,
          gatewayUrl: config.gatewayUrl,
          accounts,
          legacyAppIds: this.ownedAppIds(),
        }),
      );
      if (generation !== this.registrationGeneration) return;
      if (report.failed.length) {
        this._registration.set({
          status: 'error',
          message: REGISTRATION_FAILED,
        });
        this._runtimeStatus.set({
          status: 'degraded',
          code: report.failed.some(({ code }) => code === 'readback-failed')
            ? 'push-pusher-verification-failed'
            : 'push-pusher-registration-failed',
        });
        return;
      }
      if (report.applied.length === 0) return;
      await this.gateway.markApplied(pushAppId(platform));
      this._registration.set({
        status: 'applied',
        accounts: report.applied.length,
        at: Date.now(),
      });
      this._runtimeStatus.set({
        status: 'available',
        code: 'push-registration-ready',
      });
    } catch {
      if (generation !== this.registrationGeneration) return;
      this._registration.set({ status: 'error', message: REGISTRATION_FAILED });
      this._runtimeStatus.set({
        status: 'degraded',
        code: 'push-pusher-registration-failed',
      });
    }
  }

  /** Normalize an OS payload into a Workspace-owned semantic destination. */
  private async activation(
    data: Readonly<Record<string, unknown>>,
  ): Promise<NativePushActivation | null> {
    const payload = parseTrinityPushPayload(data);
    if (!payload || payload.kind !== 'event') return null;
    const routes = await firstValueFrom(
      this.sessions.getPushAccountRoutes(),
    ).catch(() => []);
    const route = resolvePushAccountRoute(routes, payload.accountRoute);
    const accountId = route?.accountId;
    const client = accountId ? this.matrix.clientFor(accountId) : null;
    if (
      !accountId ||
      !client ||
      !this.matrix.accountIds().includes(accountId) ||
      this.retiringClients.has(client)
    )
      return null;
    return {
      accountId,
      roomId: payload.roomId,
      eventId: payload.eventId,
    };
  }
}
