import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for clickable links: a bare URL sent as a plain-text message renders as a
// real <a> link (linkified on render), not inert text. Needs a Synapse homeserver
// (Docker).
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

test.describe('Clickable links', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('renders a bare URL in a message as a clickable link', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}l`;
    const hs = session.hs as string;
    const username = `linkify-user-${runId}`;
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
    const roomName = `Linkify E2E ${runId}`;
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName },
    });

    await login(page, {
      available: true,
      hs,
      user: username,
      pass: password,
    } as SynapseSession);
    await openRoom(page, roomName);

    const composer = page.getByTestId('composer-input');
    await composer.click();
    await composer.fill('look at https://example.com');
    await composer.press('Enter');

    // The bare URL in the message renders as a clickable link (not plain text).
    await expect(
      page
        .locator('.scroll .msg a[href="https://example.com"]', {
          hasText: 'https://example.com',
        })
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
