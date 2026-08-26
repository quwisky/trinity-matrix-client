import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

/**
 * The open room is in the URL, so a room is linkable and survives a reload.
 *
 * This is the one property of #179's routing slice that no unit test can reach. The specs
 * around `RoomShellStore` prove the store follows `paramMap`, and `app.routes.spec.ts` proves
 * the two URL shapes are one reused route — but neither exercises a real address bar, a real
 * reload, or the service worker and Electron fallbacks that a dotted path would have broken.
 * The room segment is base64url precisely so those fallbacks need no exception; the assertion
 * that the URL contains no dot is what keeps that true.
 *
 * Needs a Synapse homeserver (Docker) and self-skips otherwise.
 */
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

test.describe('The open room lives in the URL', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('is linkable, survives a reload, and Back returns to the list', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}url`;
    const user = `urlroom-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Linkable ${runId}`;

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
      data: { name: roomName },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);

    // The list, before a room is open: no room segment.
    await expect(page).toHaveURL(/\/rooms$/);

    await openRoom(page, roomName);

    // Opening a room put it in the address bar.
    await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
    const roomUrl = page.url();

    // THE constraint the encoding exists for. A raw room id ends in a dotted server name,
    // which Angular's service worker excludes from the navigations it answers with index.html
    // (`!/**‍/*.*`) and which the Electron handler reads as a file extension. If this ever
    // contains a dot, a bookmarked room 404s on two hosts and no unit test notices.
    const segment = new URL(roomUrl).pathname.split('/').pop() ?? '';
    expect(segment).not.toMatch(/[.#:]/);
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);

    // A reload lands back in the same room rather than on the list. This is the whole point:
    // before this slice the room was page state and a refresh dropped it.
    await page.reload();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(roomUrl);

    // And the room is a history entry, so Back closes it instead of leaving the shell —
    // which is what makes Android's hardware Back behave once it falls through to history.
    await page.goBack();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByTestId('composer-input')).toBeHidden({
      timeout: 15_000,
    });
  });
});
