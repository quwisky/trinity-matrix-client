import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  confirmErase,
  databaseNames,
  homeserverSession,
  login,
  waitForRooms,
} from '../../../support/app.mts';
import { openRoom, tokenFor } from '../../support/room-settings-journey.mts';
import {
  countSyncRequests,
  isSyncResponse,
  openWaitingTab,
  waitingNotice,
} from '../../support/session-tabs.mts';

// #1267: on the web, one tab runs Trinity's Matrix clients and crypto stores. Two pages of ONE
// browser context share storage and Web Locks like two tabs of one browser profile.
const session = homeserverSession();

test.describe('Session lock', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test('a second tab waits while the first one runs Trinity', async ({
    page,
  }) => {
    await login(page, session);

    const second = await openWaitingTab(page);

    await expect(
      second.page.getByText(
        'Trinity runs in one tab at a time so your encrypted messages stay readable. You can move it to this tab.',
      ),
    ).toBeVisible();
    await expect(
      second.page.getByRole('button', { name: 'Use here' }),
    ).toBeVisible();
    // One full /sync round trip of the running tab is the settle window: the waiting tab
    // restored nothing and never syncs.
    await page.waitForResponse(isSyncResponse, { timeout: 60_000 });
    expect(second.syncs()).toBe(0);
    await expect(second.page.getByTestId('user-menu-trigger')).toHaveCount(0);
  });

  test('"Use here" moves Trinity to the second tab and the first stops syncing', async ({
    page,
    request,
  }) => {
    const roomName = `Session lock ${testResourceId('room')}`;
    const token = await tokenFor(
      request,
      session.hs as string,
      session.user as string,
      session.pass as string,
    );
    const created = await request.post(
      `${session.hs as string}/_matrix/client/v3/createRoom`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
      },
    );
    expect(created.ok()).toBe(true);
    await login(page, session);
    await openRoom(page, roomName);
    await page.waitForURL((url) => url.pathname.startsWith('/rooms/'), {
      timeout: 30_000,
    });
    const room = new URL(page.url());
    const onRoom = (url: URL): boolean =>
      url.pathname === room.pathname &&
      url.searchParams.get('account') === room.searchParams.get('account');
    const second = await openWaitingTab(page);

    await second.page.getByRole('button', { name: 'Use here' }).click();

    await waitForRooms(second.page, 60_000);
    // The first tab reloaded in place into a fresh document that now waits for the lock, on
    // the room it showed. This pins the outcome, not the RoomsPage 'releasing' guard: in
    // Chromium the reload starts before the return-to-login effect can run, so this passes
    // without the guard; it fails (on /login) only when that redirect wins the race.
    await expect(waitingNotice(page)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(onRoom, { timeout: 30_000 });
    const firstTabSyncs = countSyncRequests(page);
    await second.page.waitForResponse(isSyncResponse, { timeout: 60_000 });
    expect(firstTabSyncs()).toBe(0);

    // Closing the second tab frees the lock: the reloaded first tab takes it, starts, and
    // restores the room it showed before the handover rather than the sign-in page (N12).
    await second.page.close();
    await expect(waitingNotice(page)).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page).toHaveURL(onRoom, { timeout: 60_000 });
  });

  test('"Use here" puts a message the first tab could not send into the second tab’s composer', async ({
    page,
    request,
  }) => {
    const roomName = `Session lock unsent ${testResourceId('room')}`;
    const unsent = `Not on the server yet ${testResourceId('message')}`;
    const token = await tokenFor(
      request,
      session.hs as string,
      session.user as string,
      session.pass as string,
    );
    const created = await request.post(
      `${session.hs as string}/_matrix/client/v3/createRoom`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
      },
    );
    expect(created.ok()).toBe(true);
    await login(page, session);
    await openRoom(page, roomName);
    // Hold every send of the first tab, so the message stays on its way through the handover.
    await page.route('**/_matrix/client/**/send/**', () => undefined);
    const sending = page.waitForRequest(
      (sent) => sent.method() === 'PUT' && sent.url().includes('/send/'),
      { timeout: 30_000 },
    );
    await page.getByTestId('composer-input').fill(unsent);
    await page.getByTestId('composer-input').press('Enter');
    await sending;
    const second = await openWaitingTab(page);

    await second.page.getByRole('button', { name: 'Use here' }).click();

    await waitForRooms(second.page, 60_000);
    await openRoom(second.page, roomName);
    await expect(second.page.getByTestId('composer-input')).toHaveValue(
      unsent,
      { timeout: 30_000 },
    );
  });

  test('closing the first tab lets the waiting tab start by itself', async ({
    page,
  }) => {
    await login(page, session);
    const second = await openWaitingTab(page);

    await page.close();

    await waitForRooms(second.page, 60_000);
    await expect(second.page.getByTestId('user-menu-trigger')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('reloading the only tab starts Trinity again', async ({ page }) => {
    await login(page, session);

    await page.reload({ waitUntil: 'domcontentloaded' });

    // The reloaded document may ask before the old one's lock is freed; it must start anyway.
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({
      timeout: 60_000,
    });
    await expect(waitingNotice(page)).toHaveCount(0);
  });

  test('an erase in the first tab is not blocked by the waiting tab', async ({
    page,
  }) => {
    await login(page, session);
    const before = await databaseNames(page);
    expect(
      before.some((name) => name.startsWith('matrix-js-sdk:trinity-sync:@')),
    ).toBe(true);
    const second = await openWaitingTab(page);

    // In-app to the login page, so the first tab keeps the lock: a page.goto would reload it
    // and hand the lock to the waiting tab.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('add-account').click();
    await page.getByTestId('clear-all-data').click();
    await confirmErase(page, 'RESET TRINITY');

    // The erase finished (a blocked delete would stop it from restarting) and restarted the
    // first tab, which freed the lock: the waiting tab starts on the wiped storage and offers
    // sign-in, and the restarted first tab now waits.
    await expect(second.page.getByLabel('Homeserver')).toBeVisible({
      timeout: 60_000,
    });
    await expect(waitingNotice(page)).toBeVisible({ timeout: 30_000 });
    const after = await databaseNames(second.page);
    expect(
      after.some((name) => name.startsWith('matrix-js-sdk:trinity-sync:@')),
    ).toBe(false);
    expect(after.some((name) => name.endsWith('::matrix-sdk-crypto'))).toBe(
      false,
    );
  });
});
