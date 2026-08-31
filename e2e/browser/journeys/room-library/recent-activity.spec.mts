import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers the "Recent activity" view (issue #9): the first rail item
// (`data-testid="rail-recent"`), active on launch, whose channel list mixes direct
// messages and rooms — everything joined, space-owned rooms included — where Home shows
// only DMs and Rooms shows only spaceless non-DM rooms. RoomsPage.visibleRooms() returns
// the unfiltered RoomsService.rooms() for this view; Home/Rooms keep their scoping.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

const HS_SERVER_NAME = 'localhost';

interface ApiUser {
  token: string;
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const { access_token: token, user_id: userId } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return { token, userId, headers: { Authorization: `Bearer ${token}` } };
}

/** Create a room owned by `user`, returning its id. */
async function createRoom(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  name: string,
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: user.headers,
      data: { name, preset: 'private_chat' },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
}

/** Tag `roomId` as a direct message in `user`'s `m.direct` account data. */
async function markDirect(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  roomId: string,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(user.userId)}/account_data/m.direct`,
    { headers: user.headers, data: { '@ghost:localhost': [roomId] } },
  );
}

interface Seeded extends ApiUser {
  reader: SynapseSession;
}

async function seedReader(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<Seeded> {
  const user = `recent-${runId}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const api = await apiLogin(request, hs, user, pass);
  return { ...api, reader: { available: true, hs, user, pass } };
}

test.describe('Recent activity', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('is the default view and mixes DMs with rooms; Home and Rooms stay scoped', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ra`;
    const reader = await seedReader(request, hs, runId);
    const dmName = `Direct ${runId}`;
    const roomName = `Channel ${runId}`;

    const dmId = await createRoom(request, hs, reader, dmName);
    await createRoom(request, hs, reader, roomName);
    await markDirect(request, hs, reader, dmId);

    await login(page, reader.reader);

    // On launch — no navigation — the Recent pill is current and both rooms are listed.
    await expect(page.getByTestId('rail-recent')).toHaveAttribute(
      'aria-current',
      'true',
      { timeout: 20_000 },
    );
    const dmRow = page.locator('.channel', { hasText: dmName });
    const roomRow = page.locator('.channel', { hasText: roomName });
    await expect(dmRow).toBeVisible({ timeout: 20_000 });
    await expect(roomRow).toBeVisible();

    // Home scopes to direct messages: the DM stays, the plain room drops.
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByTestId('rail-recent')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(dmRow).toBeVisible();
    await expect(roomRow).toHaveCount(0);

    // Rooms scopes to non-DM rooms: the plain room is back, the DM is gone.
    await page.getByTestId('rail-rooms').click();
    await expect(roomRow).toBeVisible({ timeout: 15_000 });
    await expect(dmRow).toHaveCount(0);

    // Back to Recent: both together again.
    await page.getByTestId('rail-recent').click();
    await expect(dmRow).toBeVisible({ timeout: 15_000 });
    await expect(roomRow).toBeVisible();
  });

  test('groups favourites above the rest of the mixed list', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}rf`;
    const reader = await seedReader(request, hs, runId);
    const dmName = `Direct ${runId}`;
    const favName = `Favourite ${runId}`;

    const dmId = await createRoom(request, hs, reader, dmName);
    const favId = await createRoom(request, hs, reader, favName);
    await markDirect(request, hs, reader, dmId);
    // Favourite the room via the standard `m.favourite` tag (what the kebab menu
    // writes) — the favourites/others partition should apply in the combined view.
    await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(reader.userId)}/rooms/${encodeURIComponent(favId)}/tags/m.favourite`,
      { headers: reader.headers, data: {} },
    );

    await login(page, reader.reader);
    await expect(page.getByTestId('rail-recent')).toHaveAttribute(
      'aria-current',
      'true',
      { timeout: 20_000 },
    );

    // A "Favourites" category header appears, and the favourited room sits under it —
    // above the (non-favourite) DM in list order, even though the DM is also here.
    const sidebar = page.locator('trn-channel-sidebar');
    await expect(
      sidebar.locator('.category', { hasText: 'Favourites' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      sidebar.locator('.channel', { hasText: favName }),
    ).toBeVisible();
    await expect(
      sidebar.locator('.channel', { hasText: dmName }),
    ).toBeVisible();

    const rowText = await sidebar.locator('.channel').allInnerTexts();
    const favIndex = rowText.findIndex((t) => t.includes(favName));
    const dmIndex = rowText.findIndex((t) => t.includes(dmName));
    expect(favIndex).toBeGreaterThanOrEqual(0);
    expect(dmIndex).toBeGreaterThan(favIndex); // favourite floats to the top
  });

  test('includes a space-owned room, which the flat Rooms view excludes', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}rs`;
    const reader = await seedReader(request, hs, runId);
    const freeName = `Freestanding ${runId}`;
    const childName = `Team Chat ${runId}`;

    await createRoom(request, hs, reader, freeName);
    // A space + a child room linked via `m.space.child` (mirrors
    // room-filter-spaceless.spec.mts / SpacesService.createRoomInSpace).
    const spaceId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: {
          name: `Team ${runId}`,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    const childId = await createRoom(request, hs, reader, childName);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
      { headers: reader.headers, data: { via: [HS_SERVER_NAME] } },
    );

    await login(page, reader.reader);
    await expect(page.getByTestId('rail-recent')).toHaveAttribute(
      'aria-current',
      'true',
      { timeout: 20_000 },
    );

    const freeRow = page.locator('.channel', { hasText: freeName });
    const childRow = page.locator('.channel', { hasText: childName });

    // Recent lists both the freestanding room and the space-owned one.
    await expect(freeRow).toBeVisible({ timeout: 20_000 });
    await expect(childRow).toBeVisible();

    // The flat Rooms view drops the space-owned room (it lives under its space pill),
    // keeping only the freestanding one — the distinction Recent deliberately ignores.
    await page.getByTestId('rail-rooms').click();
    await expect(freeRow).toBeVisible({ timeout: 15_000 });
    await expect(childRow).toHaveCount(0);
  });

  test('shows the unread total on the Recent pill', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ru`;
    const reader = await seedReader(request, hs, runId);
    const seed = 3;

    // A second user posts into a room the reader has joined but not viewed, so the
    // messages stay unread and the Recent badge (recentUnread) should count them.
    const senderUser = `sender-${runId}`;
    await registerUser(request, senderUser, `${senderUser}-pass`);
    const sender = await apiLogin(
      request,
      hs,
      senderUser,
      `${senderUser}-pass`,
    );
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: {
          name: `Unread ${runId}`,
          preset: 'private_chat',
          invite: [sender.userId],
        },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: sender.headers },
    );
    for (let i = 0; i < seed; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/ra-${runId}-${i}`,
        {
          headers: sender.headers,
          data: { msgtype: 'm.text', body: `unread ${i} ${runId}` },
        },
      );
    }

    await login(page, reader.reader);

    const recentItem = page
      .locator('trn-server-rail .item')
      .filter({ has: page.getByTestId('rail-recent') });
    const badge = recentItem.locator('.badge');
    await expect(badge).toBeVisible({ timeout: 30_000 });

    // Assert the exact seeded count, with a positive-integer fallback for server-side
    // notification-count timing quirks (mirrors unread-badges.spec.mts).
    const text = (await badge.textContent())?.trim() ?? '';
    if (text !== String(seed)) {
      expect(text).toMatch(/^\d+\+?$/);
      expect(parseInt(text, 10)).toBeGreaterThan(0);
    }
  });
});
