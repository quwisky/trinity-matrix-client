import { expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type HomeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';

// Covers Room settings › Advanced: the room ID and the version this homeserver created the
// room at, and the read-only room state viewer listing m.room.create and the member's own
// m.room.member event.
test.describe('Room settings advanced', () => {
  configureRoomSettingsSuite();

  test('shows the room ID, version and current room state', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}adv`;
    const user = `advanced-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Advanced ${runId}`;

    await registerUser(request, user, pass);
    const auth = {
      Authorization: `Bearer ${await tokenFor(request, hs, user, pass)}`,
    };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    // Read the version back rather than hard-coding one server's default.
    const roomVersion = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create`,
        { headers: auth },
      )
      .then((r) => r.json())
      .then((content) => (content.room_version as string | undefined) ?? '1');

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('room-settings-tab-advanced').click();

    const panel = page.getByTestId('room-settings-panel-advanced');
    await expect(panel.getByTestId('room-advanced-room-id')).toHaveText(roomId);
    await expect(panel.getByTestId('room-advanced-version')).toHaveText(
      roomVersion,
    );
    await expect(
      panel.getByRole('button', { name: 'Copy room ID' }),
    ).toBeVisible();

    await panel.getByTestId('room-advanced-view-state').click();
    const viewer = page.getByTestId('room-state-viewer');
    await expect(viewer).toBeVisible();

    const group = (type: string) =>
      viewer
        .getByTestId('room-state-group')
        .filter({ has: page.getByText(type, { exact: true }) });

    await group('m.room.create').getByTestId('room-state-group-toggle').click();
    await group('m.room.create')
      .getByRole('button', { name: '(empty)' })
      .click();
    await expect(viewer.getByTestId('room-state-json')).toContainText(
      '"type": "m.room.create"',
    );

    await viewer.getByTestId('room-state-filter').fill(user);
    await group('m.room.member').getByTestId('room-state-group-toggle').click();
    await group('m.room.member')
      .getByRole('button', { name: `@${user}:` })
      .click();
    await expect(viewer.getByTestId('room-state-json')).toContainText(
      '"membership": "join"',
    );
  });
});
