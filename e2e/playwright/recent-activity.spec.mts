import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the "Recent activity" view (issue #9): the first rail item
// (`data-testid="rail-recent"`), active on launch, whose channel list mixes direct
// messages and rooms — everything joined — where Home shows only DMs and Rooms shows
// only non-DM rooms. RoomsPage.visibleRooms() returns the unfiltered RoomsService.rooms()
// for this view; Home/Rooms keep their existing scoping.
//
// Seeds one reader with a DM (tagged via `m.direct`) and a plain room. Space-owned rooms
// are also included in Recent, but that split is exercised in the unit tests
// (rooms.page.spec.ts) rather than paying for space-hierarchy seeding here.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

interface Seeded {
  reader: SynapseSession;
  dmName: string;
  roomName: string;
}

async function seedDmAndRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<Seeded> {
  const user = `recent-${runId}`;
  const pass = `${user}-pass`;
  const dmName = `Direct ${runId}`;
  const roomName = `Channel ${runId}`;

  await registerUser(request, user, pass);
  const { access_token: token, user_id: userId } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  const headers = { Authorization: `Bearer ${token}` };

  const dmId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: dmName },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers,
    data: { name: roomName },
  });

  // Tag the first room as a DM against a placeholder peer — RoomsService only reads the
  // `m.direct` map's values to build directRoomIds, so the peer never needs to exist.
  await request.put(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.direct`,
    { headers, data: { '@ghost:localhost': [dmId] } },
  );

  return {
    reader: { available: true, hs, user, pass },
    dmName,
    roomName,
  };
}

test.describe('Recent activity', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('is the default view and mixes DMs with rooms; Home and Rooms stay scoped', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}ra`;
    const seeded = await seedDmAndRoom(request, session.hs as string, runId);

    await login(page, seeded.reader);

    // On launch — no navigation — the Recent pill is current and both rooms are listed.
    const recentPill = page.getByTestId('rail-recent');
    await expect(recentPill).toHaveAttribute('aria-current', 'true', {
      timeout: 20_000,
    });
    const dmRow = page.locator('.channel', { hasText: seeded.dmName });
    const roomRow = page.locator('.channel', { hasText: seeded.roomName });
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
});
