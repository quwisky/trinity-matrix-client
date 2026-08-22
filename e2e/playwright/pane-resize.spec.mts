import { test, expect } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

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
});
