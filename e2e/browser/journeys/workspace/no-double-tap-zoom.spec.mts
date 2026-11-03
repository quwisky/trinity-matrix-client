import { expect, test, testResourceId, type Page } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

const session = homeserverSession();

const touchAction = (page: Page, testId: string): Promise<string> =>
  page
    .getByTestId(testId)
    .first()
    .evaluate((el) => getComputedStyle(el).touchAction);

test.describe('Double tap does not zoom', () => {
  test.skip(!session.available, 'needs a homeserver');
  test.describe.configure({ timeout: 120_000 });
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('the document, the space rail scroller and its buttons opt out', async ({
    page,
    request,
  }) => {
    const user = `zoom-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    await login(page, {
      available: true,
      hs: session.hs as string,
      user,
      pass,
    });
    await expect(page.getByTestId('rail-rooms')).toBeVisible();

    // The rail scrolls, and touch-action stops at the nearest scroller, so each is read on its own.
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).touchAction,
      ),
    ).toBe('manipulation');
    expect(await touchAction(page, 'rail-scroll')).toBe('manipulation');
    expect(await touchAction(page, 'rail-rooms')).toBe('manipulation');

    const { scale, viewport } = await page.evaluate(() => ({
      scale: window.visualViewport?.scale,
      viewport: document
        .querySelector('meta[name="viewport"]')
        ?.getAttribute('content'),
    }));
    expect(scale).toBe(1);
    expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
  });
});
