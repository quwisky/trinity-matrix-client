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
    // The shell is still settling after sign-in; a Tab made too early can miss the trigger.
    await expect(() => focusWithKeyboard(trigger)).toPass();
    expect(await drawsRing(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('account-row').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-row').first()).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await drawsRing(page)).toBe(true);
  });

  test('a tabindex="-1" element shows no ring after keyboard use, a Tab stop and a widget do', async ({
    page,
    request,
  }) => {
    await signIn(page, request);
    await page.evaluate(() => {
      for (const [id, tabindex, role] of [
        ['ring-script-only', '-1', ''],
        ['ring-tab-stop', '0', ''],
        ['ring-widget', '-1', 'menuitem'],
      ]) {
        const element = document.createElement('div');
        element.id = id;
        element.tabIndex = Number(tabindex);
        if (role) element.setAttribute('role', role);
        element.textContent = id;
        document.body.append(element);
      }
    });
    const tabStop = page.locator('#ring-tab-stop');

    await focusWithKeyboard(tabStop);
    expect(await drawsRing(page)).toBe(true);
    const outline = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        (element as HTMLElement).focus();
        return getComputedStyle(element).outlineStyle;
      });
    expect(await outline('#ring-widget')).toBe('solid');
    expect(await outline('#ring-script-only')).toBe('none');
  });

  // Chromium resets its keyboard state on a touch, so it cannot reproduce the long press that
  // showed the ring (the iPhone 17 simulator proved that); a key press first gets the same state.
  test.describe('on a phone', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('a button, a switch and its track show no ring by touch or Tab, text entry keeps its ring', async ({
      page,
      request,
    }) => {
      const trigger = await signIn(page, request);
      // What focus paints on `painted` (the focused element unless a sibling draws it): an
      // outline, or a shadow or border colour that differs once blurred.
      const paint = (target: Locator, painted: string = ':scope') =>
        target.evaluate((element, paintedSelector) => {
          const host =
            paintedSelector === ':scope'
              ? element
              : (element.nextElementSibling as Element);
          (host as HTMLElement).style.transition = 'none';
          const visible = (shadow: string) =>
            shadow
              .replaceAll(/rgba\(0, 0, 0, 0\)[\d. a-z]*/g, '')
              .replace(/[, ]/g, '') || 'none';
          const read = () => {
            const { outlineStyle, boxShadow, borderColor } =
              getComputedStyle(host);
            return { outlineStyle, boxShadow, borderColor };
          };
          const focused = read();
          (element as HTMLElement).blur();
          const blurred = read();
          (element as HTMLElement).focus();
          return [
            focused.outlineStyle,
            visible(focused.boxShadow) !== visible(blurred.boxShadow),
            focused.borderColor !== blurred.borderColor,
          ].join('|');
        }, painted);
      await page.evaluate(() => {
        const field = document.createElement('input');
        field.id = 'ring-field';
        const area = document.createElement('textarea');
        area.id = 'ring-area';
        const editable = document.createElement('div');
        editable.id = 'ring-editable';
        editable.contentEditable = 'true';
        document.body.append(field, area, editable);
      });

      await trigger.tap();
      await expect(page.getByTestId('account-row').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(await paint(trigger)).toBe('none|false|false');

      await expect(() => focusWithKeyboard(trigger)).toPass();
      expect(await paint(trigger)).toBe('none|false|false');

      for (const id of ['ring-field', 'ring-area', 'ring-editable']) {
        const entry = page.locator(`#${id}`);
        await focusWithKeyboard(entry);
        expect(await paint(entry), id).not.toMatch(/^none\|false\|false$/);
        expect(
          await entry.evaluate((el) => getComputedStyle(el).outlineStyle),
          id,
        ).not.toBe('none');
      }

      await page.getByTestId('open-settings').tap();
      await page.getByTestId('settings-nav-notifications').tap();
      const toggle = page.getByRole('switch').first();
      await expect(toggle).toBeVisible();
      await expect(() => focusWithKeyboard(toggle)).toPass();
      expect(await paint(toggle, 'sibling')).toBe('none|false|false');
    });

    test('a real dialog container shows no ring when it takes script focus after a key', async ({
      page,
      request,
    }) => {
      await signIn(page, request);
      await page.getByTestId('open-settings').tap();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Tab');
      await dialog.evaluate((element) => {
        (element as HTMLElement).focus();
      });
      expect(await dialog.evaluate((el) => el === document.activeElement)).toBe(
        true,
      );
      expect(
        await dialog.evaluate((el) => getComputedStyle(el).outlineStyle),
      ).toBe('none');
    });
  });
});
