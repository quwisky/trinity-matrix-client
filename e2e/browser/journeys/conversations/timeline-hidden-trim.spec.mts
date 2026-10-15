import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// While the window is hidden, the open room's history is trimmed like a room nobody has
// open, but only while its view follows the newest message (#1366). This journey pages a
// busy room in completely, hides the window (the web host reads `visibilitychange`) for
// the release delay, and checks both halves of that rule: a room scrolled back keeps its
// history, and a room at its newest message is trimmed with its list unchanged, then
// pages the trimmed history back in from the server when scrolled up.
const session = homeserverSession();

const MESSAGE_COUNT = 300;
/** BackgroundMemoryRelease's delay, plus margin for the trim and the re-render. */
const RELEASE_WAIT_MS = 62_000;

interface Seeded {
  readonly reader: HomeserverSession;
  readonly roomName: string;
}

async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<Seeded> {
  const user = `trim-reader-${runId}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const headers = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json())
    .then((j) => ({ Authorization: `Bearer ${j.access_token}` }));
  const roomName = `Hidden trim E2E ${runId}`;
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${i}`,
      { headers, data: { msgtype: 'm.text', body: `trim message ${i}` } },
    );
  }
  return { reader: { available: true, hs, user, pass }, roomName };
}

/** Hide or show the window the way the web host sees it. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hide) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hide ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hide,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** The rows on screen and where they sit, relative to the scroller's top. */
function shownRows(scroll: Locator): Promise<string[]> {
  return scroll.evaluate((el) => {
    const view = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>('.msg[data-mid]')]
      .map((row) => ({ row, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > view.top && rect.top < view.bottom)
      .map(
        ({ row, rect }) =>
          `${row.getAttribute('data-mid')}@${Math.round(rect.top - view.top)}`,
      );
  });
}

/** Scroll to the top until the room's first message renders. */
async function pageToStart(scroll: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        await scroll.evaluate((el) => {
          el.scrollTop = 0;
          el.dispatchEvent(new Event('scroll'));
        });
        return scroll.getByText('trim message 0', { exact: true }).count();
      },
      { timeout: 90_000, intervals: [400] },
    )
    .toBeGreaterThan(0);
}

/** Keep scrolling to the top until no further history request goes out. */
async function drainHistory(
  scroll: Locator,
  requests: readonly string[],
): Promise<void> {
  let seen = -1;
  await expect
    .poll(
      async () => {
        await scroll.evaluate(async (el) => {
          el.scrollTop = 0;
          el.dispatchEvent(new Event('scroll'));
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        });
        const settled = requests.length === seen;
        seen = requests.length;
        return settled;
      },
      { timeout: 60_000, intervals: [0] },
    )
    .toBe(true);
}

/** The rows on screen once two looks a moment apart agree. */
async function settledRows(scroll: Locator): Promise<string[]> {
  let previous: string[] = [];
  await expect
    .poll(
      async () => {
        const now = await shownRows(scroll);
        const same = JSON.stringify(now) === JSON.stringify(previous);
        previous = now;
        return same;
      },
      { timeout: 15_000, intervals: [500] },
    )
    .toBe(true);
  return previous;
}

test.describe('Open room trimmed while the window is hidden', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('trims only a room at its newest message, keeps its list, and pages the history back in', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const runId = `${testResourceId('run')}h`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );
    const historyRequests: string[] = [];
    page.on('request', (req) => {
      if (/\/rooms\/[^/]+\/messages\?/.test(req.url())) {
        historyRequests.push(req.url());
      }
    });

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    const scroll = page.locator('.scroll');
    await expect(
      scroll.getByText(`trim message ${MESSAGE_COUNT - 1}`, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await pageToStart(scroll);
    await drainHistory(scroll, historyRequests);

    // Scrolled back: hidden past the release, the room keeps everything it paged in.
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByTestId('jump-to-latest')).toBeVisible();
    const reading = await settledRows(scroll);
    const readingHeight = await scroll.evaluate((el) => el.scrollHeight);
    await setHidden(page, true);
    await page.waitForTimeout(RELEASE_WAIT_MS);
    expect(await scroll.evaluate((el) => el.scrollHeight)).toBe(readingHeight);
    await setHidden(page, false);
    expect(await shownRows(scroll)).toEqual(reading);
    const requestsBefore = historyRequests.length;
    await pageToStart(scroll);
    expect(historyRequests.length).toBe(requestsBefore);

    // At the newest message: trimmed while hidden, and the list looks the same.
    await page.getByTestId('jump-to-latest').click();
    await expect
      .poll(() =>
        scroll.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(1);
    const newest = await settledRows(scroll);
    const fullHeight = await scroll.evaluate((el) => el.scrollHeight);
    expect(newest.length).toBeGreaterThan(0);

    await setHidden(page, true);
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollHeight), {
        timeout: RELEASE_WAIT_MS + 10_000,
        intervals: [1_000],
      })
      .toBeLessThan(fullHeight / 2);
    expect(await shownRows(scroll)).toEqual(newest);
    await setHidden(page, false);
    expect(await shownRows(scroll)).toEqual(newest);
    expect(
      await scroll.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    ).toBeLessThan(1);

    // Scrolling up fetches the trimmed history from the server again, back to the start.
    const requestsAfterTrim = historyRequests.length;
    await pageToStart(scroll);
    expect(historyRequests.length).toBeGreaterThan(requestsAfterTrim);
  });
});
