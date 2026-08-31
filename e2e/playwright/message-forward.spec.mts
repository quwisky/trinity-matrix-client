import { test, expect, type Page } from './support/fixtures.mts';
import {
  clickRowMenuItem,
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  type SynapseSession,
  waitForSent,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for message forwarding: pick another room from the switcher and the
// message lands there. Needs a Synapse homeserver (Docker).
const session = synapseSession();

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
    await waitForSent(row.first());

    // Android exposes message actions through a long-press sheet; pointer hosts use
    // the row's overflow menu. Both dispatch the same forward command.
    if (isAndroidE2E) {
      const sheet = await openMessageActionSheet(page, row.first());
      await sheet.getByTestId('sheet-forward').click();
    } else {
      await clickRowMenuItem(row.first(), page.getByTestId('msg-forward'));
    }

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
