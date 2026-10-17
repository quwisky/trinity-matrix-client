import { expect, test, testResourceId, type Page } from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

/**
 * Member info embedded in settings spans the detail pane: its surface is as wide as the pane's
 * content box (no empty strip beside it) and the pane does not scroll sideways (not wider).
 */
async function expectMemberInfoFillsDetail(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.getByTestId('members-settings-detail').evaluate((pane) => {
        const surface =
          pane.querySelector('trn-member-info')!.firstElementChild!;
        return {
          fills:
            Math.abs(
              surface.getBoundingClientRect().width - pane.clientWidth,
            ) <= 1,
          overflow: pane.scrollWidth - pane.clientWidth,
        };
      }),
    )
    .toEqual({ fills: true, overflow: 0 });
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
    const room_id = await createRoom(
      request,
      hs,
      { accessToken: adminToken },
      roomName,
      { invite: [targetId] },
    );
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
    } as HomeserverSession);
    await openRoom(page, roomName);

    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
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
    await expect(confirmation).toContainText(`account ${adminId}`);
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
    } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
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
    // The detail pane owns the width at every viewport: desktop and a 390px phone.
    await expectMemberInfoFillsDetail(page);
    const desktopViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toContainText(memberName);
    await expectMemberInfoFillsDetail(page);
    await page.setViewportSize(desktopViewport);
    await expect(detail).toContainText(memberName);
    await expectMemberInfoFillsDetail(page);
    await page.getByTestId('member-info-role-50').click();
    const roleConfirmation = page.getByRole('dialog', { name: 'Change role' });
    await expect(roleConfirmation).toContainText(roomName);
    await expect(roleConfirmation).toContainText(`account ${adminId}`);
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
      name: 'Remove from room',
    });
    await expect(kickConfirmation).toContainText(memberName);
    await expect(kickConfirmation).toContainText(roomName);
    await expect(kickConfirmation).toContainText(`account ${adminId}`);
    await kickConfirmation
      .getByPlaceholder('Reason (optional)')
      .fill('cleanup');
    await kickConfirmation
      .getByRole('button', { name: 'Remove' })
      .press('Enter');
    // The roster is not rendered while the detail is open, so `row` alone cannot prove the
    // write landed. The detail closes and focus returns to the filter only once it has.
    await expect(detail).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('member-filter')).toBeFocused();
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
      name: 'Ban from room',
    });
    await expect(banConfirmation).toContainText(memberName);
    await expect(banConfirmation).toContainText(roomName);
    await expect(banConfirmation).toContainText(`account ${adminId}`);
    await banConfirmation.getByRole('button', { name: 'Ban' }).press('Enter');
    // Wait for that focus move before pressing Banned, or it can steal the Enter.
    await expect(detail).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('member-filter')).toBeFocused();
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
      name: 'Unban from room',
    });
    await expect(unbanConfirmation).toContainText(memberName);
    await expect(unbanConfirmation).toContainText(roomName);
    await expect(unbanConfirmation).toContainText(`account ${adminId}`);
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
    // Member info is a dialog over the roster: closing it returns focus to the row.
    await expect(conversationRow).toBeVisible();
    await expect(conversationRow).toBeFocused();
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
    const room_id = await createRoom(
      request,
      hs,
      { accessToken: login1.access_token },
      roomName,
    );

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);

    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
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
    await expect(confirmation).toContainText('This does not delete the room.');
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
