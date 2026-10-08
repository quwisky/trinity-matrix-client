import {
  expect,
  test,
  testResourceId,
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
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';

// One rule decides how every modal surface opens: a bottom sheet with a handle on a phone
// or tablet and below md, a centred dialog otherwise; an action list opens as a menu beside
// its button on a large screen. These journeys pin the rule on each device class.
const session = homeserverSession();

/** iPadOS 13+ sends a desktop Safari user agent; touch points are what give it away. */
const IPAD_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

async function signIn(
  page: Page,
  request: APIRequestContext,
  tag: string,
  roomName?: string,
): Promise<void> {
  const hs = session.hs as string;
  const user = `surface-${testResourceId('run')}${tag}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  if (roomName) {
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name: roomName, preset: 'private_chat' },
    });
  }
  await login(page, { available: true, hs, user, pass } as HomeserverSession);
}

/** A full-width bottom sheet flush with the bottom edge, with its handle. */
async function expectSheet(page: Page, dialog: Locator): Promise<void> {
  const surface = dialog.locator('[data-trn-layout="sheet"]').first();
  await expect(surface).toBeVisible({ timeout: 15_000 });
  await surface.evaluate((element) =>
    Promise.all(element.getAnimations().map((a) => a.finished)),
  );
  await expect(dialog.getByTestId('sheet-handle')).toBeVisible();
  const box = await surface.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(Math.abs(box!.y + box!.height - viewport.height)).toBeLessThanOrEqual(
    1,
  );
}

/** Drag the handle down past the dismiss threshold. */
async function swipeDown(page: Page, dialog: Locator): Promise<void> {
  const box = await dialog.getByTestId('sheet-handle').boundingBox();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 150, { steps: 5 });
  await page.mouse.move(x, y + 400, { steps: 5 });
  await page.mouse.up();
}

/** System status (from the login page), New message, the directory and Settings as sheets. */
async function sheetsEverywhere(
  page: Page,
  request: APIRequestContext,
  tag: string,
): Promise<void> {
  await page.goto('/login');
  await page
    .getByRole('button', { name: 'System status', exact: true })
    .first()
    .click();
  const status = page.getByRole('dialog', { name: 'System status' });
  await expectSheet(page, status);
  await swipeDown(page, status);
  await expect(status).toBeHidden();

  await signIn(page, request, tag);
  // Two in-app moves put an app page behind the directory, so Back has history to pop.
  await page.getByTestId('rail-rooms').click();
  await page.getByTestId('rail-recent').click();
  const plus = page.getByRole('button', { name: 'New room or direct message' });
  await expect(plus).toBeVisible({ timeout: 30_000 });
  await plus.click();
  const actions = page.getByRole('dialog', { name: 'New message' });
  await expectSheet(page, actions);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await swipeDown(page, actions);
  await expect(actions).toBeHidden();

  await plus.click();
  await actions.getByRole('button', { name: 'Explore public rooms' }).click();
  const directory = page
    .getByRole('dialog')
    .filter({ has: page.getByTestId('room-directory') });
  await expectSheet(page, directory);
  await page.goBack();
  await expect(directory).toBeHidden();
  await expect(page.getByTestId('rail-rooms')).toBeVisible();

  await page.getByTestId('open-settings').click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expectSheet(page, settings);
  await swipeDown(page, settings);
  await expect(settings).toBeHidden();
}

test.describe('Modal surfaces', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 150_000 });

  test.describe('on desktop', () => {
    test.use({
      ...DESIGN_VIEWPORTS['desktop-standard'],
      viewport: { width: 1280, height: 800 },
    });

    test('centres dialogs and opens the new-chat actions as a menu by its button', async ({
      page,
      request,
    }) => {
      await signIn(page, request, 'desk');
      const plus = page.getByRole('button', {
        name: 'New room or direct message',
      });
      await expect(plus).toBeVisible({ timeout: 30_000 });
      // The open menu hides the page behind it, so measure the button first.
      const plusBox = (await plus.boundingBox())!;
      await plus.focus();
      await page.keyboard.press('Enter');

      const menu = page.getByRole('menu', { name: 'New message' });
      await expect(menu).toBeVisible();
      await expect(page.getByTestId('sheet-handle')).toHaveCount(0);
      await expect(menu.getByRole('menuitem', { name: 'Cancel' })).toHaveCount(
        0,
      );
      const menuBox = (await menu.boundingBox())!;
      expect(Math.abs(menuBox.x - plusBox.x)).toBeLessThan(320);
      expect(menuBox.y).toBeGreaterThanOrEqual(plusBox.y + plusBox.height - 1);
      await expect(
        menu.getByRole('menuitem', { name: 'Create a room' }),
      ).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(
        menu.getByRole('menuitem', { name: 'Explore public rooms' }),
      ).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(plus).toBeFocused();

      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const directory = page
        .getByRole('dialog')
        .filter({ has: page.getByTestId('room-directory') });
      await expect(directory.getByTestId('dialog-surface')).toHaveAttribute(
        'data-trn-layout',
        'dialog',
      );
      await page.keyboard.press('Escape');
      await expect(directory).toBeHidden();

      await page.getByTestId('open-settings').click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings.getByTestId('dialog-surface')).toHaveAttribute(
        'data-trn-layout',
        'dialog',
      );
      await expect(settings.getByTestId('sheet-handle')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(settings).toBeHidden();
    });

    test('keeps the menu inside a short viewport and scrolls it when it cannot fit', async ({
      page,
      request,
    }) => {
      await signIn(page, request, 'short');
      const plus = page.getByRole('button', {
        name: 'New room or direct message',
      });
      const menu = page.getByRole('menu', { name: 'New message' });
      for (const height of [220, 120]) {
        await page.setViewportSize({ width: 1280, height });
        // Let the resize reach the overlay's viewport ruler before opening.
        await page.evaluate(
          () =>
            new Promise((done) =>
              requestAnimationFrame(() => requestAnimationFrame(done)),
            ),
        );
        // A window this short lets the sidebar footer cover the button, so open by keyboard.
        await plus.focus();
        await page.keyboard.press('Enter');
        await expect(menu).toBeVisible();

        const box = (await menu.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        const last = menu.getByRole('menuitem', {
          name: 'Start a direct message',
        });
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }
    });
  });

  test.describe('on a Pixel 5', () => {
    test.use(DESIGN_VIEWPORTS['phone-pixel-5']);

    test('opens every surface as a sheet; swipe closes them and Back closes the directory', async ({
      page,
      request,
    }) => {
      await sheetsEverywhere(page, request, 'phone');
    });

    test('asks before Back discards room settings changes', async ({
      page,
      request,
    }) => {
      const roomName = `Surface ${testResourceId('room')}`;
      await signIn(page, request, 'guard', roomName);
      await page.getByTestId('rail-rooms').click();
      await page.locator('.channel', { hasText: roomName }).first().click();
      await page.getByTestId('room-actions-overflow').click();
      await page.getByTestId('overflow-open-room-settings').click();
      const settings = page.getByRole('dialog', { name: 'Room settings' });
      await expectSheet(page, settings);
      const general = settings.getByRole('button', { name: 'General' });
      if (await general.isVisible()) await general.click();
      await settings
        .getByTestId('room-settings-name')
        .fill(`${roomName} edited`);

      await page.goBack();
      const discard = page.getByRole('dialog', {
        name: 'Discard room settings changes?',
      });
      await expect(discard).toBeVisible();
      await discard.getByRole('button', { name: 'Keep editing' }).click();
      await expect(settings).toBeVisible();
      await expect(settings.getByTestId('sheet-handle')).toBeVisible();
    });
  });

  test.describe('on an iPad at 1024 px', () => {
    test.use({
      viewport: { width: 1024, height: 1366 },
      userAgent: IPAD_SAFARI,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }),
      );
    });

    test('opens every surface as a sheet at desktop width; swipe closes them and Back closes the directory', async ({
      page,
      request,
    }) => {
      await sheetsEverywhere(page, request, 'ipad');
    });
  });
});
