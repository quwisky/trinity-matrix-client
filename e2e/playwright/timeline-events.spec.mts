import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the timeline system lines (message-row `data-testid="timeline-event"`): a room
// state change (here an m.room.name rename) renders as a compact human-readable line
// between messages (TimelineService projects it via describeTimelineEvent). Needs a
// Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

test.describe('Timeline system events', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('renders a room rename as a system line', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}se`;
    const user = `se-user-${runId}`;
    const pass = `${user}-pass`;
    const renamed = `Renamed ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const auth = { Authorization: `Bearer ${token}` };

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: `Events ${runId}`, preset: 'private_chat' },
      })
      .then((r) => r.json());
    const room = encodeURIComponent(room_id);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${room}/send/m.room.message/${runId}-msg`,
      { headers: auth, data: { msgtype: 'm.text', body: 'hello' } },
    );
    // The rename is the latest event, so its system line renders at the bottom.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${room}/state/m.room.name/`,
      { headers: auth, data: { name: renamed } },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: renamed });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    const line = page
      .getByTestId('timeline-event')
      .filter({ hasText: 'changed the room name to' });
    await expect(line.first()).toBeVisible({ timeout: 30_000 });
    await expect(line.first()).toContainText(`"${renamed}"`);
  });

  test('renders another member joining as a system line', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}mj`;
    const owner = `mj-owner-${runId}`;
    const joiner = `mj-joiner-${runId}`;
    const joinerName = `Joiner ${runId}`;
    const pass = (u: string) => `${u}-pass`;

    const tokenFor = async (user: string): Promise<string> => {
      await registerUser(request, user, pass(user));
      return request
        .post(`${hs}/_matrix/client/v3/login`, {
          data: {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user },
            password: pass(user),
          },
        })
        .then((r) => r.json())
        .then((j) => j.access_token as string);
    };

    const ownerToken = await tokenFor(owner);
    const joinerToken = await tokenFor(joiner);
    const joinerId = `@${joiner}:${new URL(hs).hostname}`;
    // A display name so the join line names the member, not their bare id.
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(joinerId)}/displayname`,
      {
        headers: { Authorization: `Bearer ${joinerToken}` },
        data: { displayname: joinerName },
      },
    );

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: { name: `Members ${runId}`, preset: 'public_chat' },
      })
      .then((r) => r.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-msg`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: { msgtype: 'm.text', body: 'hi' },
      },
    );
    // The joiner's membership is the latest event, so its line renders at the bottom.
    await request.post(
      `${hs}/_matrix/client/v3/join/${encodeURIComponent(room_id)}`,
      { headers: { Authorization: `Bearer ${joinerToken}` }, data: {} },
    );

    await login(page, {
      available: true,
      hs,
      user: owner,
      pass: pass(owner),
    } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: `Members ${runId}` });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    const line = page
      .getByTestId('timeline-event')
      .filter({ hasText: `${joinerName} joined the room` });
    await expect(line.first()).toBeVisible({ timeout: 30_000 });
  });
});
