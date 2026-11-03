import { expect, test } from '../../../fixtures.mts';

test.describe('Double tap does not zoom', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('the document opts out of double-tap zoom and keeps pinch zoom', async ({
    page,
  }) => {
    await page.goto('/');
    const { touchAction, scale, viewport } = await page.evaluate(() => ({
      touchAction: getComputedStyle(document.documentElement).touchAction,
      scale: window.visualViewport?.scale,
      viewport: document
        .querySelector('meta[name="viewport"]')
        ?.getAttribute('content'),
    }));
    expect(touchAction).toBe('manipulation');
    expect(scale).toBe(1);
    expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
  });
});
