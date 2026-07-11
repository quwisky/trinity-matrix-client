import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers "leave a room": each room row's kebab (`.channel__menu`) opens a Helm
// dropdown-menu (CDK overlay) with a destructive "Leave room" item
// (`data-testid="room-leave"`). Picking it confirms via TrnAlertService
// (`data-testid="alert-confirm"`) and calls RoomsService.leave → client.leave,
// after which the room drops out of the joined room list (RoomsService filters
// to `getMyMembership() === 'join'` and refreshes on RoomEvent.MyMembership).
//
// Seeds one reader with two plain rooms so leaving one leaves a non-empty list
// to assert against. Needs a Synapse homeserver (Docker) and self-skips
// otherwise, like the other authenticated web e2e specs.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const nonceRes = await request.get(
    `${SYNAPSE_HTTP}/_synapse/admin/v1/register`,
  );
  const { nonce } = await nonceRes.json();
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

async function seedTwoRooms(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; leaveName: string; keepName: string }> {
  const readerUser = `leaver-${runId}`;
  const readerPass = `leaver-pass-${runId}`;
  const leaveName = `Leave Me ${runId}`;
  const keepName = `Keep Me ${runId}`;

  await registerUser(request, readerUser, readerPass);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: readerUser },
        password: readerPass,
      },
    })
    .then((r) => r.json());

  for (const name of [leaveName, keepName]) {
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name, preset: 'private_chat' },
    });
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    leaveName,
    keepName,
  };
}

// Open a room row's kebab menu (hover-revealed on the row, opened into a CDK
// overlay at page root), scoped to THAT row so multiple rows can't be confused.
async function openRoomMenu(page: Page, roomName: string): Promise<void> {
  const row = page.locator('.channel-row', {
    has: page.locator('.channel', { hasText: roomName }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 30_000 });
  await row.first().hover();
  await row.first().locator('.channel__menu').click();
  await page
    .getByTestId('room-leave')
    .waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('Leave a room', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('leaving a room removes it from the list while others stay', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}l`;

    const { reader, leaveName, keepName } = await seedTwoRooms(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();

    const leaveRow = page.locator('.channel', { hasText: leaveName });
    const keepRow = page.locator('.channel', { hasText: keepName });
    await leaveRow.first().waitFor({ state: 'visible', timeout: 30_000 });
    await keepRow.first().waitFor({ state: 'visible', timeout: 30_000 });

    // Leave the first room via its kebab → "Leave room" → confirm.
    await openRoomMenu(page, leaveName);
    await page.getByTestId('room-leave').click();
    await page.getByTestId('alert-confirm').click();

    // The left room drops out of the list (leave round-trips through
    // client.leave + the MyMembership-driven refresh); the other room stays.
    await expect(leaveRow).toHaveCount(0, { timeout: 30_000 });
    await expect(keepRow.first()).toBeVisible();
  });
});
