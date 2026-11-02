import { expect, test, type Page } from '../../../fixtures.mts';
import { login } from '../../../support/app.mts';
import { MatrixTestResources } from '../../../support/test-resources.mts';
import {
  addAccountViaUi,
  configureMultiAccountSuite,
  session,
} from '../../support/multi-account-journey.mts';
import {
  KEYWORD,
  openInbox,
  seedInbox,
  watchConsoleErrors,
  type InboxSeed,
} from '../../support/inbox-journey.mts';

// The inbox view in the real app: its rows come from the server's /notifications list, filtered
// by the reader's own push rules. A two-person room makes the server notify every message, so
// plain messages show under All and only the ones with the keyword highlight under Mentions.
const PHONE = { width: 390, height: 844 };
const rows = (page: Page) => page.getByTestId('inbox-row');
const scroller = (page: Page) => page.getByTestId('inbox-scroll');

async function signInAndOpenInbox(page: Page, seed: InboxSeed): Promise<void> {
  await login(page, { available: true, hs: session.hs, ...seed });
  await openInbox(page);
}

test.describe('Mentions inbox', () => {
  configureMultiAccountSuite();
  const hs = (): string => session.hs as string;
  let consoleErrors: () => readonly string[] = () => [];

  // Only the failed journey expects a failing /notifications.
  let notificationsMayFail = false;
  test.beforeEach(({ page }) => {
    notificationsMayFail = false;
    consoleErrors = watchConsoleErrors(
      page,
      (url) =>
        notificationsMayFail &&
        new URL(url).pathname.endsWith('/v3/notifications'),
    );
  });
  test.afterEach(() => {
    expect(consoleErrors(), 'console errors and CSP violations').toEqual([]);
  });

  test('a mention appears in Mentions, opening it jumps to the message', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    const mention = `${KEYWORD} look at this`;
    await seed.post(mention);
    // Enough later messages that the mention is out of the room's first screen.
    for (let i = 0; i < 40; i++) await seed.post(`plain ${i}`);

    await signInAndOpenInbox(page, seed);

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(seed.roomName);
    await expect(rows(page).first()).toContainText(seed.senderName);
    await expect(rows(page).first()).toContainText(mention);
    await expect(page.getByTestId('inbox-row-dot')).toBeVisible();

    await rows(page).first().click();

    const message = page.locator('.scroll .msg', { hasText: mention });
    await expect(message).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      seed.roomName,
    );
    await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('inbox-row-dot')).toHaveCount(0);
  });

  test('All shows every notification with its note, Mentions only the highlights', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await seed.post('plain one');
    await seed.post(`${KEYWORD} two`);
    await seed.post('plain three');

    await signInAndOpenInbox(page, seed);
    const note = page.getByText(
      'Your server may only keep these for a short time.',
    );

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(`${KEYWORD} two`);
    await expect(note).toHaveCount(0);

    await page.getByTestId('inbox-tab-all').click();
    await expect(rows(page)).toHaveCount(3);
    await expect(note).toBeVisible();
    await expect(page.getByTestId('inbox-tab-all')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.getByTestId('inbox-tab-mentions').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(note).toHaveCount(0);
  });

  test('the rail button swaps the room list for the inbox and back', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await seed.post(`${KEYWORD} wiring`);
    await login(page, { available: true, hs: session.hs, ...seed });

    const inboxButton = page.getByTestId('rail-inbox');
    await expect(page.locator('trn-notification-inbox')).toHaveCount(0);
    await expect(inboxButton).not.toHaveAttribute('aria-current', 'true');
    const historyBefore = await page.evaluate(() => history.length);

    await inboxButton.click();
    await expect(page.locator('trn-notification-inbox')).toBeVisible();
    await expect(page.locator('trn-channel-sidebar')).toHaveCount(0);
    await expect(inboxButton).toHaveAttribute('aria-current', 'true');
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);

    await page.getByTestId('rail-rooms').click();
    await expect(page.locator('trn-channel-sidebar')).toBeVisible();
    await expect(page.locator('trn-notification-inbox')).toHaveCount(0);
    await expect(inboxButton).not.toHaveAttribute('aria-current', 'true');
  });

  for (const filler of [0, 40]) {
    test(`thread: a mention in a thread opens that thread at the message (${filler} messages after the root)`, async ({
      page,
      request,
      matrixResources,
    }) => {
      const seed = await seedInbox(request, hs(), matrixResources);
      const rootId = await seed.post('the thread root');
      for (let i = 0; i < filler; i++) await seed.post(`plain ${i}`);
      const reply = `${KEYWORD} in the thread`;
      await seed.post(reply, rootId);

      await signInAndOpenInbox(page, seed);
      await expect(rows(page)).toHaveCount(1);
      await rows(page).first().click();

      const thread = page.getByTestId('thread-view');
      await expect(thread).toBeVisible({ timeout: 30_000 });
      await expect(
        thread.locator('.msg', { hasText: 'the thread root' }),
      ).toBeVisible();
      await expect(thread.locator('.msg', { hasText: reply })).toBeInViewport();
    });
  }

  test('desktop: the inbox stays beside the open room', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await seed.post(`${KEYWORD} desktop`);
    await signInAndOpenInbox(page, seed);

    await rows(page).first().click();

    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('trn-notification-inbox')).toBeVisible();
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByTestId('back-to-rooms')).toBeHidden();
  });

  for (const [label, size] of [
    ['desktop', { width: 1280, height: 720 }],
    ['phone', PHONE],
  ] as const) {
    test(`${label}: reloading at ?view=inbox shows the inbox`, async ({
      page,
      request,
      matrixResources,
    }) => {
      await page.setViewportSize(size);
      const seed = await seedInbox(request, hs(), matrixResources);
      await seed.post(`${KEYWORD} after a reload`);
      await signInAndOpenInbox(page, seed);
      await expect.poll(() => page.url()).toContain('view=inbox');

      await page.reload();

      await expect(page.locator('trn-notification-inbox')).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('trn-channel-sidebar')).toHaveCount(0);
      await expect(page.getByTestId('rail-inbox')).toHaveAttribute(
        'aria-current',
        'true',
      );
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText(
        `${KEYWORD} after a reload`,
      );
    });
  }

  test('empty: no mentions says so, and so does All', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await signInAndOpenInbox(page, seed);
    await expect(page.getByTestId('inbox-empty')).toHaveText(
      /No mentions\. When someone mentions you, it shows up here\./,
    );
    await page.getByTestId('inbox-tab-all').click();
    await expect(page.getByTestId('inbox-empty')).toHaveText(
      /No notifications\./,
    );
  });

  test('failed: a server error offers Try again, which recovers', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await seed.post(`${KEYWORD} later`);
    let failing = true;
    notificationsMayFail = true;
    await page.route('**/_matrix/client/v3/notifications**', (route) =>
      failing
        ? route.fulfill({ status: 500, json: { errcode: 'M_UNKNOWN' } })
        : route.continue(),
    );
    await login(page, { available: true, hs: session.hs, ...seed });
    await page.getByTestId('rail-inbox').click();

    await expect(page.getByTestId('inbox-failed')).toContainText(
      "Couldn't load your inbox",
    );
    failing = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('inbox-failed')).toHaveCount(0);
  });

  test('the back arrow reads Back to rooms when not opened from the inbox', async ({
    page,
    request,
    matrixResources,
  }) => {
    await page.setViewportSize(PHONE);
    const seed = await seedInbox(request, hs(), matrixResources);
    await seed.post('plain');
    await login(page, { available: true, hs: session.hs, ...seed });

    await page.getByTestId('rail-rooms').click();
    await page.locator('button.channel', { hasText: seed.roomName }).click();

    await expect(page.getByTestId('back-to-rooms')).toHaveAccessibleName(
      'Back to rooms',
    );
  });

  test('choosing the inbox adds no history entry', async ({
    page,
    request,
    matrixResources,
  }) => {
    await page.setViewportSize(PHONE);
    const seed = await seedInbox(request, hs(), matrixResources);
    await login(page, { available: true, hs: session.hs, ...seed });
    const before = await page.evaluate(() => history.length);

    await openInbox(page);

    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test.describe('phone: leaving and returning', () => {
    let seed: InboxSeed;
    test.beforeEach(async ({ page, request, matrixResources }) => {
      await page.setViewportSize(PHONE);
      seed = await seedInbox(request, hs(), matrixResources);
      for (let i = 0; i < 60; i++) await seed.post(`${KEYWORD} number ${i}`);
      await signInAndOpenInbox(page, seed);
      await page.getByTestId('inbox-tab-all').click();
      await expect(rows(page).nth(49)).toBeAttached();
    });

    /** Scrolls the list to about 400px and returns the row that sits on screen there. */
    async function scrollAndPick(page: Page) {
      await scroller(page).evaluate((el) => (el.scrollTop = 400));
      await expect
        .poll(() => scroller(page).evaluate((el) => el.scrollTop))
        .toBe(400);
      const height = await rows(page)
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
      return rows(page).nth(Math.ceil(400 / height) + 1);
    }

    async function expectRestored(page: Page): Promise<void> {
      await expect(page.locator('.shell-side')).toBeVisible();
      await expect(page.getByTestId('inbox-tab-all')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect
        .poll(() => scroller(page).evaluate((el) => el.scrollTop))
        .toBe(400);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const at = document.activeElement;
            const hidden = document.querySelector('.main');
            // After Back from any room focus rests on the routed page; it must not be left in
            // the conversation that is now hidden, nor lost.
            return at &&
              at !== document.body &&
              at.checkVisibility() &&
              !hidden?.contains(at)
              ? 'visible, outside the conversation'
              : `${at?.tagName}.${at?.className}`;
          }),
        )
        .toBe('visible, outside the conversation');
    }

    test('the floating account bar leaves the last row and Load more clear', async ({
      page,
    }) => {
      await page.getByTestId('inbox-tab-mentions').click();
      const more = page.getByTestId('inbox-load-more');
      await expect(more).toBeVisible();
      await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
      const barTop = async () =>
        (await page.locator('.userbar').boundingBox())?.y ?? 0;
      await expect
        .poll(async () => {
          const box = await more.boundingBox();
          return (box?.y ?? Infinity) + (box?.height ?? 0) <= (await barTop());
        })
        .toBe(true);
      const last = await rows(page).last().boundingBox();
      expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(
        await barTop(),
      );
    });

    test('the back arrow keeps the tab and scroll position', async ({
      page,
    }) => {
      await (await scrollAndPick(page)).click();
      await expect(
        page.getByRole('button', { name: 'Back to inbox' }),
      ).toBeVisible();
      await expect(page.locator('.shell-side')).toBeHidden();

      await page.getByRole('button', { name: 'Back to inbox' }).click();

      await expectRestored(page);
    });

    test("the browser's Back keeps the tab and scroll position", async ({
      page,
    }) => {
      await (await scrollAndPick(page)).click();
      await expect(page.locator('.shell-side')).toBeHidden();

      await page.goBack();

      await expectRestored(page);
    });
  });

  test('a very long room name at phone width does not overflow', async ({
    page,
    request,
    matrixResources,
  }) => {
    await page.setViewportSize(PHONE);
    const seed = await seedInbox(
      request,
      hs(),
      matrixResources,
      'W'.repeat(200),
    );
    for (let i = 0; i < 55; i++) await seed.post(`${KEYWORD} ${i}`);
    await signInAndOpenInbox(page, seed);
    await expect(rows(page).first()).toBeVisible();

    const fits = await scroller(page).evaluate(
      (el) => el.scrollWidth <= el.clientWidth,
    );
    expect(fits).toBe(true);
    await expect(rows(page).first()).toContainText('W'.repeat(200));
    for (const control of ['inbox-load-more', 'inbox-refresh']) {
      await expect(page.getByTestId(control)).toBeVisible();
      const box = await page.getByTestId(control).boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        PHONE.width,
      );
    }
  });

  test('Load more says when it stops at its limit', async ({
    page,
    request,
    matrixResources,
  }) => {
    const seed = await seedInbox(request, hs(), matrixResources);
    await seed.post('plain');
    let served = 0;
    await page.route('**/_matrix/client/v3/notifications**', async (route) => {
      // Three pages of 50 notifications, none of which mentions the reader.
      const served_page = ++served;
      const notifications = Array.from({ length: 50 }, (_, i) => {
        const n = served_page * 100 + i;
        return {
          actions: ['notify'],
          read: true,
          room_id: seed.roomId,
          ts: Date.now() - n * 1000,
          event: {
            event_id: `$fake${n}`,
            room_id: seed.roomId,
            sender: seed.sender.userId,
            type: 'm.room.message',
            origin_server_ts: Date.now() - n * 1000,
            content: { msgtype: 'm.text', body: `filler ${n}` },
          },
        };
      });
      await route.fulfill({
        json: { notifications, next_token: `page${served_page}` },
      });
    });
    await signInAndOpenInbox(page, seed);
    await expect(page.getByTestId('inbox-load-more')).toBeVisible();

    await page.getByTestId('inbox-load-more').click();

    await expect(page.getByTestId('inbox-limit')).toHaveText(
      /Checked 150 more notifications and found no more mentions\./,
    );
    await expect(page.getByTestId('inbox-load-more')).toBeEnabled();
  });

  test('switching account closes the inbox, and reopening it loads the new account', async ({
    page,
    request,
    matrixResources,
  }) => {
    const namespace = matrixResources.namespace;
    const second = new MatrixTestResources({
      ...namespace,
      role: (name) => namespace.role(`b-${name}`),
    });
    const a = await seedInbox(request, hs(), matrixResources);
    const b = await seedInbox(request, hs(), second);
    await a.post(`${KEYWORD} for account A`);
    await b.post(`${KEYWORD} for account B`);

    await login(page, { available: true, hs: session.hs, ...a });
    await addAccountViaUi(page, hs(), b.user, b.pass);
    await openInbox(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('for account B');

    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${a.user}:` })
      .click();

    // A switch lands on the new account's Home, so the inbox closes and must reopen on A's rows.
    await expect(page.locator('trn-notification-inbox')).toHaveCount(0);
    await openInbox(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('for account A');
  });
});
