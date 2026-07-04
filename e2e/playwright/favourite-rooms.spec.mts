import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the "favourite rooms" feature: ChannelSidebarComponent renders a
// hover-revealed kebab (`.channel__menu`) on each room row, opening a Helm
// dropdown-menu (CDK overlay) with a Favourite/Unfavourite item
// (`data-testid="room-favourite"`, RoomsService.setFavourite) that
// writes/clears the standard Matrix `m.favourite` room tag. RoomsService.refresh
// sorts favourite-first (then most-recently-active, then name), and
// ChannelSidebarComponent partitions favourited rooms under a "Favourites"
// `.category` header above the rest of the list.
//
// Seeds a single fresh reader via Synapse's shared-secret admin endpoint (same
// trick as room-list.spec.mts/room-filter-spaceless.spec.mts/
// unread-badges.spec.mts) who creates two plain (non-DM) rooms — a lone room
// couldn't demonstrate "moves to the top" since there'd be nothing to move
// past.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise, like the other
// authenticated web e2e specs.
const session = synapseSession();

// Direct (no-TLS) Synapse admin endpoint — same constant as the other e2e
// helpers (e2e/features/rooms.mjs, search.mjs, room-list.spec.mts) and
// e2e/synapse/start.mjs. The server name ('localhost') is implicit in `hs` and
// every user id below.
const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

interface ApiUser {
  token: string;
  userId: string;
  headers: { Authorization: string };
}

/** Register a user via Synapse's shared-secret admin endpoint (idempotent —
 * "already exists" is treated as success, mirrors rooms.mjs/search.mjs and
 * room-list.spec.mts). */
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
 * Register a fresh reader and have it create two plain (non-DM) rooms —
 * "Alpha Room" and "Bravo Room" (run-id-suffixed for isolation) — leaving the
 * reader with exactly two rooms and nothing else to muddy list-order
 * assertions.
 */
async function seedTwoRooms(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; alphaName: string; bravoName: string }> {
  const readerUser = `reader-${runId}`;
  const readerPass = `reader-pass-${runId}`;
  const alphaName = `Alpha Room ${runId}`;
  const bravoName = `Bravo Room ${runId}`;

  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  for (const name of [alphaName, bravoName]) {
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name, preset: 'private_chat' },
    });
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    alphaName,
    bravoName,
  };
}

/**
 * Open a room row's kebab menu and return the `room-favourite` dropdown item.
 *
 * The kebab (`.channel__menu`) lives in the same `.channel-row` as the room's
 * `.channel` button but is only opacity-revealed on hover/focus (see
 * channel-sidebar.component.scss) — hover the row first, matching a real
 * user's interaction, then click the kebab scoped to THAT row (found via
 * `hasText` on its `.channel` button) so multiple rows in the list can't be
 * confused. The dropdown itself renders in a CDK overlay at the page root
 * (not nested under the row), so the returned item is located at page scope.
 */
async function openRoomMenu(page: Page, roomName: string) {
  const row = page.locator('.channel-row', {
    has: page.locator('.channel', { hasText: roomName }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 30_000 });
  await row.first().hover();
  await row.first().locator('.channel__menu').click();

  const favouriteItem = page.getByTestId('room-favourite');
  await favouriteItem.waitFor({ state: 'visible', timeout: 10_000 });
  return favouriteItem;
}

test.describe('Favourite rooms', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('favouriting a room surfaces a Favourites section and moves it to the top; unfavouriting reverses it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}f`;

    const { reader, alphaName, bravoName } = await seedTwoRooms(
      request,
      hs,
      runId,
    );

    await login(page, reader);

    // Both seeded rooms are plain (non-DM) — reveal them under the Rooms pill.
    await page.getByTestId('rail-rooms').click();

    const alphaRow = page.locator('.channel', { hasText: alphaName });
    const bravoRow = page.locator('.channel', { hasText: bravoName });
    await alphaRow.first().waitFor({ state: 'visible', timeout: 30_000 });
    await bravoRow.first().waitFor({ state: 'visible', timeout: 30_000 });

    // No Favourites section yet — neither room carries the tag.
    await expect(
      page.locator('.category', { hasText: 'Favourites' }),
    ).toHaveCount(0);

    // Favourite Bravo via its row's kebab menu — the item starts labeled
    // "Favourite" since the room isn't tagged yet.
    // Regex matches test textContent verbatim (unlike string equality, it
    // isn't whitespace-normalized/trimmed first) — the label sits alongside
    // an icon in the template, so allow the surrounding whitespace.
    const favouriteItem = await openRoomMenu(page, bravoName);
    await expect(favouriteItem).toHaveText(/^\s*Favourite\s*$/);
    await favouriteItem.click();

    // Wait on the app's own state — the `m.favourite` tag round-trips through
    // RoomsService.setFavourite's write, its own post-write refresh(), and the
    // RoomEvent.Tags-driven rebuild from sync — rather than a fixed sleep. The
    // Favourites header is the first observable sign the room's been
    // repartitioned.
    const favouritesHeader = page.locator('.category', {
      hasText: 'Favourites',
    });
    await favouritesHeader.waitFor({ state: 'visible', timeout: 30_000 });

    // Bravo should now be the very first `.channel` row — under Favourites
    // and above the still-unfavourited Alpha (RoomsService.refresh sorts
    // favourite-first).
    await expect(
      page.locator('.channel').first().locator('.channel__name'),
    ).toHaveText(bravoName, { timeout: 30_000 });

    // Re-opening Bravo's kebab should now read "Unfavourite" — confirms the
    // tag stuck, not just a one-off UI reorder.
    const unfavouriteItem = await openRoomMenu(page, bravoName);
    await expect(unfavouriteItem).toHaveText(/^\s*Unfavourite\s*$/, {
      timeout: 10_000,
    });
    await unfavouriteItem.click();

    // The Favourites section should disappear once Bravo drops back into the
    // flat, activity-sorted list — again waiting on the tag-clear round trip
    // rather than a sleep.
    await expect(favouritesHeader).toHaveCount(0, { timeout: 30_000 });
  });
});
