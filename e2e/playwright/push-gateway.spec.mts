import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../support/app.mts';
import { registerUser } from '../support/account.mts';
import { openSettingsSection } from './journeys/navigation.mts';

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
  data: { url?: string };
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
          data: { url: NOTIFY, format: 'event_id_only' },
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
    expect(aPusher.data.url).toBe(NOTIFY);

    // App-id change: remove the old, set the new. The tuple changes, so without the
    // explicit removal the old row would survive and keep delivering.
    const NEW_APP = 'org.other.gateway.android';
    await removePusher(aTok, APP);
    await setPusher(aTok, NEW_APP);
    const after = await pushers(aTok);
    expect(after.length).toBe(1);
    expect(after[0].app_id).toBe(NEW_APP);
  });
});
