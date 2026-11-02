import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  clickRowToolbar,
  homeserverSession,
  login,
} from '../../../support/app.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';
import {
  seedFormattedRoom,
  sendMessage,
} from '../../support/formatted-message-journey.mts';

// Measuring a growing composer must not move the timeline: jsdom cannot show the browser
// clamping scrollTop during the measurement's forced layout, so this needs real layout.
const session = homeserverSession();
const BURST = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do ';
const BURSTS = 8;
const ROWS = 20;

const gapOf = (page: Page): Promise<number> =>
  page
    .locator('.scroll')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

const expectPinned = (page: Page): Promise<void> =>
  expect.poll(() => gapOf(page)).toBeLessThan(1);

/** The scroller's position and the field's height after two more frames. */
const settled = (field: Locator) =>
  field.evaluate(async (input) => {
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
    return {
      top: (document.querySelector('.scroll') as HTMLElement).scrollTop,
      height: (input as HTMLElement).offsetHeight,
    };
  });

/** Open a room that overflows its viewport, on its newest row, with the field focused. */
async function openFullRoom(
  page: Page,
  request: APIRequestContext,
): Promise<Locator> {
  const room = await seedFormattedRoom(
    request,
    session.hs as string,
    'growth-pin',
  );
  for (let i = 0; i < ROWS; i++) {
    await sendMessage(request, session.hs as string, room, {
      body: `Row ${i} ${BURST.repeat(6)}`,
    });
  }
  await login(page, room.session);
  await page.locator('.channel', { hasText: room.roomName }).first().click();
  const field = page.getByTestId('composer-input');
  await field.waitFor({ timeout: 30_000 });
  await expect(page.locator('.msg__text').last()).toContainText(
    `Row ${ROWS - 1} `,
    { timeout: 30_000 },
  );
  expect(
    await page
      .locator('.scroll')
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await expectPinned(page);
  await field.click();
  return field;
}

test.describe('Composer growth at the bottom of a room', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test.describe('on a phone', () => {
    test.use(DESIGN_VIEWPORTS['phone-pixel-5']);

    test('keeps a pinned reader on the newest message and leaves a reader who scrolled up', async ({
      page,
      request,
    }) => {
      const field = await openFullRoom(page, request);

      const resting = await settled(field);
      for (let i = 0; i < BURSTS; i++) {
        await field.pressSequentially(BURST);
        await expectPinned(page);
      }
      const grown = await settled(field);
      // The draft really wrapped over several lines, else this proves nothing.
      expect(grown.height).toBeGreaterThan(resting.height + 40);

      // Deleting lines still shrinks the field, with the reader on the newest message.
      await field.fill(BURST);
      await expectPinned(page);
      expect((await settled(field)).height).toBeLessThan(grown.height);

      // Slightly up is a reading position: the field keeps growing, the reader does not move.
      const up = await field.evaluate(() => {
        const el = document.querySelector('.scroll') as HTMLElement;
        el.scrollTop -= 3;
        return el.scrollTop;
      });
      expect(up).toBeGreaterThan(0);
      for (let i = 0; i < BURSTS; i++) {
        await field.pressSequentially(BURST);
        expect((await settled(field)).top).toBe(up);
      }
    });
  });

  test('keeps a pinned reader on the newest message through the preview', async ({
    page,
    request,
  }) => {
    const field = await openFullRoom(page, request);
    const resting = await settled(field);
    await field.fill(Array.from({ length: 6 }, () => 'a line').join('\n'));
    await expectPinned(page);
    const writing = await settled(field);
    expect(writing.height).toBeGreaterThan(resting.height + 40);

    const togglePreview = async (): Promise<void> => {
      await page.getByTestId('composer-format').click();
      await page
        .getByTestId('composer-format-menu')
        .getByTestId('format-preview')
        .click();
    };
    await togglePreview();
    await expect(page.getByTestId('composer-preview')).toBeVisible();
    await expectPinned(page);

    await togglePreview();
    await expect(field).toBeVisible();
    await expectPinned(page);
    expect((await settled(field)).height).toBe(writing.height);
  });

  test('keeps a pinned reader on the newest reply in a thread, and leaves one who scrolled up', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'thread-pin');
    const root = await sendMessage(request, hs, room, { body: 'Thread root' });
    for (let i = 0; i < ROWS; i++) {
      await sendMessage(request, hs, room, {
        body: `Reply ${i} ${BURST.repeat(6)}`,
        threadRoot: root,
      });
    }
    await login(page, room.session);
    await page.locator('.channel', { hasText: room.roomName }).first().click();
    const rootRow = page.locator('.scroll .msg[data-mid]', {
      hasText: 'Thread root',
    });
    await expect(rootRow).toBeVisible({ timeout: 30_000 });
    await clickRowToolbar(
      rootRow,
      rootRow.getByRole('button', { name: 'Reply in thread' }),
    );
    const thread = page.getByTestId('thread-view');
    await expect(thread.locator('.msg__text').last()).toContainText(
      `Reply ${ROWS - 1} `,
      { timeout: 30_000 },
    );
    const scroller = thread.locator('.thread');
    const gap = (): Promise<number> =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      );
    const bottom = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollHeight > el.clientHeight;
    });
    expect(bottom).toBe(true);
    await expect.poll(gap).toBeLessThan(1);

    const field = thread.getByTestId('composer-input');
    await field.click();
    const resting = await field.evaluate(
      (el) => (el as HTMLElement).offsetHeight,
    );
    for (let i = 0; i < BURSTS; i++) {
      await field.pressSequentially(BURST);
      await expect.poll(gap).toBeLessThan(1);
    }
    const grown = await field.evaluate(
      (el) => (el as HTMLElement).offsetHeight,
    );
    expect(grown).toBeGreaterThan(resting + 40);

    // Slightly up is a reading position: the draft grows, the reader does not move.
    await field.fill('');
    await expect.poll(gap).toBeLessThan(1);
    const up = await scroller.evaluate((el) => {
      el.scrollTop -= 3;
      return el.scrollTop;
    });
    expect(up).toBeGreaterThan(0);
    await field.pressSequentially(BURST.repeat(3));
    await page.waitForTimeout(100);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(up);
  });
});
