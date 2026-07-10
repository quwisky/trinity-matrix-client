import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for the per-room notification level: the header bell opens an
// All / Mentions / Mute chooser; picking one writes push rules, and reopening the
// chooser shows the persisted selection. Needs a Synapse homeserver (Docker).
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

async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ user: SynapseSession; roomName: string }> {
  const username = `notif-user-${runId}`;
  const password = `${username}-pass`;
  const roomName = `Notify E2E ${runId}`;

  await registerUser(request, username, password);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      },
    })
    .then((r) => r.json());
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: { name: roomName },
  });

  return {
    user: { available: true, hs, user: username, pass: password },
    roomName,
  };
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

test.describe('Per-room notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('mutes a room and remembers the choice', async ({ page, request }) => {
    const runId = `${Date.now().toString(36)}n`;
    const { user, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, user);
    await openRoom(page, roomName);

    // Open the notification chooser and mute the room.
    await page.getByTestId('room-notifications').click();
    await expect(
      page.getByRole('button', { name: 'All messages' }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Mute', exact: true }).click();

    // Reopen — the persisted selection (Mute) is now marked with a check.
    await page.getByTestId('room-notifications').click();
    await expect(page.getByRole('button', { name: '✓ Mute' })).toBeVisible({
      timeout: 15_000,
    });
  });
});
