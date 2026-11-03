import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  passwordLogin,
  registerUser,
  type AccountSession,
} from '../../../support/account.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { createRoom } from '../../support/space-journey.mts';

/**
 * The open room is in the URL, so a room is linkable and survives a reload.
 *
 * This is the one property of #179's routing slice that no unit test can reach. The specs
 * around `RoomShellStore` prove the store follows `paramMap`, and `app.routes.spec.ts` proves
 * the two URL shapes are one reused route — but neither exercises a real address bar, a real
 * reload, or the service worker and Electron fallbacks that a dotted path would have broken.
 * The room segment is base64url precisely so those fallbacks need no exception; the assertion
 * that the URL contains no dot is what keeps that true.
 *
 * Needs a Synapse homeserver (Docker) and self-skips otherwise.
 */
const session = homeserverSession();

test.describe('The open room lives in the URL', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('is linkable, survives a reload, and Back returns to the list', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}url`;
    const user = `urlroom-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Linkable ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await createRoom(request, hs, { accessToken: token }, roomName);

    await login(page, { available: true, hs, user, pass } as HomeserverSession);

    // Workspace canonicalizes the login redirect to an exact Account coordinate.
    await expect
      .poll(() => new URL(page.url()).searchParams.get('account'))
      .toContain(`@${user}:`);
    await expect(page).toHaveURL(/\/rooms\?/);

    await openRoom(page, roomName);

    // Opening a room put it and its sidebar scope in the address bar.
    await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+\?/);
    const roomUrl = page.url();
    const roomLocation = new URL(roomUrl);
    expect(roomLocation.searchParams.get('account')).toContain(`@${user}:`);
    expect(roomLocation.searchParams.get('view')).toBe('rooms');

    // THE constraint the encoding exists for. A raw room id ends in a dotted server name,
    // which Angular's service worker excludes from the navigations it answers with index.html
    // (`!/**‍/*.*`) and which the Electron handler reads as a file extension. If this ever
    // contains a dot, a bookmarked room 404s on two hosts and no unit test notices.
    const segment = new URL(roomUrl).pathname.split('/').pop() ?? '';
    expect(segment).not.toMatch(/[.#:]/);
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);

    // A reload lands back in the same room rather than on the list. This is the whole point:
    // before this slice the room was page state and a refresh dropped it.
    await page.reload();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(roomUrl);

    // Compact/wide layout is placement, not a semantic destination or history entry.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page).toHaveURL(roomUrl);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page).toHaveURL(roomUrl);

    // And the room is a history entry, so Back closes it instead of leaving the shell —
    // which is what makes Android's hardware Back behave once it falls through to history.
    await page.goBack();
    await expect(page).toHaveURL((url) => {
      return (
        url.pathname === '/rooms' &&
        url.searchParams.get('account')?.includes(`@${user}:`) === true &&
        url.searchParams.get('view') === 'rooms'
      );
    });
    await expect(page.getByTestId('composer-input')).toBeHidden({
      timeout: 15_000,
    });

    // A Room this account has not synced stays in the URL and says so (#968), instead of
    // replacing the history entry with the list.
    const listUrl = new URL(page.url());
    const missingRoom = Buffer.from('!missing:example.org').toString(
      'base64url',
    );
    const missingUrl = new URL(listUrl);
    missingUrl.pathname = `/rooms/${missingRoom}`;
    await page.goto(missingUrl.toString());
    await expect(
      page.getByText("This room isn't available on this account yet."),
    ).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(`/rooms/${missingRoom}`);
    await expect(page.getByTestId('composer-input')).toBeHidden();

    // Mixed scope coordinates are malformed and canonicalize to Recent rather than
    // allowing two independent selections to leak into the Workspace.
    const malformedUrl = new URL(listUrl);
    malformedUrl.searchParams.set(
      'space',
      Buffer.from('!space:example.org').toString('base64url'),
    );
    await page.goto(malformedUrl.toString());
    await expect(page).toHaveURL((url) => {
      return (
        url.pathname === '/rooms' &&
        url.searchParams.get('account')?.includes(`@${user}:`) === true &&
        !url.searchParams.has('view') &&
        !url.searchParams.has('space')
      );
    });
  });

  test('gives every room panel a URL you can reload and share', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}pnl`;
    const user = `urlpanel-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Panels ${runId}`;

    await registerUser(request, user, pass);
    const account = await passwordLogin(request, hs, user, pass);
    const roomId = await createRoom(request, hs, account, roomName);
    const rootBody = `thread root ${runId}`;
    const rootId = await send(request, hs, account, roomId, { body: rootBody });
    await send(request, hs, account, roomId, {
      body: `thread reply ${runId}`,
      'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
    });
    await putState(request, hs, account, roomId, 'm.room.pinned_events', {
      pinned: [rootId],
    });

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await expect(page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+\?/);
    const roomUrl = page.url();
    const panelOf = () => {
      const query = new URL(page.url()).searchParams;
      return [query.get('panel'), query.get('root')];
    };

    const members = page.locator('.chat-members');
    const threads = page.getByRole('complementary', { name: 'Threads' });
    const thread = page.getByTestId('thread-view');
    const pinned = page.getByTestId('pinned-panel');
    const search = page.getByRole('complementary', { name: 'Search messages' });

    // Every opener names its panel in the URL, the roster's wide column included.
    await page.getByTestId('toggle-members').click();
    await expect(members).toBeVisible({ timeout: 10_000 });
    await expect.poll(panelOf).toEqual(['members', null]);
    await page.getByTestId('open-threads').click();
    await expect(threads).toBeVisible({ timeout: 10_000 });
    await expect.poll(panelOf).toEqual(['threads', null]);
    await threads.locator('.thread-item').first().click();
    await expect(thread).toContainText(`thread reply ${runId}`, {
      timeout: 15_000,
    });
    await expect.poll(panelOf).toEqual(['thread', rootId]);
    await page.getByTestId('open-pinned').click();
    await expect(pinned).toBeVisible({ timeout: 10_000 });
    await expect.poll(panelOf).toEqual(['pinned', null]);
    // The query is what the person typed, so it stays out of the URL and its history.
    await page.getByTestId('header-search').fill(`secret ${runId}`);
    await expect(search).toBeVisible({ timeout: 10_000 });
    await expect.poll(panelOf).toEqual(['search', null]);
    expect(page.url()).not.toContain('secret');

    // Closing a panel opened over the roster returns to the roster.
    await search.getByRole('button', { name: /^Close/ }).click();
    await expect(members).toBeVisible();
    await expect.poll(panelOf).toEqual(['members', null]);

    // A reload, or the same link opened fresh, restores each kind.
    const withPanel = (query: Record<string, string>) => {
      const url = new URL(roomUrl);
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
      return url.toString();
    };
    for (const [kind, panel] of [
      ['members', members],
      ['threads', threads],
      ['pinned', pinned],
      ['search', search],
    ] as const) {
      await page.goto(withPanel({ panel: kind }));
      await expect(panel).toBeVisible({ timeout: 30_000 });
    }
    const threadUrl = withPanel({ panel: 'thread', root: rootId });
    await page.goto(threadUrl);
    await page.reload();
    await expect(thread).toContainText(`thread reply ${runId}`, {
      timeout: 30_000,
    });
    expect(canonical(page.url())).toBe(canonical(threadUrl));

    // Moving to drawer width keeps the URL, and the panel shows as a drawer.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(thread).toBeVisible();
    expect(canonical(page.url())).toBe(canonical(threadUrl));
    await page.setViewportSize({ width: 1280, height: 800 });

    // A root that won't load lands on the Room, the URL corrected in place and no error.
    const unloadable = withPanel({
      panel: 'thread',
      root: `$missing-${runId}:example.org`,
    });
    await page.goto(unloadable);
    await expect(page).toHaveURL(same(roomUrl), { timeout: 30_000 });
    await expect(thread).toBeHidden();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByText('Could not load that message.')).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(same(threadUrl));

    // A deep link to a message, then a thread from its list: Back steps to the list, and
    // closing the thread closes the panel, as its close button did before it had a URL. The
    // link's `event` leaves the URL once a panel opens, and its row is still there after.
    const eventUrl = withPanel({ event: rootId });
    await page.goto(eventUrl);
    const rootRow = page.locator('.scroll .msg[data-mid]', {
      hasText: rootBody,
    });
    await expect(rootRow.first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('open-threads').click();
    await expect.poll(panelOf).toEqual(['threads', null]);
    expect(new URL(page.url()).searchParams.has('event')).toBe(false);
    await threads.locator('.thread-item').first().click();
    await expect.poll(panelOf).toEqual(['thread', rootId]);
    await page.goBack();
    await expect(threads).toBeVisible();
    await expect.poll(panelOf).toEqual(['threads', null]);
    await threads.locator('.thread-item').first().click();
    await expect(thread).toBeVisible();
    await thread.getByRole('button', { name: 'Close thread' }).click();
    await expect(thread).toBeHidden();
    await expect(threads).toBeHidden();
    await expect.poll(panelOf).toEqual([null, null]);
    await expect(rootRow.first()).toBeInViewport({ timeout: 15_000 });

    // A thread in a Room this Account hasn't synced says so, as the room link does, and the
    // URL drops the panel it cannot show.
    const missingRoom = new URL(roomUrl);
    missingRoom.pathname = `/rooms/${Buffer.from('!missing:example.org').toString('base64url')}`;
    const missingRoomUrl = missingRoom.toString();
    missingRoom.searchParams.set('panel', 'thread');
    missingRoom.searchParams.set('root', rootId);
    await page.goto(missingRoom.toString());
    await expect(
      page.getByText("This room isn't available on this account yet."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(same(missingRoomUrl));

    // A panel link naming an Account not signed in here ends where its room link does.
    const foreign = new URL(roomUrl);
    foreign.searchParams.set(
      'account',
      `@stranger-${runId}:${account.userId.split(':').slice(1).join(':')}`,
    );
    // Today a room link for another Account lands on this Account's list.
    const outcome = async (url: string) => {
      await page.goto(url);
      await expect(page.getByTestId('chat-empty')).toBeVisible({
        timeout: 30_000,
      });
      return canonical(page.url());
    };
    const roomLanding = await outcome(foreign.toString());
    foreign.searchParams.set('panel', 'members');
    expect(await outcome(foreign.toString())).toBe(roomLanding);
    await expect(page.getByText(/Unable to open/)).toHaveCount(0);
  });
});

/** A URL's path and query, whatever percent-encoding wrote it. */
function canonical(url: string | URL): string {
  const parsed = new URL(url);
  return `${parsed.pathname}?${[...parsed.searchParams].sort().join('&')}`;
}

function same(expected: string): (url: URL) => boolean {
  return (url) => canonical(url) === canonical(expected);
}

async function send(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
  roomId: string,
  content: Record<string, unknown>,
): Promise<string> {
  const txn = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    {
      headers: { Authorization: `Bearer ${account.accessToken}` },
      data: { msgtype: 'm.text', ...content },
    },
  );
  expect(res.ok()).toBe(true);
  return (await res.json()).event_id as string;
}

async function putState(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
  roomId: string,
  type: string,
  content: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/`,
    {
      headers: { Authorization: `Bearer ${account.accessToken}` },
      data: content,
    },
  );
  expect(res.ok()).toBe(true);
}
