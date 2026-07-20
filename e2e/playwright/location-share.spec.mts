import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers sharing a location (+ tray → Location → m.location): the location card
// (data-testid="location-card") shows the coordinates + an OpenStreetMap link. The
// browser's geolocation is overridden so the position is deterministic offline.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

// Override the device location so getCurrentPosition resolves deterministically.
test.use({
  permissions: ['geolocation'],
  geolocation: { latitude: 40.7128, longitude: -74.006 },
});

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

test.describe('Share location', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shares the current location as a map card', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}loc`;
    const user = `loc-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Location ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('composer-insert').click();
    await page.getByTestId('insert-location').click();

    // The location card renders with the (overridden) coordinates + a maps link.
    const card = page.getByTestId('location-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('40.71280, -74.00600');
    await expect(card).toHaveAttribute(
      'href',
      /openstreetmap\.org.*mlat=40\.7128/,
    );

    // A location isn't free text, so it offers no Edit affordance (a text m.replace
    // would corrupt it) — even though it's the user's own message.
    const row = page.locator('.scroll .msg', {
      hasText: '40.71280, -74.00600',
    });
    await row.first().hover();
    await row.first().getByTestId('msg-more').click();
    await expect(page.getByTestId('msg-edit')).toHaveCount(0);
    // The menu did open (a non-edit action is present), so the absence is real.
    await expect(page.getByTestId('msg-copy-link')).toBeVisible();
  });
});
