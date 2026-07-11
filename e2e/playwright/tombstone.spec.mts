import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the room-upgrade / tombstone banner (data-testid="tombstone-banner"): a room
// with an m.room.tombstone shows a banner whose "Go to the new room" (tombstone-go) joins
// and opens the successor. Uses distinctly-named old/new rooms so each is identifiable.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Room tombstone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows the upgrade banner and moves to the successor room', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}tb`;
    const user = `tomb-${runId}`;
    const pass = `${user}-pass`;
    const oldName = `OldRoom ${runId}`;
    const newName = `NewRoom ${runId}`;

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
    const createRoom = (name: string) =>
      request
        .post(`${hs}/_matrix/client/v3/createRoom`, {
          headers: auth,
          data: { name, preset: 'private_chat' },
        })
        .then((r) => r.json())
        .then((j) => j.room_id as string);

    const oldRoom = await createRoom(oldName);
    const newRoom = await createRoom(newName);
    // Tombstone the old room, pointing at the (distinctly-named) successor.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(oldRoom)}/state/m.room.tombstone/`,
      {
        headers: auth,
        data: {
          body: 'This room has been upgraded.',
          replacement_room: newRoom,
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, oldName);

    // The old room shows the upgrade banner.
    await expect(page.getByTestId('tombstone-banner')).toBeVisible({
      timeout: 20_000,
    });

    // Go to the successor: the banner clears (the live successor has no tombstone).
    await page.getByTestId('tombstone-go').click();
    await expect(page.getByTestId('tombstone-banner')).toBeHidden({
      timeout: 20_000,
    });
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });
});
