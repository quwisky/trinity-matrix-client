import { test, expect, type Page } from './support/fixtures.mts';
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

    // Workspace canonicalizes the login redirect to an exact Account coordinate.
    await expect
      .poll(() => new URL(page.url()).searchParams.get('account'))
      .toContain(`@${user}:`);
    await expect(page).toHaveURL(/\/rooms\?/);

    await openRoom(page, roomName);

    // Opening a room put it and its sidebar scope in the address bar.
    await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+\?/);
    const roomUrl = page.url();
    const roomLocation = new URL(roomUrl);
    expect(roomLocation.searchParams.get('account')).toContain(`@${user}:`);
    expect(roomLocation.searchParams.get('view')).toBe('rooms');

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

    // Compact/wide layout is placement, not a semantic destination or history entry.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page).toHaveURL(roomUrl);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page).toHaveURL(roomUrl);

    // And the room is a history entry, so Back closes it instead of leaving the shell —
    // which is what makes Android's hardware Back behave once it falls through to history.
    await page.goBack();
    await expect(page).toHaveURL((url) => {
      return (
        url.pathname === '/rooms' &&
        url.searchParams.get('account')?.includes(`@${user}:`) === true &&
        url.searchParams.get('view') === 'rooms'
      );
    });
    await expect(page.getByTestId('composer-input')).toBeHidden({
      timeout: 15_000,
    });

    // An unavailable Room keeps the requested Account and scope but replaces the bad
    // history entry with their safe list destination.
    const listUrl = new URL(page.url());
    const missingRoom = Buffer.from('!missing:example.org').toString(
      'base64url',
    );
    const missingUrl = new URL(listUrl);
    missingUrl.pathname = `/rooms/${missingRoom}`;
    await page.goto(missingUrl.toString());
    await expect(page).toHaveURL(listUrl.toString());
    await expect(page.getByTestId('composer-input')).toBeHidden();

    // Mixed scope coordinates are malformed and canonicalize to Recent rather than
    // allowing two independent selections to leak into the Workspace.
    const malformedUrl = new URL(listUrl);
    malformedUrl.searchParams.set(
      'space',
      Buffer.from('!space:example.org').toString('base64url'),
    );
    await page.goto(malformedUrl.toString());
    await expect(page).toHaveURL((url) => {
      return (
        url.pathname === '/rooms' &&
        url.searchParams.get('account')?.includes(`@${user}:`) === true &&
        !url.searchParams.has('view') &&
        !url.searchParams.has('space')
      );
    });
  });
});
