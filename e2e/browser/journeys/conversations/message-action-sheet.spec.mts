import {
  testResourceId,
  test,
  expect,
  devices,
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
import {
  sheetAtRest,
  touchLongPress,
  waitUntilStill,
} from '../../../support/touch-platform.mts';
import { createRoom } from '../../support/space-journey.mts';

// The message action sheet (#220), which no other spec can see. Every authenticated spec
// runs the desktop Chromium project, where a message's actions are a bar revealed by
// :hover — a surface that on a phone covered the message it acted on, closed on any
// scroll, and opened its reaction picker off the top of the scroller.
//
// `devices['Pixel 5']` and not merely `hasTouch`: the branch is chosen by `isMobileOs()`,
// which reads the PLATFORM. A touch-emulated desktop Chromium keeps its desktop user agent
// and would take the desktop path, so a spec written on the `composer-formatting.spec.mts`
// phone pattern would silently assert nothing.
const session = homeserverSession();

/** Press and hold past the 500ms threshold, the way a finger does. */
async function longPress(page: Page, selector: string): Promise<void> {
  await longPressTarget(page, page.locator(selector).first());
}

/**
 * Long-press until the action sheet opens. Right after a room opens, the sync can re-add
 * events already in the timeline and re-render the row mid-hold, which drops that press —
 * a person would simply press again, so the test does too.
 */
async function longPressTarget(page: Page, target: Locator): Promise<void> {
  const sheet = page.getByRole('dialog', { name: 'Message actions' });
  await expect(async () => {
    if (await sheet.isVisible()) return;
    await touchLongPress(page, target);
    await expect(sheet).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Open a seeded room and hand back the newest row's stable selector. */
async function openRoomWithMessage(
  page: Page,
  request: APIRequestContext,
  tag: string,
  messageCount = 1,
): Promise<string> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
  const user = `sheet-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Sheet ${runId}`;

  await registerUser(request, user, pass);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  const headers = { Authorization: `Bearer ${access_token}` };
  const room_id = await createRoom(
    request,
    hs,
    { accessToken: access_token },
    roomName,
  );
  for (let i = 0; i < messageCount - 1; i++) {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/s-${runId}-${i}`,
      {
        headers,
        data: { msgtype: 'm.text', body: `sheet filler ${tag} ${i}` },
      },
    );
  }
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/s-${runId}`,
    { headers, data: { msgtype: 'm.text', body: `act on me ${runId}` } },
  );

  await login(page, { available: true, hs, user, pass } as HomeserverSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });

  const row = page.locator('.msg[data-mid]').last();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  return `.msg[data-mid="${await row.getAttribute('data-mid')}"]`;
}

/**
 * Record every frame from now on: by the time a locator assertion returns, most of a 200ms
 * entrance has gone.
 */
function sampleSheetFrames(page: Page, rowSel: string) {
  return page.evaluateHandle((selector) => {
    const frames: {
      slide: number;
      sliding: boolean;
      sheetTop: number;
      rowTop: number;
      rowBottom: number;
    }[] = [];
    const sample = () => {
      const sheet = document.querySelector(
        '[data-testid=action-sheet-surface]',
      );
      const row = document.querySelector(selector);
      if (sheet && row) {
        frames.push({
          slide: new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42,
          sliding: sheet
            .getAnimations()
            .some(
              (animation) =>
                (animation as CSSAnimation).animationName === 'trn-sheet-in',
            ),
          sheetTop: sheet.getBoundingClientRect().top,
          rowTop: row.getBoundingClientRect().top,
          rowBottom: row.getBoundingClientRect().bottom,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return frames;
  }, rowSel);
}

async function expectMessageClearOfSheet(
  row: Locator,
  sheet: Locator,
): Promise<void> {
  await sheetAtRest(sheet);
  const geometry = await row.evaluate((message) => {
    const scroller = message.closest('[data-message-scroller]');
    if (!scroller) {
      throw new Error('pressed message is not inside its timeline scroller');
    }
    const rowBox = message.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    return {
      row: { top: rowBox.top, bottom: rowBox.bottom },
      scroller: { top: scrollerBox.top, bottom: scrollerBox.bottom },
    };
  });
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(geometry.row.top).toBeGreaterThanOrEqual(geometry.scroller.top - 1);
  expect(geometry.row.bottom).toBeLessThanOrEqual(geometry.scroller.bottom + 1);
  // CDP reports fractional CSS pixels after Android device-scale conversion; allow
  // sub-pixel rounding while preserving the intended eight-pixel visual gap.
  expect(geometry.row.bottom + 8).toBeLessThanOrEqual(sheetBox!.y + 0.5);
}

async function scrollerRelativeTop(row: Locator): Promise<number> {
  return row.evaluate((message) => {
    const scroller = message.closest('[data-message-scroller]');
    if (!scroller) {
      throw new Error('message is not inside its timeline scroller');
    }
    return (
      message.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    );
  });
}

async function expectScrollerPositionRestored(
  row: Locator,
  before: number,
): Promise<void> {
  await expect
    .poll(async () => Math.abs((await scrollerRelativeTop(row)) - before), {
      timeout: 10_000,
      intervals: [100],
    })
    .toBeLessThanOrEqual(2);
}

test.use({ ...devices['Pixel 5'] });

test.describe('Message actions on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 90_000 });

  test('a long press opens a sheet, and picking Reply starts a reply', async ({
    page,
    request,
  }) => {
    const rowSel = await openRoomWithMessage(page, request, 'a');

    const row = page.locator(rowSel);
    await expect(row.locator('.msg__toolbar')).toHaveCount(0);
    const bodyWidth = await row
      .locator('.msg__body')
      .evaluate((body) => body.getBoundingClientRect().width);
    expect(bodyWidth).toBeGreaterThan(200);

    await longPress(page, rowSel);

    // The sheet, and NOT the hover bar. A revealed toolbar is `opacity: 1` on the row, and
    // a hidden one is `opacity: 0` — which Playwright still reports as visible, so the
    // class is what has to be asserted.
    const dialog = page.getByRole('dialog', { name: 'Message actions' });
    const sheet = dialog.getByTestId('action-sheet-surface');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheetAtRest(sheet);
    await expect(page.locator(`${rowSel}.msg--revealed`)).toHaveCount(0);

    // It is a named dialog, not a bare one.
    await expect(
      page.locator('[role=dialog][aria-label="Message actions"]'),
    ).toHaveCount(1);

    // Every row is REACHABLE — which for a list this long means reachable by scrolling
    // INSIDE the sheet, not all visible at once. Two things to hold: the sheet itself sits
    // within the viewport (it is bounded by 90svh and the top safe-area inset, so it cannot run off the screen), and
    // the last row can be scrolled to. Asserting that every row fits unscrolled was the
    // earlier version of this check, and it started failing the moment a row was added —
    // which is the behaviour the scroller exists to provide, not a regression.
    const sheetBox = await sheet.boundingBox();
    const viewportHeight = page.viewportSize()?.height ?? 0;
    expect(sheetBox).not.toBeNull();
    // The sheet may move the timeline, but it may neither cover the message being acted on
    // nor shove it outside its own scroller to make the overlap assertion pass vacuously.
    await expectMessageClearOfSheet(page.locator(rowSel), sheet);
    expect(sheetBox!.y).toBeGreaterThanOrEqual(0);
    expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(
      viewportHeight + 1,
    );

    const cancel = sheet.getByText('Cancel');
    await cancel.scrollIntoViewIfNeeded();
    await expect(cancel).toBeVisible();
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox).not.toBeNull();
    expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(
      viewportHeight + 1,
    );

    // And it does the thing. Reply is the cheapest action to observe end to end.
    await page.getByTestId('sheet-reply').click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      {
        timeout: 10_000,
      },
    );
  });

  test('the sheet slides up and pushes the pressed message along, with no jump', async ({
    page,
    request,
  }) => {
    const rowSel = await openRoomWithMessage(page, request, 's', 30);
    const frames = await sampleSheetFrames(page, rowSel);

    await longPress(page, rowSel);
    const sheet = page
      .getByRole('dialog', { name: 'Message actions' })
      .getByTestId('action-sheet-surface');
    await expectMessageClearOfSheet(page.locator(rowSel), sheet);

    const seen = await frames.jsonValue();
    expect(
      seen.filter((frame) => frame.sliding && frame.slide > 1),
    ).not.toEqual([]);
    // Once the row has moved, the edge is what moved it. A timeline that jumps to its final
    // place sits far above a sheet still on its way up.
    const moved = seen.filter((frame) => frame.rowTop < seen[0].rowTop - 1);
    expect(moved).not.toEqual([]);
    for (const frame of moved) {
      expect(frame.rowBottom + 8).toBeGreaterThanOrEqual(frame.sheetTop - 2);
    }
  });

  test('under reduced motion the sheet is simply there', async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const rowSel = await openRoomWithMessage(page, request, 'm', 30);
    const frames = await sampleSheetFrames(page, rowSel);

    await longPress(page, rowSel);
    const sheet = page
      .getByRole('dialog', { name: 'Message actions' })
      .getByTestId('action-sheet-surface');
    await expectMessageClearOfSheet(page.locator(rowSel), sheet);

    const seen = await frames.jsonValue();
    // A 0.01ms entrance waits off-screen for its first frames, then is done: never partly up.
    const offScreen = page.viewportSize()!.height - 1;
    expect(
      seen.filter((frame) => frame.slide > 0 && frame.sheetTop < offScreen),
    ).toEqual([]);
    expect(seen.at(-1)!.slide).toBe(0);
  });

  test('reacting from the sheet puts the reaction on the message', async ({
    page,
    request,
  }) => {
    // The quick strip exists because reacting is the highest-frequency message action and
    // six full-width text rows would push everything else off the screen. It is also the
    // one part of the sheet that is not a plain button row, so it gets its own check.
    const rowSel = await openRoomWithMessage(page, request, 'b');
    await longPress(page, rowSel);
    await expect(page.locator('trn-action-list')).toBeVisible({
      timeout: 10_000,
    });

    // The exact id, not the `^=` prefix: `sheet-react-more` matches that prefix too, and
    // `.first()` only misses it because the strip happens to render above the button list.
    // Reordering the sheet would silently start clicking "More reactions…" instead.
    await page.locator('[data-testid="sheet-react-👍"]').click();

    await expect(page.locator('trn-action-list')).toHaveCount(0);
    await expect(page.locator(`${rowSel} trn-message-reactions`)).toContainText(
      '👍',
      { timeout: 15_000 },
    );
  });

  test('tapping outside closes the sheet without acting', async ({
    page,
    request,
  }) => {
    // The backdrop is the way out on a phone — there is no Escape key and no hover to
    // move away. Nothing must fire on the way.
    const rowSel = await openRoomWithMessage(page, request, 'c');
    await longPress(page, rowSel);
    const sheet = page.locator('trn-action-list');
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    await page
      .locator('.cdk-overlay-backdrop')
      .click({ position: { x: 5, y: 5 } });

    await expect(sheet).toHaveCount(0);
    // No reply started, no reaction added — dismissing is not choosing.
    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });

  test('the finger that opened the sheet selects nothing in it', async ({
    page,
    request,
  }) => {
    // The finger is still down when the sheet opens under it, and the browser carries the same
    // touch on (#1868): iOS WebKit into a selection and callout there, Chromium into a click on
    // the sheet row its lift lands on. A real touch, held through the opening, nudged and lifted.
    const rowSel = await openRoomWithMessage(page, request, 'sel');
    const row = page.locator(rowSel);
    const dialog = page.getByRole('dialog', { name: 'Message actions' });
    const sheet = dialog.getByTestId('action-sheet-surface');
    const cdp = await page.context().newCDPSession(page);
    try {
      await expect(async () => {
        await waitUntilStill(row);
        const box = (await row.locator('.msg__body').boundingBox())!;
        const at = {
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
          id: 1,
        };
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [at],
        });
        try {
          // A sync re-render mid-hold drops the press; a person would press again.
          await expect(sheet).toBeVisible({ timeout: 1_500 });
          await page.waitForTimeout(600);
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ ...at, x: at.x + 3, y: at.y + 2 }],
          });
        } finally {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
          });
        }
      }).toPass({ timeout: 20_000 });
    } finally {
      await cdp.detach();
    }

    // The lift chose nothing: the sheet is still open and no row's action ran.
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe(
      '',
    );
    expect(
      await sheet.evaluate((el) => {
        const selection = getSelection();
        return (
          selection !== null &&
          !selection.isCollapsed &&
          selection.containsNode(el, true)
        );
      }),
    ).toBe(false);
    // Lifting the finger hands selection back for a fresh, deliberate press.
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.body).userSelect),
      )
      .not.toBe('none');
  });

  test('keeps a windowed target connected and restores the latest state on close', async ({
    page,
    request,
  }) => {
    const rowSel = await openRoomWithMessage(page, request, 'v', 81);
    const timeline = page.locator('[data-message-scroller]').first();
    const rows = timeline.locator('trn-message-row');

    await expect(page.locator('trn-message-list')).toBeVisible();
    await expect
      .poll(
        async () => {
          await timeline.evaluate((element) => (element.scrollTop = 0));
          return timeline
            .getByText('sheet filler v 0', { exact: true })
            .count();
        },
        { timeout: 60_000, intervals: [400] },
      )
      .toBeGreaterThan(0);
    const jumpToLatest = page.getByTestId('jump-to-latest');
    await expect(jumpToLatest).toBeVisible({ timeout: 15_000 });
    await jumpToLatest.click();
    const row = page.locator(rowSel);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(jumpToLatest).toBeHidden();
    await expect.poll(() => rows.count()).toBeLessThan(80);
    const targetTopBefore = await scrollerRelativeTop(row);

    await longPress(page, rowSel);
    const dialog = page.getByRole('dialog', { name: 'Message actions' });
    const sheet = dialog.getByTestId('action-sheet-surface');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveCount(1);
    await expectMessageClearOfSheet(row, sheet);
    await expect(jumpToLatest).toBeHidden();

    await page
      .locator('.cdk-overlay-backdrop')
      .click({ position: { x: 5, y: 5 } });

    await expect(sheet).toHaveCount(0);
    await expect(row).toBeVisible();
    await expectScrollerPositionRestored(row, targetTopBefore);
    await expect(jumpToLatest).toBeHidden();
  });

  test('keeps the acted-on thread reply above the same sheet', async ({
    page,
    request,
  }) => {
    const rowSel = await openRoomWithMessage(page, request, 't');
    await longPress(page, rowSel);
    await page.getByTestId('sheet-thread').click();

    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible({ timeout: 15_000 });
    const threadRow = thread.locator('.msg[data-mid]').last();
    await expect(threadRow).toBeVisible();
    const targetTopBefore = await scrollerRelativeTop(threadRow);

    await longPressTarget(page, threadRow);
    const dialog = page.getByRole('dialog', { name: 'Message actions' });
    const sheet = dialog.getByTestId('action-sheet-surface');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expectMessageClearOfSheet(threadRow, sheet);

    await page
      .locator('.cdk-overlay-backdrop')
      .click({ position: { x: 5, y: 5 } });

    await expect(sheet).toHaveCount(0);
    await expectScrollerPositionRestored(threadRow, targetTopBefore);
  });
});
