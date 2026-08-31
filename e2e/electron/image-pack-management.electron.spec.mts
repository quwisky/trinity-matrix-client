import { test, type Page } from './fixtures.mts';

import { synapseSession, type Navigate } from '../support/app.mts';
import { runImagePackManagementJourney } from '../support/image-pack-management-journey.mts';
import { launchApp } from './support/launch.mts';

const session = synapseSession();

const electronNavigate: Navigate = async (page: Page, path: string) => {
  const baseUrl = page.url() === 'about:blank' ? 'trinity://app/' : page.url();
  await page.goto(new URL(path, baseUrl).href, {
    waitUntil: 'domcontentloaded',
  });
};

test.describe('Electron image pack management', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('installs, uses, and uninstalls a room image pack', async ({
    request,
  }) => {
    test.slow();
    const app = await launchApp();

    try {
      const page = await app.firstWindow();
      await runImagePackManagementJourney({
        page,
        request,
        session,
        navigate: electronNavigate,
      });
    } finally {
      await app.close();
    }
  });
});
