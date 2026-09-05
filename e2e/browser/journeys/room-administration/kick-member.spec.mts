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

// Covers kick and ban projection recovery. The roster must be visible again before the
// removed row assertion: opening member info replaces the roster, so asserting only that
// the row disappeared can pass while the info panel is still covering the stale list.
const session = synapseSession();

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

interface RoomAdministrationFaultWindow extends Window {
  ng: {
    getComponent(element: Element): {
      runtime: {
        state(): unknown;
        adapter: {
          session: {
            roomAdministration: {
              members: {
                membersOf(roomId: string | null): readonly unknown[];
                retryProjection(): void;
              };
            };
          };
        };
      };
    };
  };
  restoreRoomAdministrationMembers?: () => void;
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
      const runId = `${testResourceId('run')}${moderation.slug[0]}`;
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
      await expect(page.locator('.chat-members')).toBeHidden();
      await page.getByTestId('toggle-members').click();
      await expect(page.locator('.chat-members')).toBeVisible();

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

  test('labels a retained stale roster and recovers without closing its panel', async ({
    page,
    request,
  }, testInfo) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}health`;
    const adminUser = `administration-health-${runId}`;
    const adminPass = `${adminUser}-pass`;
    const memberUser = `administration-member-${runId}`;
    const memberPass = `${memberUser}-pass`;
    const roomName = `administration health ${runId}`;
    const memberName = `Visible member ${runId}`;

    await registerUser(request, adminUser, adminPass);
    await registerUser(request, memberUser, memberPass);
    const admin = await apiLogin(request, hs, adminUser, adminPass);
    const member = await apiLogin(request, hs, memberUser, memberPass);
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(member.userId)}/displayname`,
      { headers: member.headers, data: { displayname: memberName } },
    );
    await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: admin.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [member.userId],
        },
      })
      .then((response) => response.json())
      .then(({ room_id }) =>
        request.post(
          `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id as string)}/join`,
          { headers: member.headers },
        ),
      );

    await login(page, {
      available: true,
      hs,
      user: adminUser,
      pass: adminPass,
    } as SynapseSession);
    await openRoom(page, roomName);
    await page.getByTestId('toggle-members').click();
    const roster = page.getByTestId('member-list');
    const memberRow = page.getByTestId('member-row').filter({
      hasText: memberName,
    });
    await expect(memberRow).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => {
      const target = window as unknown as RoomAdministrationFaultWindow;
      const root = document.querySelector('trn-root');
      if (!root) throw new Error('Application root unavailable');
      const members =
        target.ng.getComponent(root).runtime.adapter.session.roomAdministration
          .members;
      const membersOf = members.membersOf;
      target.restoreRoomAdministrationMembers = () => {
        members.membersOf = membersOf;
      };
      members.membersOf = () => {
        throw new Error('synthetic private membership response');
      };
      members.retryProjection();
    });

    const memberHealth = page.getByTestId('app-room-members-health');
    const banHealth = page.getByTestId('app-room-bans-health');
    await expect(memberHealth).toContainText('member list may be stale');
    await expect(banHealth).toContainText('ban list may be stale');
    await expect(memberHealth).not.toContainText('synthetic');
    await expect(page.getByTestId('member-list-freshness')).toContainText(
      'Showing the last known member list',
    );
    await expect(memberRow).toBeVisible();
    await expect(page.getByTestId('invite-people')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await testInfo.attach('room-administration-stale-roster', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await page.evaluate(() => {
      const target = window as unknown as RoomAdministrationFaultWindow;
      target.restoreRoomAdministrationMembers?.();
      delete target.restoreRoomAdministrationMembers;
    });
    await page.getByTestId('app-room-members-retry').click();

    await expect(memberHealth).toHaveCount(0);
    await expect(banHealth).toHaveCount(0);
    await expect(page.getByTestId('member-list-freshness')).toHaveCount(0);
    await expect(roster).toBeVisible();
    await expect(memberRow).toBeVisible();
    await testInfo.attach('room-administration-recovered-roster', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
