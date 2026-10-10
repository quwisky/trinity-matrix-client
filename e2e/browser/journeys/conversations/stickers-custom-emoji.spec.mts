import {
  expect,
  test,
  testResourceId,
  type Locator,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';
import {
  openImagePackJourneyRoom,
  runImagePackManagementJourney,
} from '../../../support/image-pack-management-journey.mts';

const session = homeserverSession();

/** A pack's action sits under its text, not squeezed beside it, as a 44px touch target. */
async function expectStackedTouchAction(
  card: Locator,
  action: Locator,
): Promise<void> {
  const body = await card.locator('.pack-card__body').boundingBox();
  const box = await action.boundingBox();
  expect(body, 'pack text has a layout box').not.toBeNull();
  expect(box, 'pack action has a layout box').not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(body!.y + body!.height - 1);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

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
        } as HomeserverSession);
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

  test.describe('390px touch phone', () => {
    test.use({
      ...DESIGN_VIEWPORTS['phone-pixel-5'],
      viewport: { width: 390, height: 844 },
    });

    test('stacks Install and Remove under the pack text as touch targets', async ({
      page,
      request,
    }) => {
      const hs = session.hs as string;
      const run = `${testResourceId('image-pack')}phone`;
      const user = `sticker-${run}`;
      const pass = `${user}-pass`;
      await registerUser(request, user, pass);
      const account = await passwordLogin(request, hs, user, pass);
      const headers = { Authorization: `Bearer ${account.accessToken}` };
      const alias = `packs-${run}`;
      const packRoomId = await request
        .post(`${hs}/_matrix/client/v3/createRoom`, {
          headers,
          data: {
            name: `Pack source ${run}`,
            visibility: 'public',
            preset: 'public_chat',
            room_alias_name: alias,
          },
        })
        .then((response) => response.json())
        .then((json) => json.room_id as string);
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(packRoomId)}/state/m.room.image_pack/fun`,
        {
          headers,
          data: {
            pack: { display_name: 'Fun pack', usage: ['sticker'] },
            images: {
              party: { url: 'mxc://localhost/party', body: 'Party pixel' },
            },
          },
        },
      );
      const serverName = account.userId.split(':').slice(1).join(':');

      await login(page, { available: true, hs, user, pass });
      expect(
        await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        'the touch profile reports a coarse pointer',
      ).toBe(true);
      await openSettingsSection(page, 'stickers');
      const source = page.getByTestId('image-pack-source');
      await source.click();
      await source.pressSequentially(`#${alias}:${serverName}`);
      await page.getByTestId('find-image-packs').click();

      const available = page
        .getByTestId('available-image-pack')
        .filter({ hasText: 'Fun pack' });
      const install = available.getByTestId('install-image-pack');
      await expect(install).toBeVisible({ timeout: 30_000 });
      await expectStackedTouchAction(available, install);

      await install.click();
      const installed = page
        .getByTestId('installed-image-pack')
        .filter({ hasText: 'Fun pack' });
      const remove = installed.getByTestId('remove-image-pack');
      await expect(remove).toBeVisible({ timeout: 30_000 });
      await expectStackedTouchAction(installed, remove);
    });
  });
});
