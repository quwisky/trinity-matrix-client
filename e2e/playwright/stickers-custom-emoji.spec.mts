import { expect, test } from '../fixtures.mts';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import {
  openImagePackJourneyRoom,
  runImagePackManagementJourney,
} from '../support/image-pack-management-journey.mts';

const session = synapseSession();

test.describe('MSC2545 stickers and custom emoji', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('installs, sends, and uninstalls a room image pack', async ({
    page,
    request,
    secondaryApp,
  }) => {
    test.slow();
    await runImagePackManagementJourney({
      page,
      request,
      session,
      verifyInstalledOnSecondClient: async ({ hs, user, pass, roomName }) => {
        // A separately installed client signed into the same account receives
        // the stable reference without sharing browser/app storage.
        const deviceB = await secondaryApp.launch();
        await login(deviceB, {
          available: true,
          hs,
          user,
          pass,
        } as SynapseSession);
        await openImagePackJourneyRoom(deviceB, roomName);
        await deviceB.getByTestId('composer-insert').click();
        await expect(deviceB.getByTestId('insert-sticker')).toBeVisible({
          timeout: 20_000,
        });
        await deviceB.getByTestId('insert-sticker').click();
        const deviceBPack = deviceB
          .getByTestId('sticker-pack')
          .filter({ hasText: 'Fun pack' });
        await expect(deviceBPack.getByTestId('sticker-pack-scope')).toHaveText(
          'All rooms',
        );
        await secondaryApp.activatePrimary();
      },
    });
  });
});
