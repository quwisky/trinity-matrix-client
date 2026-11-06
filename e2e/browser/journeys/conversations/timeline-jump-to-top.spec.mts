import { expect, test, type Locator, type Page } from '../../../fixtures.mts';
import { login } from '../../../support/app.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { waitUntilStill } from '../../../support/touch-platform.mts';
import {
  configureMultiAccountSuite,
  session,
} from '../../support/multi-account-journey.mts';
import { seedInbox, type InboxSeed } from '../../support/inbox-journey.mts';

// A programmatic jump to the top (keyboard Home, a screen reader) moves the list thousands of
// pixels in one scroll event, before the window renders the rows of the new position. The page
// of older history it asks for must still leave the rows the reader now sees where they are.
// jsdom has no layout, so the row offsets are measured in a real browser.

async function signIn(page: Page, seed: InboxSeed): Promise<void> {
  await login(page, {
    available: true,
    hs: session.hs as string,
    user: seed.user,
    pass: seed.pass,
  });
}

/** Page history in until the list is long, then go back to the bottom: the jump must be a long one. */
async function loadBack(page: Page, scroll: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        scroll.evaluate((el) => {
          el.scrollTop = 0;
          return el.scrollHeight - el.clientHeight;
        }),
      { timeout: 90_000, intervals: [400] },
    )
    .toBeGreaterThan(2500);
  await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
  // Let a page asked for at the top land before the jump asks for the next.
  await page.waitForTimeout(1500);
  await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
}

/** Jump to the top with `scrollTop = 0`, and expect the first row on screen to hold when the page lands. */
async function expectPlaceKeptAfterJumpToTop(
  page: Page,
  scroll: Locator,
  isHistory: (url: string) => boolean,
  leadingId?: string,
): Promise<void> {
  // Hold the page at the browser, so the reader's place is read before it lands.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => isHistory(String(url)),
    async (route) => {
      await held;
      await route.continue().catch(() => undefined);
    },
  );
  const asked = page.waitForRequest((r) => isHistory(r.url()));
  expect(
    await scroll.evaluate((el) => el.scrollTop),
    'the jump must be a long one',
  ).toBeGreaterThan(2000);
  await scroll.evaluate((el) => (el.scrollTop = 0));
  await asked;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

  // The first row the reader sees (a thread's root leads the list and is no anchor).
  const anchorId = await scroll.evaluate((el, lead) => {
    const { top, bottom } = el.getBoundingClientRect();
    return [...el.querySelectorAll('.msg[data-mid]')]
      .find((row) => {
        const rect = row.getBoundingClientRect();
        return (
          row.getAttribute('data-mid') !== lead &&
          rect.bottom > top &&
          rect.top < bottom
        );
      })
      ?.getAttribute('data-mid');
  }, leadingId);
  expect(anchorId, 'a row is on screen after the jump').toBeTruthy();
  const offset = (): Promise<number> =>
    scroll.evaluate((el, id) => {
      const row = el.querySelector(`.msg[data-mid="${id}"]`);
      return (
        (row?.getBoundingClientRect().top ?? NaN) -
        el.getBoundingClientRect().top
      );
    }, anchorId);
  const before = await offset();

  const landed = page.waitForResponse((r) => isHistory(r.url()));
  release();
  await landed;
  await waitUntilStill(scroll.locator(`.msg[data-mid="${anchorId}"]`));
  const after = await offset();
  expect(
    Math.abs(after - before),
    `the first row on screen moved from ${before} to ${after}`,
  ).toBeLessThanOrEqual(2);
}

test.describe('Jump to the top', () => {
  configureMultiAccountSuite();

  test('keeps the reader in place in a long room', async ({
    page,
    request,
    matrixResources,
  }) => {
    test.slow();
    const seed = await seedInbox(
      request,
      session.hs as string,
      matrixResources,
    );
    for (let i = 0; i < 250; i++) await seed.post(`Line ${i}`);
    await signIn(page, seed);
    await openRoom(page, seed.roomName);
    const scroll = page.locator('.scroll').first();
    await expect(scroll.locator('.msg', { hasText: /Line 249$/ })).toBeVisible({
      timeout: 30_000,
    });
    await loadBack(page, scroll);

    await expectPlaceKeptAfterJumpToTop(page, scroll, (url) =>
      url.includes('/messages?'),
    );
  });

  test('keeps the reader in place in a long thread', async ({
    page,
    request,
    matrixResources,
  }) => {
    test.slow();
    const seed = await seedInbox(
      request,
      session.hs as string,
      matrixResources,
    );
    const rootId = await seed.post('the thread root');
    for (let i = 0; i < 250; i++) await seed.post(`Reply ${i}`, rootId);
    // Room history after the thread, deeper than the room's own backfill, so the thread pages itself.
    for (let i = 0; i < 150; i++) await seed.post(`Room ${i}`);
    await signIn(page, seed);
    await openRoom(page, seed.roomName);
    const url = new URL(page.url());
    url.searchParams.set('panel', 'thread');
    url.searchParams.set('root', rootId);
    await page.goto(url.toString());
    const thread = page.getByTestId('thread-view');
    const scroll = thread.locator('.scroll');
    await expect(
      thread.locator('.msg[data-mid]', { hasText: /Reply 249$/ }),
    ).toBeVisible({ timeout: 30_000 });
    await loadBack(page, scroll);

    await expectPlaceKeptAfterJumpToTop(
      page,
      scroll,
      (url) =>
        url.includes('/relations/') && url.includes(encodeURIComponent(rootId)),
      rootId,
    );
  });
});
