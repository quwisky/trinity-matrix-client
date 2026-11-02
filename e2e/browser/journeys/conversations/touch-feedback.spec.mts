import { test, expect, testResourceId } from '../../../fixtures.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';
import { createRoom } from '../../support/space-journey.mts';

// A touch screen keeps matching `:hover` after the finger lifts, so rows stayed shaded (#1868).
// Chromium reports `(hover: none)` for a context that is both `isMobile` and `hasTouch`; the
// media query itself is asserted so the premise cannot silently stop holding.
const session = homeserverSession();

test.describe('Touch feedback on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use(DESIGN_VIEWPORTS['phone-pixel-5']);

  test('leaves no row shaded, selectable or hover-revealed after a tap, and Send keeps the keyboard', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const user = `touch-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const account = await passwordLogin(request, hs, user, pass);
    const roomName = `Touch ${user}`;
    await createRoom(
      request,
      hs,
      { accessToken: account.accessToken },
      roomName,
    );

    await login(page, { ...session, user, pass });
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(
      true,
    );

    const channel = page.locator('.channel', { hasText: roomName }).first();
    await channel.waitFor({ timeout: 30_000 });
    // A long press would otherwise select the name and offer Copy / Look Up / Translate.
    const press = await channel.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        select: style.userSelect,
        callout: style.getPropertyValue('-webkit-touch-callout'),
      };
    });
    expect(press.select).toBe('none');
    // Chromium has no callout property; only WebKit reports one.
    expect(['', 'none']).toContain(press.callout);
    await channel.click();

    const composer = page.getByTestId('composer-input');
    await composer.waitFor({ timeout: 30_000 });
    const send = page.getByTestId('composer-send');
    for (const text of ['first', 'second']) {
      await composer.fill(text);
      await send.tap();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue('');
      await expect(page.locator('.msg', { hasText: text })).toBeVisible();
    }

    // A second quick tap lands on Send while it is disabled (the box is empty again).
    await expect(send).toBeDisabled();
    const box = (await send.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(composer).toBeFocused();

    const row = page.locator('.msg', { hasText: 'first' }).first();
    await row.tap();
    // Lifting the finger must not leave the hover shade behind.
    await expect
      .poll(() => row.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgba(0, 0, 0, 0)');
  });
});
