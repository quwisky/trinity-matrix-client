import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for message forwarding: pick another room from the switcher and the
// message lands there. Needs a Synapse homeserver (Docker).
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

test.describe('Message forwarding', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('forwards a message to another room', async ({ page, request }) => {
    const runId = `${Date.now().toString(36)}f`;
    const hs = session.hs as string;
    const username = `fwd-user-${runId}`;
    const password = `${username}-pass`;
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
    const headers = { Authorization: `Bearer ${access_token}` };

    const sourceName = `Forward Source ${runId}`;
    const targetName = `Forward Target ${runId}`;
    for (const name of [sourceName, targetName]) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name },
      });
    }

    await login(page, {
      available: true,
      hs,
      user: username,
      pass: password,
    } as SynapseSession);
    await openRoom(page, sourceName);

    // Send the message to forward.
    const body = `forward this ${runId}`;
    const composer = page.getByTestId('composer-input');
    await composer.click();
    await composer.fill(body);
    await composer.press('Enter');
    const row = page.locator('.scroll .msg', { hasText: body });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });

    // Open the overflow menu and forward it.
    await row.first().hover();
    await row.first().getByTestId('msg-more').click();
    await page.getByTestId('msg-forward').click();

    // The switcher opens as a room picker — choose the target room.
    const search = page.getByPlaceholder('Search rooms, spaces, people');
    await expect(search).toBeVisible({ timeout: 10_000 });
    await search.fill(targetName);
    await page.locator('.qs-row', { hasText: targetName }).first().click();

    // The forwarded message now appears in the target room.
    await openRoom(page, targetName);
    await expect(
      page.locator('.scroll .msg', { hasText: body }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
