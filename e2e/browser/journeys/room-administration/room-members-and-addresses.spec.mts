import { expect, test, testResourceId } from '../../../fixtures.mts';
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
    const adminAuth = {
      Authorization: `Bearer ${await tokenFor(request, hs, admin, adminPass)}`,
    };
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
    await openSettingsTab(page, 'room-settings', 'bans');
    await expect(page.getByTestId('banned-members')).toBeVisible({
      timeout: 10_000,
    });
    const row = page
      .getByTestId('banned-member')
      .filter({ hasText: targetName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Unban them: the row disappears and the ban is lifted server-side.
    await row.getByTestId('banned-member-unban').click();
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
    await openSettingsTab(page, 'room-settings', 'access');
    await expect(page.getByTestId('room-aliases')).toBeVisible({
      timeout: 10_000,
    });

    // Add a new local address; it appears in the list and resolves in the directory.
    await page.getByTestId('room-alias-input').fill(localpart);
    await page.getByTestId('room-alias-add').click();
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
    await row.getByTestId('room-alias-set-main').click();
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
  });
});
