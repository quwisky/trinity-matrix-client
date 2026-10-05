import { expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type HomeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  HS_SERVER_NAME,
  configureRoomSettingsSuite,
  linkIntoSpace,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';

// Covers Room settings › Advanced › Upgrade room: an admin upgrades a private room that a space
// links. They land in the new room; the member has an invite to it; the space's child now points
// at the new room with its order and suggested flag kept; the old room shows the tombstone banner.
test.describe('Room upgrade', () => {
  configureRoomSettingsSuite();

  test('upgrades a private room, invites its member and moves its space link', async ({
    page,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}up`;
    const admin = `upgrade-${runId}`;
    const adminPass = `${admin}-pass`;
    const member = `upgrade-member-${runId}`;
    const memberPass = `${member}-pass`;
    const memberId = `@${member}:${HS_SERVER_NAME}`;
    const roomName = `Upgrade ${runId}`;
    const spaceName = `Upgrade space ${runId}`;

    await registerUser(request, admin, adminPass);
    await registerUser(request, member, memberPass);
    const adminToken = await tokenFor(request, hs, admin, adminPass);
    const memberToken = await tokenFor(request, hs, member, memberPass);
    const asAdmin = { Authorization: `Bearer ${adminToken}` };
    const room = (id: string) =>
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(id)}`;

    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: asAdmin,
        data: { name: roomName, preset: 'private_chat', invite: [memberId] },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    const joined = await request.post(`${room(roomId)}/join`, {
      headers: { Authorization: `Bearer ${memberToken}` },
      data: {},
    });
    expect(joined.ok()).toBe(true);

    const spaceId = await linkIntoSpace(
      request,
      hs,
      adminToken,
      spaceName,
      roomId,
    );
    const childOf = (childId: string) =>
      `${room(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`;
    // Give the link an order, so the journey can see it carried over.
    const ordered = await request.put(childOf(roomId), {
      headers: asAdmin,
      data: { via: [HS_SERVER_NAME], suggested: true, order: 'upgrade-a' },
    });
    expect(ordered.ok()).toBe(true);
    const versionOf = (id: string) =>
      request
        .get(`${room(id)}/state/m.room.create`, { headers: asAdmin })
        .then((r) => r.json())
        .then((content) => (content.room_version as string | undefined) ?? '1');
    const oldVersion = await versionOf(roomId);

    await login(page, {
      available: true,
      hs,
      user: admin,
      pass: adminPass,
    } as HomeserverSession);
    // Via the space pill: a linked room leaves the flat Rooms list by design.
    const pill = page.getByRole('button', { name: spaceName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });
    const oldRoomUrl = page.url();
    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('room-settings-tab-advanced').click();
    await page.getByTestId('room-advanced-upgrade').click();

    const dialog = page.getByTestId('room-upgrade-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('room-upgrade-invite')).toContainText(
      'Invite current members (1)',
    );
    await expect(
      dialog.getByTestId('room-upgrade-invite').getByRole('checkbox'),
    ).toBeChecked();
    await expect(dialog.getByTestId('room-upgrade-space')).toContainText(
      spaceName,
    );
    await expect(dialog.getByTestId('room-upgrade-space')).toContainText(
      'Will be re-linked',
    );

    await dialog.getByTestId('room-upgrade-confirm').click();
    await expect(
      page.getByLabel('Notifications alt+T').getByText('Room upgraded.'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('room-settings')).toBeHidden({
      timeout: 30_000,
    });

    // The server tombstoned the old room, pointing at its replacement.
    const newRoomId = await request
      .get(`${room(roomId)}/state/m.room.tombstone/`, { headers: asAdmin })
      .then((r) => r.json())
      .then((content) => content.replacement_room as string);
    expect(newRoomId).toMatch(/^!/);
    expect(Number(await versionOf(newRoomId))).toBeGreaterThan(
      Number(oldVersion),
    );

    // The admin landed in the new room.
    await expect
      .poll(() => page.url(), { timeout: 30_000 })
      .not.toBe(oldRoomUrl);
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('tombstone-banner')).toBeHidden();
    await page.getByTestId('open-room-settings').click();
    await page.getByTestId('room-settings-tab-advanced').click();
    await expect(page.getByTestId('room-advanced-room-id')).toHaveText(
      newRoomId,
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('room-settings')).toBeHidden();

    // The member has an invite to the new room.
    const membership = await request
      .get(
        `${room(newRoomId)}/state/m.room.member/${encodeURIComponent(memberId)}`,
        { headers: asAdmin },
      )
      .then((r) => r.json());
    expect(membership.membership).toBe('invite');

    // The space links the new room, with its order and suggested flag kept, and not the old one.
    const newChild = await request
      .get(childOf(newRoomId), { headers: asAdmin })
      .then((r) => r.json());
    expect(newChild).toMatchObject({ order: 'upgrade-a', suggested: true });
    expect(newChild.via).toContain(HS_SERVER_NAME);
    const oldChild = await request.get(childOf(roomId), { headers: asAdmin });
    expect(oldChild.ok() ? await oldChild.json() : {}).toEqual({});

    // The old room keeps the tombstone banner.
    await page.goto(oldRoomUrl);
    await expect(page.getByTestId('tombstone-banner')).toBeVisible({
      timeout: 30_000,
    });
  });
});
