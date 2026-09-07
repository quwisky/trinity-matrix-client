import {
  testResourceId,
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  isAndroidE2E,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { captureScreenshot } from '../../../support/screenshot.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import { hasDarkMode } from '../../support/settings-journey.mts';
import { setTimeout as wait } from 'node:timers/promises';

// Covers "who reacted" (issue #8): a reaction pill names its reactors on hover, and
// the trailing chip opens the full list, grouped by emoji.
//
// A large reaction snapshot is sent straight over the CS API so the browser can verify
// grouped hints, long lists and overflow without making the UI perform setup work.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

async function loginApi(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  const response = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  expect(response.ok(), `login ${user}: ${response.status()}`).toBe(true);
  const json = await response.json();
  return json.access_token as string;
}

/** Synapse rate-limits joins into a room; honor its retry delay, bounded to five tries. */
async function joinWithRetry(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  headers: Record<string, string>,
  user: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers },
    );
    if (response.ok()) {
      expect(response.status(), `join ${user}: final status`).toBeLessThan(300);
      return;
    }
    if (response.status() !== 429) {
      throw new Error(
        `join ${user}: ${response.status()} ${await response.text()}`,
      );
    }
    const body = (await response.json().catch(() => ({}))) as {
      retry_after_ms?: number;
    };
    const retryAfter = Number(body.retry_after_ms);
    await wait(
      Number.isFinite(retryAfter)
        ? Math.min(Math.max(retryAfter, 1), 10_000)
        : 1_000,
    );
  }
  throw new Error(`join ${user}: still rate-limited after 5 attempts`);
}

interface Seeded {
  reader: SynapseSession;
  roomName: string;
  /** Display name of the second reactor, as the room shows it. */
  otherName: string;
  body: string;
  reactorCount: number;
  totalReactions: number;
  reactionGroupCount: number;
  sendReactions: () => Promise<void>;
}

/**
 * A room with one message that many members have reacted to: the account the browser
 * signs in as plus a large reactor set (👍), with 20 total reaction groups.
 */
async function seedReactedMessage(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<Seeded> {
  const readerUser = `who-reader-${runId}`;
  const otherUsers = [
    `who-other-${runId}-${'x'.repeat(36)}`,
    ...Array.from({ length: 15 }, (_, index) => `who-other-${runId}-${index}`),
  ];
  const otherUser = otherUsers[0];
  const roomName = `Who reacted ${runId}`;
  const body = `react to me ${runId}`;

  await registerUser(request, readerUser, `${readerUser}-pass`);
  for (const user of otherUsers) {
    await registerUser(request, user, `${user}-pass`);
  }
  const readerToken = await loginApi(
    request,
    hs,
    readerUser,
    `${readerUser}-pass`,
  );
  const readerHeaders = { Authorization: `Bearer ${readerToken}` };
  const otherHeaders = await Promise.all(
    otherUsers.map(async (user) => ({
      user,
      headers: {
        Authorization: `Bearer ${await loginApi(request, hs, user, `${user}-pass`)}`,
      },
    })),
  );

  const roomResponse = await request.post(
    `${hs}/_matrix/client/v3/createRoom`,
    { headers: readerHeaders, data: { name: roomName, preset: 'public_chat' } },
  );
  expect(roomResponse.ok(), `create room: ${roomResponse.status()}`).toBe(true);
  const { room_id: roomId } = await roomResponse.json();
  for (const { user, headers } of otherHeaders) {
    await joinWithRetry(request, hs, roomId, headers, user);
  }

  const messageResponse = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/who-${runId}`,
    { headers: readerHeaders, data: { msgtype: 'm.text', body } },
  );
  expect(
    messageResponse.ok(),
    `send message: ${messageResponse.status()}`,
  ).toBe(true);
  const { event_id: eventId } = await messageResponse.json();

  const react = async (
    headers: Record<string, string>,
    key: string,
    txn: string,
  ): Promise<void> => {
    const response = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txn}`,
      {
        headers,
        data: {
          'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
        },
      },
    );
    expect(response.ok(), `reaction ${key}: ${response.status()}`).toBe(true);
  };
  const sendReactions = async (): Promise<void> => {
    await react(readerHeaders, '👍', `r1-${runId}`);
    for (const [{ headers }, index] of otherHeaders.map(
      (entry, index) => [entry, index] as const,
    )) {
      await react(headers, '👍', `r${index + 2}-${runId}`);
    }
    await react(otherHeaders[0].headers, '🎉', `r10-${runId}`);
    for (const [index, key] of [
      '❤️',
      '😂',
      '😮',
      '😢',
      '😡',
      '🚀',
      '✅',
      '❌',
      '👏',
      '🙌',
      '🔥',
      '💯',
      '🎯',
      '✨',
      '💡',
      '🌈',
      '🍀',
      '🌟',
    ].entries()) {
      // Spread the group events over the joined accounts so Synapse's per-user event
      // limiter cannot turn this layout stress fixture into a setup-rate-limit test.
      await react(
        otherHeaders[(index + 1) % otherHeaders.length].headers,
        key,
        `group${index}-${runId}`,
      );
    }
  };

  return {
    reader: {
      available: true,
      hs,
      user: readerUser,
      pass: `${readerUser}-pass`,
    },
    roomName,
    // Synapse leaves a password-registered account's display name as its localpart.
    otherName: otherUser,
    body,
    reactorCount: otherUsers.length + 1,
    totalReactions: otherUsers.length + 1 + 1 + 18,
    reactionGroupCount: 20,
    sendReactions,
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Who reacted', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ hasTouch: true });

  test('names the reactors on the pill and lists them all in the dialog', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}w`;
    const seeded = await seedReactedMessage(
      request,
      session.hs as string,
      runId,
    );

    await login(page, seeded.reader);
    await openRoom(page, seeded.roomName);

    const row = page.locator('.scroll .msg', { hasText: seeded.body });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });
    const thumbsUp = row
      .first()
      .locator('.reaction:not(.reaction--who)')
      .filter({ hasText: '👍' });

    // Load the source message before the relation burst, then wait for the live pill to
    // settle after the API-seeded reactions arrive.
    await seeded.sendReactions();
    await expect(thumbsUp.locator('.reaction__count')).toHaveText(
      String(seeded.reactorCount),
      {
        timeout: 30_000,
      },
    );
    await expect(
      row.first().locator('.reaction:not(.reaction--who)'),
    ).toHaveCount(seeded.reactionGroupCount, { timeout: 30_000 });

    // The pill names who is behind the count — the local user first, as "You".
    // Loose on the second name: it is whatever the homeserver resolved (display name,
    // a disambiguated one, or the raw mxid) — all of which contain the localpart.
    await expect(thumbsUp).toHaveAttribute(
      'aria-label',
      /^👍 reacted by You, .* and \d+ others$/,
      { timeout: 20_000 },
    );
    // Hover and assert as ONE retried unit, not two statements.
    //
    // The tooltip opens 150ms after the pointer settles (brn's `showDelay`), and this pill
    // lives inside the virtual scroller, which re-measures rows as images resolve and as
    // later events arrive. A row that shifts inside that window leaves the pointer over
    // something else, brn cancels the pending show on the mouseleave, and a bare `hover()`
    // followed by a separate wait then blocks on a tooltip that is never coming — which is
    // what this line did, intermittently, at the default 5s.
    //
    // `toPass` re-hovers at the element's CURRENT position on every attempt, so a shifted
    // row costs a retry instead of the test. The inner timeout is short on purpose: it is a
    // per-attempt budget, and a long one here would spend the whole run inside one doomed
    // attempt rather than re-hovering.
    if (!isAndroidE2E) {
      await expect(async () => {
        await thumbsUp.hover();
        await expect(page.getByRole('tooltip')).toContainText(
          'reacted by You',
          {
            timeout: 1_000,
          },
        );
      }).toPass({ timeout: 20_000 });
    }

    // The trailing chip opens the full list.
    if (!isAndroidE2E) {
      // Establish the light proof state through the product's Appearance controls rather
      // than relying on a clean profile's default preference.
      await openSettingsFromRooms(page);
      await page.getByTestId('settings-nav-appearance').click();
      await page.getByTestId('mode-light').click();
      await expect.poll(() => hasDarkMode(page)).toBe(false);
      await closeSettings(page);
    }
    await row.first().getByTestId('reactions-who').click();
    const dialog = page.getByTestId('reactions-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // The desktop dialog follows the Settings frame: a fixed reaction directory sits
    // beside the selected people detail. Measure the rendered panes because utility
    // classes and media queries are not meaningful in unit tests.
    const sidebar = page.getByTestId('reactions-directory');
    const detail = dialog.locator('.reactions-dialog__detail');
    if (!isAndroidE2E) {
      const [sidebarBox, detailBox] = await Promise.all([
        sidebar.boundingBox(),
        detail.boundingBox(),
      ]);
      expect(sidebarBox).not.toBeNull();
      expect(detailBox).not.toBeNull();
      expect(detailBox!.x).toBeGreaterThanOrEqual(
        sidebarBox!.x + sidebarBox!.width - 1,
      );
      await expect(dialog).toHaveCSS('overflow-x', 'hidden');
      await expect
        .poll(async () =>
          dialog.evaluate((element) =>
            Math.max(0, element.scrollWidth - element.clientWidth),
          ),
        )
        .toBeLessThanOrEqual(1);
    }

    // The subtitle counts every reaction event across the large snapshot.
    await expect(dialog.locator('.reactions-dialog__total')).toHaveText(
      `${seeded.totalReactions} total`,
    );
    await expect(page.getByTestId('close-reactions')).toBeVisible();

    let lightPaint: { background: string; foreground: string } | undefined;
    if (!isAndroidE2E) {
      lightPaint = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          foreground: style.color,
        };
      });
      await test.info().attach('reactions-desktop-light', {
        body: await captureScreenshot(page, () => dialog.screenshot()),
        contentType: 'image/png',
      });
      await page.getByTestId('close-reactions').click();
      await expect(dialog).toBeHidden();
      await openSettingsFromRooms(page);
      await page.getByTestId('settings-nav-appearance').click();
      await page.getByTestId('mode-dark').click();
      await expect.poll(() => hasDarkMode(page)).toBe(true);
      await closeSettings(page);
      await row.first().getByTestId('reactions-who').click();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      const darkPaint = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          foreground: style.color,
        };
      });
      expect(darkPaint.background).not.toBe(lightPaint.background);
      expect(darkPaint.foreground).not.toBe(lightPaint.foreground);
      await test.info().attach('reactions-desktop-dark', {
        body: await captureScreenshot(page, () => dialog.screenshot()),
        contentType: 'image/png',
      });
    }

    // One section per emoji; the first lists the full large reactor set.
    await expect(dialog.getByTestId('reactions-key')).toHaveCount(20);
    if (!isAndroidE2E) {
      await expect
        .poll(() =>
          sidebar.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(0);
    }
    await expect(dialog.getByTestId('reactors-list')).toContainText(
      seeded.otherName,
    );
    await expect(dialog.locator('.reactor')).toHaveCount(seeded.reactorCount);
    await expect(
      dialog
        .locator('.reactor__name')
        .filter({ hasText: seeded.otherName })
        .first(),
    ).toHaveCSS('text-overflow', 'ellipsis');
    await expect
      .poll(() =>
        dialog
          .locator('.reactor__name')
          .filter({ hasText: seeded.otherName })
          .first()
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        dialog
          .locator('.reactions-dialog__detail')
          .evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBeGreaterThan(0);

    if (!isAndroidE2E) {
      // Keyboard activation changes the selected group and preserves the pressed/current
      // semantics used by the directory buttons.
      const closeButton = page.getByTestId('close-reactions');
      const firstKey = dialog.getByTestId('reactions-key').first();
      await closeButton.focus();
      await page.keyboard.press('Tab');
      await expect(firstKey).toBeFocused();
      const firstFocusPaint = await firstKey.evaluate((element) => {
        const style = getComputedStyle(element);
        return { outline: style.outlineStyle, shadow: style.boxShadow };
      });
      expect(
        firstFocusPaint.outline !== 'none' || firstFocusPaint.shadow !== 'none',
      ).toBe(true);
      await test.info().attach('reactions-desktop-focus', {
        body: await captureScreenshot(page, () => firstKey.screenshot()),
        contentType: 'image/png',
      });
      await page.keyboard.press('Tab');
      const celebration = dialog
        .getByTestId('reactions-key')
        .filter({ hasText: '🎉' });
      await expect(celebration).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(firstKey).toBeFocused();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(celebration).toHaveAttribute('aria-pressed', 'true');
      await expect(celebration).toHaveAttribute('aria-current', 'true');
      const heart = dialog
        .getByTestId('reactions-key')
        .filter({ hasText: '❤️' });
      await page.keyboard.press('Tab');
      await expect(heart).toBeFocused();
      await page.keyboard.press('Space');
      await expect(heart).toHaveAttribute('aria-pressed', 'true');
      await expect(celebration).toHaveAttribute('aria-pressed', 'false');
      await celebration.click();
      await expect(dialog.locator('.reactor')).toHaveCount(1);
      await expect(dialog.getByTestId('reactors-list')).toContainText(
        seeded.otherName,
      );
    } else {
      const heart = dialog
        .getByTestId('reactions-key')
        .filter({ hasText: '❤️' });
      await heart.click();
      await expect(heart).toHaveAttribute('aria-pressed', 'true');
      await expect(dialog.locator('.reactor')).toHaveCount(1);
    }

    // The same surface falls back to a compact stacked layout below the Settings
    // breakpoint, keeping the reaction directory reachable without horizontal overflow.
    if (!isAndroidE2E) {
      await page.setViewportSize({ width: 640, height: 800 });
      const workspace = dialog.locator('.reactions-dialog__workspace');
      await expect
        .poll(() =>
          workspace.evaluate(
            (element) => getComputedStyle(element).flexDirection,
          ),
        )
        .toBe('column');
      const [compactSidebarBox, compactDetailBox] = await Promise.all([
        sidebar.boundingBox(),
        detail.boundingBox(),
      ]);
      expect(compactSidebarBox).not.toBeNull();
      expect(compactDetailBox).not.toBeNull();
      expect(compactDetailBox!.y).toBeGreaterThanOrEqual(
        compactSidebarBox!.y + compactSidebarBox!.height - 1,
      );
      await test.info().attach('reactions-compact', {
        body: await captureScreenshot(page, () => dialog.screenshot()),
        contentType: 'image/png',
      });
    }

    if (!isAndroidE2E) {
      // Traverse back to the close control and dismiss with Space, proving focus returns
      // to the message control that opened the dialog. Escape is checked on a fresh open.
      const closeButton = page.getByTestId('close-reactions');
      const firstKey = dialog.getByTestId('reactions-key').first();
      await firstKey.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(closeButton).toBeFocused();
      await page.keyboard.press('Space');
      await expect(dialog).toBeHidden();
      await expect(row.first().getByTestId('reactions-who')).toBeFocused();

      await row.first().getByTestId('reactions-who').press('Enter');
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(row.first().getByTestId('reactions-who')).toBeFocused();
    } else {
      // The Android runner owns host Back dispatch; Escape keeps this shared journey's
      // browser and WebView close contract meaningful without requiring the web adapter's
      // Android-only app fixture.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });
});

async function runMobileReactionJourney(
  page: import('@playwright/test').Page,
  request: APIRequestContext,
  pressHostBack: () => Promise<void>,
): Promise<void> {
  const touch = async (
    target: import('@playwright/test').Locator,
  ): Promise<void> => {
    if (isAndroidE2E) await target.click();
    else await target.tap();
  };
  const seeded = await seedReactedMessage(
    request,
    session.hs as string,
    `${testResourceId('mobile')}m`,
  );
  await login(page, seeded.reader);
  await openRoom(page, seeded.roomName);
  let row = page.locator('.scroll .msg', { hasText: seeded.body }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const thumbsUp = row
    .locator('.reaction:not(.reaction--who)')
    .filter({ hasText: '👍' });
  await seeded.sendReactions();
  await expect(thumbsUp.locator('.reaction__count')).toHaveText(
    String(seeded.reactorCount),
    { timeout: 30_000 },
  );
  await expect(row.locator('.reaction:not(.reaction--who)')).toHaveCount(
    seeded.reactionGroupCount,
    { timeout: 30_000 },
  );

  const lightBack = page.getByTestId('back-to-rooms');
  if (await lightBack.isVisible()) await touch(lightBack);
  await openSettingsFromRooms(page, touch);
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('mode-light').click();
  await expect.poll(() => hasDarkMode(page)).toBe(false);
  await closeSettings(page);
  await openRoom(page, seeded.roomName);
  row = page.locator('.scroll .msg', { hasText: seeded.body }).first();

  let trigger = row.getByTestId('reactions-who');
  await touch(trigger);
  const dialog = page.getByTestId('reactions-dialog');
  const sheetHost = page
    .locator('trn-reactions-dialog')
    .filter({ has: dialog });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(sheetHost).toHaveClass(/reactions-dialog--sheet/);

  const geometry = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.bottom).toBeCloseTo(geometry.viewportHeight, 0);
  await test.info().attach('reactions-mobile-light', {
    body: await captureScreenshot(page, () => dialog.screenshot()),
    contentType: 'image/png',
  });

  await touch(page.getByTestId('close-reactions'));
  await expect(dialog).toBeHidden();
  const darkBack = page.getByTestId('back-to-rooms');
  if (await darkBack.isVisible()) await touch(darkBack);
  await openSettingsFromRooms(page, touch);
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('mode-dark').click();
  await expect.poll(() => hasDarkMode(page)).toBe(true);
  await closeSettings(page);
  await openRoom(page, seeded.roomName);
  row = page.locator('.scroll .msg', { hasText: seeded.body }).first();
  trigger = row.getByTestId('reactions-who');
  await touch(trigger);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await test.info().attach('reactions-mobile-dark', {
    body: await captureScreenshot(page, () => dialog.screenshot()),
    contentType: 'image/png',
  });

  const directory = page.getByTestId('reactions-directory');
  const detail = dialog.locator('.reactions-dialog__detail');
  await expect
    .poll(() =>
      directory.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      detail.evaluate((element) => element.scrollHeight - element.clientHeight),
    )
    .toBeGreaterThan(0);

  const lastKey = dialog.getByTestId('reactions-key').last();
  await touch(lastKey);
  await expect(lastKey).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => directory.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(dialog.locator('.reactor')).toHaveCount(1);

  // A mobile OS keeps the sheet treatment when the browser is temporarily wide; the
  // selected reaction must survive that resize before returning to a phone width.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(dialog).toBeVisible();
  await expect(lastKey).toHaveAttribute('aria-pressed', 'true');
  const wideSheet = await dialog.boundingBox();
  expect(wideSheet).not.toBeNull();
  expect(wideSheet!.x).toBeGreaterThanOrEqual(0);
  expect(wideSheet!.x + wideSheet!.width).toBeLessThanOrEqual(901);
  await expect(dialog.locator('.reactions-dialog__workspace')).toHaveCSS(
    'flex-direction',
    'column',
  );

  // Synthetic count text is a layout probe only; all behavior assertions above use
  // the real Matrix snapshot. It catches count overflow without creating thousands of
  // server events.
  await dialog
    .locator('.key__count')
    .first()
    .evaluate((element) => {
      element.textContent = '123456789';
    });
  await expect
    .poll(() =>
      directory.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    )
    .toBeGreaterThan(0);

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '125%';
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(dialog).toBeVisible();
  await expect(lastKey).toHaveAttribute('aria-pressed', 'true');
  const narrow = await dialog.boundingBox();
  expect(narrow).not.toBeNull();
  expect(narrow!.x).toBeGreaterThanOrEqual(0);
  expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(321);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await test.info().attach('reactions-mobile-sheet', {
    body: await captureScreenshot(page, () => dialog.screenshot()),
    contentType: 'image/png',
  });

  await pressHostBack();
  await expect(dialog).toBeHidden();
  if (!isAndroidE2E) {
    await expect(trigger).toBeFocused();
  } else {
    await expect(page.getByTestId('composer-input')).toBeVisible();
  }
}

test.describe('Who reacted · Pixel 5 sheet', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({
    viewport: { width: 393, height: 851 },
    hasTouch: true,
    isMobile: true,
  });
  if (!isAndroidE2E) {
    test.use({
      userAgent: devices['Pixel 5'].userAgent,
      deviceScaleFactor: devices['Pixel 5'].deviceScaleFactor,
    });
    test('keeps the reaction sheet bounded, touch-selectable and scrollable', async ({
      page,
      request,
    }) =>
      runMobileReactionJourney(page, request, () =>
        page.keyboard.press('Escape'),
      ));
  } else {
    test('uses touch selection and native Back to dismiss the reaction sheet', async ({
      page,
      request,
      app,
    }) => runMobileReactionJourney(page, request, () => app.pressBack()));
  }
});
