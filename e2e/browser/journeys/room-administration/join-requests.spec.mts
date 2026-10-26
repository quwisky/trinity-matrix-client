import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
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
import {
  configureRoomSettingsSuite,
  openRoom,
  session,
} from '../../support/room-settings-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

// Covers ask to join: an admin opens a room to knocking, a knock reaches the banner and the
// Requests list, and approve, deny and revoke land as the matching membership on the
// homeserver. Knocks and invites come over the API; the admin acts in the UI.
// Needs a Synapse homeserver; self-skips otherwise.

type Account = ApiUser & { user: string; pass: string };

async function account(
  request: APIRequestContext,
  hs: string,
  user: string,
): Promise<Account> {
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  return { ...(await apiLogin(request, hs, user, pass)), user, pass };
}

async function memberState(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  roomId: string,
  userId: string,
): Promise<{ membership?: string; reason?: string }> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
    { headers: actor.headers },
  );
  return res.ok() ? await res.json() : {};
}

async function joinRule(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  roomId: string,
): Promise<string | undefined> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules/`,
    { headers: actor.headers },
  );
  return res.ok() ? (await res.json()).join_rule : undefined;
}

async function knock(
  request: APIRequestContext,
  hs: string,
  who: ApiUser,
  roomId: string,
  reason: string,
): Promise<void> {
  const res = await request.post(
    `${hs}/_matrix/client/v3/knock/${encodeURIComponent(roomId)}`,
    { headers: who.headers, data: { reason } },
  );
  if (!res.ok()) throw new Error(await describeFailure('knock', res));
}

async function openMembersSettings(page: Page): Promise<void> {
  await page.getByTestId('room-actions-overflow').click();
  await page.getByTestId('overflow-open-room-settings').click();
  await openSettingsTab(page, 'room-settings', 'members');
}

test.describe('Ask to join', () => {
  configureRoomSettingsSuite();

  test('an admin opens knocking, then approves a request', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ja`;
    const alice = await account(request, hs, `knock-admin-${runId}`);
    const bob = await account(request, hs, `knock-bob-${runId}`);
    const roomName = `Knock ${runId}`;
    const roomId = await createRoom(request, hs, alice, roomName);

    await login(page, {
      available: true,
      hs,
      user: alice.user,
      pass: alice.pass,
    } as HomeserverSession);
    await openRoom(page, roomName);
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-open-room-settings').click();
    await openSettingsTab(page, 'room-settings', 'access');
    await page.getByTestId('room-settings-join-rule').click();
    await page.getByTestId('join-rule-knock').click();
    await page.getByTestId('room-settings-save').click();
    await expect
      .poll(() => joinRule(request, hs, alice, roomId), { timeout: 30_000 })
      .toBe('knock');
    // Close with the X once the saved rule has synced back: right after a save, Escape did not
    // always reach the dialog on CI.
    await expect(page.getByTestId('room-settings-save')).toHaveCount(0, {
      timeout: 30_000,
    });
    await page
      .getByRole('dialog', { name: 'Room settings' })
      .getByRole('button', { name: 'Close settings' })
      .click();
    await expect(page.getByTestId('room-settings')).toHaveCount(0);

    await knock(request, hs, bob, roomId, 'From the meetup');

    const banner = page.getByTestId('join-requests-banner');
    await expect(banner).toContainText('asked to join.', { timeout: 30_000 });
    await page.getByTestId('join-requests-review').click();
    const row = page.getByTestId(`pending-member-${bob.userId}`);
    await expect(row).toContainText('From the meetup');
    await row.getByTestId('pending-approve').click();

    await expect
      .poll(
        async () =>
          (await memberState(request, hs, alice, roomId, bob.userId))
            .membership,
        { timeout: 30_000 },
      )
      .toBe('invite');
  });

  test('an admin denies a request with a reason', async ({ page, request }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}jd`;
    const alice = await account(request, hs, `deny-admin-${runId}`);
    const carol = await account(request, hs, `deny-carol-${runId}`);
    const roomName = `Deny ${runId}`;
    const roomId = await createRoom(request, hs, alice, roomName);
    const rule = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules/`,
      { headers: alice.headers, data: { join_rule: 'knock' } },
    );
    if (!rule.ok()) throw new Error(await describeFailure('join_rules', rule));
    await knock(request, hs, carol, roomId, 'Let me in');

    await login(page, {
      available: true,
      hs,
      user: alice.user,
      pass: alice.pass,
    } as HomeserverSession);
    await openRoom(page, roomName);
    await openMembersSettings(page);
    await page.getByTestId('members-settings-requests').click();
    await page
      .getByTestId(`pending-member-${carol.userId}`)
      .getByTestId('pending-deny')
      .click();
    await page.getByPlaceholder('Reason (optional)').fill('Not this time');
    await page.getByTestId('alert-confirm').click();

    await expect
      .poll(
        async () => {
          const { membership, reason } = await memberState(
            request,
            hs,
            alice,
            roomId,
            carol.userId,
          );
          return { membership, reason };
        },
        { timeout: 30_000 },
      )
      .toEqual({ membership: 'leave', reason: 'Not this time' });
  });

  test('an admin revokes an invite', async ({ page, request }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}jr`;
    const alice = await account(request, hs, `revoke-admin-${runId}`);
    const dan = await account(request, hs, `revoke-dan-${runId}`);
    const roomName = `Revoke ${runId}`;
    const roomId = await createRoom(request, hs, alice, roomName, {
      invite: [dan.userId],
    });

    await login(page, {
      available: true,
      hs,
      user: alice.user,
      pass: alice.pass,
    } as HomeserverSession);
    await openRoom(page, roomName);
    await openMembersSettings(page);
    await page.getByTestId('members-settings-invited').click();
    await page
      .getByTestId(`pending-member-${dan.userId}`)
      .getByTestId('pending-revoke')
      .click();
    await page.getByTestId('alert-confirm').click();

    await expect
      .poll(
        async () =>
          (await memberState(request, hs, alice, roomId, dan.userId))
            .membership,
        { timeout: 30_000 },
      )
      .toBe('leave');
  });
});
