import { captureScreenshot } from '../../../support/screenshot.mts';
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

// Covers a stale Room-administration roster: when the member projection fails, the
// retained roster stays visible and labelled while System Status reports the paused
// actions, and Retry recovers it without closing the panel. The kick and ban journeys
// were retired to android.member-moderation (#709).
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

  test('labels a retained stale roster and recovers without closing its panel', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      process.env['TRINITY_E2E_PLATFORM'] === 'android',
      'fault injection requires Angular development hooks; the installed APK is production',
    );
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

    await page
      .getByTestId('app-capability-summary')
      .getByRole('button', { name: 'System Status' })
      .click();
    const status = page.getByRole('dialog', { name: 'System Status' });
    const memberHealth = status
      .locator('article')
      .filter({ hasText: 'The current Room member list is unavailable' });
    const banHealth = status
      .locator('article')
      .filter({ hasText: 'The current Room ban list is unavailable' });
    await expect(memberHealth).toContainText(
      'Administrative actions that depend on it are paused',
    );
    await expect(banHealth).toContainText(
      'Administrative actions that depend on it are paused',
    );
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
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });

    await page.evaluate(() => {
      const target = window as unknown as RoomAdministrationFaultWindow;
      target.restoreRoomAdministrationMembers?.();
      delete target.restoreRoomAdministrationMembers;
    });
    await memberHealth
      .getByRole('button', { name: 'Retry Room administration' })
      .click();

    await expect(memberHealth).toHaveCount(0);
    await expect(banHealth).toHaveCount(0);
    await status.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('member-list-freshness')).toHaveCount(0);
    await expect(roster).toBeVisible();
    await expect(memberRow).toBeVisible();
    await testInfo.attach('room-administration-recovered-roster', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });
  });
});
