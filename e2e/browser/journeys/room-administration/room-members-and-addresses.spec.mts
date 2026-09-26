import { captureScreenshot } from '../../../support/screenshot.mts';
import {
  devices,
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import type { TouchPlatform } from '../../../support/platform-contracts.mts';
import {
  configureRoomSettingsSuite,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';

const { defaultBrowserType: _pixelBrowser, ...pixel5 } = devices['Pixel 5'];

async function createSpace(
  request: APIRequestContext,
  hs: string,
  token: string,
  name: string,
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    })
    .then((response) => response.json())
    .then((body) => body.room_id as string);
}

async function openSpaceSettings(
  page: Page,
  spaceName: string,
  roomName: string,
  touchPlatform: TouchPlatform,
): Promise<void> {
  const space = page.getByRole('button', { name: spaceName, exact: true });
  await space.waitFor({ state: 'visible', timeout: 30_000 });
  await touchPlatform.tap(page, space);
  const room = page.locator('.channel', { hasText: roomName }).first();
  await room.waitFor({ state: 'visible', timeout: 30_000 });
  await touchPlatform.tap(page, room);
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
  await touchPlatform.tap(
    page,
    page.getByRole('button', { name: 'Back to rooms' }),
  );
  await touchPlatform.tap(page, space);
  await touchPlatform.tap(page, page.getByTestId('space-actions-overflow'));
  await touchPlatform.tap(page, page.getByTestId('open-space-settings'));
  await expect(page.getByTestId('space-settings')).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Space member and address settings on a phone', () => {
  test.use(pixel5);
  configureRoomSettingsSuite();

  test('opens Space Members from the shortcut and invites only to the Space', async ({
    page,
    request,
    touchPlatform,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spmembers`;
    const owner = `space-members-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const invitee = `space-members-invitee-${runId}`;
    const inviteePass = `${invitee}-pass`;
    const inviteeName = `Mobile member ${runId}`;
    const spaceName = `Members space ${runId}`;
    const childName = `Members child ${runId}`;
    await registerUser(request, owner, ownerPass);
    await registerUser(request, invitee, inviteePass);
    const ownerToken = await tokenFor(request, hs, owner, ownerPass);
    const inviteeToken = await tokenFor(request, hs, invitee, inviteePass);
    const ownerAuth = { Authorization: `Bearer ${ownerToken}` };
    const inviteeAuth = { Authorization: `Bearer ${inviteeToken}` };
    const inviteeId = await request
      .get(`${hs}/_matrix/client/v3/account/whoami`, { headers: inviteeAuth })
      .then((response) => response.json())
      .then((body) => body.user_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(inviteeId)}/displayname`,
      { headers: inviteeAuth, data: { displayname: inviteeName } },
    );
    const spaceId = await createSpace(request, hs, ownerToken, spaceName);
    const childId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: ownerAuth,
        data: { name: childName, preset: 'private_chat' },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
      { headers: ownerAuth, data: { via: ['localhost'] } },
    );

    await login(page, {
      available: true,
      hs,
      user: owner,
      pass: ownerPass,
    } as SynapseSession);
    const space = page.getByRole('button', { name: spaceName, exact: true });
    await space.waitFor({ state: 'visible', timeout: 30_000 });
    await touchPlatform.tap(page, space);
    await touchPlatform.tap(page, page.getByTestId('space-actions-overflow'));
    await touchPlatform.tap(page, page.getByTestId('open-space-members'));

    const settings = page.getByTestId('space-settings');
    await expect(settings).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('space-settings-section-heading')).toHaveText(
      'Members',
    );
    await expect(page.getByTestId('members-settings')).toBeVisible();

    const invite = page.getByTestId('members-settings-invite');
    expect((await invite.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );
    await touchPlatform.tap(page, invite);
    await page.getByLabel('@user:server or a name').fill(inviteeId);
    await touchPlatform.tap(
      page,
      page.getByRole('button', { name: 'Invite', exact: true }),
    );

    const membership = async (roomId: string): Promise<unknown> => {
      const response = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(inviteeId)}`,
        { headers: ownerAuth },
      );
      return response.ok() ? (await response.json()).membership : undefined;
    };
    await expect
      .poll(() => membership(spaceId), { timeout: 20_000 })
      .toBe('invite');
    await expect
      .poll(() => membership(childId), { timeout: 5_000 })
      .toBeUndefined();

    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/join`,
      { headers: inviteeAuth },
    );
    const row = page
      .getByTestId('member-list')
      .getByTestId('member-row')
      .filter({ hasText: inviteeName });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await touchPlatform.tap(page, row);
    const detail = page.getByTestId('members-settings-detail');
    await expect(detail).toContainText(inviteeName);
    await expect(detail).toContainText(inviteeId);

    const originalAppearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
      fontSize: document.documentElement.style.fontSize,
    }));
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('data-theme');
      document.documentElement.style.fontSize = '125%';
    });
    await test.info().attach('space-members-mobile-light', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('space-members-mobile-dark-amethyst', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme, fontSize }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.fontSize = fontSize;
    }, originalAppearance);

    await touchPlatform.tap(page, page.getByTestId('member-info-close'));
    await expect(row).toBeVisible();
    await touchPlatform.tap(page, page.getByTestId('members-settings-banned'));
    await expect(page.getByTestId('banned-members')).toBeVisible();
    expect(
      (await page.getByTestId('members-settings-banned').boundingBox())
        ?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  });

  test('keeps a long Space address readable, actionable and inside the viewport', async ({
    page,
    request,
    touchPlatform,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spaddr`;
    const user = `space-address-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Address space ${runId}`;
    const roomName = `Address room ${runId}`;
    const localpart = `a-very-long-community-address-${runId}-for-mobile-layout-proof`;

    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, spaceName);
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { via: ['localhost'], suggested: true },
      },
    );
    const userId = await request
      .get(`${hs}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => response.json())
      .then((body) => body.user_id as string);
    const server = userId.slice(userId.indexOf(':') + 1);
    const alias = `#${localpart}:${server}`;
    const directoryRoom = async (): Promise<unknown> => {
      const response = await request.get(
        `${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return response.ok() ? (await response.json()).room_id : undefined;
    };
    const canonicalAddress = async (): Promise<unknown> => {
      const response = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.canonical_alias/`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return response.ok() ? (await response.json()).alias : undefined;
    };

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceSettings(page, spaceName, roomName, touchPlatform);
    await openSettingsTab(page, 'space-settings', 'addresses');
    await expect(
      page.getByTestId('space-settings-section-heading'),
    ).toBeFocused();

    const input = page.getByTestId('room-alias-input');
    await input.fill(localpart);
    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, page.getByTestId('room-alias-add'));
    const row = page.getByTestId('room-alias').filter({ hasText: alias });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect.poll(directoryRoom, { timeout: 20_000 }).toBe(spaceId);
    await touchPlatform.tap(page, row.getByTestId('room-alias-set-main'));
    await expect(page.getByTestId('room-alias-primary')).toHaveText(alias);
    await expect.poll(canonicalAddress, { timeout: 20_000 }).toBe(alias);
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`${alias} is now the primary address.`),
    ).toBeHidden({ timeout: 5_000 });

    const settings = page.getByTestId('space-settings');
    await row.scrollIntoViewIfNeeded();
    const viewport = page.viewportSize();
    const rowBox = await row.boundingBox();
    expect(rowBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(
      viewport?.width ?? 0,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport?.width ?? 0);
    for (const action of [
      'room-alias-copy',
      'room-alias-link',
      'room-alias-remove',
    ]) {
      expect(
        (await row.getByTestId(action).boundingBox())?.height ?? 0,
      ).toBeGreaterThanOrEqual(44);
    }

    // Touch opens the exact-address confirmation; cancel keeps the published Space link.
    await touchPlatform.tap(page, row.getByTestId('room-alias-remove'));
    const confirmation = page.getByRole('dialog', {
      name: `Remove ${alias}?`,
    });
    await expect(confirmation).toContainText('does not delete the Space');
    await touchPlatform.tap(
      page,
      confirmation.getByRole('button', { name: 'Keep address' }),
    );
    await expect(row).toBeVisible();

    const originalAppearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
      fontSize: document.documentElement.style.fontSize,
    }));
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('data-theme');
      document.documentElement.style.fontSize = '125%';
    });
    await expect(row).toBeVisible();
    await test.info().attach('space-addresses-mobile-light', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('space-addresses-mobile-dark-amethyst', {
      body: await captureScreenshot(page, () => settings.screenshot()),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme, fontSize }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.fontSize = fontSize;
    }, originalAppearance);

    const spaceDirectoryRoute = /\/directory\/room\//;
    await page.route(spaceDirectoryRoute, async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ errcode: 'M_UNKNOWN', error: 'retry me' }),
        });
        return;
      }
      await route.continue();
    });
    const retryLocalpart = `retry-space-${runId}`;
    await input.fill(retryLocalpart);
    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, page.getByTestId('room-alias-add'));
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`Could not add #${retryLocalpart}:${server}.`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue(retryLocalpart);
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`Could not add #${retryLocalpart}:${server}.`),
    ).toBeHidden({ timeout: 5_000 });
    await page.unroute(spaceDirectoryRoute);

    // Confirmation removes both the Space's canonical state and its local directory entry.
    await touchPlatform.tap(page, row.getByTestId('room-alias-remove'));
    await touchPlatform.tap(
      page,
      confirmation.getByRole('button', { name: 'Remove address' }),
    );
    await expect(row).toHaveCount(0);
    await expect.poll(directoryRoom, { timeout: 20_000 }).toBeUndefined();
    await expect.poll(canonicalAddress, { timeout: 20_000 }).toBeUndefined();

    // Publish it again, then remove this Account's power remotely. The address remains
    // readable and public actions remain usable while every administration action vanishes.
    await input.fill(localpart);
    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, page.getByTestId('room-alias-add'));
    await expect(row).toBeVisible({ timeout: 10_000 });
    const powerLevelsUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`;
    const powerLevels = await request
      .get(powerLevelsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => response.json());
    await request.put(powerLevelsUrl, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        ...powerLevels,
        users: { ...(powerLevels.users ?? {}), [userId]: 0 },
      },
    });
    await expect(page.getByTestId('room-aliases-read-only')).toContainText(
      "The opening Account cannot currently manage this Space's addresses.",
      { timeout: 20_000 },
    );
    await expect(row).toBeVisible();
    await expect(row.getByTestId('room-alias-copy')).toBeVisible();
    await expect(row.getByTestId('room-alias-link')).toBeVisible();
    await expect(page.getByTestId('room-alias-input')).toHaveCount(0);
    await expect(page.getByTestId('room-alias-add')).toHaveCount(0);
    await expect(page.getByTestId('room-alias-set-main')).toHaveCount(0);
    await expect(page.getByTestId('room-alias-remove')).toHaveCount(0);

    await touchPlatform.tap(
      page,
      page.getByTestId('space-settings-mobile-back'),
    );
    await expect(page.getByTestId('space-settings-directory')).toBeVisible();

    // The server remains the final authority for the address created through the UI.
    await expect.poll(directoryRoom, { timeout: 20_000 }).toBe(spaceId);
  });
});
