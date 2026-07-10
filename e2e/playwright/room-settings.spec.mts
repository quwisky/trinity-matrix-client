import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers editing a room's settings: the room header's ⚙ button
// (data-testid="open-room-settings") opens a dialog (data-testid="room-settings")
// with Name/Topic fields, gated by the viewer's power level. As the room creator
// (admin), the reader renames the room; the new name round-trips through
// RoomSettingsService.setName → setRoomName → sync and re-labels the room.
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

test.describe('Room settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('an admin renames a room from the settings dialog', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}s`;
    const user = `settings-user-${runId}`;
    const pass = `${user}-pass`;
    const originalName = `Before ${runId}`;
    const newName = `After ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: originalName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, originalName);

    // Open the room settings dialog and rename the room.
    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('room-settings-name').fill(newName);
    await page.getByTestId('room-settings-save').click();

    // The rename round-trips: the room now shows under its new name (and not the
    // old one) in the channel list.
    await expect(
      page.locator('.channel', { hasText: newName }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('.channel', { hasText: originalName }),
    ).toHaveCount(0);
  });
});
