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

// Covers the sidebar's in-place filter box (`data-testid="sidebar-filter"`), which
// ChannelSidebarComponent renders between the header and the scrolling list. It narrows
// every list under it — joined rooms, invites and a space's child lists — by a
// case- and accent-insensitive substring match on the name (see
// channel-sidebar/room-filter.ts), and leaves the result on screen. That last part is the
// whole difference from the Ctrl/Cmd+K switcher, which closes on selection, so the
// assertions below check what is still rendered rather than what was navigated to.
//
// Seeds a fresh reader via Synapse's shared-secret admin endpoint (same trick as
// room-list.spec.mts / favourite-rooms.spec.mts) with two plain (non-DM) rooms whose names
// share no substring — one room could not demonstrate narrowing, and overlapping names
// could not distinguish a real filter from a no-op.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise, like the other
// authenticated web e2e specs.
const session = synapseSession();

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
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  const json = await res.json();
  return {
    token: json.access_token as string,
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/**
 * A fresh reader with two plain rooms whose names share nothing: "Cafétéria …" and
 * "Warehouse …". The accented name is deliberate — the filter folds diacritics, so typing
 * plain ASCII has to find it, and that cannot be tested with English-only fixtures.
 */
async function seedTwoRooms(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: SynapseSession;
  cafeName: string;
  warehouseName: string;
}> {
  const readerUser = `filter-${runId}`;
  const readerPass = `filter-pass-${runId}`;
  const cafeName = `Cafétéria ${runId}`;
  const warehouseName = `Warehouse ${runId}`;

  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  for (const name of [cafeName, warehouseName]) {
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name, preset: 'private_chat' },
    });
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    cafeName,
    warehouseName,
  };
}

/** Room names currently rendered in the sidebar, top to bottom. */
async function visibleRooms(page: Page): Promise<string[]> {
  return page.locator('.channel__name').allTextContents();
}

test.describe('Sidebar room filter', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('filters the room list in place, folds accents, and restores on clear', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}q`;

    const { reader, cafeName, warehouseName } = await seedTwoRooms(
      request,
      hs,
      runId,
    );

    await login(page, reader);

    // Both seeded rooms are plain (non-DM) — reveal them under the Rooms pill.
    await page.getByTestId('rail-rooms').click();

    await page
      .locator('.channel', { hasText: cafeName })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page
      .locator('.channel', { hasText: warehouseName })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });

    const filter = page.getByTestId('sidebar-filter');
    const clear = page.getByTestId('sidebar-filter-clear');

    // Nothing to clear before anything is typed.
    await expect(clear).toHaveCount(0);

    // Unaccented ASCII against an accented room name: the NFD fold is what makes this
    // work, and nobody types "é" to find their own room.
    await filter.fill('cafeteria');

    await expect(page.locator('.channel')).toHaveCount(1, { timeout: 10_000 });
    expect(await visibleRooms(page)).toEqual([cafeName]);

    // The filtered list STAYS — this is the difference from the Ctrl/Cmd+K switcher, so
    // assert the box still holds the query with the result still on screen.
    await expect(filter).toHaveValue('cafeteria');

    // A query matching neither room reports that nothing matched, rather than claiming
    // the account has no rooms.
    await filter.fill('zzzz');
    await expect(page.locator('.channel')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('room-list-empty')).toHaveText(
      /No rooms match/,
    );

    await clear.click();

    await expect(filter).toHaveValue('');
    await expect(page.locator('.channel')).toHaveCount(2, { timeout: 10_000 });
    expect((await visibleRooms(page)).sort()).toEqual(
      [cafeName, warehouseName].sort(),
    );
  });

  test('Escape clears the filter without closing anything behind it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}e`;

    const { reader, cafeName, warehouseName } = await seedTwoRooms(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();

    const filter = page.getByTestId('sidebar-filter');
    await expect(page.locator('.channel')).toHaveCount(2, { timeout: 30_000 });

    await filter.fill('warehouse');
    await expect(page.locator('.channel')).toHaveCount(1, { timeout: 10_000 });
    expect(await visibleRooms(page)).toEqual([warehouseName]);

    await filter.press('Escape');

    await expect(filter).toHaveValue('');
    await expect(page.locator('.channel')).toHaveCount(2, { timeout: 10_000 });
    expect((await visibleRooms(page)).sort()).toEqual(
      [cafeName, warehouseName].sort(),
    );
    // The sidebar is still here: Escape cleared the box, it did not navigate away.
    await expect(filter).toBeVisible();
  });
});
