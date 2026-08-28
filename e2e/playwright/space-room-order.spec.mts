import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';
import { openSettingsSection } from './journeys/navigation.mts';

// Covers issue #34: how rooms are ordered inside a space.
//
// A space's children can be listed by recent activity (the default), by the space's own
// `m.space.child` order, or alphabetically — chosen per space from the sidebar header, with a
// per-account default in Settings → Appearance.
//
// The seed below makes the three orderings disagree PAIRWISE, so no assertion here can pass
// under the wrong one:
//
//   room   m.space.child order   curated   alphabetical   recency
//   Zulu   10                    1st       3rd            2nd
//   Alpha  20                    2nd       1st            3rd
//   Mike   30                    3rd       2nd            1st
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise, like the other authenticated
// web e2e specs.
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

/** One of the space's children: its display name and the room id it got. */
interface SeededChild {
  name: string;
  roomId: string;
}

/**
 * Register a reader, then create a space with three children linked by `m.space.child`,
 * each carrying an explicit `order` so the curated ordering is a real choice rather than the
 * name tiebreak `spaceChildIdsOf` otherwise falls back to.
 *
 * A message is sent into each child, awaited in sequence, so `getLastActiveTimestamp` — and
 * therefore recency order — is deterministic: Alpha, then Zulu, then Mike, newest last.
 */
async function seedOrderedSpace(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: SynapseSession;
  spaceName: string;
  zulu: SeededChild;
  alpha: SeededChild;
  mike: SeededChild;
}> {
  const readerUser = `order-${runId}`;
  const readerPass = `order-pass-${runId}`;
  const spaceName = `Ordered ${runId}`;

  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  const spaceId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  /** Create a child room and link it into the space at the given curated position. */
  async function addChild(name: string, order: string): Promise<SeededChild> {
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: { name, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    const link = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(
        spaceId,
      )}/state/m.space.child/${encodeURIComponent(roomId)}`,
      {
        headers: reader.headers,
        // `order` is what makes the curated ordering distinguishable from alphabetical;
        // `via` must be non-empty or the link reads as a removed child.
        data: { via: [HS_SERVER_NAME], order, suggested: true },
      },
    );
    if (!link.ok()) {
      throw new Error(
        `m.space.child ${spaceId}→${roomId} → ${link.status()} ${await link.text()}`,
      );
    }
    return { name, roomId };
  }

  const zulu = await addChild(`Zulu ${runId}`, '10');
  const alpha = await addChild(`Alpha ${runId}`, '20');
  const mike = await addChild(`Mike ${runId}`, '30');

  // Awaited in sequence so the timestamps are strictly ordered: Mike is newest.
  for (const child of [alpha, zulu, mike]) {
    await sendMessage(request, hs, reader, child.roomId, `seed ${child.name}`);
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    spaceName,
    zulu,
    alpha,
    mike,
  };
}

/** Send a message over the API, so it arrives via /sync rather than as a local echo. */
async function sendMessage(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  roomId: string,
  body: string,
): Promise<void> {
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(
      roomId,
    )}/send/m.room.message/${encodeURIComponent(`${Date.now()}-${Math.random()}`)}`,
    { headers: user.headers, data: { msgtype: 'm.text', body } },
  );
  if (!res.ok()) {
    throw new Error(`send → ${res.status()} ${await res.text()}`);
  }
}

/** Open the space's sort menu — a submenu of the header overflow — and pick one of its rows. */
async function chooseSort(page: Page, option: string): Promise<void> {
  await page.getByTestId('space-actions-overflow').click();
  await page.getByTestId('space-sort').click();
  const item = page.getByTestId(option);
  await item.waitFor({ state: 'visible', timeout: 15_000 });

  // The tick on whichever row is CURRENTLY selected has to be visible, and this is the only
  // place in the suite where one is on screen. It reads a real `[data-checked]` presence
  // attribute through `group-data-checked/dropdown-menu-radio:opacity-100`, which a theme
  // remap onto `data-state` silently switches off for every menu in the app — emitting a
  // rule that looks correct and matches nothing. jsdom cannot see it (no CSS) and the
  // existing unit test asserts only `hasAttribute('data-checked')`, which stays true.
  const checked = page.locator('[data-checked]:not([data-checked="false"])');
  await expect(checked.first()).toBeVisible({ timeout: 5_000 });
  await expect
    .poll(() =>
      checked
        .first()
        .locator('ng-icon')
        .evaluate((icon) => getComputedStyle(icon.parentElement!).opacity),
    )
    .toBe('1');

  await item.click();
  await expect(item).toHaveCount(0); // the overlay closed
}

/** Pick an option from a settings dropdown (the list lives in a CDK overlay). */
async function chooseOption(
  page: Page,
  select: string,
  option: string,
): Promise<void> {
  await page.getByTestId(select).locator('button').first().click();
  const item = page.getByTestId(option);
  await item.waitFor({ state: 'visible', timeout: 15_000 });
  await item.click();
  await expect(item).toHaveCount(0);
}

/** Select the space in the rail. Pills carry no testid — they are named buttons. */
async function openSpace(page: Page, spaceName: string): Promise<void> {
  const pill = page.getByRole('button', { name: spaceName, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await pill.click();
  // The sort entry lives in the header overflow now, so the overflow trigger is what says
  // the space's sidebar is up.
  await expect(page.getByTestId('space-actions-overflow')).toBeVisible({
    timeout: 15_000,
  });
}

/** The room names currently listed in the sidebar, top to bottom. */
function roomNames(page: Page) {
  return page.locator('.channel__name');
}

test.describe('Room order inside a space', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('defaults to recent activity, and a per-space choice beats the account default', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ord`;

    const { reader, spaceName, zulu, alpha, mike } = await seedOrderedSpace(
      request,
      hs,
      runId,
    );
    const curated = [zulu.name, alpha.name, mike.name];
    const alphabetical = [alpha.name, mike.name, zulu.name];
    const recency = [mike.name, zulu.name, alpha.name];

    await login(page, reader);
    await openSpace(page, spaceName);

    // 1. Out of the box a space reads like the rest of the app: newest first. Before this
    //    change the sidebar rendered the curated order here.
    await expect(roomNames(page)).toHaveText(recency, { timeout: 30_000 });

    // 2. The space can be pinned to the curated order from its header.
    await chooseSort(page, 'space-sort-space');
    await expect(roomNames(page)).toHaveText(curated);

    // 3. And the choice sticks — per space, across a reload.
    await page.reload();
    await openSpace(page, spaceName);
    await expect(roomNames(page)).toHaveText(curated, { timeout: 30_000 });

    // 4. Changing the account default does NOT disturb a space that has its own choice.
    await openSettingsSection(page, 'appearance');
    await chooseOption(page, 'space-order-select', 'space-order-alphabetical');

    await page.goto('/rooms');
    await openSpace(page, spaceName);
    await expect(roomNames(page)).toHaveText(curated, { timeout: 30_000 });

    // 5. Dropping the override hands the space back to that default — proving "use my
    //    default" tracks the setting rather than freezing whatever it was.
    await chooseSort(page, 'space-sort-default');
    await expect(roomNames(page)).toHaveText(alphabetical);
  });

  /**
   * Seed one EMPTY space and open it. Deliberately not `seedOrderedSpace`: the header
   * assertions care about nothing but the space existing, and every Synapse-backed spec
   * shares one disposable homeserver (the config caps workers at 2 for that reason).
   */
  async function openSeededSpace(
    page: Page,
    request: APIRequestContext,
    tag: string,
  ): Promise<void> {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}${tag}`;
    const user = `hdr-${runId}`;
    const pass = `hdr-pass-${runId}`;
    const spaceName = `Header ${runId}`;

    await registerUser(request, user, pass);
    const api = await apiLogin(request, hs, user, pass);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: api.headers,
      data: {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    });

    await login(page, { available: true, hs, user, pass });
    await openSpace(page, spaceName);
  }

  /** Three buttons, and a title with room to actually read — see #38. */
  async function expectHeaderFits(page: Page): Promise<void> {
    await expect(page.locator('.sidebar__actions button')).toHaveCount(3);

    const title = await page.locator('.sidebar__title').boundingBox();
    if (!title) {
      throw new Error('sidebar title not laid out');
    }
    expect(title.width).toBeGreaterThan(100);
  }

  test('collapsing the actions gives the space name its room back', async ({
    page,
    request,
  }) => {
    // The regression guard for #38's premise, measured rather than eyeballed. The sidebar is
    // a fixed 280px (256px content box). Six 30px buttons plus gaps took 198px and left the
    // title about 58px — roughly six characters. Three buttons take 94px, so the title
    // measures 154px: the 100px floor sits clear of both the old value and the new one.
    await openSeededSpace(page, request, 'hdr');

    await expectHeaderFits(page);
  });

  // The touch case is the one the change was actually made for: `@media (pointer: coarse)`
  // lifts `.sidebar__action` to the 44px touch minimum, where the old six buttons needed
  // 274px — more than the 256px the sidebar has. A fine-pointer measurement alone would let
  // a fourth button through: 4 × 30 + gaps = 126px still leaves the title 122px on desktop,
  // while 4 × 44 + gaps = 182px drops it to 66px on touch.
  test.describe('with a coarse pointer', () => {
    test.use({ hasTouch: true });

    test('still fits once the buttons grow to touch size', async ({
      page,
      request,
    }) => {
      await openSeededSpace(page, request, 'tch');

      // Guard the guard: if this emulation ever stopped setting the media query, every
      // assertion below would silently re-measure the desktop case.
      expect(
        await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
      ).toBe(true);

      await expectHeaderFits(page);
    });
  });

  test('re-orders as a message arrives, without reopening the space', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}live`;

    const { reader, spaceName, zulu, alpha, mike } = await seedOrderedSpace(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await openSpace(page, spaceName);
    await expect(roomNames(page)).toHaveText(
      [mike.name, zulu.name, alpha.name],
      {
        timeout: 30_000,
      },
    );

    // Sent over the API, never typed: neither RoomsService nor MixedRoomsService listens to
    // RoomEvent.Timeline, so a local echo would not reorder until the next /sync anyway.
    const sender = await apiLogin(
      request,
      hs,
      reader.user as string,
      reader.pass as string,
    );
    await sendMessage(request, hs, sender, alpha.roomId, `bump ${runId}`);

    await expect(roomNames(page)).toHaveText(
      [alpha.name, mike.name, zulu.name],
      { timeout: 30_000 },
    );
  });
});
