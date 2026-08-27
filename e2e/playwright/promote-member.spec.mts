import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers power-level editing: from the member info panel an admin uses a role
// button (data-testid="member-info-role-50" = Moderator), confirms
// (data-testid="alert-confirm"), and the member is promoted
// (RoomModerationService.setPowerLevel → client.setPowerLevel → sync), moving them
// into the Moderator section of the member list. Needs a Synapse homeserver
// (Docker); self-skips otherwise.
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

test.describe('Promote a member', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('an admin promotes a member to moderator', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}p`;
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
    } as SynapseSession);
    await openRoom(page, roomName);

    // No Moderator section yet — the member is a plain member.
    await expect(
      page.locator('.members__section-label', { hasText: 'Moderator' }),
    ).toHaveCount(0);

    // Open the member's panel and make them a Moderator.
    const memberRow = page.locator('[data-testid="member-row"]', {
      hasText: memberName,
    });
    await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
    await memberRow.first().click();
    await expect(page.getByTestId('member-info')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('member-info-role-50').click();
    await page.getByTestId('alert-confirm').click();

    // The member now sits under a Moderator section.
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
