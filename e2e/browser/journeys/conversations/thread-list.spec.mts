import { expect, test, type Locator, type Page } from '../../../fixtures.mts';
import { clickRowMenuItem, login, waitForSent } from '../../../support/app.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import {
  configureMultiAccountSuite,
  session,
} from '../../support/multi-account-journey.mts';
import {
  KEYWORD,
  openInbox,
  seedInbox,
  type InboxSeed,
} from '../../support/inbox-journey.mts';

// The thread panel renders through the shared message list: backfill on scroll, an anchored
// first reply while a page lands, one entrance per new reply, a flash for a revealed reply.
// jsdom has no layout, so offsets and class additions are measured in a real browser.
// Not covered here: day dividers. Synapse honours `ts` for appservices only, so a seeded
// thread cannot span two days; the unit tests cover them.
const REPLIES = 120;
const ROOM_AFTER_THREAD = 150;

async function seedThread(
  request: Parameters<typeof seedInbox>[0],
  resources: Parameters<typeof seedInbox>[2],
  replies: number,
  mentionAt?: number,
): Promise<{ seed: InboxSeed; rootId: string; mention: string }> {
  const seed = await seedInbox(request, session.hs as string, resources);
  const rootId = await seed.post('the thread root');
  const mention = `${KEYWORD} old reply`;
  for (let i = 0; i < replies; i++) {
    await seed.post(i === mentionAt ? mention : `Reply ${i}`, rootId);
  }
  return { seed, rootId, mention };
}

async function signIn(page: Page, seed: InboxSeed): Promise<void> {
  await login(page, {
    available: true,
    hs: session.hs as string,
    user: seed.user,
    pass: seed.pass,
  });
}

// By URL: a long thread pushes its root out of the sync window, so the room list may not hold it.
async function openThread(
  page: Page,
  seed: InboxSeed,
  rootId: string,
): Promise<Locator> {
  await signIn(page, seed);
  await openRoom(page, seed.roomName);
  const url = new URL(page.url());
  url.searchParams.set('panel', 'thread');
  url.searchParams.set('root', rootId);
  await page.goto(url.toString());
  const thread = page.getByTestId('thread-view');
  await expect(thread).toBeVisible({ timeout: 30_000 });
  return thread;
}

/** Counts `msg-enter` additions per row element from the first paint of every page load. */
async function watchEntrances(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts = new Map<Element, number>();
    (window as unknown as { __entrances: typeof counts }).__entrances = counts;
    const bump = (el: Element): void => {
      counts.set(el, (counts.get(el) ?? 0) + 1);
    };
    new MutationObserver((records) => {
      const inserted = new Set<Element>();
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          const rows = [
            ...(n.matches('trn-message-row') ? [n] : []),
            ...n.querySelectorAll('trn-message-row'),
          ];
          for (const el of rows)
            if (el.classList.contains('msg-enter')) inserted.add(el);
        });
      }
      inserted.forEach(bump);
      for (const r of records) {
        const el = r.target as Element;
        if (
          r.type === 'attributes' &&
          el.tagName === 'TRN-MESSAGE-ROW' &&
          !(r.oldValue ?? '').split(' ').includes('msg-enter') &&
          el.classList.contains('msg-enter') &&
          !inserted.has(el)
        )
          bump(el);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
  });
}

const entrances = (page: Page, text: string): Promise<number> =>
  page.evaluate((t) => {
    const counts = (window as unknown as { __entrances: Map<Element, number> })
      .__entrances;
    let total = 0;
    counts.forEach((n, el) => {
      if (el.textContent?.includes(t)) total += n;
    });
    return total;
  }, text);

/** A request for a page of this thread's replies. */
const threadPage =
  (rootId: string) =>
  (url: URL | string): boolean => {
    const href = String(url);
    return (
      href.includes('/relations/') && href.includes(encodeURIComponent(rootId))
    );
  };

/** The rendered rows in DOM order: 'root', a reply's number, or '?' for anything else. */
const rowOrder = (thread: Locator): Promise<string[]> =>
  thread.locator('.msg[data-mid]').evaluateAll((rows) =>
    rows.map((row) => {
      const text = row.textContent ?? '';
      if (text.includes('the thread root')) return 'root';
      if (text.includes('old reply')) return '8';
      return /Reply (\d+)/.exec(text)?.[1] ?? '?';
    }),
  );

/** The root leads, and every reply after it is in ascending order. */
async function expectInOrder(thread: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const order = await rowOrder(thread);
      const replies = order.slice(1).map(Number);
      const ascending = replies.every((n, i) => i === 0 || n > replies[i - 1]);
      return order[0] === 'root' && ascending ? 'in order' : order.join(',');
    })
    .toBe('in order');
}

const reply = (thread: Locator, text: string): Locator =>
  thread.locator('.msg[data-mid]', { hasText: new RegExp(`${text}$`) });

test.describe('Thread list', () => {
  configureMultiAccountSuite();

  test('scrolling to the top loads older replies', async ({
    page,
    request,
    matrixResources,
  }) => {
    test.slow();
    const { seed, rootId } = await seedThread(
      request,
      matrixResources,
      REPLIES,
    );
    // Room history after the thread, deeper than the room's own backfill: otherwise that
    // backfill loads the replies into the thread too, and its pages bring nothing older.
    for (let i = 0; i < ROOM_AFTER_THREAD; i++) await seed.post(`Room ${i}`);
    const thread = await openThread(page, seed, rootId);
    const scroll = thread.locator('.scroll');
    await expect(reply(thread, `Reply ${REPLIES - 1}`)).toBeVisible({
      timeout: 30_000,
    });
    // The newest page holds the newest replies only.
    await expect(reply(thread, 'Reply 0')).toHaveCount(0);
    await expect(
      thread.getByRole('button', { name: /load older/i }),
    ).toHaveCount(0);

    // Hold the page request at the browser, so the offset is read before and after it lands.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(threadPage(rootId), async (route) => {
      await held;
      await route.continue().catch(() => undefined);
    });
    const paged = page.waitForRequest((r) => threadPage(rootId)(r.url()));
    // Wheel up as a reader does, until the list asks for the next page.
    await scroll.hover();
    let asked = false;
    void paged.then(() => (asked = true));
    for (let i = 0; i < 200 && !asked; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(50);
    }
    await paged;

    // The first reply the reader sees at the top (the root leads the list and is no anchor).
    const anchorId = await scroll.evaluate((el, root) => {
      const top = el.getBoundingClientRect().top;
      const rows = [...el.querySelectorAll('.msg[data-mid]')];
      return rows
        .find(
          (row) =>
            row.getAttribute('data-mid') !== root &&
            row.getBoundingClientRect().bottom > top,
        )
        ?.getAttribute('data-mid');
    }, rootId);
    const offset = (): Promise<number> =>
      scroll.evaluate((el, id) => {
        const row = el.querySelector(`.msg[data-mid="${id}"]`);
        return (
          (row?.getBoundingClientRect().top ?? NaN) -
          el.getBoundingClientRect().top
        );
      }, anchorId);
    const before = await offset();
    const oldest = async (): Promise<number> =>
      Math.min(...(await rowOrder(thread)).map(Number).filter(Number.isFinite));
    const oldestBefore = await oldest();
    const landed = page.waitForResponse((r) => threadPage(rootId)(r.url()));
    release();
    await landed;
    await page.waitForTimeout(500);
    expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(2);
    // The page brought older replies, above the ones read.
    await expect.poll(oldest).toBeLessThan(oldestBefore);

    // At the top, the root leads and the replies run in order.
    await scroll.evaluate((el) => (el.scrollTop = 0));
    await expectInOrder(thread);
  });

  test('a new reply at the bottom stays pinned and slides in once', async ({
    page,
    request,
    matrixResources,
  }) => {
    const { seed, rootId } = await seedThread(request, matrixResources, 3);
    await watchEntrances(page);
    const thread = await openThread(page, seed, rootId);
    await expect(reply(thread, 'Reply 2')).toBeVisible({ timeout: 30_000 });

    await seed.post('arrived live', rootId);
    await expect(reply(thread, 'arrived live')).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(600);
    expect(await entrances(page, 'arrived live')).toBe(1);
    await expect
      .poll(() =>
        thread
          .locator('.scroll')
          .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      )
      .toBeLessThan(50);
  });

  test('opening at an old reply pages to it and highlights it', async ({
    page,
    request,
    matrixResources,
  }) => {
    test.slow();
    const { seed, mention } = await seedThread(request, matrixResources, 70, 8);
    await watchEntrances(page);
    await signIn(page, seed);
    await openInbox(page);
    // The newest notifications come first; page back to the old reply's.
    const row = page.getByTestId('inbox-row').first();
    await expect(async () => {
      if (!(await row.isVisible()))
        await page.getByRole('button', { name: 'Load more' }).click();
      await expect(row).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
    await row.click();

    const thread = page.getByTestId('thread-view');
    const target = thread.locator('.msg[data-mid]', { hasText: mention });
    await expect(target).toBeInViewport({ timeout: 60_000 });
    await expect(target).toHaveClass(/msg--flash/);
    expect(await entrances(page, mention)).toBe(0);
    await expectInOrder(thread);
  });

  test('reloading the thread URL lands in the thread', async ({
    page,
    request,
    matrixResources,
  }) => {
    const { seed, rootId } = await seedThread(request, matrixResources, 3);
    const thread = await openThread(page, seed, rootId);
    await expect(reply(thread, 'Reply 2')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('root'))
      .toBe(rootId);

    await page.reload();

    await expect(page.getByTestId('thread-view')).toBeVisible({
      timeout: 30_000,
    });
    await expect(reply(page.getByTestId('thread-view'), 'Reply 2')).toBeVisible(
      { timeout: 30_000 },
    );
  });

  test('deleting a reply asks for confirmation', async ({
    page,
    request,
    matrixResources,
  }) => {
    const { seed, rootId } = await seedThread(request, matrixResources, 1);
    const thread = await openThread(page, seed, rootId);
    const input = thread.getByTestId('composer-input');
    await input.fill('mine to delete');
    await input.press('Enter');
    const mine = reply(thread, 'mine to delete');
    await expect(mine).toBeVisible({ timeout: 30_000 });
    await waitForSent(mine);

    await clickRowMenuItem(mine, page.getByTestId('msg-delete'));
    await expect(page.getByTestId('alert-confirm')).toBeVisible();
    await expect(mine).toBeVisible();
    await page.getByTestId('alert-confirm').click();
    await expect(mine).toHaveCount(0, { timeout: 30_000 });
  });

  test('a short thread shows the root and does not page', async ({
    page,
    request,
    matrixResources,
  }) => {
    const { seed, rootId } = await seedThread(request, matrixResources, 2);
    // Listening from before the open, so a page the list's initial fill asks for is seen too.
    // Only a page from a `from` token is the list paging: the SDK's own first fetch has none.
    const paging: string[] = [];
    page.on('request', (r) => {
      if (
        threadPage(rootId)(r.url()) &&
        new URL(r.url()).searchParams.has('from')
      )
        paging.push(r.url());
    });
    const thread = await openThread(page, seed, rootId);
    await expect(reply(thread, 'Reply 1')).toBeVisible({ timeout: 30_000 });
    await expect(thread).toContainText('the thread root');

    await thread.locator('.scroll').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(1_500);
    expect(paging).toEqual([]);
  });
});
