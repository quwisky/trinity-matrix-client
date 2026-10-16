import { expect, test } from '../../../fixtures.mts';
import { settleSurface } from '../../../support/surface-settle.mts';
import { waitUntilStill } from '../../../support/touch-platform.mts';

// The harness's settle waits run inside the page, where Playwright's own timeouts do not
// reach. These pin that each one gives up on time with a message naming what it waited for,
// instead of holding a journey to its 120s test timeout. No homeserver or app needed.
test.describe('Harness settle waits', () => {
  const STYLES = `
    @keyframes slow-slide { from { transform: translateY(40px); } }
    @keyframes spin { to { transform: rotate(1turn); } }
    @keyframes drift { from { transform: translateX(0); } to { transform: translateX(80px); } }
  `;

  test('settleSurface waits out an entrance but not a spinner', async ({
    page,
  }) => {
    await page.setContent(`<style>${STYLES}</style>
      <div role="dialog">
        <span style="display:inline-block; animation: spin 1s linear infinite">o</span>
        <button style="animation: slow-slide 300ms ease-out">Close</button>
      </div>`);
    const started = Date.now();
    await settleSurface(page.getByRole('button', { name: 'Close' }), 5_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('settleSurface fails fast when an animation never ends', async ({
    page,
  }) => {
    await page.setContent(`<style>${STYLES}</style>
      <div role="dialog">
        <button style="animation: slow-slide 60s linear">Close</button>
      </div>`);
    const started = Date.now();
    await expect(
      settleSurface(page.getByRole('button', { name: 'Close' }), 500),
    ).rejects.toThrow(/still animating after 500ms: slow-slide/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test('waitUntilStill resolves for a still target and fails fast for a moving one', async ({
    page,
  }) => {
    await page.setContent(`<style>${STYLES}</style>
      <p id="still">Still</p>
      <p id="moving" style="animation: drift 2s linear infinite alternate">Moving</p>`);
    await waitUntilStill(page.locator('#still'), 2_000);

    const started = Date.now();
    await expect(waitUntilStill(page.locator('#moving'), 500)).rejects.toThrow(
      /kept moving for 500ms/,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
