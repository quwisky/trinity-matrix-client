import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers blocking (ignoring) a member: from the member info panel the Block action
// (data-testid="member-info-ignore") ignores the user account-wide
// (IgnoredUsersService → setIgnoredUsers) and the button flips to "Unblock". Needs a
// Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Block a member', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('blocking a member flips the action to Unblock', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}b`;
    const adminUser = `block-admin-${runId}`;
    const adminPass = `${adminUser}-pass`;
    const memberUser = `block-member-${runId}`;
    const memberPass = `${memberUser}-pass`;
    const roomName = `Block ${runId}`;
    const memberName = `Blocked ${runId}`;

    await registerUser(request, adminUser, adminPass);
    await registerUser(request, memberUser, memberPass);
    const admin = await apiLogin(request, hs, adminUser, adminPass);
    const memberB = await apiLogin(request, hs, memberUser, memberPass);

    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(memberB.userId)}/displayname`,
      { headers: memberB.headers, data: { displayname: memberName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: admin.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [memberB.userId],
        },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: memberB.headers },
    );

    await login(page, {
      available: true,
      hs,
      user: adminUser,
      pass: adminPass,
    } as SynapseSession);
    await openRoom(page, roomName);

    const memberRow = page.locator('[data-testid="member-row"]', {
      hasText: memberName,
    });
    await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
    await memberRow.first().click();
    await expect(page.getByTestId('member-info')).toBeVisible({
      timeout: 10_000,
    });

    const ignoreBtn = page.getByTestId('member-info-ignore');
    await expect(ignoreBtn).toHaveText('Block');
    await ignoreBtn.click();

    // The account-data write round-trips and the action flips to Unblock.
    await expect(ignoreBtn).toHaveText('Unblock', { timeout: 30_000 });
  });
});
