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
import { createRoom } from '../../support/space-journey.mts';

// While the window is hidden, the open room's history is trimmed like a room nobody has
// open, but only while its view follows the newest message (#1366). These journeys page a
// busy room in completely and hide the window (the web host reads `visibilitychange`) for
// the release delay. The first checks both halves of the rule: a room scrolled back keeps
// its history, and a room at its newest message is trimmed at the release with its list
// unchanged, then pages the trimmed history back in when scrolled up. The second trims
// after a sync and checks that the rows on screen, captured before the trim, are the same
// after it and when the window is shown. The third checks that a reply's quote of an old
// message and the "New messages" divider are still there when the window is shown.
//
// Rendering continues while "hidden" here, as on the desktop shell (`backgroundThrottling`
// off); a really hidden web tab stops measuring rows, which the unit tests cover.
const session = homeserverSession();

const MESSAGE_COUNT = 300;
/** BackgroundMemoryRelease's delay, plus margin for the trim and the re-render. */
const RELEASE_WAIT_MS = 62_000;

interface ApiUser {
  readonly session: HomeserverSession;
  readonly userId: string;
  readonly accessToken: string;
  readonly headers: Record<string, string>;
}

/** A throwaway account, signed in over the CS API. */
async function apiUser(
  request: APIRequestContext,
  hs: string,
  user: string,
): Promise<ApiUser> {
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    session: { available: true, hs, user, pass },
    userId: json.user_id as string,
    accessToken: json.access_token as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/** Send `content` as `sender`; returns the event id. */
async function send(
  request: APIRequestContext,
  hs: string,
  sender: ApiUser,
  roomId: string,
  txn: string,
  content: Record<string, unknown>,
  type = 'm.room.message',
): Promise<string> {
  return request
    .put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/${txn}`,
      { headers: sender.headers, data: content },
    )
    .then((r) => r.json())
    .then((j) => j.event_id as string);
}

const text = (body: string) => ({ msgtype: 'm.text', body });

/** A room the reader owns and a second member writes in. */
async function sharedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
  name: string,
): Promise<{ reader: ApiUser; writer: ApiUser; roomId: string }> {
  const reader = await apiUser(request, hs, `trim-owner-${runId}`);
  const writer = await apiUser(request, hs, `trim-writer-${runId}`);
  const roomId = await createRoom(request, hs, reader, name);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
    { headers: reader.headers, data: { user_id: writer.userId } },
  );
  await request.post(
    `${hs}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    { headers: writer.headers, data: {} },
  );
  return { reader, writer, roomId };
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

/** Scroll to the newest message (the jump-to-latest button gives way to jump-to-unread). */
async function toNewest(scroll: Locator): Promise<void> {
  await expect
    .poll(() =>
      scroll.evaluate(async (el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return el.scrollHeight - el.scrollTop - el.clientHeight;
      }),
    )
    .toBeLessThan(1);
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
    const hs = session.hs as string;
    const owner = await apiUser(request, hs, `trim-reader-${runId}`);
    const roomName = `Hidden trim E2E ${runId}`;
    const roomId = await createRoom(request, hs, owner, roomName);
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      await send(
        request,
        hs,
        owner,
        roomId,
        `${runId}-${i}`,
        text(`trim message ${i}`),
      );
    }
    const reader = owner.session;
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

  test('trims after a sync without changing the rows on screen', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    // A window tall enough to show more than the 50 latest events a trim keeps anyway, so
    // what the list reports for its view decides where the cut lands, just above the
    // screen: a view report that named too little would lose rows on screen.
    await page.setViewportSize({ width: 1280, height: 3000 });
    const runId = `${testResourceId('run')}v`;
    const hs = session.hs as string;
    const roomName = `Hidden view trim E2E ${runId}`;
    const { reader, writer, roomId } = await sharedRoom(
      request,
      hs,
      runId,
      roomName,
    );
    // Just under the high-water mark once the room's state events and the writer's
    // messages below are counted.
    const OWN = 175;
    let lastOwn = '';
    for (let i = 0; i < OWN; i++) {
      lastOwn = await send(
        request,
        hs,
        reader,
        roomId,
        `${runId}-${i}`,
        text(`trim message ${i}`),
      );
    }
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      {
        headers: reader.headers,
        data: { 'm.fully_read': lastOwn, 'm.read': lastOwn },
      },
    );
    const historyRequests: string[] = [];
    page.on('request', (req) => {
      if (/\/rooms\/[^/]+\/messages\?/.test(req.url())) {
        historyRequests.push(req.url());
      }
    });

    await login(page, reader.session);
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    const scroll = page.locator('.scroll');
    await expect(
      scroll.getByText(`trim message ${OWN - 1}`, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await pageToStart(scroll);
    await drainHistory(scroll, historyRequests);
    await toNewest(scroll);
    await settledRows(scroll);

    // Hidden past the release; under the high-water mark, nothing is trimmed yet.
    await setHidden(page, true);
    await page.waitForTimeout(RELEASE_WAIT_MS);
    for (let i = 0; i < 10; i++) {
      await send(
        request,
        hs,
        writer,
        roomId,
        `${runId}-w${i}`,
        text(`writer message ${i}`),
      );
    }
    await expect(
      scroll.getByText('writer message 9', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const before = await settledRows(scroll);
    const heightBefore = await scroll.evaluate((el) => el.scrollHeight);

    // Events the list does not render take the room past the high-water mark, and the
    // sync that brings them trims it: the rows above the screen go, those on it stay.
    for (let i = 0; i < 12; i++) {
      await send(
        request,
        hs,
        writer,
        roomId,
        `${runId}-p${i}`,
        { n: i },
        'org.trinity.e2e.ping',
      );
    }
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollHeight), {
        timeout: 30_000,
      })
      .toBeLessThan(heightBefore);
    expect(await settledRows(scroll)).toEqual(before);

    await setHidden(page, false);
    expect(await shownRows(scroll)).toEqual(before);
    expect(
      await scroll.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    ).toBeLessThan(1);
    await expect(page.getByTestId('new-messages-divider')).toBeVisible();

    const requestsAfterTrim = historyRequests.length;
    await pageToStart(scroll);
    expect(historyRequests.length).toBeGreaterThan(requestsAfterTrim);
  });

  test('keeps a quoted message and the unread divider when trimmed after a sync', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const runId = `${testResourceId('run')}s`;
    const hs = session.hs as string;
    const reader = await apiUser(request, hs, `trim-owner-${runId}`);
    const writer = await apiUser(request, hs, `trim-writer-${runId}`);
    const roomName = `Hidden sync trim E2E ${runId}`;
    const roomId = await createRoom(request, hs, reader, roomName);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { headers: reader.headers, data: { user_id: writer.userId } },
    );
    await request.post(
      `${hs}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { headers: writer.headers, data: {} },
    );
    // Just under the high-water mark once the room's state events are counted.
    const OWN = 185;
    let quoted = '';
    let readUpTo = '';
    for (let i = 0; i < OWN; i++) {
      if (i === 121) {
        await send(
          request,
          hs,
          writer,
          roomId,
          `${runId}-early`,
          text('early writer message'),
        );
      }
      const eventId = await send(
        request,
        hs,
        reader,
        roomId,
        `${runId}-${i}`,
        text(`trim message ${i}`),
      );
      if (i === 60) quoted = eventId;
      if (i === 120) readUpTo = eventId;
    }
    // Read up to here: the writer's message after it is where the divider is drawn.
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      {
        headers: reader.headers,
        data: { 'm.fully_read': readUpTo, 'm.read': readUpTo },
      },
    );
    const historyRequests: string[] = [];
    page.on('request', (req) => {
      if (/\/rooms\/[^/]+\/messages\?/.test(req.url())) {
        historyRequests.push(req.url());
      }
    });

    await login(page, reader.session);
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    const scroll = page.locator('.scroll');
    await expect(
      scroll.getByText(`trim message ${OWN - 1}`, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await pageToStart(scroll);
    await drainHistory(scroll, historyRequests);
    await toNewest(scroll);
    await settledRows(scroll);

    // Hidden past the release: under the high-water mark, nothing is trimmed yet.
    await setHidden(page, true);
    await page.waitForTimeout(RELEASE_WAIT_MS);

    // Someone replies to one of the reader's messages from well before the read marker,
    // and the reply is on screen with its quote. A few more messages take the room past
    // the high-water mark, and the sync that does trims it, with the reply still on screen.
    await send(request, hs, writer, roomId, `${runId}-reply`, {
      ...text('> <@x:hs> trim message 60\n\nreplying to an old one'),
      'm.relates_to': { 'm.in_reply_to': { event_id: quoted } },
    });
    await expect(
      scroll.locator('trn-message-reply-preview', {
        hasText: 'trim message 60',
      }),
    ).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < 8; i++) {
      await send(
        request,
        hs,
        writer,
        roomId,
        `${runId}-w${i}`,
        text(`writer message ${i}`),
      );
    }
    await expect(
      scroll.getByText('writer message 7', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const hidden = await settledRows(scroll);

    await setHidden(page, false);
    expect(await shownRows(scroll)).toEqual(hidden);
    expect(
      await scroll.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    ).toBeLessThan(1);
    // The reply still quotes the old message.
    await expect(
      scroll.locator('trn-message-reply-preview', {
        hasText: 'trim message 60',
      }),
    ).toBeVisible();
    // The "New messages" divider is still where it was drawn, off screen above.
    const jumpToUnread = page.getByTestId('jump-to-unread');
    await expect(jumpToUnread).toBeVisible();
    await jumpToUnread.click();
    await expect(page.getByTestId('new-messages-divider')).toBeVisible();

    // The room was trimmed after a sync: what it had paged in is fetched again.
    const requestsAfterTrim = historyRequests.length;
    await pageToStart(scroll);
    expect(historyRequests.length).toBeGreaterThan(requestsAfterTrim);
  });
});
