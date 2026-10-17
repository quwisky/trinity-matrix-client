import { expect, test, testResourceId, type Page } from '../../../fixtures.mts';
import { login, type HomeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  HS_SERVER_NAME,
  configureRoomSettingsSuite,
  openRoom,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';

// Covers Room settings › Addresses › Room directory: an admin lists a room in their server's
// directory, a second account finds it in Explore public rooms, and after the admin unlists it
// the search no longer finds it.
async function openExplore(page: Page): Promise<void> {
  await page.click('button[aria-label="New room or direct message"]');
  const menu = page.getByRole('menu', { name: 'New message' });
  await menu.waitFor({ state: 'visible', timeout: 15_000 });
  await menu.getByRole('menuitem', { name: 'Explore public rooms' }).click();
  await expect(page.getByTestId('room-directory')).toBeVisible({
    timeout: 15_000,
  });
}

async function search(page: Page, roomName: string) {
  await page.getByTestId('directory-search').fill(roomName);
  await page.getByTestId('directory-search-btn').click();
  return page.getByTestId('directory-room').filter({ hasText: roomName });
}

test.describe('Room directory listing', () => {
  configureRoomSettingsSuite();

  test('an admin lists a room, another account finds it, and unlisting hides it', async ({
    page,
    request,
    secondaryApp,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}dl`;
    const owner = `listing-${runId}`;
    const ownerPass = `${owner}-pass`;
    const finder = `finder-${runId}`;
    const finderPass = `${finder}-pass`;
    const roomName = `Listed ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, finder, finderPass);
    const token = await tokenFor(request, hs, owner, ownerPass);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'public_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    const listing = () =>
      request
        .get(
          `${hs}/_matrix/client/v3/directory/list/room/${encodeURIComponent(roomId)}`,
        )
        .then((r) => r.json())
        .then((j) => j.visibility as string);

    await login(page, {
      available: true,
      hs,
      user: owner,
      pass: ownerPass,
    } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('room-settings-tab-addresses').click();

    const toggle = page.getByRole('switch', {
      name: `List in ${HS_SERVER_NAME}'s room directory`,
    });
    await expect(toggle).not.toBeChecked({ timeout: 15_000 });
    const putListing = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().includes('/directory/list/room/'),
      );

    let sent = putListing();
    await toggle.click();
    expect((await sent).ok()).toBe(true);
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    expect(await listing()).toBe('public');

    const finderPage = await secondaryApp.launch();
    await login(finderPage, {
      available: true,
      hs,
      user: finder,
      pass: finderPass,
    } as HomeserverSession);
    await openExplore(finderPage);
    await expect(await search(finderPage, roomName)).toBeVisible({
      timeout: 20_000,
    });

    sent = putListing();
    await toggle.click();
    expect((await sent).ok()).toBe(true);
    await expect(toggle).not.toBeChecked();
    expect(await listing()).toBe('private');

    // The empty state appears only once a search has finished without results.
    await expect(async () => {
      const rows = await search(finderPage, roomName);
      await expect(finderPage.getByTestId('directory-empty')).toBeVisible({
        timeout: 5_000,
      });
      await expect(rows).toHaveCount(0);
    }).toPass({ timeout: 30_000 });
  });
});
