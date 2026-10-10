import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import { homeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Pins the pusher-table behaviour PushService is built on against a real Synapse, so a
// homeserver change cannot drift it out from under the unit tests' stateful mock:
// append:true lets co-hosted accounts share one device token, and the homeserver keeps the
// extra `data` keys the Trinity push gateway reads (`trinity_user_id`, `trinity_render`).
const session = homeserverSession();

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<{ token: string; userId: string }> {
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
  const body = (await res.json()) as { access_token: string; user_id: string };
  return { token: body.access_token, userId: body.user_id };
}

interface Pusher {
  app_id: string;
  pushkey: string;
  kind: string;
  data: {
    url?: string;
    format?: string;
    trinity_user_id?: string;
    trinity_render?: string;
  };
}

const NOTIFY = 'https://push.trinityproject.dev/_matrix/push/v1/notify';
const PUSHKEY = 'E2E-DEVICE-TOKEN';
const APP = 'dev.trinityproject.trinity.android';

test.describe('Pushers', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('co-hosted accounts keep their own device-render pushers', async ({
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}p`;
    const [aUser, bUser] = [`pshr-a-${runId}`, `pshr-b-${runId}`];
    await registerUser(request, aUser, 'pw');
    await registerUser(request, bUser, 'pw');
    const a = await apiLogin(request, hs, aUser, 'pw');
    const b = await apiLogin(request, hs, bUser, 'pw');

    const setPusher = (account: { token: string; userId: string }) =>
      request.post(`${hs}/_matrix/client/v3/pushers/set`, {
        headers: { Authorization: `Bearer ${account.token}` },
        data: {
          app_id: APP,
          pushkey: PUSHKEY,
          kind: 'http',
          app_display_name: 'Trinity',
          device_display_name: 'E2E',
          lang: 'en',
          data: {
            url: NOTIFY,
            format: 'event_id_only',
            trinity_user_id: account.userId,
            trinity_render: 'device',
          },
          append: true,
        },
      });
    const pushers = async (token: string): Promise<Pusher[]> => {
      const res = await request.get(`${hs}/_matrix/client/v3/pushers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await res.json()).pushers ?? [];
    };

    // B's registration of the same (app_id, pushkey) must NOT delete A's pusher.
    await setPusher(a);
    await setPusher(b);
    expect((await pushers(a.token)).length).toBe(1);
    expect((await pushers(b.token)).length).toBe(1);

    // Re-registering A stays idempotent — no accumulation.
    await setPusher(a);
    const [aPusher, ...extra] = await pushers(a.token);
    expect(extra).toEqual([]);

    // The readback shape verifyPushers() matches on, with the gateway's data keys kept.
    expect(aPusher.kind).toBe('http');
    expect(aPusher.data).toMatchObject({
      url: NOTIFY,
      format: 'event_id_only',
      trinity_user_id: a.userId,
      trinity_render: 'device',
    });
  });
});
