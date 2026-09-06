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
import {
  configureRoomSettingsSuite,
  openRoom,
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
): Promise<void> {
  const space = page.getByRole('button', { name: spaceName, exact: true });
  await space.waitFor({ state: 'visible', timeout: 30_000 });
  await space.tap();
  const room = page.locator('.channel', { hasText: roomName }).first();
  await room.waitFor({ state: 'visible', timeout: 30_000 });
  await room.tap();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Back to rooms' }).tap();
  await space.tap();
  await page.getByTestId('space-actions-overflow').tap();
  await page.getByTestId('open-space-settings').tap();
  await expect(page.getByTestId('space-settings')).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Room settings', () => {
  configureRoomSettingsSuite();

  test('an admin unbans a member from the banned list', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ub`;
    const admin = `unban-admin-${runId}`;
    const adminPass = `${admin}-pass`;
    const target = `unban-target-${runId}`;
    const targetPass = `${target}-pass`;
    const targetName = `Banned ${runId}`;
    const roomName = `Bans ${runId}`;

    await registerUser(request, admin, adminPass);
    await registerUser(request, target, targetPass);
    const adminToken = await tokenFor(request, hs, admin, adminPass);
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const adminId = await request
      .get(`${hs}/_matrix/client/v3/account/whoami`, { headers: adminAuth })
      .then((response) => response.json())
      .then((body) => body.user_id as string);
    const targetLogin = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: target },
          password: targetPass,
        },
      })
      .then((r) => r.json());
    const targetId = targetLogin.user_id as string;
    const targetAuth = { Authorization: `Bearer ${targetLogin.access_token}` };

    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(targetId)}/displayname`,
      { headers: targetAuth, data: { displayname: targetName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: adminAuth,
        data: { name: roomName, preset: 'private_chat', invite: [targetId] },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: targetAuth },
    );
    // The admin bans the target so they appear in the room's banned list.
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/ban`,
      { headers: adminAuth, data: { user_id: targetId, reason: 'spam' } },
    );

    await login(page, {
      available: true,
      hs,
      user: admin,
      pass: adminPass,
    } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'members');
    await page.getByTestId('members-settings-banned').click();
    await expect(page.getByTestId('banned-members')).toBeVisible({
      timeout: 10_000,
    });
    const row = page
      .getByTestId('banned-member')
      .filter({ hasText: targetName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Unban them: the row disappears and the ban is lifted server-side.
    await row.getByTestId('banned-member-unban').click();
    const confirmation = page.getByRole('dialog', {
      name: 'Unban from room',
    });
    await expect(confirmation).toContainText(targetName);
    await expect(confirmation).toContainText(roomName);
    await expect(confirmation).toContainText(`Account ${adminId}`);
    await confirmation.getByRole('button', { name: 'Unban' }).click();
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`Unbanned ${targetName}.`),
    ).toBeVisible({ timeout: 20_000 });

    const membership = async (): Promise<unknown> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.member/${encodeURIComponent(targetId)}`,
        { headers: adminAuth },
      );
      return res.ok() ? (await res.json()).membership : undefined;
    };
    await expect.poll(membership, { timeout: 20_000 }).toBe('leave');
  });

  test('keeps Room roster, member detail, role changes and live authority in one destination', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}members`;
    const admin = `members-admin-${runId}`;
    const adminPass = `${admin}-pass`;
    const controller = `members-controller-${runId}`;
    const controllerPass = `${controller}-pass`;
    const member = `members-person-${runId}`;
    const memberPass = `${member}-pass`;
    const memberName = `Ada ${runId}`;
    const roomName = `Roster ${runId}`;
    await registerUser(request, admin, adminPass);
    await registerUser(request, controller, controllerPass);
    await registerUser(request, member, memberPass);
    const adminToken = await tokenFor(request, hs, admin, adminPass);
    const controllerToken = await tokenFor(
      request,
      hs,
      controller,
      controllerPass,
    );
    const memberToken = await tokenFor(request, hs, member, memberPass);
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const controllerAuth = { Authorization: `Bearer ${controllerToken}` };
    const memberAuth = { Authorization: `Bearer ${memberToken}` };
    const adminId = await request
      .get(`${hs}/_matrix/client/v3/account/whoami`, { headers: adminAuth })
      .then((response) => response.json())
      .then((body) => body.user_id as string);
    const memberId = await request
      .get(`${hs}/_matrix/client/v3/account/whoami`, { headers: memberAuth })
      .then((response) => response.json())
      .then((body) => body.user_id as string);
    const controllerId = await request
      .get(`${hs}/_matrix/client/v3/account/whoami`, {
        headers: controllerAuth,
      })
      .then((response) => response.json())
      .then((body) => body.user_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(memberId)}/displayname`,
      { headers: memberAuth, data: { displayname: memberName } },
    );
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: controllerAuth,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [adminId, memberId],
          power_level_content_override: {
            users: { [controllerId]: 101, [adminId]: 100 },
          },
        },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: memberAuth },
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: adminAuth },
    );

    await login(page, {
      available: true,
      hs,
      user: admin,
      pass: adminPass,
    } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'members');

    const roster = page.getByTestId('member-list');
    await expect(roster).toBeVisible({ timeout: 20_000 });
    const row = roster
      .getByTestId('member-row')
      .filter({ hasText: memberName });
    await expect(row).toBeVisible();
    await row.click();

    const detail = page.getByTestId('members-settings-detail');
    await expect(detail).toContainText(memberName);
    await page.getByTestId('member-info-role-50').click();
    const roleConfirmation = page.getByRole('dialog', { name: 'Change role' });
    await expect(roleConfirmation).toContainText(roomName);
    await expect(roleConfirmation).toContainText(`Account ${adminId}`);
    await roleConfirmation.getByRole('button', { name: 'Change' }).click();

    await expect(roster).toBeVisible({ timeout: 20_000 });
    const moderatorGroup = roster.getByRole('group', { name: /Moderator/ });
    await expect(moderatorGroup).toContainText(memberName, { timeout: 20_000 });
    await moderatorGroup.getByTestId('member-row').click();
    await expect(detail).toContainText('Moderator');

    const powerLevelsUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`;
    const powerLevels = await request
      .get(powerLevelsUrl, { headers: adminAuth })
      .then((response) => response.json());
    await request.put(powerLevelsUrl, {
      headers: controllerAuth,
      data: {
        ...powerLevels,
        users: { ...(powerLevels.users ?? {}), [adminId]: 0 },
      },
    });

    await expect(page.getByTestId('member-info-kick')).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.getByTestId('member-info-ban')).toHaveCount(0);
    // The opening Account is now an ordinary member. Exact settings keep the selected
    // member readable while every unavailable administration command disappears.
    await expect(detail).toContainText(memberName);
    await expect(detail.getByTestId('member-info-role')).toHaveText(
      'Moderator',
    );
    await test.info().attach('room-members-desktop', {
      body: await page.getByTestId('room-settings').screenshot(),
      contentType: 'image/png',
    });

    // Restore the opening Account's authority, then exercise the consequential settings
    // commands through their keyboard path. The live permission projection must make them
    // available again without closing or retargeting the selected detail.
    await request.put(powerLevelsUrl, {
      headers: controllerAuth,
      data: {
        ...powerLevels,
        users: { ...(powerLevels.users ?? {}), [adminId]: 100 },
      },
    });
    const kick = page.getByTestId('member-info-kick');
    await expect(kick).toBeVisible({ timeout: 20_000 });
    await kick.focus();
    await kick.press('Enter');
    const kickConfirmation = page.getByRole('dialog', {
      name: 'Remove from Room',
    });
    await expect(kickConfirmation).toContainText(memberName);
    await expect(kickConfirmation).toContainText(roomName);
    await expect(kickConfirmation).toContainText(`Account ${adminId}`);
    await kickConfirmation
      .getByPlaceholder('Reason (optional)')
      .fill('cleanup');
    await kickConfirmation
      .getByRole('button', { name: 'Remove' })
      .press('Enter');
    await expect(row).toHaveCount(0, { timeout: 20_000 });

    // Rejoin the same exact Room and ban through Members so both moderation commands are
    // proven on the new destination rather than inherited only from Conversation tests.
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { headers: adminAuth, data: { user_id: memberId } },
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: memberAuth },
    );
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.focus();
    await row.press('Enter');
    const ban = page.getByTestId('member-info-ban');
    await expect(ban).toBeVisible();
    await ban.focus();
    await ban.press('Enter');
    const banConfirmation = page.getByRole('dialog', {
      name: 'Ban from Room',
    });
    await expect(banConfirmation).toContainText(memberName);
    await expect(banConfirmation).toContainText(roomName);
    await expect(banConfirmation).toContainText(`Account ${adminId}`);
    await banConfirmation.getByRole('button', { name: 'Ban' }).press('Enter');
    await expect(row).toHaveCount(0, { timeout: 20_000 });

    await page.getByTestId('members-settings-banned').focus();
    await page.getByTestId('members-settings-banned').press('Enter');
    const bannedRow = page
      .getByTestId('banned-member')
      .filter({ hasText: memberName });
    await expect(bannedRow).toBeVisible({ timeout: 20_000 });
    await bannedRow.getByTestId('banned-member-unban').focus();
    await bannedRow.getByTestId('banned-member-unban').press('Enter');
    const unbanConfirmation = page.getByRole('dialog', {
      name: 'Unban from Room',
    });
    await expect(unbanConfirmation).toContainText(memberName);
    await expect(unbanConfirmation).toContainText(roomName);
    await expect(unbanConfirmation).toContainText(`Account ${adminId}`);
    await unbanConfirmation
      .getByRole('button', { name: 'Unban' })
      .press('Enter');
    await expect(bannedRow).toHaveCount(0, { timeout: 20_000 });

    // Restore joined membership, close settings with its keyboard-owned Escape path, and
    // prove the pre-existing Conversation roster still opens and finds the same person.
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { headers: adminAuth, data: { user_id: memberId } },
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: memberAuth },
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('room-settings')).toHaveCount(0);
    const conversationMembers = page.getByTestId('toggle-members');
    await conversationMembers.focus();
    await conversationMembers.press('Enter');
    const conversationRow = page
      .getByTestId('member-list')
      .getByTestId('member-row')
      .filter({ hasText: memberName });
    await expect(conversationRow).toBeVisible({ timeout: 20_000 });
    await conversationRow.press('Enter');
    await expect(page.getByTestId('member-info')).toContainText(memberName);
    await page.getByTestId('member-info-close').press('Enter');
    await expect(conversationRow).toBeVisible();
    await expect(page.getByTestId('member-filter')).toBeFocused();
  });

  test('an admin adds a room address and makes it the main one', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}al`;
    const user = `alias-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Addr ${runId}`;

    await registerUser(request, user, pass);
    const login1 = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const auth = { Authorization: `Bearer ${login1.access_token}` };
    const server = (login1.user_id as string).split(':')[1];
    const localpart = `addr-${runId}`;
    const alias = `#${localpart}:${server}`;
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'addresses');
    await expect(page.getByTestId('room-aliases')).toBeVisible({
      timeout: 10_000,
    });

    // Add a new local address; it appears in the list and resolves in the directory.
    const input = page.getByTestId('room-alias-input');
    await input.fill(localpart);
    await input.press('Enter');
    const row = page.getByTestId('room-alias').filter({ hasText: alias });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const resolvedRoom = async (): Promise<unknown> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
        { headers: auth },
      );
      return res.ok() ? (await res.json()).room_id : undefined;
    };
    await expect.poll(resolvedRoom, { timeout: 20_000 }).toBe(room_id);

    // Make it the main (canonical) address; the state event round-trips.
    const makePrimary = row.getByTestId('room-alias-set-main');
    await makePrimary.focus();
    await makePrimary.press('Enter');
    await expect(page.getByTestId('room-alias-main')).toBeVisible({
      timeout: 10_000,
    });
    const canonical = async (): Promise<unknown> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.canonical_alias/`,
        { headers: auth },
      );
      return res.ok() ? (await res.json()).alias : undefined;
    };
    await expect.poll(canonical, { timeout: 20_000 }).toBe(alias);
    const settings = page.getByTestId('room-settings');
    const settingsBox = await settings.boundingBox();
    const viewport = page.viewportSize();
    expect(
      (settingsBox?.x ?? -1) + (settingsBox?.width ?? 0),
    ).toBeLessThanOrEqual(viewport?.width ?? 0);
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`${alias} is now the primary address.`),
    ).toBeHidden({ timeout: 5_000 });
    await test.info().attach('room-addresses-desktop', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });

    // Removal names the exact address and its joining/linking effect. Cancellation keeps
    // the address intact; confirmation removes both the directory entry and primary state.
    await row.getByTestId('room-alias-remove').click();
    const confirmation = page.getByRole('dialog', {
      name: `Remove ${alias}?`,
    });
    await expect(confirmation).toContainText(
      `People will no longer be able to join or link to this room with ${alias}.`,
    );
    await expect(confirmation).toContainText('This does not delete the Room.');
    await confirmation.getByRole('button', { name: 'Keep address' }).click();
    await expect(row).toBeVisible();

    await row.getByTestId('room-alias-remove').click();
    const confirmRemoval = confirmation.getByRole('button', {
      name: 'Remove address',
    });
    await confirmRemoval.focus();
    await confirmRemoval.press('Enter');
    await expect(row).toHaveCount(0);
    await expect.poll(resolvedRoom, { timeout: 20_000 }).toBeUndefined();
    await expect.poll(canonical, { timeout: 20_000 }).toBeUndefined();

    // A rejected finite add keeps the draft in the dedicated address action; no global
    // settings Save or Cancel participates in it.
    const directoryRoute = /\/directory\/room\//;
    await page.route(directoryRoute, async (route) => {
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
    const retryLocalpart = `retry-${runId}`;
    await input.fill(retryLocalpart);
    await input.press('Enter');
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`Could not add #${retryLocalpart}:${server}.`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue(retryLocalpart);
  });
});

test.describe('Space member and address settings on a phone', () => {
  test.use(pixel5);
  configureRoomSettingsSuite();

  test('opens Space Members from the shortcut and invites only to the Space', async ({
    page,
    request,
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
    await space.tap();
    await page.getByTestId('space-actions-overflow').tap();
    await page.getByTestId('open-space-members').tap();

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
    await invite.tap();
    await page.getByLabel('@user:server or a name').fill(inviteeId);
    await page.getByRole('button', { name: 'Invite', exact: true }).tap();

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
    await row.tap();
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
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('space-members-mobile-dark-amethyst', {
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.evaluate(({ dark, theme, fontSize }) => {
      document.documentElement.classList.toggle('dark', dark);
      if (theme === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.fontSize = fontSize;
    }, originalAppearance);

    await page.getByTestId('member-info-close').tap();
    await expect(row).toBeVisible();
    await page.getByTestId('members-settings-banned').tap();
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
    await openSpaceSettings(page, spaceName, roomName);
    await openSettingsTab(page, 'space-settings', 'addresses');
    await expect(
      page.getByTestId('space-settings-section-heading'),
    ).toBeFocused();

    const input = page.getByTestId('room-alias-input');
    await input.fill(localpart);
    await page.getByTestId('room-alias-add').tap();
    const row = page.getByTestId('room-alias').filter({ hasText: alias });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect.poll(directoryRoom, { timeout: 20_000 }).toBe(spaceId);
    await row.getByTestId('room-alias-set-main').tap();
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
    await row.getByTestId('room-alias-remove').tap();
    const confirmation = page.getByRole('dialog', {
      name: `Remove ${alias}?`,
    });
    await expect(confirmation).toContainText('does not delete the Space');
    await confirmation.getByRole('button', { name: 'Keep address' }).tap();
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
      body: await settings.screenshot(),
      contentType: 'image/png',
    });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'amethyst');
    });
    await test.info().attach('space-addresses-mobile-dark-amethyst', {
      body: await settings.screenshot(),
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
    await page.getByTestId('room-alias-add').tap();
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
    await row.getByTestId('room-alias-remove').tap();
    await confirmation.getByRole('button', { name: 'Remove address' }).tap();
    await expect(row).toHaveCount(0);
    await expect.poll(directoryRoom, { timeout: 20_000 }).toBeUndefined();
    await expect.poll(canonicalAddress, { timeout: 20_000 }).toBeUndefined();

    // Publish it again, then remove this Account's power remotely. The address remains
    // readable and public actions remain usable while every administration action vanishes.
    await input.fill(localpart);
    await page.getByTestId('room-alias-add').tap();
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

    await page.getByTestId('space-settings-mobile-back').tap();
    await expect(page.getByTestId('space-settings-directory')).toBeVisible();

    // The server remains the final authority for the address created through the UI.
    await expect.poll(directoryRoom, { timeout: 20_000 }).toBe(spaceId);
  });
});
