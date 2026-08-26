import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the two room-tag features, which share one fixture and one menu:
// SidebarRoomListComponent renders a hover-revealed kebab (`.channel__menu`) on
// each room row, opening a Helm dropdown-menu (CDK overlay) with a
// Favourite/Unfavourite item (`data-testid="room-favourite"`,
// RoomsService.setFavourite) and a Low priority/Restore item
// (`data-testid="room-low-priority"`, RoomsService.setLowPriority), which
// write/clear the standard Matrix `m.favourite` and `m.lowpriority` room tags.
// RoomsService.refresh sorts favourite-first then low-priority-last (then
// most-recently-active, then name), and the component partitions the list into
// "Favourites" / untagged / "Low priority" `.category` groups in that order.
// A room carrying both tags counts as a favourite in both the sort and the
// partition.
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
 * Open a room row's kebab menu and return one of its dropdown items
 * (`room-favourite` by default, `room-low-priority` for the sibling tag).
 *
 * The kebab (`.channel__menu`) lives in the same `.channel-row` as the room's
 * `.channel` button but is only opacity-revealed on hover/focus (see
 * channel-sidebar.component.scss) — hover the row first, matching a real
 * user's interaction, then click the kebab scoped to THAT row (found via
 * `hasText` on its `.channel` button) so multiple rows in the list can't be
 * confused. The dropdown itself renders in a CDK overlay at the page root
 * (not nested under the row), so the returned item is located at page scope.
 */
async function openRoomMenu(
  page: Page,
  roomName: string,
  itemTestId = 'room-favourite',
) {
  const row = page.locator('.channel-row', {
    has: page.locator('.channel', { hasText: roomName }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 30_000 });
  await row.first().hover();
  await row.first().locator('.channel__menu').click();

  const item = page.getByTestId(itemTestId);
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  return item;
}

test.describe('Room tags: favourite and low priority', () => {
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

  test('demoting a room sinks it under a Low priority section, and favouriting it there pulls it back to the top', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}l`;

    const { reader, alphaName, bravoName } = await seedTwoRooms(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();

    const alphaRow = page.locator('.channel', { hasText: alphaName });
    const bravoRow = page.locator('.channel', { hasText: bravoName });
    await alphaRow.first().waitFor({ state: 'visible', timeout: 30_000 });
    await bravoRow.first().waitFor({ state: 'visible', timeout: 30_000 });

    const lowPriorityHeader = page.locator('.category', {
      hasText: 'Low priority',
    });
    await expect(lowPriorityHeader).toHaveCount(0);

    // Bravo leads: the list is most-recently-active first and it was created
    // second, so the name tiebreak never gets consulted. Pin that before
    // demoting — demoting the room that is already last would prove nothing.
    await expect(
      page.locator('.channel').first().locator('.channel__name'),
    ).toHaveText(bravoName, { timeout: 30_000 });

    const demoteItem = await openRoomMenu(page, bravoName, 'room-low-priority');
    await expect(demoteItem).toHaveText(/^\s*Low priority\s*$/);
    await demoteItem.click();

    // Same round trip as favouriting: RoomsService.setLowPriority writes the
    // `m.lowpriority` tag, refreshes, and the RoomEvent.Tags rebuild
    // repartitions the list. The header is the first observable sign.
    await lowPriorityHeader.waitFor({ state: 'visible', timeout: 30_000 });

    // Bravo crosses the whole list: first before, last after — `lowPriorityLast`
    // sinks it below every untagged room, and Alpha inherits the top.
    await expect(
      page.locator('.channel').last().locator('.channel__name'),
    ).toHaveText(bravoName, { timeout: 30_000 });
    await expect(
      page.locator('.channel').first().locator('.channel__name'),
    ).toHaveText(alphaName);

    // Both tags at once: favourite wins. The partition and the comparator have
    // to agree on that, or a room would render in one group while the keyboard
    // walk found it in the other — so this is the assertion worth paying a
    // round trip for.
    const favouriteItem = await openRoomMenu(page, bravoName);
    await favouriteItem.click();

    await expect(lowPriorityHeader).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.locator('.category', { hasText: 'Favourites' }),
    ).toBeVisible();
    await expect(
      page.locator('.channel').first().locator('.channel__name'),
    ).toHaveText(bravoName, { timeout: 30_000 });

    // Reads "Restore to list" now — confirms `m.lowpriority` survived the
    // favourite rather than being cleared by it, so the room really is
    // double-tagged and Favourites won on merit.
    const restoreItem = await openRoomMenu(
      page,
      bravoName,
      'room-low-priority',
    );
    await expect(restoreItem).toHaveText(/^\s*Restore to list\s*$/, {
      timeout: 10_000,
    });
  });
});
