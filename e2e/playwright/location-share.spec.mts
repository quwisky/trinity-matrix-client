import { testResourceId, test, expect, type Page } from '../fixtures.mts';
import {
  clickRowToolbar,
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  type SynapseSession,
} from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// Covers sharing a location (+ tray → Location → m.location): the location card
// (data-testid="location-card") shows the coordinates + an OpenStreetMap link. The
// browser's geolocation is overridden so the position is deterministic offline.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

// Override the device location so getCurrentPosition resolves deterministically.
test.use({
  permissions: ['geolocation'],
  geolocation: { latitude: 40.7128, longitude: -74.006 },
});

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
    const runId = `${testResourceId('run')}loc`;
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
    if (isAndroidE2E) {
      const sheet = await openMessageActionSheet(page, row.first());
      await expect(sheet.getByTestId('sheet-edit')).toHaveCount(0);
      // The sheet did open (a non-edit action is present), so the absence is real.
      await expect(sheet.getByTestId('sheet-copy-link')).toBeVisible();
    } else {
      await clickRowToolbar(row.first(), row.first().getByTestId('msg-more'));
      await expect(page.getByTestId('msg-edit')).toHaveCount(0);
      // The menu did open (a non-edit action is present), so the absence is real.
      await expect(page.getByTestId('msg-copy-link')).toBeVisible();
    }
  });
});
