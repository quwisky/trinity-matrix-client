import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  readPreference,
  seedPreference,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { apiLogin, registerUser } from '../../../support/account.mts';
import { createRoom } from '../../support/space-journey.mts';

/**
 * The room side panel's divider: one stored width for every panel, dragged or keyed, kept
 * across a reload, and never at the cost of the timeline's 320px floor or of the panel's own
 * edge. From 1280px the panel runs the full height of the room in a grid track; below it, it
 * shares the row under the room header. Both have to squeeze a wide stored panel rather than
 * push it past the window.
 *
 * Needs a Synapse homeserver and self-skips otherwise.
 */
const session = homeserverSession();

const PANEL_WIDTH_KEY = 'trinity.shell.right-panel-width';
const SIDEBAR_WIDTH_KEY = 'trinity.shell.sidebar-width';
const TIMELINE_FLOOR = 320;

async function seedRoom(
  request: Parameters<typeof apiLogin>[0],
  runId: string,
): Promise<{ reader: HomeserverSession; roomName: string }> {
  const hs = session.hs as string;
  const user = `panel-resize-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Panel resize ${runId}`;
  await registerUser(request, user, pass);
  const account = await apiLogin(request, hs, user, pass);
  await createRoom(request, hs, account, roomName);
  return { reader: { available: true, hs, user, pass }, roomName };
}

async function openMembers(page: Page, roomName: string): Promise<void> {
  const channel = page.locator('.channel', { hasText: roomName }).first();
  if (!(await channel.isVisible())) {
    await page.getByTestId('rail-rooms').click();
  }
  await channel.waitFor({ state: 'visible', timeout: 30_000 });
  await channel.click();
  await expect(page.locator('.scroll').first()).toBeVisible({
    timeout: 15_000,
  });
  if ((await page.locator('.chat-members').count()) === 0) {
    await page.getByTestId('toggle-members').click();
  }
  await expect(page.locator('.chat-members')).toBeVisible({ timeout: 10_000 });
}

/** The slot, the conversation column and the timeline, as rendered. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box
        ? {
            left: Math.round(box.left),
            right: Math.round(box.right),
            width: Math.round(box.width),
          }
        : null;
    };
    return {
      panel: rect('[data-right-panel-surface]'),
      main: rect('.main'),
      timeline: rect('.chat-body > trn-message-list'),
      close: rect('[data-right-panel-surface] trn-side-panel-header button'),
    };
  });
}

/** The panel stays inside the conversation column, its close button included. */
async function expectNotClipped(page: Page): Promise<void> {
  const { panel, main, timeline, close } = await geometry(page);
  expect(panel!.right).toBeLessThanOrEqual(main!.right);
  expect(close!.right).toBeLessThanOrEqual(main!.right);
  expect(timeline!.width).toBeGreaterThanOrEqual(TIMELINE_FLOOR);
  await expect(page.getByTestId('close-members')).toBeInViewport();
  // The room header keeps its actions apart: none of its buttons overlaps another.
  const overlaps = await page
    .locator('header[data-trn-layout="toolbar"]')
    .evaluate((header) => {
      const boxes = [...header.querySelectorAll('button, input')]
        .map((el) => el.getBoundingClientRect())
        .filter((box) => box.width > 0);
      return boxes.some((a, i) =>
        boxes
          .slice(i + 1)
          .some(
            (b) =>
              a.left < b.right - 1 &&
              b.left < a.right - 1 &&
              a.top < b.bottom - 1 &&
              b.top < a.bottom - 1,
          ),
      );
    });
  expect(overlaps).toBe(false);
}

test.describe('Side panel width', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test('drags the panel wider, and the width is still there after a reload', async ({
    page,
    request,
  }) => {
    const { reader, roomName } = await seedRoom(
      request,
      testResourceId('drag'),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, reader);
    await openMembers(page, roomName);

    const panel = page.locator('.chat-members');
    const handle = page.getByRole('separator', { name: 'Panel width' });
    expect(Math.round((await panel.boundingBox())!.width)).toBe(360);

    // The divider grows the panel to its right, so dragging left widens it. Several moves:
    // the gesture lives in the `pointermove`s.
    const box = (await handle.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    for (const dx of [-30, -70, -100]) {
      await page.mouse.move(box.x + box.width / 2 + dx, y);
    }
    await page.mouse.up();

    await expect
      .poll(async () => Math.round((await panel.boundingBox())!.width))
      .toBe(460);
    await expect(handle).toHaveAttribute('aria-valuenow', '460');
    await expect.poll(() => readPreference(page, PANEL_WIDTH_KEY)).toBe('460');

    // Another panel takes the same width.
    await page.getByTestId('open-pinned').click();
    await expect(page.getByTestId('pinned-panel')).toBeVisible();
    expect(
      Math.round((await page.locator('.chat-panel').boundingBox())!.width),
    ).toBe(460);

    await page.reload();
    await expect(page.locator('.chat-panel')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () =>
        Math.round((await page.locator('.chat-panel').boundingBox())!.width),
      )
      .toBe(460);
  });

  test('resizes the member list from the keyboard, within its bounds', async ({
    page,
    request,
  }) => {
    const { reader, roomName } = await seedRoom(
      request,
      testResourceId('keys'),
    );
    // Wide enough that the 720px maximum fits beside the room column's floor.
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page, reader);
    await openMembers(page, roomName);

    const handle = page.getByRole('separator', { name: 'Panel width' });
    await handle.focus();
    const min = Number(await handle.getAttribute('aria-valuemin'));
    const max = Number(await handle.getAttribute('aria-valuemax'));
    expect([min, max]).toEqual([280, 720]);

    await handle.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));
    // Past the top the value stays put.
    await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));

    await handle.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', String(min));
    await handle.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', String(min));

    // Left grows this panel, which sits to the divider's right; Shift takes the long step.
    await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(min + 16));
    await handle.press('Shift+ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(min + 80));
    expect(
      Math.round((await page.locator('.chat-members').boundingBox())!.width),
    ).toBe(min + 80);
  });

  for (const viewport of [
    { width: 1180, height: 800, layout: 'the row under the room header' },
    { width: 1280, height: 800, layout: 'the full-height grid' },
    { width: 1440, height: 900, layout: 'the full-height grid' },
  ]) {
    test(`squeezes a wide stored panel at ${viewport.width}px (${viewport.layout}), never clipping it`, async ({
      page,
      request,
    }) => {
      const { reader, roomName } = await seedRoom(
        request,
        testResourceId(`wide${viewport.width}`),
      );
      await seedPreference(page, PANEL_WIDTH_KEY, '720');
      await page.setViewportSize(viewport);
      await login(page, reader);
      await openMembers(page, roomName);
      await expectNotClipped(page);

      // The divider says how wide the panel really is, not the stored 720.
      const { panel } = await geometry(page);
      const handle = page.getByRole('separator', { name: 'Panel width' });
      await expect(handle).toHaveAttribute(
        'aria-valuenow',
        String(Math.min(720, panel!.width)),
      );

      // With the widest room list too.
      await seedPreference(page, SIDEBAR_WIDTH_KEY, '560');
      await page.reload();
      await expect(page.locator('.chat-members')).toBeVisible({
        timeout: 30_000,
      });
      await expectNotClipped(page);
      await test.info().attach(`wide-panel-${viewport.width}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });
  }
});
