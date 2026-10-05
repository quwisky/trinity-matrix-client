import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser, passwordLogin } from '../../../support/account.mts';
import { openNamedRoom } from '../../../support/message-composer.mts';

// Truthful timeline loading states (#545): a skeleton only while a Room is really loading,
// an inline error with Retry when backfill fails, and "No messages yet." only once settled.
// Needs Synapse (Docker).
const session = homeserverSession();

/** Records whether a skeleton was EVER attached, so "never flashed" is provable. */
async function watchSkeleton(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __skeletonSeen: boolean };
    w.__skeletonSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="timeline-skeleton"]')) {
        w.__skeletonSeen = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
}
const skeletonSeen = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __skeletonSeen: boolean }).__skeletonSeen,
  );

/** Strip these Rooms' timelines from /sync so the client must backfill via /messages. */
async function forceBackfill(
  page: Page,
  roomIds: readonly string[],
): Promise<void> {
  await page.route('**/_matrix/client/**/sync*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const roomId of roomIds) {
      const timeline = body?.rooms?.join?.[roomId]?.timeline;
      if (timeline) {
        timeline.events = [];
        timeline.limited = true;
      }
    }
    await route.fulfill({ response, json: body });
  });
}

/** Intercept /messages for these Rooms only: per-Room delay, optional first-request 500. */
async function routeMessages(
  page: Page,
  rooms: Record<string, { delayMs?: number; failFirst?: boolean }>,
): Promise<void> {
  const failed = new Set<string>();
  await page.route('**/rooms/*/messages*', async (route) => {
    const url = decodeURIComponent(route.request().url());
    const roomId = Object.keys(rooms).find((id) =>
      url.includes(`/rooms/${id}/`),
    );
    if (!roomId) return route.continue();
    const { delayMs = 0, failFirst = false } = rooms[roomId];
    if (failFirst && !failed.has(roomId)) {
      failed.add(roomId);
      return route.fulfill({ status: 500, json: { errcode: 'M_UNKNOWN' } });
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.continue();
  });
}

/** Flags any rendered message text containing one of `bodies` (a leak from another Room). */
async function watchLeaks(
  page: Page,
  bodies: readonly string[],
): Promise<void> {
  await page.addInitScript((forbidden) => {
    const w = window as unknown as { __leaked: boolean };
    w.__leaked = false;
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.msg__text')) {
        if (forbidden.some((b) => el.textContent?.includes(b)))
          w.__leaked = true;
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, bodies);
}

interface Fixture {
  hs: string;
  me: HomeserverSession;
  headers: { Authorization: string };
  runId: string;
}

async function newUser(request: APIRequestContext): Promise<Fixture> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}tl`;
  const user = `tl-${runId}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const { accessToken } = await passwordLogin(request, hs, user, pass);
  return {
    hs,
    me: { available: true, hs, user, pass } as HomeserverSession,
    headers: { Authorization: `Bearer ${accessToken}` },
    runId,
  };
}

let txn = 0;

async function seedRoom(
  request: APIRequestContext,
  f: Fixture,
  name: string,
  bodies: readonly string[],
): Promise<string> {
  const { room_id } = await request
    .post(`${f.hs}/_matrix/client/v3/createRoom`, {
      headers: f.headers,
      data: { name, preset: 'private_chat' },
    })
    .then((r) => r.json());
  for (const body of bodies) {
    await request.put(
      `${f.hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${f.runId}-${txn++}`,
      { headers: f.headers, data: { msgtype: 'm.text', body } },
    );
  }
  return room_id as string;
}

const messages = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${tag} message ${i + 1}`);

test.describe('Timeline loading states', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  // Held /sync long-polls would otherwise outlive the test and error inside the route.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('populated room shows no skeleton', async ({ page, request }) => {
    const f = await newUser(request);
    const name = `Populated ${f.runId}`;
    const bodies = messages(`pop ${f.runId}`, 5);
    await seedRoom(request, f, name, bodies);
    await watchSkeleton(page);
    await login(page, f.me);
    await openNamedRoom(page, name);
    await expect(
      page.locator('.msg__text', { hasText: bodies[4] }),
    ).toBeVisible({ timeout: 30_000 });
    expect(await skeletonSeen(page)).toBe(false);
    await page.getByTestId('composer-input').fill('hello');
    await expect(page.getByTestId('composer-send')).toBeEnabled();
  });

  test('ready empty room never shows a skeleton', async ({ page, request }) => {
    const f = await newUser(request);
    const name = `Empty ${f.runId}`;
    await seedRoom(request, f, name, []);
    await watchSkeleton(page);
    await login(page, f.me);
    await openNamedRoom(page, name);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    // A created Room is never truly empty (the server seeds state events), so settled
    // means its creation row renders instead of a skeleton.
    await expect(page.getByText('created the room')).toBeVisible({
      timeout: 15_000,
    });
    expect(await skeletonSeen(page)).toBe(false);
  });

  test('delayed backfill shows the skeleton, then content', async ({
    page,
    request,
  }) => {
    const f = await newUser(request);
    const name = `Delayed ${f.runId}`;
    const bodies = messages(`del ${f.runId}`, 3);
    const roomId = await seedRoom(request, f, name, bodies);
    await watchSkeleton(page);
    await forceBackfill(page, [roomId]);
    await routeMessages(page, { [roomId]: { delayMs: 1500 } });
    await login(page, f.me);
    await openNamedRoom(page, name);
    await expect(page.getByTestId('timeline-skeleton')).toBeVisible();
    await page.getByTestId('composer-input').fill('typing while loading');
    await expect(page.getByTestId('composer-send')).toBeDisabled();
    await expect(
      page.locator('.msg__text', { hasText: bodies[2] }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('timeline-skeleton')).toBeHidden();
    // Control: proves the watcher used by journeys 1, 2 and 5 can detect a skeleton.
    expect(await skeletonSeen(page)).toBe(true);
  });

  test('backfill error, then Retry', async ({ page, request }) => {
    const f = await newUser(request);
    const name = `Errored ${f.runId}`;
    const bodies = messages(`err ${f.runId}`, 3);
    const roomId = await seedRoom(request, f, name, bodies);
    await forceBackfill(page, [roomId]);
    await routeMessages(page, { [roomId]: { failFirst: true } });
    await login(page, f.me);
    await openNamedRoom(page, name);
    await expect(page.getByTestId('timeline-load-error')).toContainText(
      "Couldn't load messages.",
      { timeout: 30_000 },
    );
    await page.getByTestId('timeline-load-retry').click();
    await expect(
      page.locator('.msg__text', { hasText: bodies[2] }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('timeline-load-error')).toBeHidden();
  });

  // Brief expected a skeleton here. Measured instead: a reload hydrates the Room from the
  // client cache (ready, so no skeleton), and a fresh context redirects an unknown Room URL
  // to /rooms while "Connecting…" (no timeline mounted at all). See the task report.
  test('reload on a room URL before sync keeps cached content, no false state', async ({
    page,
    request,
  }) => {
    const f = await newUser(request);
    const name = `Reload ${f.runId}`;
    const bodies = messages(`rel ${f.runId}`, 1);
    await seedRoom(request, f, name, bodies);
    await watchSkeleton(page);
    await login(page, f.me);
    await openNamedRoom(page, name);
    const message = page.locator('.msg__text', { hasText: bodies[0] });
    await expect(message).toBeVisible({ timeout: 30_000 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/_matrix/client/**/sync*', async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload();

    // With /sync held the Room is served from cache: content, never a skeleton or a
    // false "No messages yet.".
    await expect(message).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('No messages yet.')).toBeHidden();
    expect(await skeletonSeen(page)).toBe(false);
    release();
    await expect(message).toBeVisible();
    await expect(page.getByTestId('timeline-skeleton')).toBeHidden();
  });

  test('rapid switching ends on the right room', async ({ page, request }) => {
    const f = await newUser(request);
    const names = ['A', 'B', 'C'].map((l) => `Switch${l} ${f.runId}`);
    const bodies = ['A', 'B', 'C'].map((l) => `switch ${l} ${f.runId}`);
    const ids: string[] = [];
    for (const [i, n] of names.entries()) {
      ids.push(await seedRoom(request, f, n, [bodies[i]]));
    }
    await forceBackfill(page, ids);
    await routeMessages(page, {
      [ids[0]]: { delayMs: 800 },
      [ids[1]]: { delayMs: 800 },
      [ids[2]]: { delayMs: 2500 },
    });
    await watchLeaks(page, [bodies[0], bodies[1]]);
    await login(page, f.me);
    await page.getByTestId('rail-rooms').click();
    for (const n of names) {
      await page
        .locator('.channel', { hasText: n })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    }
    for (const n of names) {
      await page.locator('.channel', { hasText: n }).first().click();
    }
    await expect(
      page.locator('.msg__text', { hasText: bodies[2] }),
    ).toBeVisible({ timeout: 30_000 });
    // A's and B's responses (800 ms) landed while C (2500 ms) was focused; none may render.
    await page.waitForTimeout(1500);
    expect(
      await page.evaluate(
        () => (window as unknown as { __leaked: boolean }).__leaked,
      ),
    ).toBe(false);
    await expect(
      page.locator('.msg__text', { hasText: bodies[2] }),
    ).toBeVisible();
  });
});
