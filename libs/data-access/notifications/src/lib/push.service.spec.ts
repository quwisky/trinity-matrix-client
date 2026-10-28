import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  engineFail,
  engineFailureMessage,
  engineOk,
} from '@trinity/util/matrix';
import { FakeNotificationEngine } from '../contract/fake-notification-engine';
import type { HttpPusher } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { DEFAULT_APP_ID, PUSH_CONFIG, type PushConfig } from './push-config';
import { PushService } from './push.service';

// Shared, mutable mock state — hoisted so the vi.mock factories can close over it.
const h = vi.hoisted(() => {
  const listeners: Record<string, (arg: unknown) => void> = {};
  const handles: { remove: ReturnType<typeof vi.fn> }[] = [];
  const state = {
    platform: 'ios',
    permission: 'granted' as string,
    // Android only: whether the host has Firebase (the PushHandoff plugin answers).
    canRegister: true,
  };
  const handoff = {
    registrationAvailable: vi.fn(async () => ({ value: state.canRegister })),
  };
  const push = {
    requestPermissions: vi.fn(async () => ({ receive: state.permission })),
    register: vi.fn(async () => undefined),
    createChannel: vi.fn(async () => undefined),
    addListener: vi.fn(async (event: string, cb: (arg: unknown) => void) => {
      listeners[event] = cb;
      const handle = { remove: vi.fn(async () => undefined) };
      handles.push(handle);
      return handle;
    }),
    removeAllListeners: vi.fn(async () => undefined),
  };
  return { listeners, handles, state, push, handoff };
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => h.handoff),
  Capacitor: {
    getPlatform: () => h.state.platform,
    // Electron reports isNativePlatform() === true but has no push plugin — the
    // service must NOT rely on this (see the electron test below).
    isNativePlatform: () => h.state.platform !== 'web',
    isPluginAvailable: () =>
      h.state.platform === 'ios' || h.state.platform === 'android',
  },
}));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: h.push }));
const CONFIG: PushConfig = {
  gatewayUrl: 'https://push.example/_matrix/push/v1/notify',
  appId: 'dev.trinityproject.trinity',
};

function status(accountId: string): SessionAccountStatus {
  return {
    accountId,
    generation: 1,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

/** The engine's pusher store holds what was set, so the readback checks real state. */
function setup(
  opts: {
    config?: PushConfig | null;
    accounts?: string[];
    active?: string;
  } = {},
) {
  const ids = opts.accounts ?? ['@me:hs'];
  const active = opts.active ?? ids[0];
  const engine = new FakeNotificationEngine();
  const snapshot = signal<SessionSnapshot>(EMPTY_SESSION);
  const setAccounts = (accounts: readonly string[]): void => {
    for (const id of accounts) engine.live.add(id);
    snapshot.set({
      ...EMPTY_SESSION,
      activeAccountId: active,
      accounts: accounts.map(status),
    });
  };
  setAccounts(ids);
  const setPusher = vi.spyOn(engine, 'setPusher');
  const removePusher = vi.spyOn(engine, 'removePusher');
  const pushers = vi.spyOn(engine, 'pushers');
  TestBed.configureTestingModule({
    providers: [
      PushService,
      { provide: NOTIFICATION_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: snapshot },
      {
        provide: PUSH_CONFIG,
        useValue: 'config' in opts ? opts.config : CONFIG,
      },
    ],
  });
  const svc = TestBed.inject(PushService);
  const activations: unknown[] = [];
  const lifetime = svc
    .run()
    .subscribe((activation) => activations.push(activation));
  /** The pushers set for `accountId`, in order. */
  const sent = (accountId: string): HttpPusher[] =>
    setPusher.mock.calls
      .filter(([id]) => id === accountId)
      .map(([, pusher]) => pusher);
  return {
    svc,
    engine,
    setPusher,
    removePusher,
    pushers,
    sent,
    setAccounts,
    activations,
    lifetime,
  };
}

const REFUSED: EngineFailure = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 400, errcode: 'M_UNKNOWN' },
};

/** Let the fire-and-forget `setPusher` microtasks settle. */
const flush = () => new Promise((r) => setTimeout(r));

describe('PushService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    h.state.platform = 'ios';
    h.state.permission = 'granted';
    h.state.canRegister = true;
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.handles.length = 0;
    vi.clearAllMocks();
  });

  it('registers a Matrix pusher with the device token on iOS', async () => {
    const { svc, sent } = setup();

    await firstValueFrom(svc.register());
    expect(h.push.requestPermissions).toHaveBeenCalled();
    expect(h.push.register).toHaveBeenCalled();

    // The plugin delivers the APNs/FCM token via the `registration` event.
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    // The engine registers it as kind http with append: true (its own spec and contract).
    expect(sent('@me:hs')).toEqual([
      {
        appId: 'dev.trinityproject.trinity.ios',
        pushkey: 'TOKEN123',
        appDisplayName: 'Trinity',
        lang: 'en',
        url: CONFIG.gatewayUrl,
        format: 'event_id_only',
        data: {
          // Tagged with the owning account so the gateway can fan out per account.
          trinity_user_id: '@me:hs',
          // Asks the gateway for a push the device renders itself (data-only on
          // Android, mutable-content on iOS).
          trinity_render: 'device',
        },
      },
    ]);
  });

  it('registers a pusher on every account, each tagged by its user id', async () => {
    const { svc, sent } = setup({ accounts: ['@me:hs', '@alt:hs'] });

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    for (const userId of ['@me:hs', '@alt:hs']) {
      expect(sent(userId)).toEqual([
        expect.objectContaining({
          pushkey: 'TOKEN123',
          data: expect.objectContaining({ trinity_user_id: userId }),
        }),
      ]);
    }
  });

  it('asks for device rendering on every account pusher', async () => {
    const { svc, sent } = setup({ accounts: ['@me:hs', '@alt:hs'] });

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    for (const userId of ['@me:hs', '@alt:hs']) {
      expect(sent(userId)).toEqual([
        expect.objectContaining({
          format: 'event_id_only',
          data: expect.objectContaining({ trinity_render: 'device' }),
        }),
      ]);
    }
  });

  it('creates the Android notification channel before registering', async () => {
    h.state.platform = 'android';
    const { svc } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'messages' }),
    );
    expect(h.push.register).toHaveBeenCalled();
  });

  it('stays quietly unavailable on an Android build that cannot register', async () => {
    // Without Firebase the plugin's Android register() would crash the app.
    h.state.platform = 'android';
    h.state.canRegister = false;
    const { svc, setPusher } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.register).not.toHaveBeenCalled();
    expect(setPusher).not.toHaveBeenCalled();
    expect(svc.runtimeStatus()).toEqual({
      status: 'unsupported',
      code: 'push-registration-unsupported',
    });
    expect(svc.registration()).toEqual({ status: 'idle' });
  });

  it('no-ops on web (plugin unavailable)', async () => {
    h.state.platform = 'web';
    const { svc, setPusher } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.requestPermissions).not.toHaveBeenCalled();
    expect(h.push.register).not.toHaveBeenCalled();
    expect(setPusher).not.toHaveBeenCalled();
  });

  it('no-ops on Electron even though isNativePlatform() is true', async () => {
    h.state.platform = 'electron';
    const { svc } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.requestPermissions).not.toHaveBeenCalled();
    expect(h.push.register).not.toHaveBeenCalled();
  });

  it('no-ops when no push config is provided', async () => {
    const { svc } = setup({ config: null });

    await firstValueFrom(svc.register());

    expect(h.push.requestPermissions).not.toHaveBeenCalled();
  });

  describe('background delivery', () => {
    async function registerWithToken(svc: PushService): Promise<void> {
      await firstValueFrom(svc.register());
      h.listeners['registration']?.({ value: 'TOKEN123' });
      await flush();
    }

    it('hands the background to native push once Android pushers carry the token', async () => {
      h.state.platform = 'android';
      const { svc } = setup();
      expect(svc.backgroundDelivery()).toBe('app');

      await registerWithToken(svc);

      expect(svc.runtimeStatus().status).toBe('available');
      expect(svc.backgroundDelivery()).toBe('push');
    });

    it('keeps the background with the app on iOS even when registered', async () => {
      const { svc } = setup();

      await registerWithToken(svc);

      expect(svc.runtimeStatus().status).toBe('available');
      expect(svc.backgroundDelivery()).toBe('app');
    });

    it('keeps the background with the app on Android when permission is denied', async () => {
      h.state.platform = 'android';
      h.state.permission = 'denied';
      const { svc } = setup();

      // A denied permission never reaches the OS registration, so no token arrives.
      await firstValueFrom(svc.register());

      expect(svc.runtimeStatus().status).toBe('disabled');
      expect(svc.backgroundDelivery()).toBe('app');
    });

    it('keeps the background with the app on Android when the homeserver refuses the pusher', async () => {
      h.state.platform = 'android';
      const { svc, setPusher } = setup();
      setPusher.mockReturnValueOnce(of(engineFail(REFUSED)));

      await registerWithToken(svc);

      expect(svc.runtimeStatus().status).toBe('degraded');
      expect(svc.backgroundDelivery()).toBe('app');
    });

    it('keeps the background with the app on Android without a gateway', async () => {
      h.state.platform = 'android';
      const { svc } = setup({ config: null });

      await registerWithToken(svc);

      expect(svc.backgroundDelivery()).toBe('app');
    });

    it('returns the background to the app when push is torn down', async () => {
      h.state.platform = 'android';
      const { svc } = setup();
      await registerWithToken(svc);

      await firstValueFrom(svc.unregister());

      expect(svc.backgroundDelivery()).toBe('app');
    });

    it('leaves web with the app', async () => {
      h.state.platform = 'web';
      const { svc } = setup();

      await firstValueFrom(svc.register());

      expect(svc.backgroundDelivery()).toBe('app');
    });
  });

  describe('registration state', () => {
    it('starts idle', () => {
      const { svc } = setup();
      expect(svc.registration()).toEqual({ status: 'idle' });
    });

    it('reports applied with the account count after a successful round', async () => {
      const { svc } = setup({ accounts: ['@me:hs', '@alt:hs'] });

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      const state = svc.registration();
      expect(state.status).toBe('applied');
      expect(state).toMatchObject({ status: 'applied', accounts: 2 });
      expect(state.status === 'applied' && state.at).toBeGreaterThan(0);
    });

    it('records why the homeserver refused instead of swallowing it, and still completes', async () => {
      const { svc, setPusher } = setup();
      // The refusal a mistyped gateway URL produces.
      setPusher.mockReturnValueOnce(of(engineFail(REFUSED)));

      // register() must resolve normally — the observable does not error out.
      await expect(firstValueFrom(svc.register())).resolves.toBeUndefined();
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration()).toEqual({
        status: 'error',
        message: engineFailureMessage(REFUSED),
      });
    });

    it('falls back to a generic message when the pusher call faults', async () => {
      const { svc, setPusher } = setup();
      setPusher.mockReturnValueOnce(throwError(() => new Error('fault')));

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration()).toEqual({
        status: 'error',
        message: 'Could not reach the homeserver.',
      });
    });

    it('reads the pushers back to confirm the homeserver kept them', async () => {
      const { svc, pushers } = setup();

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(pushers).toHaveBeenCalledWith('@me:hs');
      expect(svc.registration().status).toBe('applied');
    });

    it('downgrades to an error if the homeserver accepted but did not keep the pusher', async () => {
      // setPusher resolves (200) but the pusher is absent on readback — the accept-and-
      // drop a non-Synapse homeserver can exhibit. This is the case setPusher's own
      // return value cannot catch.
      const { svc, pushers } = setup();
      pushers.mockReturnValue(of(engineOk([])));

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration()).toEqual({
        status: 'error',
        message:
          '@me:hs accepted the pusher but the homeserver did not keep it.',
      });
      expect(svc.runtimeStatus().code).toBe('push-pusher-verification-failed');
    });

    it('leaves the applied state standing when the readback itself fails', async () => {
      // A failed GET is inconclusive — the pusher was accepted, so a transient network
      // error on the readback must not report the registration as broken.
      const { svc, pushers } = setup();
      pushers.mockReturnValue(of(engineFail(REFUSED)));

      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();

      expect(svc.registration().status).toBe('applied');
    });

    it('returns to idle when all pushers are torn down', async () => {
      const { svc } = setup();
      await firstValueFrom(svc.register());
      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();
      expect(svc.registration().status).toBe('applied');

      await firstValueFrom(svc.unregister());

      expect(svc.registration()).toEqual({ status: 'idle' });
    });
  });

  it('does not register a pusher when permission is denied', async () => {
    h.state.permission = 'denied';
    const { svc, setPusher } = setup();

    await firstValueFrom(svc.register());

    expect(h.push.register).not.toHaveBeenCalled();
    expect(setPusher).not.toHaveBeenCalled();
    // Push is the ONLY delivery path on mobile, so a denial has to be visible in
    // settings — "denied" and "never attempted" must not both read as idle.
    expect(svc.registration()).toMatchObject({ status: 'error' });
  });

  describe('a refused device token', () => {
    it('surfaces the registrationError and lets a later register() retry', async () => {
      // FCM/APNs refuses the token AFTER the one-time OS flow has been marked as run.
      // Without releasing that guard the refusal is silent AND permanent: no pusher,
      // no notifications, and no way back for the lifetime of the process.
      const { svc, setPusher } = setup();
      await firstValueFrom(svc.register());

      h.listeners['registrationError']({ error: 'SENDER_ID_MISMATCH' });

      expect(svc.registration()).toEqual({
        status: 'error',
        message: 'SENDER_ID_MISMATCH',
      });

      // The retry gets as far as the OS again, and a token this time registers pushers.
      await firstValueFrom(svc.register());
      expect(h.push.register).toHaveBeenCalledTimes(2);

      h.listeners['registration']({ value: 'TOKEN123' });
      await flush();
      expect(setPusher).toHaveBeenCalled();
    });

    it('releases the one-time guard when register() itself rejects', async () => {
      const { svc } = setup();
      h.push.register.mockRejectedValueOnce(
        new Error('no google play services'),
      );

      await firstValueFrom(svc.register());

      expect(svc.registration()).toEqual({
        status: 'error',
        message: 'no google play services',
      });

      await firstValueFrom(svc.register());
      expect(h.push.register).toHaveBeenCalledTimes(2);
    });
  });

  it('runs the OS-registration flow only once (idempotent)', async () => {
    const { svc } = setup();

    await firstValueFrom(svc.register());
    await firstValueFrom(svc.register());

    expect(h.push.register).toHaveBeenCalledTimes(1);
  });

  it('restarts an in-progress OS-registration flow only through exact retry', async () => {
    const { svc } = setup();

    await firstValueFrom(svc.register());
    await firstValueFrom(svc.register());
    expect(h.push.register).toHaveBeenCalledOnce();

    await firstValueFrom(svc.retryRegistration());
    expect(h.push.requestPermissions).toHaveBeenCalledTimes(2);
    expect(h.push.register).toHaveBeenCalledTimes(2);
  });

  it('re-applies pushers for all accounts on a repeat register (new account)', async () => {
    const { svc, sent, setAccounts } = setup({ accounts: ['@me:hs'] });

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    // A second account joined; a repeat register() re-applies pushers for all.
    setAccounts(['@me:hs', '@alt:hs']);
    await firstValueFrom(svc.register());
    await flush();

    expect(sent('@me:hs')).toHaveLength(2);
    expect(sent('@alt:hs')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ trinity_user_id: '@alt:hs' }),
      }),
    ]);
  });

  it('falls back to the bundle id when the config omits appId', async () => {
    // `appId` is optional, so a config carrying only a gateway URL must still produce a
    // usable app id. Interpolating the missing field directly would send the literal
    // "undefined.ios" to the homeserver — a pusher no gateway could ever match.
    const { svc, sent } = setup({
      config: { gatewayUrl: 'https://push.example/_matrix/push/v1/notify' },
    });

    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    const [pusher] = sent('@me:hs');
    expect(pusher.appId).toBe(`${DEFAULT_APP_ID}.ios`);
    expect(pusher.appId).not.toContain('undefined');
  });

  it('opens the app when a notification is tapped', async () => {
    const { svc, activations } = setup();
    await firstValueFrom(svc.register());

    h.listeners['pushNotificationActionPerformed']({});

    expect(activations).toEqual([{}]);
  });

  it('switches to the tagged account and opens the room on tap', async () => {
    const { svc, activations } = setup({
      accounts: ['@me:hs', '@alt:hs'],
      active: '@me:hs',
    });
    await firstValueFrom(svc.register());

    h.listeners['pushNotificationActionPerformed']({
      notification: {
        data: {
          trinity_user_id: '@alt:hs',
          room_id: '!r:hs',
          event_id: '$event',
        },
      },
    });

    expect(activations).toEqual([
      { accountId: '@alt:hs', roomId: '!r:hs', eventId: '$event' },
    ]);
  });

  it('opens the room but does not switch when the tagged account is gone or already active', async () => {
    const { svc, activations } = setup({
      accounts: ['@me:hs', '@alt:hs'],
      active: '@me:hs',
    });
    await firstValueFrom(svc.register());

    // Tagged with an account signed out since delivery — not in accountIds().
    h.listeners['pushNotificationActionPerformed']({
      notification: { data: { trinity_user_id: '@gone:hs', room_id: '!a:hs' } },
    });
    // Tagged with the account that is already active — no redundant switch.
    h.listeners['pushNotificationActionPerformed']({
      notification: { data: { trinity_user_id: '@me:hs', room_id: '!b:hs' } },
    });

    expect(activations).toEqual([
      { roomId: '!a:hs' },
      { accountId: '@me:hs', roomId: '!b:hs' },
    ]);
  });

  it('deletes every account pusher while session teardown owns the listeners', async () => {
    const { svc, removePusher, engine, lifetime } = setup({
      accounts: ['@me:hs', '@alt:hs'],
    });
    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    await firstValueFrom(svc.unregister());

    expect(removePusher.mock.calls).toEqual([
      ['@me:hs', 'dev.trinityproject.trinity.ios', 'TOKEN123'],
      ['@alt:hs', 'dev.trinityproject.trinity.ios', 'TOKEN123'],
    ]);
    for (const userId of ['@me:hs', '@alt:hs']) {
      expect(await firstValueFrom(engine.pushers(userId))).toEqual(
        engineOk([]),
      );
    }
    expect(h.push.removeAllListeners).not.toHaveBeenCalled();
    expect(
      h.handles.every(({ remove }) => remove.mock.calls.length === 0),
    ).toBe(true);

    lifetime.unsubscribe();
    expect(
      h.handles.every(({ remove }) => remove.mock.calls.length === 1),
    ).toBe(true);
  });

  it('deletes only one account pusher on a per-account unregister', async () => {
    const { svc, removePusher } = setup({ accounts: ['@me:hs', '@alt:hs'] });
    await firstValueFrom(svc.register());
    h.listeners['registration']({ value: 'TOKEN123' });
    await flush();

    await firstValueFrom(svc.unregister('@alt:hs'));

    expect(removePusher.mock.calls).toEqual([
      ['@alt:hs', 'dev.trinityproject.trinity.ios', 'TOKEN123'],
    ]);
    // A single-account teardown must NOT detach the shared listeners.
    expect(h.push.removeAllListeners).not.toHaveBeenCalled();
  });
});
