import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers kicking a member: from the member info panel (data-testid="member-info"),
// an admin uses "Remove from room" (data-testid="member-info-kick"), confirms the
// prompt (data-testid="alert-confirm"), and the member drops out of the member
// list (RoomModerationService.kick → client.kick → sync). Two users so there's a
// lower-power member to remove. Needs a Synapse homeserver (Docker); self-skips.
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

test.describe('Kick a member', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('an admin removes a lower-power member from the room', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}k`;
    const adminUser = `kick-admin-${runId}`;
    const adminPass = `${adminUser}-pass`;
    const memberUser = `kick-member-${runId}`;
    const memberPass = `${memberUser}-pass`;
    const roomName = `Kick ${runId}`;
    const memberName = `Kicked ${runId}`;

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

    // Open the member's info panel and remove them.
    const memberRow = page.locator('[data-testid="member-row"]', {
      hasText: memberName,
    });
    await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
    await memberRow.first().click();
    await expect(page.getByTestId('member-info')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('member-info-kick').click();
    await page.getByTestId('alert-confirm').click();

    // The removed member drops out of the member list.
    await expect(memberRow).toHaveCount(0, { timeout: 30_000 });
  });
});
