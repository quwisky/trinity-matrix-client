import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import {
  addAccountViaUi,
  seedLiveNotifyReader,
} from '../../support/multi-account-journey.mts';
import type { Observable } from 'rxjs';

type PushFixtureEvent = {
  kind: 'activated';
  data: Record<string, string>;
};
interface PushFixtureWindow extends Window {
  ng: {
    getComponent(element: Element): {
      runtime: {
        state(): { phase: string };
        adapter: {
          session: {
            notificationSession: {
              push: {
                push: {
                  nativePush: { platform: string; supported(): boolean };
                  gateway: {
                    supported(): boolean;
                    save(url: string): Promise<void>;
                  };
                  currentPushkey: string | null;
                  register(): Observable<void>;
                  matrix: {
                    all(): readonly {
                      client: {
                        getPushers(): Promise<{ pushers: Pusher[] }>;
                        removePusher(
                          pushkey: string,
                          appId: string,
                        ): Promise<unknown>;
                      };
                    }[];
                  };
                  sessions: {
                    ensurePushAccountRoutes(): Observable<
                      readonly { accountId: string; route: string }[]
                    >;
                  };
                  handleNativeEvent(
                    event: PushFixtureEvent,
                  ): Observable<unknown>;
                };
              };
              handlePush(event: unknown): Observable<never>;
            };
          };
        };
      };
    };
  };
}

// Two things, both needing a Synapse homeserver (Docker); self-skips otherwise.
//
// 1. UI: the push-gateway block (Settings → Notifications → PushGatewayBlockComponent)
//    is native-only. In the web build Capacitor.getPlatform() is 'web', so the block
//    must show its "applies on iOS and Android" note and NOT the URL form — the only
//    part of the feature a browser can observe (delivery needs a real device).
//
// 2. CS API: the pusher-table invariants PushService is built on. setPushers() assumes
//    append:true lets co-hosted accounts coexist, and the app-id swap (removePusher old
//    → setPusher new) leaves no orphan. Those are unit-tested against a stateful mock;
//    this pins the mock to the real homeserver so a Synapse/spec change can't drift it
//    out from under the unit tests silently.
const session = synapseSession();

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  if (!res.ok()) {
    throw new Error(`login ${user} → ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).access_token as string;
}

interface Pusher {
  app_id: string;
  pushkey: string;
  kind: string;
  data: {
    url?: string;
    trinity_account_id?: string;
    trinity_push_version?: string;
    format?: string;
  };
}

const NOTIFY = 'https://push.example.org/_matrix/push/v1/notify';
const PUSHKEY = 'E2E-DEVICE-TOKEN';

test.describe('Push gateway', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('the gateway block follows the current platform capability', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}g`;
    const user = `pgw-ui-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSettingsSection(page, 'notifications');

    // The block composes into the section...
    await expect(
      page.getByRole('heading', { name: 'Push gateway (this device)' }),
    ).toBeVisible({ timeout: 15_000 });
    if (isAndroidE2E) {
      await expect(page.getByTestId('push-gateway-unsupported')).toHaveCount(0);
      await expect(page.getByTestId('push-gateway-url')).toBeVisible();
    } else {
      // On the web platform it is inert: the note shows, the form does not.
      await expect(page.getByTestId('push-gateway-unsupported')).toBeVisible();
      await expect(page.getByTestId('push-gateway-url')).toHaveCount(0);
    }
  });

  test('append lets co-hosted accounts coexist and an app-id change leaves no orphan', async ({
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}p`;
    const [aUser, bUser] = [`pgw-a-${runId}`, `pgw-b-${runId}`];
    await registerUser(request, aUser, 'pw');
    await registerUser(request, bUser, 'pw');
    const aTok = await apiLogin(request, hs, aUser, 'pw');
    const bTok = await apiLogin(request, hs, bUser, 'pw');

    const setPusher = (token: string, appId: string): Promise<unknown> =>
      request.post(`${hs}/_matrix/client/v3/pushers/set`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          app_id: appId,
          pushkey: PUSHKEY,
          kind: 'http',
          app_display_name: 'Trinity',
          device_display_name: 'E2E',
          lang: 'en',
          data: {
            url: NOTIFY,
            format: 'event_id_only',
            trinity_account_id:
              token === aTok ? 'account_route_a' : 'account_route_b',
            trinity_push_version: '1',
          },
          append: true,
        },
      });
    const removePusher = (token: string, appId: string): Promise<unknown> =>
      request.post(`${hs}/_matrix/client/v3/pushers/set`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { app_id: appId, pushkey: PUSHKEY, kind: null },
      });
    const pushers = async (token: string): Promise<Pusher[]> => {
      const res = await request.get(`${hs}/_matrix/client/v3/pushers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await res.json()).pushers ?? [];
    };

    const APP = 'eu.qwky.trinity.android';

    // Both accounts register the same (app_id, pushkey) with append:true — the
    // multi-account case. B's registration must NOT delete A's pusher.
    await setPusher(aTok, APP);
    await setPusher(bTok, APP);
    expect((await pushers(aTok)).length).toBe(1);
    expect((await pushers(bTok)).length).toBe(1);

    // Re-registering A with the same key stays idempotent — no accumulation.
    await setPusher(aTok, APP);
    expect((await pushers(aTok)).length).toBe(1);

    // The readback shape verifyPushers() matches on.
    const [aPusher] = await pushers(aTok);
    expect(aPusher.kind).toBe('http');
    expect(aPusher.data).toEqual({
      url: NOTIFY,
      format: 'event_id_only',
      trinity_account_id: 'account_route_a',
      trinity_push_version: '1',
    });
    expect((await pushers(bTok))[0].data.trinity_account_id).toBe(
      'account_route_b',
    );

    // App-id change: remove the old, set the new. The tuple changes, so without the
    // explicit removal the old row would survive and keep delivering.
    const NEW_APP = 'org.other.gateway.android';
    await removePusher(aTok, APP);
    await setPusher(aTok, NEW_APP);
    const after = await pushers(aTok);
    expect(after.length).toBe(1);
    expect(after[0].app_id).toBe(NEW_APP);
  });

  test('Retry recovers a failed registration and restores a missing homeserver pusher', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'controlled token injection uses Angular development hooks; device delivery is verified separately',
    );
    const hs = session.hs as string;
    const user = `pgw-recovery-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.querySelector('trn-root');
          return root
            ? (window as unknown as PushFixtureWindow).ng
                .getComponent(root)
                .runtime.state().phase
            : undefined;
        }),
      )
      .toBe('ready');

    let refuseNextRegistration = true;
    await page.route('**/_matrix/client/v3/pushers/set', async (route) => {
      const payload = route.request().postDataJSON() as { kind?: string };
      if (refuseNextRegistration && payload.kind === 'http') {
        refuseNextRegistration = false;
        await route.fulfill({
          status: 400,
          json: {
            errcode: 'M_UNKNOWN',
            error: 'private-server-detail-must-not-be-displayed',
          },
        });
      } else await route.continue();
    });

    // Supply the native capability and token; registration, persistence, SDK calls,
    // retry handling and rendered Settings remain the production implementation.
    await page.evaluate(
      async ({ notify, token }) => {
        const root = document.querySelector('trn-root');
        if (!root) throw new Error('Application root unavailable');
        const push = (window as unknown as PushFixtureWindow).ng.getComponent(
          root,
        ).runtime.adapter.session.notificationSession.push.push;
        push.nativePush.platform = 'android';
        push.nativePush.supported = () => true;
        push.gateway.supported = () => true;
        await push.gateway.save(notify);
        push.currentPushkey = token;
        await new Promise<void>((resolve, reject) => {
          push.register().subscribe({ complete: resolve, error: reject });
        });
      },
      { notify: NOTIFY, token: `E2E-recovery-${testResourceId('token')}` },
    );

    await openSettingsSection(page, 'notifications');
    await expect(page.getByTestId('push-gateway-status')).toContainText(
      'Retry',
    );
    await expect(page.getByTestId('push-gateway-status')).not.toContainText(
      'private-server-detail',
    );
    await page.getByTestId('push-gateway-retry').click();
    await expect(page.getByTestId('push-gateway-status')).toContainText(
      'Registered on 1 account',
    );

    // Read the real homeserver state independently of the rendered success message.
    await page.evaluate(async () => {
      const root = document.querySelector('trn-root');
      if (!root) throw new Error('Application root unavailable');
      const push = (window as unknown as PushFixtureWindow).ng.getComponent(
        root,
      ).runtime.adapter.session.notificationSession.push.push;
      const client = push.matrix.all()[0].client;
      const { pushers } = await client.getPushers();
      if (pushers.length !== 1)
        throw new Error('Expected one registered pusher');
      const before = pushers[0];
      await client.removePusher(before.pushkey, before.app_id);
      if ((await client.getPushers()).pushers.length !== 0)
        throw new Error('The pusher was not removed from the homeserver');
      await new Promise<void>((resolve, reject) => {
        push.register().subscribe({ complete: resolve, error: reject });
      });
      const restored = (await client.getPushers()).pushers;
      if (
        restored.length !== 1 ||
        restored[0].pushkey !== before.pushkey ||
        restored[0].data.trinity_account_id !== before.data.trinity_account_id
      )
        throw new Error(
          'Registration did not restore the owning Account pusher',
        );
    });
    await expect(page.getByTestId('push-gateway-status')).toContainText(
      'Registered on 1 account',
    );
    expect(refuseNextRegistration).toBe(false);
  });

  test('a v1 push tap opens its saved Account and Conversation', async ({
    page,
    request,
    matrixResources,
  }) => {
    test.skip(
      isAndroidE2E,
      'payload injection uses Angular development hooks; device delivery is verified separately',
    );
    const hs = session.hs as string;
    const b = await seedLiveNotifyReader(request, hs, matrixResources);
    const body = `Push destination ${testResourceId('run')}`;
    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(b.roomId)}/send/m.room.message/${testResourceId('push')}`,
      { headers: b.sender.headers, data: { msgtype: 'm.text', body } },
    );
    expect(sent.ok()).toBe(true);
    const { event_id: eventId } = await sent.json();
    await login(page, session);
    await addAccountViaUi(page, hs, b.user, b.pass);
    await expect(page.locator('.userbar__handle')).toContainText(`@${b.user}:`);
    await page.getByTestId('rail-rooms').click();
    await expect(
      page.locator('.channel', { hasText: b.roomName }).first(),
    ).toBeVisible();
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${session.user}:` })
      .click();
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${session.user}:`,
    );

    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.querySelector('trn-root');
          if (!root) return undefined;
          return (window as unknown as PushFixtureWindow).ng
            .getComponent(root)
            .runtime.state().phase;
        }),
      )
      .toBe('ready');

    // Inject at the native adapter boundary. Real parsing, saved-route admission,
    // Runtime handling and Workspace navigation remain in the exercised path.
    await page.evaluate(
      async ({ accountId, roomId, eventId }) => {
        const root = document.querySelector('trn-root');
        if (!root) throw new Error('Application root unavailable');
        const composition = (
          window as unknown as PushFixtureWindow
        ).ng.getComponent(root).runtime.adapter.session.notificationSession;
        const push = composition.push.push;
        const routes = await new Promise<
          readonly { accountId: string; route: string }[]
        >((resolve, reject) => {
          push.sessions
            .ensurePushAccountRoutes()
            .subscribe({ next: resolve, error: reject });
        });
        const route = routes.find(
          (entry) => entry.accountId === accountId,
        )?.route;
        if (!route) throw new Error('Saved Account route unavailable');
        await new Promise<void>((resolve, reject) => {
          let admitted = false;
          push
            .handleNativeEvent({
              kind: 'activated',
              data: {
                schema: '1',
                kind: 'event',
                trinity_account_id: route,
                room_id: roomId,
                event_id: eventId,
                unread: '1',
                missed_calls: '0',
                sound: 'false',
              },
            })
            .subscribe({
              next: (event) => {
                admitted = true;
                composition
                  .handlePush(event)
                  .subscribe({ error: reject, complete: resolve });
              },
              error: reject,
              complete: () => {
                if (!admitted)
                  reject(
                    new Error('Valid saved Account push was not admitted'),
                  );
              },
            });
        });
      },
      { accountId: b.readerUserId, roomId: b.roomId, eventId },
    );

    await expect(page.locator('.userbar__handle')).toContainText(`@${b.user}:`);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('account'))
      .toBe(b.readerUserId);
    await expect(page.getByText(body, { exact: true }).first()).toBeVisible();
  });
});
