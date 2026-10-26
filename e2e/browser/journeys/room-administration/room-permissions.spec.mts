import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  apiLogin,
  registerUser,
  type ApiUser,
} from '../../../support/account.mts';
import { describeFailure } from '../../../support/http-failure.mts';
import { focusWithKeyboard } from '../../support/keyboard-focus.mts';
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

// Covers the Roles and permissions section of Room and Space settings, asserted on the
// `m.room.power_levels` event the homeserver holds: a save that writes nothing, or that
// rewrites `users`, looks identical from the UI.
// Needs a Synapse homeserver; self-skips otherwise.

const POST_UNAVAILABLE =
  "You don't have permission to send messages in this room.";

async function powerLevels(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  roomId: string,
): Promise<Record<string, unknown>> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`,
    { headers: actor.headers },
  );
  if (!res.ok()) throw new Error(await describeFailure('power levels', res));
  return (await res.json()) as Record<string, unknown>;
}

/** Register and log in a throwaway account. */
async function account(
  request: APIRequestContext,
  hs: string,
  user: string,
): Promise<ApiUser & { user: string; pass: string }> {
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  return { ...(await apiLogin(request, hs, user, pass)), user, pass };
}

/** Invite `member` into `roomId` and accept as them. */
async function joinAsMember(
  request: APIRequestContext,
  hs: string,
  owner: ApiUser,
  member: ApiUser,
  roomId: string,
): Promise<void> {
  const room = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  const invite = await request.post(`${room}/invite`, {
    headers: owner.headers,
    data: { user_id: member.userId },
  });
  if (!invite.ok()) throw new Error(await describeFailure('invite', invite));
  const join = await request.post(`${room}/join`, { headers: member.headers });
  if (!join.ok()) throw new Error(await describeFailure('join', join));
}

async function signIn(
  page: Page,
  hs: string,
  who: { user: string; pass: string },
): Promise<void> {
  await login(page, {
    available: true,
    hs,
    user: who.user,
    pass: who.pass,
  } as HomeserverSession);
}

/** From an open room, open Room settings on Roles and permissions. */
async function openRoomPermissions(page: Page): Promise<void> {
  await page.getByTestId('room-actions-overflow').click();
  await page.getByTestId('overflow-open-room-settings').click();
  await openSettingsTab(page, 'room-settings', 'permissions');
}

/** The row's select, named by its label. */
function levelSelect(page: Page, label: string): Locator {
  return page
    .getByTestId('permissions-settings')
    .getByRole('combobox', { name: label, exact: true });
}

/** Choose a level with the pointer; the options live in a CDK portal. */
async function chooseLevel(
  page: Page,
  label: string,
  level: string,
): Promise<void> {
  await levelSelect(page, label).click();
  await page.getByRole('option', { name: level, exact: true }).click();
  await expect(levelSelect(page, label)).toContainText(level);
}

test.describe('Roles and permissions', () => {
  configureRoomSettingsSuite();

  test("an admin limits sending to moderators and a member's composer follows", async ({
    page,
    request,
    secondaryApp,
  }) => {
    // Two signed-in pages and two power-level round trips through /sync.
    test.setTimeout(180_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ps`;
    const admin = await account(request, hs, `perm-admin-${runId}`);
    const member = await account(request, hs, `perm-member-${runId}`);
    const roomName = `Permissions ${runId}`;
    const roomId = await createRoom(request, hs, admin, roomName);
    await joinAsMember(request, hs, admin, member, roomId);
    const usersBefore = (await powerLevels(request, hs, admin, roomId))[
      'users'
    ];

    const memberPage = await secondaryApp.launch();
    await signIn(memberPage, hs, member);
    await openRoom(memberPage, roomName);
    // The member's page stays open from here on: no reload separates the two states.
    await expect(memberPage.getByTestId('composer-input')).toBeVisible();

    await signIn(page, hs, admin);
    await openRoom(page, roomName);
    await openRoomPermissions(page);
    await chooseLevel(page, 'Send messages', 'Moderator');
    await page.getByTestId('permissions-save').click();

    await expect
      .poll(
        async () =>
          (await powerLevels(request, hs, admin, roomId))['events_default'],
        { timeout: 30_000 },
      )
      .toBe(50);
    expect((await powerLevels(request, hs, admin, roomId))['users']).toEqual(
      usersBefore,
    );

    // The member's page follows the power-level event live, with no reload.
    const notice = memberPage.getByTestId('composer-post-unavailable');
    await expect(notice).toHaveText(POST_UNAVAILABLE, { timeout: 30_000 });
    await expect(memberPage.getByTestId('composer-input')).toHaveCount(0);

    await chooseLevel(page, 'Send messages', 'Member');
    await page.getByTestId('permissions-save').click();
    await expect(memberPage.getByTestId('composer-input')).toBeVisible({
      timeout: 30_000,
    });
    await expect(notice).toHaveCount(0);
    expect(
      (await powerLevels(request, hs, admin, roomId))['events_default'],
    ).toBe(0);
  });

  test("an admin changes who manages a space's rooms", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}pss`;
    const admin = await account(request, hs, `perm-space-${runId}`);
    const spaceName = `Permission space ${runId}`;
    const spaceId = await createRoom(request, hs, admin, spaceName, {
      space: true,
    });

    await signIn(page, hs, admin);
    const pill = page.getByRole('button', { name: spaceName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    await page.getByTestId('space-header').click();
    await page.getByTestId('open-space-settings').click();
    await openSettingsTab(page, 'space-settings', 'permissions');
    await expect(
      page.getByTestId('space-settings-panel-permissions'),
    ).toBeVisible();

    await chooseLevel(page, 'Manage rooms in this space', 'Admin');
    await page.getByTestId('permissions-save').click();

    await expect
      .poll(
        async () => {
          const events = (await powerLevels(request, hs, admin, spaceId))[
            'events'
          ] as Record<string, unknown> | undefined;
          return events?.['m.space.child'];
        },
        { timeout: 30_000 },
      )
      .toBe(100);
  });

  test('the editor works from the keyboard', async ({ page, request }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}pk`;
    const admin = await account(request, hs, `perm-keys-${runId}`);
    const roomName = `Permission keys ${runId}`;
    // Pin the starting level so one ArrowDown lands on Moderator whatever the preset gives.
    const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: admin.headers,
      data: {
        name: roomName,
        preset: 'private_chat',
        power_level_content_override: { invite: 0 },
      },
    });
    if (!created.ok()) {
      throw new Error(await describeFailure('createRoom', created));
    }
    const roomId = (await created.json()).room_id as string;

    await signIn(page, hs, admin);
    await openRoom(page, roomName);
    await openRoomPermissions(page);

    const invite = levelSelect(page, 'Invite');
    await expect(invite).toContainText('Member');
    await focusWithKeyboard(invite);
    await page.keyboard.press('Enter');
    // Opening makes the current value active; wait for it before moving.
    await expect(
      page.getByRole('option', { name: 'Member', exact: true }),
    ).toHaveAttribute('data-highlighted', '');
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('option', { name: 'Moderator', exact: true }),
    ).toHaveAttribute('data-highlighted', '');
    await page.keyboard.press('Enter');
    await expect(invite).toContainText('Moderator');
    await expect(invite).toBeFocused();

    const save = page.getByRole('button', { name: 'Save permissions' });
    await expect(save).toBeVisible();
    // Tab past the remaining rows; bounded so a focus trap fails here rather than hanging.
    await expect(async () => {
      await page.keyboard.press('Tab');
      await expect(save).toBeFocused({ timeout: 100 });
    }).toPass({ timeout: 15_000, intervals: [0] });
    await page.keyboard.press('Enter');

    await expect
      .poll(
        async () => (await powerLevels(request, hs, admin, roomId))['invite'],
        { timeout: 30_000 },
      )
      .toBe(50);
  });

  test('a member sees the section read-only', async ({ page, request }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}pr`;
    const admin = await account(request, hs, `perm-owner-${runId}`);
    const member = await account(request, hs, `perm-reader-${runId}`);
    const roomName = `Permission reader ${runId}`;
    const roomId = await createRoom(request, hs, admin, roomName);
    await joinAsMember(request, hs, admin, member, roomId);

    await signIn(page, hs, member);
    await openRoom(page, roomName);
    await openRoomPermissions(page);

    await expect(page.getByTestId('permissions-readonly')).toHaveText(
      "Your role cannot change this room's permissions.",
    );
    const selects = page
      .getByTestId('permissions-settings')
      .getByRole('combobox');
    const count = await selects.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index++) {
      await expect(selects.nth(index)).toBeDisabled();
    }
    await expect(page.getByTestId('permissions-save')).toHaveCount(0);
  });
});
