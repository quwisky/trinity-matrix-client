import {
  expect,
  test,
  testResourceId,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { focusWithKeyboard } from '../../support/keyboard-focus.mts';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
const session = homeserverSession();

/** Whether the focused element asks for a focus ring: `:focus-visible`, an outline or a ring-shaped shadow. */
function drawsRing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.activeElement as Element);
    return (
      (document.activeElement as Element).matches(':focus-visible') ||
      style.outlineStyle !== 'none' ||
      /rgba?\((?!0, 0, 0, 0\))/.test(style.boxShadow)
    );
  });
}

async function signIn(
  page: Page,
  request: Parameters<typeof registerUser>[0],
): Promise<Locator> {
  const user = `ring-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  await login(page, {
    available: true,
    hs: session.hs as string,
    user,
    pass,
  });
  await page.getByTestId('rail-rooms').click();
  return page.getByTestId('user-menu-trigger');
}

test.describe('Focus rings follow the last input', () => {
  test.skip(!session.available, 'needs a homeserver');
  test.describe.configure({ timeout: 120_000 });

  test('a click closing the account menu leaves no ring', async ({
    page,
    request,
  }) => {
    const trigger = await signIn(page, request);
    await trigger.click();
    await expect(page.getByTestId('account-row').first()).toBeVisible();
    await page.mouse.click(3, 3);
    await expect(page.getByTestId('account-row').first()).toBeHidden();
    expect(await drawsRing(page)).toBe(false);
  });

  test.describe('on a phone', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('a tap closing the account menu leaves no ring', async ({
      page,
      request,
    }) => {
      const trigger = await signIn(page, request);
      await trigger.tap();
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      await page.touchscreen.tap(3, 3);
      await expect(page.getByTestId('account-row').first()).toBeHidden();
      expect(await drawsRing(page)).toBe(false);
    });
  });

  test('the keyboard keeps its rings: Tab, and Escape closing the menu', async ({
    page,
    request,
  }) => {
    const trigger = await signIn(page, request);
    await focusWithKeyboard(trigger);
    expect(await drawsRing(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('account-row').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-row').first()).toBeHidden();
    await expect
      .poll(() => trigger.evaluate((el) => el === document.activeElement))
      .toBe(true);
    expect(await drawsRing(page)).toBe(true);
  });

  test('a tabindex="-1" element shows no ring after keyboard use, a Tab stop does', async ({
    page,
    request,
  }) => {
    await signIn(page, request);
    await page.evaluate(() => {
      for (const [id, tabindex] of [
        ['ring-script-only', '-1'],
        ['ring-tab-stop', '0'],
      ]) {
        const element = document.createElement('div');
        element.id = id;
        element.tabIndex = Number(tabindex);
        element.textContent = id;
        document.body.append(element);
      }
    });
    const scriptOnly = page.locator('#ring-script-only');
    const tabStop = page.locator('#ring-tab-stop');

    await focusWithKeyboard(tabStop);
    expect(await drawsRing(page)).toBe(true);
    await scriptOnly.evaluate((element) => element.focus());
    await expect(scriptOnly).toBeFocused();
    expect(
      await scriptOnly.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      ),
    ).toBe('none');
  });
});
