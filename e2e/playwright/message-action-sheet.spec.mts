import {
  test,
  expect,
  devices,
  type APIRequestContext,
  type Locator,
  type Page,
} from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// The message action sheet (#220), which no other spec can see. Every authenticated spec
// runs the desktop Chromium project, where a message's actions are a bar revealed by
// :hover — a surface that on a phone covered the message it acted on, closed on any
// scroll, and opened its reaction picker off the top of the scroller.
//
// `devices['Pixel 5']` and not merely `hasTouch`: the branch is chosen by `isMobileOs()`,
// which reads the PLATFORM. A touch-emulated desktop Chromium keeps its desktop user agent
// and would take the desktop path, so a spec written on the `composer-formatting.spec.mts`
// phone pattern would silently assert nothing.
const session = synapseSession();

/** Press and hold past the 500ms threshold, the way a finger does. */
async function longPress(page: Page, selector: string): Promise<void> {
  await longPressTarget(page, page.locator(selector).first());
}

async function longPressTarget(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) {
    throw new Error('no box for long-press target');
  }
  const point = {
    isPrimary: true,
    pointerType: 'touch',
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  };
  await target.dispatchEvent('pointerdown', point);
  await page.waitForTimeout(700);
  // A finger LIFTS. Without the release the page is left with a pointer down forever —
  // a state no gesture can produce, and one that made an earlier probe report a defect
  // that did not exist (see the correction on #220).
  await target.dispatchEvent('pointerup', point);
}

/** Open a seeded room and hand back the newest row's stable selector. */
async function openRoomWithMessage(
  page: Page,
  request: APIRequestContext,
  tag: string,
  messageCount = 1,
): Promise<string> {
  const hs = session.hs as string;
  const runId = `${Date.now().toString(36)}${tag}`;
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
  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json());
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

  await login(page, { available: true, hs, user, pass } as SynapseSession);
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

async function expectMessageClearOfSheet(
  row: Locator,
  sheet: Locator,
): Promise<void> {
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
    await expect(page.locator(`${rowSel}.msg--revealed`)).toHaveCount(0);

    // It is a named dialog, not a bare one.
    await expect(
      page.locator('[role=dialog][aria-label="Message actions"]'),
    ).toHaveCount(1);

    // Every row is REACHABLE — which for a list this long means reachable by scrolling
    // INSIDE the sheet, not all visible at once. Two things to hold: the sheet itself sits
    // within the viewport (it is bounded by 80svh, so it cannot run off the screen), and
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

  test('reacting from the sheet puts the reaction on the message', async ({
    page,
    request,
  }) => {
    // The quick strip exists because reacting is the highest-frequency message action and
    // six full-width text rows would push everything else off the screen. It is also the
    // one part of the sheet that is not a plain button row, so it gets its own check.
    const rowSel = await openRoomWithMessage(page, request, 'b');
    await longPress(page, rowSel);
    await expect(page.locator('trn-action-sheet')).toBeVisible({
      timeout: 10_000,
    });

    // The exact id, not the `^=` prefix: `sheet-react-more` matches that prefix too, and
    // `.first()` only misses it because the strip happens to render above the button list.
    // Reordering the sheet would silently start clicking "More reactions…" instead.
    await page.locator('[data-testid="sheet-react-👍"]').click();

    await expect(page.locator('trn-action-sheet')).toHaveCount(0);
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
    const sheet = page.locator('trn-action-sheet');
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    await page
      .locator('.cdk-overlay-backdrop')
      .click({ position: { x: 5, y: 5 } });

    await expect(sheet).toHaveCount(0);
    // No reply started, no reaction added — dismissing is not choosing.
    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });

  test('keeps a windowed target connected and restores the latest state on close', async ({
    page,
    request,
  }) => {
    const rowSel = await openRoomWithMessage(page, request, 'v', 81);
    const timeline = page.locator('[data-message-scroller]').first();
    const rows = timeline.locator('trn-message-row');

    await expect(page.locator('trn-virtual-message-list')).toBeVisible();
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
