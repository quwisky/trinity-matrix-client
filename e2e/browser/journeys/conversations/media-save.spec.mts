import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { createRoom } from '../../support/space-journey.mts';

// Covers saving an image from the timeline: the message ⋯ menu ("Save image") and the
// lightbox download button, both ending in a browser download that keeps the original
// filename. Needs Synapse (Docker).
const session = homeserverSession();
const FILENAME = 'saved-photo.png';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('Save timeline media', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('saves an image from the message menu and from the lightbox', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}save`;
    const user = `save-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Save media ${runId}`;

    await registerUser(request, user, pass);
    const { access_token: token } = (await (
      await request.post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
    ).json()) as { access_token: string };
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: token },
      roomName,
    );
    const { content_uri: mxc } = (await (
      await request.post(
        `${hs}/_matrix/media/v3/upload?filename=${encodeURIComponent(FILENAME)}`,
        { headers: { ...headers, 'Content-Type': 'image/png' }, data: PNG_1X1 },
      )
    ).json()) as { content_uri: string };
    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.image',
          body: FILENAME,
          url: mxc,
          info: { mimetype: 'image/png', size: PNG_1X1.length, w: 1, h: 1 },
        },
      },
    );
    expect(sent.ok()).toBe(true);

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    const row = page.locator('.scroll .msg', {
      has: page.locator(`img[alt="${FILENAME}"]`),
    });
    await expect(row.first()).toBeVisible({ timeout: 30_000 });

    // The ⋯ menu item.
    const [fromMenu] = await Promise.all([
      page.waitForEvent('download'),
      clickRowMenuItem(row.first(), page.getByTestId('msg-save-media')),
    ]);
    expect(fromMenu.suggestedFilename()).toBe(FILENAME);

    // The lightbox's download button.
    await page.getByRole('button', { name: `Open image ${FILENAME}` }).click();
    const dialog = page.getByRole('dialog', { name: FILENAME });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const [fromLightbox] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByTestId('lightbox-download').click(),
    ]);
    expect(fromLightbox.suggestedFilename()).toBe(FILENAME);
    // Saving leaves the viewer open; the button is usable again once the save ends.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('lightbox-download')).toBeEnabled();
  });
});
