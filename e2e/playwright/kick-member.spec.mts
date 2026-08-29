import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers kick and ban projection recovery. The roster must be visible again before the
// removed row assertion: opening member info replaces the roster, so asserting only that
// the row disappeared can pass while the info panel is still covering the stale list.
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

test.describe('Remove a member', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  for (const moderation of [
    {
      label: 'removes',
      slug: 'kick',
      actionTestId: 'member-info-kick',
      expectedMembership: 'leave',
    },
    {
      label: 'bans',
      slug: 'ban',
      actionTestId: 'member-info-ban',
      expectedMembership: 'ban',
    },
  ] as const) {
    test(`an admin ${moderation.label} a lower-power member from the visible roster`, async ({
      page,
      request,
    }) => {
      const hs = session.hs as string;
      const runId = `${Date.now().toString(36)}${moderation.slug[0]}`;
      const adminUser = `${moderation.slug}-admin-${runId}`;
      const adminPass = `${adminUser}-pass`;
      const memberUser = `${moderation.slug}-member-${runId}`;
      const memberPass = `${memberUser}-pass`;
      const roomName = `${moderation.slug} ${runId}`;
      const memberName = `${moderation.label} ${runId}`;

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
      await page.getByTestId(moderation.actionTestId).click();
      await page.getByTestId('alert-confirm').click();

      await expect(page.getByTestId('member-info')).toHaveCount(0);
      await expect(page.getByTestId('member-list')).toBeVisible();
      await expect(memberRow).toHaveCount(0);

      const membership = await request
        .get(
          `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.member/${encodeURIComponent(memberB.userId)}`,
          { headers: admin.headers },
        )
        .then((response) => response.json());
      expect(membership.membership).toBe(moderation.expectedMembership);
    });
  }
});
