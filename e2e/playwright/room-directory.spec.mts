import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers browsing the public room directory: the Home "+" → "Explore public rooms"
// opens a dialog (data-testid="room-directory") that searches publicRooms and joins a
// chosen room (data-testid="directory-join" → PublicRoomsService.join → joinRoom). One
// user publishes a public room; another finds it in the directory and joins, and it lands
// in their channel list. Needs a Synapse homeserver (Docker); self-skips otherwise.
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

test.describe('Room directory', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('finds a public room in the directory and joins it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}dir`;
    const owner = `dir-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const joiner = `dir-joiner-${runId}`;
    const joinerPass = `${joiner}-pass`;
    const roomName = `Directory ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, joiner, joinerPass);
    const ownerToken = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: owner },
          password: ownerPass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);

    // Publish a public, directory-listed room the joiner can discover.
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      data: { name: roomName, preset: 'public_chat', visibility: 'public' },
    });

    await login(page, {
      available: true,
      hs,
      user: joiner,
      pass: joinerPass,
    } as SynapseSession);

    // Home "+" → the new-message action sheet → Explore public rooms.
    await page.click('button[aria-label="New room or direct message"]');
    const sheet = page.locator('trn-action-sheet');
    await sheet.waitFor({ state: 'visible', timeout: 15_000 });
    await sheet.getByRole('button', { name: 'Explore public rooms' }).click();

    // The directory dialog opens; search for the room by name.
    await expect(page.getByTestId('room-directory')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('directory-search').fill(roomName);
    await page.getByTestId('directory-search-btn').click();

    const row = page
      .getByTestId('directory-room')
      .filter({ hasText: roomName });
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Join it; the dialog closes and the room lands in the channel list.
    await row.getByTestId('directory-join').click();
    await expect(
      page.locator('button.channel', { hasText: roomName }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});
