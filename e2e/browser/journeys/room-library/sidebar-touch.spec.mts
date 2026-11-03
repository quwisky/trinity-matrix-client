import { testResourceId, test, expect, devices } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { createRoom } from '../../support/space-journey.mts';

// Covers the sidebar's touch affordances, which no other spec can see: every other
// authenticated spec runs the desktop Chromium project, where `hover: hover` and
// `pointer: fine` hold and the room row's ⋮ is revealed by :hover.
//
// This exists because a refactor broke exactly this and shipped green. Extracting the room
// list into SidebarRoomListComponent moved `.channel__menu` into a child component but left
// `@media (hover: none) { .channel__menu { opacity: 1 } }` in the PARENT stylesheet. Under
// Angular's emulated encapsulation a rule is attributed to its own component's elements, so
// the parent's copy silently matched nothing and every room's ⋮ rendered fully transparent
// on phones and tablets — invisible, though still hit-testable. Unit tests click
// `.channel__menu` directly and never consult a media query, so nothing caught it.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = homeserverSession();

// A mobile descriptor, which is what makes Chromium report `hover: none` and
// `pointer: coarse` — the two media features the rules under test key off.
test.use({ ...devices['Pixel 5'] });

test.describe('Sidebar on a touch device', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps the rail, room, menu and identity-dock controls touch-sized', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}t`;
    const user = `touch-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Touch ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await createRoom(request, hs, { accessToken: token }, roomName);

    await login(page, { available: true, hs, user, pass } as HomeserverSession);

    // Confirm the emulation actually took, or every assertion below would be about the
    // desktop rules and the spec would pass while proving nothing.
    const coarse = await page.evaluate(() => ({
      noHover: matchMedia('(hover: none)').matches,
      noAnyHover: matchMedia('(any-hover: none)').matches,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
    }));
    expect(coarse).toEqual({
      noHover: true,
      noAnyHover: true,
      coarsePointer: true,
    });

    // The identity menu remains usable on the touch layout and keeps the same hierarchy as
    // desktop. Escape must close it without leaving focus stranded in the overlay.
    await page.getByTestId('user-menu-trigger').click();
    const accountMenu = page.getByRole('menu').last();
    await expect(accountMenu).toBeVisible();
    await expect(accountMenu).toContainText('Switch account');
    await expect(accountMenu.getByTestId('add-account')).toContainText(
      'Add account',
    );
    await expect(accountMenu.getByTestId('logout')).toContainText(
      'Remove account from this device',
    );
    const menuGeometry = await accountMenu.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        withinViewport:
          box.top >= 0 &&
          box.left >= 0 &&
          box.bottom <= window.innerHeight &&
          box.right <= window.innerWidth,
      };
    });
    expect(menuGeometry.withinViewport).toBe(true);
    await test.info().attach('account-menu-mobile', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('user-menu-trigger')).toBeFocused();

    // Phones float the identity dock as desktop does; mobile-account-bar.spec.mts owns its geometry.
    await expect(page.locator('trn-sidebar-user-panel')).toHaveCSS(
      'position',
      'absolute',
    );

    const targets = [
      page.getByTestId('rail-rooms'),
      page.getByTestId('user-menu-trigger'),
      page.getByTestId('open-settings'),
    ];
    for (const target of targets) {
      const targetBox = await target.boundingBox();
      expect(targetBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(targetBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await page.getByTestId('rail-rooms').click();
    const row = page.locator('.channel-row', {
      has: page.locator('.channel', { hasText: roomName }),
    });
    await row.first().waitFor({ state: 'visible', timeout: 30_000 });

    const channelBox = await row.first().locator('.channel').boundingBox();
    expect(channelBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Touch opens the room's actions by holding the row, so the ⋮ no longer takes a place in the
    // layout. It stays in the accessibility tree and focusable for VoiceOver and keyboards.
    const kebab = row.first().locator('.channel__menu');
    const kebabBox = await kebab.boundingBox();
    expect(kebabBox?.width ?? 0).toBeLessThanOrEqual(1);
    await expect(kebab).toHaveAccessibleName(`Options for ${roomName}`);
    await kebab.focus();
    await expect(kebab).toBeFocused();

    const channel = row.first().locator('.channel');
    const cdp = await page.context().newCDPSession(page);
    const box = (await channel.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', dy = 0) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y: y + dy }],
      });

    // Scrolling or dragging never opens the sheet.
    await touch('touchStart');
    await touch('touchMove', 40);
    await page.waitForTimeout(700);
    await touch('touchEnd');
    await expect(page.getByTestId('sheet-room-leave')).toHaveCount(0);

    // Holding opens the same actions as the ⋮ menu, without opening the room or selecting text.
    await touch('touchStart');
    await expect(page.getByTestId('sheet-room-leave')).toBeVisible({
      timeout: 5_000,
    });
    await touch('touchEnd');
    // The click that follows the lift must not dismiss the sheet.
    await page.waitForTimeout(500);
    await expect(page.getByTestId('sheet-room-favourite')).toBeVisible();
    await expect(channel).not.toHaveClass(/channel--selected/);
    expect(
      await page.evaluate(() => window.getSelection()?.toString() ?? ''),
    ).toBe('');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('sheet-room-leave')).toHaveCount(0);

    // A short press still opens the room.
    await touch('touchStart');
    await page.waitForTimeout(80);
    await touch('touchEnd');
    await expect(channel).toHaveClass(/channel--selected/);
    await expect(page.getByTestId('sheet-room-leave')).toHaveCount(0);
  });
});
