import type { Navigate } from './platform-contracts.mts';

export const isAndroidE2E = process.env['TRINITY_E2E_PLATFORM'] === 'android';

export const navigateApplication: Navigate = async (page, path) => {
  if (isAndroidE2E) {
    const target = new URL(path, page.url()).href;
    if (target === page.url()) return;
    await page.evaluate((url) => {
      const state = {
        ...window.history.state,
        navigationId:
          typeof window.history.state?.navigationId === 'number'
            ? window.history.state.navigationId + 1
            : 1,
      };
      window.history.pushState(state, '', url);
      window.dispatchEvent(new PopStateEvent('popstate', { state }));
    }, target);
    return;
  }
  await page.goto(path, { waitUntil: 'networkidle' });
};
