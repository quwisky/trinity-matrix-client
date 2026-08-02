import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Observable, defer } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { DEFAULT_APP_ID } from './push-config';
import { PushGatewayService } from './push-gateway.service';

/** Pusher `data` key carrying the owning account's user id (see docs/reference/push-notifications.md). The
 * gateway must forward this from `devices[].data` into the delivered push payload so
 * a tap can switch to the right account. */
const ACCOUNT_DATA_KEY = 'trinity_user_id';

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

/**
 * Best human-readable message from a rejected pusher call. A `MatrixError` carries the
 * homeserver's own text in `data.error` (e.g. the notify-path config error); fall back
 * to the Error message, then to a generic line so the UI never shows `undefined`.
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

/**
 * Registers the device for OS push (FCM/APNs via `@capacitor/push-notifications`)
 * and a matching **Matrix pusher on every signed-in account** so each account's
 * homeserver routes its notifications through the configured push gateway. All
 * accounts share the one device token (pushkey); each pusher tags itself with its
 * account's user id in `data` so the gateway can fan out to the right account and a
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
  private readonly router = inject(Router);
  private readonly storage = inject(SessionStorageService);
  /**
   * Resolves the gateway to use — the user's setting, else the build-time
   * `PUSH_CONFIG`. Injected rather than reading the token directly so a change
   * made in settings takes effect on the next `register()` without a restart.
   */
  private readonly gateway = inject(PushGatewayService);

  /** The device push token (FCM/APNs), shared by every account's pusher. */
  private currentPushkey: string | null = null;
  private listenersAttached = false;
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
      const appIds = this.liveAppIds();
      if (userId) {
        const client = this.matrix.clientFor(userId);
        if (pushkey && client) {
          for (const appId of appIds) {
            await client.removePusher(pushkey, appId).catch(() => undefined);
          }
        }
        return;
      }
      this.currentPushkey = null;
      this.registered = false;
      // Every pusher is going away — a lingering "applied to N accounts" would be a lie
      // the settings page shows after a clear or logout.
      this._registration.set({ status: 'idle' });
      if (this.listenersAttached) {
        // Never let teardown reject — logout chains on this and must complete.
        await PushNotifications.removeAllListeners().catch(() => undefined);
        this.listenersAttached = false;
      }
      if (pushkey) {
        for (const account of this.matrix.all()) {
          for (const appId of appIds) {
            await account.client
              .removePusher(pushkey, appId)
              .catch(() => undefined);
          }
        }
      }
    });
  }

  /**
   * Every per-platform app id a pusher of ours might currently be registered under:
   * the one last written (the ledger) plus the one currently configured. Usually the
   * same value, so usually one entry — they diverge only when an app-id change was
   * interrupted, and removing both is what stops that stranding a pusher on the old
   * gateway. `removePusher` against an id with no pusher is harmless.
   *
   * Note the ordering contract this implies for the settings UI: tear the pushers down
   * *before* clearing the stored gateway, because clearing drops the ledger and with it
   * the only record of what to remove.
   */
  private liveAppIds(): readonly string[] {
    const ids = new Set<string>();
    const applied = this.gateway.appliedAppId();
    if (applied) {
      ids.add(this.platformAppId(applied));
    }
    const config = this.gateway.effective();
    if (config) {
      ids.add(this.platformAppId(config.appId));
    }
    return [...ids];
  }

  private canPush(): boolean {
    // Gate on the concrete mobile platforms. On web — and inside the hand-rolled
    // Electron desktop shell, where `getPlatform()` is also `'web'` — there is no
    // push plugin, so this keeps push a no-op everywhere except real iOS/Android.
    const platform = Capacitor.getPlatform();
    return (
      this.gateway.configured() &&
      this.matrix.isInitialized &&
      (platform === 'ios' || platform === 'android') &&
      Capacitor.isPluginAvailable('PushNotifications')
    );
  }

  /**
   * Per-platform app id the gateway is keyed by, e.g. `eu.qwky.trinity.ios`.
   *
   * Falls back to {@link DEFAULT_APP_ID} rather than interpolating the optional field
   * directly: `${undefined}` would stringify to the literal `"undefined.ios"` and be
   * sent to the homeserver as a real app id, producing a pusher no gateway can match.
   */
  private platformAppId(baseId: string | undefined): string {
    return `${baseId ?? DEFAULT_APP_ID}.${Capacitor.getPlatform()}`;
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
        const data = action?.notification?.data as
          Record<string, unknown> | undefined;
        this.openFromPush(data);
      },
    );
  }

  /**
   * Register (or refresh) a pusher for every signed-in account with `pushkey`.
   *
   * When the configured app id differs from the one last written, each account's stale
   * pusher is removed *before* the new one is set. A pusher's identity is
   * `(user_id, app_id, pushkey)`, so a changed app id does not update the existing row —
   * it adds a second one and the first keeps delivering to the previous gateway
   * (verified against Synapse: `GET /pushers` returns two rows after such a change).
   * Remove-then-set is the safe order: interrupted after the remove, the account is
   * simply unregistered until the next `register()` re-applies it; interrupted the other
   * way round, the old gateway would keep receiving indefinitely.
   *
   * The ledger only advances once *every* account succeeded, so a partial failure leaves
   * the old id recorded and the next round retries the removal. Re-removing an id that
   * is already gone is harmless.
   */
  private async setPushers(pushkey: string): Promise<void> {
    const config = this.gateway.effective();
    if (!config) {
      return;
    }
    this.currentPushkey = pushkey;
    const appId = this.platformAppId(config.appId);
    const appliedBase = this.gateway.appliedAppId();
    const stale =
      appliedBase && this.platformAppId(appliedBase) !== appId
        ? this.platformAppId(appliedBase)
        : null;
    // The first failure's message, if any: kept so the settings UI can show why the
    // gateway did not take, instead of the round failing silently. A null failure gates
    // the ledger advance exactly as the old boolean did — a stale removal that failed
    // keeps the old id recorded so the next round retries it.
    let failure: string | null = null;
    let accounts = 0;

    for (const account of this.matrix.all()) {
      accounts++;
      if (stale) {
        await account.client
          .removePusher(pushkey, stale)
          .catch((e) => (failure ??= pushErrorMessage(e)));
      }
      // `event_id_only` keeps message content off the gateway; the client fetches the
      // event after sync. `trinity_user_id` tags the pusher so the gateway can fan out
      // to the right account and a tap can switch to it (see docs/reference/push-notifications.md). Built as a
      // value, not an inline literal: the Matrix spec allows extra `data` keys but the
      // SDK types the field narrowly (`{ url, format, brand }`).
      const data = {
        url: config.gatewayUrl,
        format: 'event_id_only',
        [ACCOUNT_DATA_KEY]: account.userId,
      };
      await account.client
        .setPusher({
          app_id: appId,
          pushkey,
          kind: 'http',
          app_display_name: 'Trinity',
          device_display_name: account.client.getDeviceId() ?? 'Trinity',
          lang: 'en',
          data,
          // `append` governs pushers belonging to *other users*, not this one — the
          // homeserver always replaces this user's own pusher for the same
          // (app_id, pushkey). It must be true here: every account shares one device
          // token, so `false` makes each account in this loop delete the previous
          // one's pusher whenever two accounts live on the same homeserver, leaving
          // only the last. Verified against Synapse: with `false` the earlier
          // account's pusher count drops to 0; with `true` both survive, and
          // re-registering the same account stays idempotent at one pusher.
          append: true,
        })
        .catch((e) => (failure ??= pushErrorMessage(e)));
    }

    if (failure === null) {
      await this.gateway.markApplied(config.appId ?? DEFAULT_APP_ID);
      this._registration.set({ status: 'applied', accounts, at: Date.now() });
      await this.verifyPushers(pushkey, appId);
    } else {
      this._registration.set({ status: 'error', message: failure });
    }
  }

  /**
   * Read the pushers back and confirm the one just registered is actually there.
   *
   * `setPusher` returning 200 is the homeserver's word that it stored the pusher; this
   * is an independent check that the row is queryable — the state the gateway depends
   * on — and catches a homeserver that accepts the POST but does not persist it (a real
   * risk on the non-Synapse homeservers this feature invites people to point at). It is
   * the only delivery-adjacent thing the client CAN verify: the gateway → FCM/APNs →
   * device leg is invisible from here, so this confirms registration, never delivery.
   *
   * Matching is on the `(app_id, pushkey)` identity tuple, not the URL: the URL we sent
   * is authoritative, and a homeserver that canonicalises it differently must not read
   * as a failure. Only a definitive *absence* downgrades the state — if the readback GET
   * itself fails, the just-succeeded registration is left standing rather than punished
   * for an unrelated network blip.
   */
  private async verifyPushers(pushkey: string, appId: string): Promise<void> {
    for (const account of this.matrix.all()) {
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
        this._registration.set({
          status: 'error',
          message: `${account.userId} accepted the pusher but the homeserver did not keep it.`,
        });
        return;
      }
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
