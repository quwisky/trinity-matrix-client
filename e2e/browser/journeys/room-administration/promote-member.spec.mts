import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers power-level editing: from the member info dialog an admin uses a role
// button (data-testid="member-info-role-50" = Moderator), confirms
// (data-testid="alert-confirm"), and the member is promoted
// (RoomModerationService.setPowerLevel → client.setPowerLevel → sync). Member info
// closes itself and the member list it opened over shows them in the Moderator
// section. Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = homeserverSession();

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

test.describe('Promote a member', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('an admin promotes a member to moderator', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}p`;
    const adminUser = `promo-admin-${runId}`;
    const adminPass = `${adminUser}-pass`;
    const memberUser = `promo-member-${runId}`;
    const memberPass = `${memberUser}-pass`;
    const roomName = `Promote ${runId}`;
    const memberName = `Promoted ${runId}`;

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
    } as HomeserverSession);
    await openRoom(page, roomName);
    await expect(page.locator('.chat-members')).toBeHidden();
    await page.getByTestId('toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();

    // No Moderator section yet — the member is a plain member.
    await expect(
      page.locator('.members__section-label', { hasText: 'Moderator' }),
    ).toHaveCount(0);

    // Open the member's info over the list and make them a Moderator.
    const memberRow = page.locator('[data-testid="member-row"]', {
      hasText: memberName,
    });
    await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
    await memberRow.first().click();
    const memberInfo = page.getByRole('dialog', { name: 'Member info' });
    await expect(memberInfo.getByTestId('member-info')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('.chat-members')).toBeVisible();
    await page.getByTestId('member-info-role-50').click();
    await page.getByTestId('alert-confirm').click();

    // Member info closes once the change lands, back to the list it opened over, where the
    // member now sits under a Moderator section.
    await expect(memberInfo).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.chat-members')).toBeVisible();
    const moderatorSection = page.locator('.members__section', {
      has: page.locator('.members__section-label', { hasText: 'Moderator' }),
    });
    await expect(moderatorSection).toBeVisible({ timeout: 30_000 });
    await expect(
      moderatorSection.locator('[data-testid="member-row"]', {
        hasText: memberName,
      }),
    ).toBeVisible();
  });
});
