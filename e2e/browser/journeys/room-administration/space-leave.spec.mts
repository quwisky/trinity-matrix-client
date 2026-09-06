import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

const session = synapseSession();

async function tokenFor(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((response) => response.json())
    .then((body) => body.access_token as string);
}

async function openSpaceMenu(page: Page, name: string): Promise<void> {
  const pill = page.getByRole('button', { name, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await pill.click();
  await page.getByTestId('space-actions-overflow').click();
}

async function joinedRooms(
  request: APIRequestContext,
  hs: string,
  token: string,
): Promise<readonly string[]> {
  return request
    .get(`${hs}/_matrix/client/v3/joined_rooms`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .then((response) => response.json())
    .then((body) => body.joined_rooms as string[]);
}

test.describe('Leaving a Space', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('names the exact Account, cancels safely, and leaves child Room membership intact', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spleave`;
    const user = `space-leave-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Leave space ${runId}`;
    const roomName = `Keep room ${runId}`;
    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    const spaceId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          name: spaceName,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json())
      .then((body) => body.room_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { via: ['localhost'], suggested: true },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('space-leave').click();
    const confirmation = page.getByRole('dialog', { name: 'Leave space' });
    await expect(confirmation).toContainText(spaceName);
    await expect(confirmation).toContainText(user);
    await expect(confirmation).toContainText(
      'You remain a member of its Rooms',
    );
    await confirmation.getByRole('button', { name: 'Cancel' }).click();

    expect(await joinedRooms(request, hs, token)).toEqual(
      expect.arrayContaining([spaceId, roomId]),
    );
    await expect(
      page.getByRole('button', { name: spaceName, exact: true }),
    ).toBeVisible();

    await openSpaceMenu(page, spaceName);
    await page.getByTestId('space-leave').click();
    await confirmation.getByRole('button', { name: 'Leave' }).click();

    await expect
      .poll(() => joinedRooms(request, hs, token), { timeout: 30_000 })
      .not.toContain(spaceId);
    await expect
      .poll(() => joinedRooms(request, hs, token), { timeout: 30_000 })
      .toContain(roomId);
  });
});
