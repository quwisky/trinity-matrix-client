import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';

// Covers "Decline and report" on an invite row: the invited account reports the room to its
// own server's admins without joining (POST /rooms/{roomId}/report), the invite is declined,
// and the confirmation's "Block {inviter}" adds the inviter to m.ignored_user_list.
const session = homeserverSession();

test.describe('Decline and report an invite', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('reports the room without joining, declines, and blocks the inviter', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}dr`;
    const inviter = `dr-alice-${runId}`;
    const invitee = `dr-bob-${runId}`;
    const roomName = `Spam offers ${runId}`;
    const aliceName = `Alice ${runId}`;
    await registerUser(request, inviter, `${inviter}-pass`);
    await registerUser(request, invitee, `${invitee}-pass`);
    const alice = await passwordLogin(request, hs, inviter, `${inviter}-pass`);
    const bob = await passwordLogin(request, hs, invitee, `${invitee}-pass`);
    const aliceAuth = { Authorization: `Bearer ${alice.accessToken}` };
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(alice.userId)}/displayname`,
      { headers: aliceAuth, data: { displayname: aliceName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: aliceAuth,
        data: { name: roomName, preset: 'private_chat', invite: [bob.userId] },
      })
      .then((r) => r.json());

    // Every membership-changing request Bob's app makes, in order.
    const membershipRequests: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST') return;
      const path = new URL(r.url()).pathname;
      // The SDK joins with POST /join/{roomIdOrAlias}; the room endpoints end in the action.
      if (/\/join\/[^/]+$/.test(path)) membershipRequests.push('join');
      const action = /\/rooms\/[^/]+\/(join|leave|report)$/.exec(path)?.[1];
      if (action) membershipRequests.push(action);
    });

    await login(page, {
      available: true,
      hs,
      user: invitee,
      pass: `${invitee}-pass`,
    } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    const action = page.getByRole('button', {
      name: `Decline and report ${roomName}`,
    });
    await expect(action).toBeVisible({ timeout: 30_000 });
    await action.click();

    const prompt = page.getByRole('dialog', { name: 'Report room' });
    await expect(prompt.getByPlaceholder('Reason (optional)')).toBeVisible();
    await prompt.getByLabel('Reason (optional)').fill('Unsolicited offers');
    const reported = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes(`/rooms/${encodeURIComponent(room_id)}/report`),
    );
    await prompt
      .getByRole('button', { name: 'Decline and report', exact: true })
      .click();
    expect((await reported).status()).toBe(200);

    const sent = page.getByRole('dialog', { name: 'Report sent' });
    await expect(sent).toBeVisible({ timeout: 30_000 });
    await sent.getByRole('button', { name: `Block ${aliceName}` }).click();

    await expect(action).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByRole('button', { name: `Decline invite to ${roomName}` }),
    ).toHaveCount(0);

    // Reported first, then declined, and never joined on the way.
    expect(membershipRequests).toEqual(['report', 'leave']);
    // Bob never joined, and his invite is now a leave.
    const membership = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/state/m.room.member/${encodeURIComponent(bob.userId)}`,
        { headers: aliceAuth },
      )
      .then((r) => r.json());
    expect(membership.membership).toBe('leave');

    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${hs}/_matrix/client/v3/user/${encodeURIComponent(bob.userId)}/account_data/m.ignored_user_list`,
            { headers: { Authorization: `Bearer ${bob.accessToken}` } },
          );
          return res.ok()
            ? Object.keys((await res.json()).ignored_users ?? {})
            : [];
        },
        { timeout: 30_000 },
      )
      .toContain(alice.userId);
  });
});
