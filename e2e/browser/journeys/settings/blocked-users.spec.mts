import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  passwordLogin,
  registerUser,
  type AccountSession,
} from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { openMemberCard, openMemberTab } from '../../support/member-card.mts';

// Covers Settings › Privacy › Blocked users: a member blocked from their card is listed
// there (IgnoredUsersService.ignoredUsers over m.ignored_user_list), unblocking from the
// list removes them, and the card follows the same list back to "Block", including changes
// made on another device. A message sent while blocked shows once they are unblocked.
const session = homeserverSession();

function serverOf(userId: string): string {
  return userId.slice(userId.indexOf(':') + 1);
}

async function putIgnored(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
  userIds: readonly string[],
): Promise<void> {
  const res = await request.put(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(account.userId)}/account_data/m.ignored_user_list`,
    {
      headers: { Authorization: `Bearer ${account.accessToken}` },
      data: {
        ignored_users: Object.fromEntries(userIds.map((id) => [id, {}])),
      },
    },
  );
  expect(res.ok()).toBe(true);
}

test.describe('Blocked users in Settings', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('a member blocked from their card is listed, and unblocking there reaches the card', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}bu`;
    const viewer = `blocked-viewer-${runId}`;
    const viewerPass = `${viewer}-pass`;
    const other = `blocked-other-${runId}`;
    const otherPass = `${other}-pass`;
    const roomName = `Blocked users ${runId}`;
    const otherName = `Blocked ${runId}`;

    await registerUser(request, viewer, viewerPass);
    await registerUser(request, other, otherPass);
    const viewerApi = await passwordLogin(request, hs, viewer, viewerPass);
    const otherApi = await passwordLogin(request, hs, other, otherPass);
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(otherApi.userId)}/displayname`,
      { headers: auth(otherApi.accessToken), data: { displayname: otherName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth(viewerApi.accessToken),
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [otherApi.userId],
        },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: auth(otherApi.accessToken) },
    );

    await login(page, {
      available: true,
      hs,
      user: viewer,
      pass: viewerPass,
    } as HomeserverSession);
    await openRoom(page, roomName);
    await openMemberCard(page, otherName);
    await openMemberTab(page, 'Manage');
    const cardAction = page.getByTestId('member-info-ignore');
    await expect(cardAction).toHaveText('Block');
    await cardAction.click();
    await expect(cardAction).toHaveText('Unblock', { timeout: 30_000 });
    await expect(page.getByTestId('member-info-block-notice')).toHaveText(
      "Blocked — you won't see their messages.",
    );
    await page.getByTestId('member-info-close').click();
    await expect(page.getByTestId('member-info')).toBeHidden();

    // A message sent while blocked stays hidden until the block is lifted.
    const whileBlocked = `while blocked ${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}wb`,
      {
        headers: auth(otherApi.accessToken),
        data: { msgtype: 'm.text', body: whileBlocked },
      },
    );
    const hiddenMessage = page.locator('.scroll .msg[data-mid]', {
      hasText: whileBlocked,
    });

    await openSettingsSection(page, 'privacy');
    const blocked = page.getByTestId('privacy-blocked-users');
    const row = blocked.getByTestId('blocked-user-row');
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await expect(row).toContainText(otherName);
    await expect(row).toContainText(otherApi.userId);

    // Another device adds someone: the open list follows the synced account data.
    const elsewhere = `@elsewhere-${runId}:${serverOf(viewerApi.userId)}`;
    await putIgnored(request, hs, viewerApi, [otherApi.userId, elsewhere]);
    await expect(row).toHaveCount(2, { timeout: 30_000 });
    await expect(row.nth(1)).toContainText(elsewhere);

    await blocked.getByRole('button', { name: `Unblock ${otherName}` }).click();
    await expect(
      page
        .getByLabel('Notifications alt+T')
        .getByText(`Unblocked ${otherName}.`, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).toContainText(elsewhere);
    await closeSettings(page);

    // What the server hid while they were blocked appears in the open room, with no reload.
    await expect(hiddenMessage.first()).toBeVisible({ timeout: 30_000 });

    await openMemberCard(page, otherName);
    await openMemberTab(page, 'Manage');
    const card = page.getByTestId('member-info-ignore');
    await expect(card).toHaveText('Block', { timeout: 15_000 });

    // Another device blocks them again: the open card follows.
    await putIgnored(request, hs, viewerApi, [otherApi.userId]);
    await expect(card).toHaveText('Unblock', { timeout: 30_000 });
  });

  test('blocking by user ID refuses yourself and lists someone else', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}bi`;
    const viewer = `blockid-viewer-${runId}`;
    const viewerPass = `${viewer}-pass`;
    await registerUser(request, viewer, viewerPass);
    const viewerApi = await passwordLogin(request, hs, viewer, viewerPass);
    const serverName = viewerApi.userId.slice(
      viewerApi.userId.indexOf(':') + 1,
    );
    const target = `@nobody-${runId}:${serverName}`;

    await login(page, {
      available: true,
      hs,
      user: viewer,
      pass: viewerPass,
    } as HomeserverSession);
    await openSettingsSection(page, 'privacy');
    const blocked = page.getByTestId('privacy-blocked-users');
    const field = blocked.getByLabel('Block someone by user ID');

    await field.fill(viewerApi.userId);
    await blocked.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(blocked.getByRole('alert')).toHaveText(
      "You can't block yourself.",
    );

    await field.fill(target);
    await blocked.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(blocked.getByTestId('blocked-user-row')).toContainText(
      target,
      { timeout: 30_000 },
    );
    await expect(field).toHaveValue('');
  });
});
