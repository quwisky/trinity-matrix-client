import { test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  readPreference,
  synapseSession,
} from '../../../support/app.mts';

/**
 * Dragging a pane changes the layout, and the layout survives a reload.
 *
 * The unit tests pin the handle's arithmetic — the CSS property it writes, the clamping, the
 * keyboard steps — against a fake shell. What they cannot see is whether the property is
 * actually WIRED to anything: `.shell-side` reads `--shell-sidebar-w` in a stylesheet, the
 * shell root carries it as a binding, and the committed value goes out to
 * `@capacitor/preferences`. Any one of those could be wrong with every unit test green and
 * the pane simply not moving.
 *
 * Reload is the half that matters most and is the easiest to get subtly wrong: the width is
 * loaded by an app initializer, so a persisted layout has to be in place before the first
 * paint rather than applied after it.
 *
 * Needs a Synapse homeserver (Docker) and self-skips otherwise.
 */
const session = synapseSession();

/** The server rail is a fixed column; everything the drag adds goes to the room list. */
const RAIL_WIDTH = 72;
const CHAT_MIN_WIDTH = 320;
const SIDEBAR_STORAGE_KEY = 'trinity.shell.sidebar-width';

async function shellGeometry(page: Page) {
  return page.locator('[data-shell-root]').evaluate((shell) => {
    const sidebar = shell.querySelector('.shell-side');
    const main = shell.querySelector('.main');
    const rail = shell.querySelector('.rail');
    const roomList = shell.querySelector('.sidebar');
    if (!sidebar || !main || !rail || !roomList) {
      throw new Error('rooms shell panes are incomplete');
    }

    const rectOf = (element: Element) => {
      const { left, right, width } = element.getBoundingClientRect();
      return {
        left: Math.round(left),
        right: Math.round(right),
        width: Math.round(width),
      };
    };

    return {
      shell: rectOf(shell),
      sidebar: rectOf(sidebar),
      main: rectOf(main),
      rail: rectOf(rail),
      roomList: rectOf(roomList),
    };
  });
}

test.describe('Resizable panes', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('drags the room list wider, and it is still wider after a reload', async ({
    page,
  }) => {
    await login(page, session);

    const sidebar = page.locator('.shell-side');
    await expect(sidebar).toBeVisible({ timeout: 30_000 });

    const handle = page.getByRole('separator', { name: 'Room list width' });
    await expect(handle).toBeVisible();

    const before = (await sidebar.boundingBox())?.width ?? 0;
    expect(before).toBeGreaterThan(0);

    // Drag right by 80px. Three moves rather than one: a single jump can be delivered as a
    // click with no intermediate `pointermove`, and the whole gesture lives in those moves.
    const box = (await handle.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, y);
    await page.mouse.move(box.x + 60, y);
    await page.mouse.move(box.x + 80, y);
    await page.mouse.up();

    // POLLED, not read once. The commit goes signal -> change detection -> layout, so the
    // box read immediately after `mouse.up()` is a race — it was, and this spec was flaky
    // for exactly that reason on the run that introduced it.
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width ?? 0, {
        timeout: 10_000,
      })
      .toBeGreaterThan(before + 50);

    const after = (await sidebar.boundingBox())?.width ?? 0;

    // The ROOM LIST, not just the column around it. `.shell-side` is a flex row holding a
    // fixed 72px rail and the list; if the list does not absorb the difference, dragging out
    // opens a strip of bare rail colour and dragging in paints the list over the timeline,
    // while this test's `.shell-side` measurement moves exactly as it should.
    const list =
      (await page.locator('.sidebar').first().boundingBox())?.width ?? 0;
    expect(Math.round(list)).toBe(Math.round(after - RAIL_WIDTH));

    // The committed width is announced, so a screen reader is not left describing the old one.
    await expect(handle).toHaveAttribute(
      'aria-valuenow',
      String(Math.round(after)),
    );

    await page.reload();
    await expect(page.locator('.shell-side')).toBeVisible({ timeout: 30_000 });

    const restored =
      (await page.locator('.shell-side').boundingBox())?.width ?? 0;
    expect(Math.abs(restored - after)).toBeLessThanOrEqual(2);
  });

  test('resizes from the keyboard, and refuses to go past its bounds', async ({
    page,
  }) => {
    // The interaction a pointer drag cannot be emulated with. Home is the lower bound, so
    // this also proves the clamp is real rather than advisory.
    await login(page, session);

    const sidebar = page.locator('.shell-side');
    await expect(sidebar).toBeVisible({ timeout: 30_000 });

    const handle = page.getByRole('separator', { name: 'Room list width' });
    await handle.focus();

    const min = Number(await handle.getAttribute('aria-valuemin'));
    const max = Number(await handle.getAttribute('aria-valuemax'));
    expect(min).toBeGreaterThan(0);

    await handle.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));

    // Past the top: the value must stay put rather than keep climbing.
    await handle.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));

    await handle.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', String(min));

    await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(min));

    const narrow = (await sidebar.boundingBox())?.width ?? 0;
    expect(Math.abs(narrow - min)).toBeLessThanOrEqual(2);

    // And the list came with it rather than overflowing the column it lives in — the failure
    // that reads as the room list sitting on top of the conversation.
    const list =
      (await page.locator('.sidebar').first().boundingBox())?.width ?? 0;
    expect(Math.round(list)).toBe(Math.round(narrow - RAIL_WIDTH));
  });

  test('temporarily yields a maximum sidebar to the chat on narrower desktops', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, session);

    const sidebar = page.locator('.shell-side');
    await expect(sidebar).toBeVisible({ timeout: 30_000 });

    const handle = page.getByRole('separator', { name: 'Room list width' });
    const max = Number(await handle.getAttribute('aria-valuemax'));
    expect(max).toBe(560);

    await handle.focus();
    await handle.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));
    await expect
      .poll(() => readPreference(page, SIDEBAR_STORAGE_KEY))
      .toBe(String(max));
    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
      .toBe(max);

    // Both ends of the affected interval: 879px needs the sidebar to yield by one pixel,
    // while 768px is the narrowest width at which both panes remain in the desktop row.
    for (const viewportWidth of [879, 768]) {
      await page.setViewportSize({ width: viewportWidth, height: 720 });

      const renderedSidebarWidth = viewportWidth - CHAT_MIN_WIDTH;
      await expect
        .poll(() => shellGeometry(page))
        .toEqual({
          shell: { left: 0, right: viewportWidth, width: viewportWidth },
          sidebar: {
            left: 0,
            right: renderedSidebarWidth,
            width: renderedSidebarWidth,
          },
          main: {
            left: renderedSidebarWidth,
            right: viewportWidth,
            width: CHAT_MIN_WIDTH,
          },
          rail: { left: 0, right: RAIL_WIDTH, width: RAIL_WIDTH },
          roomList: {
            left: RAIL_WIDTH,
            right: renderedSidebarWidth,
            width: renderedSidebarWidth - RAIL_WIDTH,
          },
        });

      // The handle stays at the rendered pane edge even though storage keeps the preference.
      await expect(handle).toHaveAttribute(
        'aria-valuenow',
        String(renderedSidebarWidth),
      );
      expect(await readPreference(page, SIDEBAR_STORAGE_KEY)).toBe(String(max));
    }

    // Growing is impossible at the live cap. It must be a no-op rather than silently
    // replacing the preserved 560px preference with 464px, which would only become visible
    // after the window widened again.
    await expect(handle).toHaveAttribute('aria-valuemax', '448');
    const clampedBox = (await handle.boundingBox())!;
    const clampedY = clampedBox.y + clampedBox.height / 2;
    const clampedX = clampedBox.x + clampedBox.width / 2;
    await page.mouse.move(clampedX, clampedY);
    await page.mouse.down();
    await page.mouse.move(clampedX + 8, clampedY);
    await page.mouse.move(clampedX + 16, clampedY);
    await page.mouse.up();
    await handle.press('ArrowRight');

    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
      .toBe(448);
    await expect
      .poll(() => readPreference(page, SIDEBAR_STORAGE_KEY))
      .toBe(String(max));

    // Widening has to restore the preference without another write or reload.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
      .toBe(max);
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));

    // Interaction must start at the rendered edge, not at the hidden preference. At 768px
    // the difference is 112px; using 560 as the baseline made this 16px drag and the first
    // seven ArrowLeft presses write values that flexbox still had to clamp, so nothing moved.
    await page.setViewportSize({ width: 768, height: 720 });
    await expect(handle).toHaveAttribute('aria-valuenow', '448');

    const box = (await handle.boundingBox())!;
    const y = box.y + box.height / 2;
    const x = box.x + box.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 8, y);
    await page.mouse.move(x - 16, y);
    await page.mouse.up();

    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
      .toBe(432);
    await expect(handle).toHaveAttribute('aria-valuenow', '432');
    await expect
      .poll(() => readPreference(page, SIDEBAR_STORAGE_KEY))
      .toBe('432');

    // Reset the preference while still clamped, then prove the first keypress moves the pane.
    await handle.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '448');
    await handle.press('ArrowLeft');
    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
      .toBe(432);
    await expect(handle).toHaveAttribute('aria-valuenow', '432');
    await expect
      .poll(() => readPreference(page, SIDEBAR_STORAGE_KEY))
      .toBe('432');
  });
});
