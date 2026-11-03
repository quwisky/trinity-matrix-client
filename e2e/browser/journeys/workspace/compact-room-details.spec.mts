import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import { devices } from '@playwright/test';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import {
  registerUser,
  apiLogin,
  type ApiUser,
} from '../../../support/account.mts';
import { createRoom } from '../../support/space-journey.mts';

// End-to-end for the mobile (narrow-viewport) room navigation the desktop specs
// never exercise, since the shared config runs at Desktop Chrome (1280px):
//  - the room header collapses its secondary actions (Invite / Room settings /
//    Pinned / Members) into an overflow (⋮) menu below the md breakpoint, keeping
//    only Search + Threads inline (rooms.page.html);
//  - the member list, a static column at or above the `members` breakpoint, becomes
//    a slide-in drawer with a
//    dismissing backdrop below that, opened from the overflow menu and closed by the
//    backdrop or by selecting a member.
// Runs at a phone viewport so the width-based breakpoints (max-md / max-members /
// matchMedia) engage. Drives a real Synapse room with a second member; self-skips
// without Docker like the other authenticated web specs.
const session = homeserverSession();

// A phone viewport: below md (768) so the header uses the kebab, and below the
// `members` breakpoint (1100) so
// the member list is a drawer.
test.use({ ...devices['Pixel 5'] });

/** Give a user a stable display name so a member row can be matched by name. */
async function setDisplayName(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  name: string,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(actor.userId)}/displayname`,
    { headers: actor.headers, data: { displayname: name } },
  );
}

/**
 * Register a reader plus one extra member, have the reader create a plain (non-DM)
 * room inviting the extra, and have the extra join — a synced two-member room the
 * reader can open from their list.
 */
async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: HomeserverSession;
  roomName: string;
  buddyName: string;
  roomId: string;
}> {
  const readerUser = `mob-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  const buddyUser = `mob-buddy-${runId}`;
  const buddyPass = `${buddyUser}-pass`;
  await registerUser(request, buddyUser, buddyPass);
  const buddy = await apiLogin(request, hs, buddyUser, buddyPass);
  const buddyName = `Mobile Buddy ${runId}`;
  await setDisplayName(request, hs, buddy, buddyName);

  const roomName = `Mobile E2E ${runId}`;
  const roomId = await createRoom(request, hs, reader, roomName, {
    invite: [buddy.userId],
  });
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: buddy.headers },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    buddyName,
    roomId,
  };
}

/** Open the seeded room on the narrow layout: the room list is the mobile home page,
 * so pick the Rooms rail then the room — selecting it switches to the chat page. */
async function openRoomMobile(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click(); // switches from the list page to the chat page
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

/** Open the room-header overflow (⋮) menu. */
async function openOverflowMenu(page: Page): Promise<void> {
  await page.getByTestId('room-actions-overflow').click();
}

test.describe('Mobile room navigation', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('collapses the room header actions into an overflow menu', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}k`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoomMobile(page, roomName);

    // Primary actions stay inline; the secondary ones are demoted (max-md:hidden).
    await expect(page.getByTestId('search-messages')).toBeVisible();
    await expect(page.getByTestId('open-threads')).toBeVisible();
    await expect(page.getByTestId('open-pinned')).toBeHidden();
    await expect(page.getByTestId('toggle-members')).toBeHidden();

    // The overflow kebab is present and reveals the demoted actions.
    await expect(page.getByTestId('room-actions-overflow')).toBeVisible();
    await openOverflowMenu(page);
    await expect(page.getByTestId('overflow-invite-people')).toBeVisible();
    await expect(page.getByTestId('overflow-open-room-settings')).toBeVisible();
    await expect(page.getByTestId('overflow-open-pinned')).toBeVisible();
    await expect(page.getByTestId('overflow-toggle-members')).toBeVisible();
  });

  test('opens room details from the room title', async ({ page, request }) => {
    const runId = `${testResourceId('run')}t`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoomMobile(page, roomName);

    const title = page
      .getByRole('heading', { level: 1 })
      .getByRole('button', { name: roomName });
    const box = await title.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await title.click();
    await expect(
      page.getByRole('dialog', { name: 'Room settings' }),
    ).toBeVisible();
  });

  test('opens the member list as a dismissible drawer between md and the members breakpoint', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}d`;
    const { reader, roomName, buddyName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    // Below md the roster is a page instead; see the phone pages below.
    await page.setViewportSize({ width: 800, height: 900 });
    await login(page, reader);
    await page.locator('.channel', { hasText: roomName }).first().click();
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

    // The member list is not shown on the narrow layout by default.
    await expect(page.locator('.chat-members')).toBeHidden();

    // Opening it from the header shows a drawer plus a backdrop.
    await page.getByTestId('toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();
    await expect(page.getByTestId('member-filter')).toBeFocused();
    await expect(page.getByTestId('members-backdrop')).toBeVisible();
    // Both the reader and the buddy have synced into the list.
    await expect(page.locator('.members .member')).toHaveCount(2, {
      timeout: 20_000,
    });

    // Tapping the backdrop dismisses the drawer — near its top-left corner, deliberately: the
    // backdrop is `inset-0`, so a click at its centre could land on the drawer over it.
    await page
      .getByTestId('members-backdrop')
      .click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.chat-members')).toBeHidden();

    // Reopen and pick the buddy: member info opens over the drawer, which stays open under
    // it, and closing it goes back to the drawer (#1041).
    await page.getByTestId('toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();
    await page.locator('.members .member', { hasText: buddyName }).click();
    const memberInfo = page.getByRole('dialog', { name: 'Member info' });
    await expect(memberInfo.getByTestId('member-info')).toBeVisible();
    await expect(page.locator('.chat-members')).toBeVisible();
    await memberInfo.getByTestId('member-info-close').click();
    await expect(memberInfo).toBeHidden();
    await expect(page.locator('.chat-members')).toBeVisible();
  });

  test('Escape dismisses the member drawer, and only when it is open', async ({
    page,
    request,
  }) => {
    // The drawer's backdrop is mouse-only, so Escape is the keyboard path to dismissing
    // it — and it had no coverage of any kind: it is reachable only through a `host`
    // binding, which the unit spec cannot drive because it never renders the page.
    const runId = `${testResourceId('run')}e`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoomMobile(page, roomName);

    await openOverflowMenu(page);
    await page.getByTestId('overflow-toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.chat-members')).toBeHidden();
    await expect(page.getByTestId('members-backdrop')).toBeHidden();

    // Deliberately NOT asserting that a second Escape "does nothing" here. On this
    // viewport the drawer is already closed, so an unguarded handler would call
    // closeMembers() on a closed drawer and look identical — the assertion could not
    // fail. The guard is pinned on the wide layout below, where it is observable.
  });

  test('Escape leaves the wide layout member column alone', async ({
    page,
    request,
  }) => {
    // This is the half that pins the document-Escape guard. Above the `members`
    // breakpoint the explicitly opened member list is a static column, so Escape belongs
    // to the focused editor rather than closing the column.
    const runId = `${testResourceId('run')}w`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, reader);

    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.locator('.chat-members')).toBeHidden();
    await page.getByTestId('toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator('.chat-members')).toBeVisible();
  });

  test('keeps the roster in the URL while temporary surfaces and widths change', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}l`;
    const { reader, roomName } = await seedRoom(request, hs, runId);
    const actor = await apiLogin(
      request,
      hs,
      reader.user as string,
      reader.pass as string,
    );
    const otherRoomName = `Mobile Other ${runId}`;
    await createRoom(request, hs, actor, otherRoomName);

    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, reader);
    const firstRoom = page.locator('.channel', { hasText: roomName }).first();
    await firstRoom.waitFor({ state: 'visible', timeout: 30_000 });
    await firstRoom.click();

    const members = page.locator('.chat-members');
    const toggle = page.getByTestId('toggle-members');
    await expect(members).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(members).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toBeFocused();

    await page.getByTestId('open-threads').click();
    await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
    await expect(members).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await page.setViewportSize(devices['Pixel 5'].viewport);
    await expect(page.getByRole('heading', { name: 'Threads' })).toBeVisible();
    // At phone width the threads are a page, closed by its Back button.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    // The roster the threads opened over is still the URL's, so it returns as the drawer.
    await expect(members).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(members).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // The open roster follows into the Account's next Room, and a closed one stays closed.
    const otherRoom = page
      .locator('.channel', { hasText: otherRoomName })
      .first();
    await otherRoom.waitFor({ state: 'visible', timeout: 30_000 });
    await otherRoom.click();
    await expect(members).toBeVisible();
    await expect(page).toHaveURL(/panel=members/);

    await toggle.click();
    await expect(members).toBeHidden();
    await firstRoom.click();
    await expect(members).toBeHidden();
  });
});

/** Post one message as `actor`; returns its event id. */
async function send(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  roomId: string,
  content: Record<string, unknown>,
): Promise<string> {
  const txn = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
    { headers: actor.headers, data: { msgtype: 'm.text', ...content } },
  );
  expect(res.ok()).toBe(true);
  return (await res.json()).event_id as string;
}

/** The panel has settled over the whole conversation pane, its header and composer included. */
async function expectPage(page: Page, panel: Locator): Promise<void> {
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const rounded = async (target: Locator) =>
    Object.values((await target.boundingBox())!).map(Math.round);
  const main = await rounded(page.locator('main.main'));
  expect(main[2]).toBe(page.viewportSize()!.width);
  // Polled: the page lands as the panel renders.
  await expect.poll(() => rounded(panel)).toEqual(main);
  await expect(page.locator('trn-room-header')).toHaveAttribute('inert', '');
  await expect(page.locator('trn-message-list')).toHaveAttribute('inert', '');
  await expect(page.getByTestId('members-backdrop')).toBeHidden();
  // The way out leads the header as a Back button, as on the room page itself: first on
  // screen and first in reading and focus order.
  const back = panel
    .locator('trn-side-panel-header')
    .getByRole('button', { name: 'Back', exact: true });
  const title = panel.locator('trn-side-panel-header h2');
  expect((await back.boundingBox())!.x).toBeLessThan(
    (await title.boundingBox())!.x,
  );
  expect(
    await back.evaluate(
      (button) =>
        !!(
          button.compareDocumentPosition(
            button.closest('trn-side-panel-header')!.querySelector('h2')!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(true);
  // The opener went inert under the page, so focus moves into it.
  await expect
    .poll(() =>
      panel.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await expect(page.locator('[data-shell-root]')).not.toHaveAttribute(
    'data-panel-slide',
  );
  // Arriving with the room's own slide, the page rides it, and it does not slide in again
  // once that slide has ended.
  expect(
    await page.evaluate(async () => {
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      const workspace = document.querySelector('.rooms-workspace')!;
      const surface = document.querySelector(
        '[data-right-panel-surface]',
      ) as HTMLElement;
      workspace.setAttribute('data-pane-slide', 'open');
      await frame();
      const during = surface.getAnimations().length;
      workspace.removeAttribute('data-pane-slide');
      await frame();
      await frame();
      return [during, surface.getAnimations().length];
    }),
  ).toEqual([0, 0]);
}

/**
 * Record each panel-page slide as it starts: its direction, and the duration of the page's
 * own slide animation then (-1 when the page has none).
 */
async function watchPanelSlides(
  page: Page,
): Promise<() => Promise<[string, number][]>> {
  await page.evaluate(() => {
    const root = document.querySelector('[data-shell-root]')!;
    const seen: [string, number][] = [];
    Object.assign(window, { panelSlides: seen });
    new MutationObserver(() => {
      const slide = root.getAttribute('data-panel-slide');
      if (!slide) return;
      const keyframes = slide === 'open' ? 'pane-over-in' : 'pane-over-out';
      const run = root
        .querySelector('[data-right-panel-surface]')
        ?.getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSAnimation &&
            animation.animationName.endsWith(keyframes),
        );
      seen.push([
        slide,
        run ? Number(run.effect!.getComputedTiming().duration) : -1,
      ]);
    }).observe(root, {
      attributes: true,
      attributeFilter: ['data-panel-slide'],
    });
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { panelSlides: [string, number][] }).panelSlides,
    );
}

/**
 * A resize starts no slide: two frames on, well inside a slide's length, there is no slide
 * attribute and nothing on the page or the room is moving. Not waiting for a slide to clear,
 * which would hide one that started.
 */
async function expectNoSlideStarted(page: Page): Promise<void> {
  expect(
    await page.evaluate(async () => {
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      await frame();
      await frame();
      return {
        slide: document
          .querySelector('[data-shell-root]')!
          .getAttribute('data-panel-slide'),
        moving: [
          ...document.querySelectorAll(
            '[data-right-panel-surface], .main > *, .chat-body > *',
          ),
        ].flatMap((element) =>
          element.getAnimations().map((a) => (a as CSSAnimation).animationName),
        ),
      };
    }),
  ).toEqual({ slide: null, moving: [] });
}

/** Two frames after the slide has cleared, nothing on the page or the room is still moving. */
async function expectSettled(page: Page): Promise<void> {
  await expect(page.locator('[data-shell-root]')).not.toHaveAttribute(
    'data-panel-slide',
  );
  expect(
    await page.evaluate(async () => {
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      await frame();
      await frame();
      return [
        ...document.querySelectorAll(
          '[data-right-panel-surface], .main > *, .chat-body > *',
        ),
      ].flatMap((element) =>
        element.getAnimations().map((a) => (a as CSSAnimation).animationName),
      );
    }),
  ).toEqual([]);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 600, height: 900 },
]) {
  test.describe(`Room panels as pages at ${viewport.width}px`, () => {
    test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
    test.use({ viewport });

    test('opens every panel over the whole room, and Back returns to it as it was', async ({
      page,
      request,
    }) => {
      const hs = session.hs as string;
      const runId = `${testResourceId('run')}p${viewport.width}`;
      const { reader, roomName, roomId } = await seedRoom(request, hs, runId);
      const actor = await apiLogin(
        request,
        hs,
        reader.user as string,
        reader.pass as string,
      );
      // Enough history to scroll, so the timeline's position is something to keep.
      for (let line = 0; line < 30; line++) {
        await send(request, hs, actor, roomId, { body: `history ${line}` });
      }
      const rootId = await send(request, hs, actor, roomId, {
        body: `thread root ${runId}`,
      });
      await send(request, hs, actor, roomId, {
        body: `thread reply ${runId}`,
        'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
      });

      await login(page, reader);
      await openRoomMobile(page, roomName);

      const composer = page.getByTestId('composer-input');
      await composer.fill(`half typed ${runId}`);
      const scroller = page.locator('.scroll').first();
      await expect(
        page.locator('.scroll .msg[data-mid]', { hasText: 'history 29' }),
      ).toBeVisible({ timeout: 20_000 });
      await scroller.evaluate(
        (el) => (el.scrollTop = Math.max(0, el.scrollTop - 400)),
      );
      const anchor = () =>
        scroller.evaluate((el) => {
          const top = el.getBoundingClientRect().top;
          const row = [
            ...el.querySelectorAll<HTMLElement>('.msg[data-mid]'),
          ].find((candidate) => candidate.getBoundingClientRect().bottom > top);
          return row
            ? {
                id: row.dataset['mid'],
                offset: Math.round(row.getBoundingClientRect().top - top),
              }
            : null;
        });
      await expect.poll(anchor).not.toBeNull();
      const before = await anchor();

      const threads = page.getByRole('complementary', { name: 'Threads' });
      const thread = page.getByTestId('thread-view');
      const panels: [string, () => Promise<void>, Locator][] = [
        [
          'members',
          async () => {
            await openOverflowMenu(page);
            await page.getByTestId('overflow-toggle-members').click();
          },
          page.locator('.chat-members'),
        ],
        ['threads', () => page.getByTestId('open-threads').click(), threads],
        [
          'pinned',
          async () => {
            await openOverflowMenu(page);
            await page.getByTestId('overflow-open-pinned').click();
          },
          page.getByTestId('pinned-panel'),
        ],
        [
          'search',
          () => page.getByTestId('search-messages').click(),
          page.getByRole('complementary', { name: 'Search messages' }),
        ],
      ];
      const slides = await watchPanelSlides(page);
      let slid = 0;
      for (const [kind, open, panel] of panels) {
        await open();
        await expect(page).toHaveURL(new RegExp(`panel=${kind}`));
        await expectPage(page, panel);
        // Pushed over the room, the page slides in once, as a room does over its list.
        const opened = await slides();
        expect(opened.slice(slid).map(([slide]) => slide)).toEqual(['open']);
        expect(opened[slid][1]).toBeGreaterThan(100);
        slid = opened.length;
        await expectSettled(page);
        // History Back draws no slide: the platform's own swipe already did.
        await page.goBack();
        await expect(panel).toBeHidden();
        await expect(page.locator('trn-room-header')).not.toHaveAttribute(
          'inert',
          '',
        );
      }

      // A thread opened from the list is a page over the list: Back steps to it, then out.
      await page.getByTestId('open-threads').click();
      await threads.locator('.thread-item').first().click();
      await expect(thread).toContainText(`thread reply ${runId}`, {
        timeout: 15_000,
      });
      await expectPage(page, page.locator('.chat-panel'));
      await page.goBack();
      await expect(threads).toBeVisible();
      await page.goBack();
      await expect(threads).toBeHidden();

      // The back arrow closes a page too.
      await page.getByTestId('open-threads').click();
      await expectPage(page, threads);
      await threads.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(threads).toBeHidden();
      // The in-app Back slides the page off once, as leaving a room does.
      const closed = (await slides()).slice(-2);
      expect(closed.map(([slide]) => slide)).toEqual(['open', 'close']);
      expect(closed[1][1]).toBeGreaterThan(100);
      await expectSettled(page);
      await expect(page.getByTestId('open-threads')).toBeFocused();

      // Rotating past md and back changes presentation only: no slide starts.
      await page.setViewportSize({ width: 900, height: viewport.height });
      await page.setViewportSize(viewport);
      await expectNoSlideStarted(page);

      await expect(composer).toHaveValue(`half typed ${runId}`);
      await expect.poll(anchor).toEqual(before);
    });
  });
}

test.describe('Room panel pages with Reduce Motion', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens and closes a page with no slide', async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const runId = `${testResourceId('run')}rm`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );
    await login(page, reader);
    await openRoomMobile(page, roomName);
    const slides = await watchPanelSlides(page);
    const threads = page.getByRole('complementary', { name: 'Threads' });

    await page.getByTestId('open-threads').click();
    await expectPage(page, threads);
    await threads.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(threads).toBeHidden();
    await expectSettled(page);
    // The room slide's handling: the same slide, collapsed to an instant.
    const seen = await slides();
    expect(seen.map(([slide]) => slide)).toEqual(['open', 'close']);
    for (const [, duration] of seen) {
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThan(1);
    }
  });
});

test.describe('Room panel pages across a room change', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ viewport: { width: 390, height: 844 } });

  test('drop a page at once when the room changes in place', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}hop`;
    const { reader, roomName } = await seedRoom(request, hs, runId);
    const actor = await apiLogin(
      request,
      hs,
      reader.user as string,
      reader.pass as string,
    );
    const otherRoomName = `Mobile Hop ${runId}`;
    const otherRoomId = await createRoom(request, hs, actor, otherRoomName);

    await login(page, reader);
    await openRoomMobile(page, roomName);
    const slides = await watchPanelSlides(page);
    const threads = page.getByRole('complementary', { name: 'Threads' });
    await page.getByTestId('open-threads').click();
    await expectPage(page, threads);
    const before = (await slides()).length;

    // A room opened in place over the page, as a notification tap or an inbound link does:
    // the page's own room-opening workflow, reached through Angular's dev-mode handle,
    // since no control on a phone page opens another room.
    await page.evaluate(
      ({ accountId, roomId }) => {
        const ng = (
          window as unknown as {
            ng: {
              getComponent(element: Element): {
                routing: {
                  onSelectRoomSelection(
                    selection: { accountId: string; roomId: string },
                    origin: string,
                  ): void;
                };
              };
            };
          }
        ).ng;
        ng.getComponent(
          document.querySelector('trn-rooms')!,
        ).routing.onSelectRoomSelection({ accountId, roomId }, 'rail-unread');
      },
      { accountId: actor.userId, roomId: otherRoomId },
    );
    await expect(
      page.getByRole('heading', { level: 1, name: otherRoomName }),
    ).toBeVisible({ timeout: 15_000 });
    // It leaves at once rather than sliding off over the new room.
    await expect(threads).toBeHidden();
    await expectSettled(page);
    expect((await slides()).slice(before)).toEqual([]);
  });
});

test.describe('Room panels across widths', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps the drawer and the column above md, and resizing adds no history', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}rz`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, reader);
    await page.locator('.channel', { hasText: roomName }).first().click();
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('toggle-members').click();
    const members = page.locator('.chat-members');
    await expect(members).toBeVisible();
    const entries = await page.evaluate(() => history.length);
    const url = page.url();

    const settled = async () => {
      await members.evaluate((element) =>
        Promise.all(element.getAnimations().map((a) => a.finished)),
      );
      return (await members.boundingBox())!;
    };
    const backdrop = page.getByTestId('members-backdrop');

    // The wide column sits in the row beside the timeline.
    expect(Math.round((await settled()).width)).toBe(240);
    await expect(backdrop).toBeHidden();

    // The drawer lies over the timeline, against the right edge, with its backdrop.
    await page.setViewportSize({ width: 800, height: 800 });
    let box = await settled();
    expect(Math.round(box.width)).toBe(240);
    expect(Math.round(box.x + box.width)).toBe(800);
    await expect(backdrop).toBeVisible();

    // Below md it is a page, and crossing md slides nothing in.
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoSlideStarted(page);
    box = await settled();
    expect(Math.round(box.width)).toBe(390);
    await expect(backdrop).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    box = await settled();
    expect(Math.round(box.width)).toBe(240);
    expect(await page.evaluate(() => history.length)).toBe(entries);
    expect(page.url()).toBe(url);
  });
});
