import { expect, test, devices, type Page } from '../../../fixtures.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import {
  seedFormattedRoom,
  sendMessage,
} from '../../support/formatted-message-journey.mts';
import { cdpSwipe } from '../../../support/touch-platform.mts';

// Dragging the timeline down with the keyboard up dismisses it, as phones do. Real touch through
// CDP, on a phone profile: a drag that never reaches the page as touch events proves nothing.
const session = homeserverSession();
const ROWS = 20;

test.use({ ...devices['Pixel 5'] });

test.describe('Dragging the timeline with the keyboard up', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 120_000 });

  async function openRoom(
    page: Page,
    request: Parameters<typeof seedFormattedRoom>[0],
  ) {
    const room = await seedFormattedRoom(
      request,
      session.hs as string,
      'drag-kb',
    );
    for (let i = 0; i < ROWS; i++) {
      await sendMessage(request, session.hs as string, room, {
        body: `Row ${i} ${'lorem ipsum dolor sit amet '.repeat(6)}`,
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
    await field.click();
    await expect(field).toBeFocused();
    const box = (await page.locator('.scroll').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return { field, x, y };
  }

  for (const [name, dx, dy, dismisses] of [
    ['a downward drag', 0, 120, true],
    ['a small drag', 0, 30, false],
    ['an upward drag', 0, -120, false],
    ['a sideways swipe on a message', 120, 10, false],
  ] as const) {
    test(`${name} ${dismisses ? 'dismisses' : 'keeps'} the keyboard`, async ({
      page,
      request,
    }) => {
      const { field, x, y } = await openRoom(page, request);
      const from = { x: x - dx / 2, y: y - dy / 2 };
      await cdpSwipe(page, from, { x: from.x + dx, y: from.y + dy });
      if (dismisses) {
        await expect(field).not.toBeFocused();
      } else {
        await page.waitForTimeout(500);
        await expect(field).toBeFocused();
      }
    });
  }

  test('a downward drag in a thread dismisses the keyboard', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'drag-kb-thread');
    const root = await sendMessage(request, hs, room, { body: 'Thread root' });
    for (let i = 0; i < ROWS; i++) {
      await sendMessage(request, hs, room, {
        body: `Reply ${i} ${'lorem ipsum dolor sit amet '.repeat(6)}`,
        threadRoot: root,
      });
    }
    await login(page, room.session);
    await page.locator('.channel', { hasText: room.roomName }).first().click();
    const rootRow = page.locator('.scroll .msg[data-mid]', {
      hasText: 'Thread root',
    });
    await expect(rootRow).toBeVisible({ timeout: 30_000 });
    await rootRow.getByTestId('message-thread-summary').tap();
    const thread = page.getByTestId('thread-view');
    await expect(thread.locator('.msg__text').last()).toContainText(
      `Reply ${ROWS - 1} `,
      { timeout: 30_000 },
    );
    const field = thread.getByTestId('composer-input');
    await field.click();
    await expect(field).toBeFocused();
    const box = (await thread.locator('.scroll').boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 - 60 };
    await cdpSwipe(page, from, { x: from.x, y: from.y + 120 });
    await expect(field).not.toBeFocused();
  });
});
