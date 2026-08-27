import { expect, test, type Page } from './support/fixtures.mts';
import {
  login,
  synapseSession,
  waitForSent,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName }).first();
  await channel.waitFor({ state: 'visible', timeout: 30_000 });
  await channel.click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

async function leaveSettings(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await page.getByTestId('rail-rooms').isVisible()) return;
    await page.getByRole('button', { name: 'Back' }).click();
  }
  await expect(page.getByTestId('rail-rooms')).toBeVisible();
}

test.describe('MSC2545 stickers and custom emoji', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('installs, sends, and uninstalls a room image pack', async ({
    page,
    request,
    secondaryApp,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}stk`;
    const user = `sticker-${runId}`;
    const pass = `${user}-pass`;
    const publisher = `publisher-${runId}`;
    const publisherPass = `${publisher}-pass`;
    const roomName = `Sticker chat ${runId}`;
    await registerUser(request, user, pass);
    await registerUser(request, publisher, publisherPass);
    const auth = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((response) => response.json());
    const publisherAuth = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: publisher },
          password: publisherPass,
        },
      })
      .then((response) => response.json());
    const headers = { Authorization: `Bearer ${auth.access_token as string}` };
    const publisherHeaders = {
      Authorization: `Bearer ${publisherAuth.access_token as string}`,
    };
    const chatRoomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json())
      .then((json) => json.room_id as string);
    const aliasLocalpart = `packs-${runId}`;
    const packRoomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: publisherHeaders,
        data: {
          name: `Pack source ${runId}`,
          visibility: 'public',
          preset: 'public_chat',
          room_alias_name: aliasLocalpart,
        },
      })
      .then((response) => response.json())
      .then((json) => json.room_id as string);
    const serverName = (publisherAuth.user_id as string)
      .split(':')
      .slice(1)
      .join(':');
    const roomAlias = `#${aliasLocalpart}:${serverName}`;

    // A complete 1x1 transparent PNG. Pack media is intentionally homeserver media:
    // MSC2545 references public mxc content even when the room event is encrypted.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const mxc = await request
      .post(`${hs}/_matrix/media/v3/upload?filename=party.png`, {
        headers: { ...publisherHeaders, 'Content-Type': 'image/png' },
        data: png,
      })
      .then((response) => response.json())
      .then((json) => json.content_uri as string);

    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(packRoomId)}/state/m.room.image_pack/fun`,
      {
        headers: publisherHeaders,
        data: {
          pack: {
            display_name: 'Fun pack',
            usage: ['sticker', 'emoticon'],
            attribution: 'Trinity test pack',
          },
          images: {
            party: {
              url: mxc,
              body: 'Party pixel',
              info: { mimetype: 'image/png', w: 1, h: 1 },
            },
          },
        },
      },
    );
    // A same-key legacy event proves stable state wins without producing a duplicate row.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(packRoomId)}/state/im.ponies.room_emotes/fun`,
      {
        headers: publisherHeaders,
        data: {
          pack: { display_name: 'Legacy duplicate', usage: ['sticker'] },
          images: { old: { url: mxc, body: 'Old pixel' } },
        },
      },
    );
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(packRoomId)}/state/m.room.image_pack/other`,
      {
        headers: publisherHeaders,
        data: {
          pack: { display_name: 'Other pack', usage: ['sticker'] },
          images: { other: { url: mxc, body: 'Other pixel' } },
        },
      },
    );
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(chatRoomId)}/send/m.room.message/${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: 'hello :party:',
          format: 'org.matrix.custom.html',
          formatted_body: `hello <img data-mx-emoticon src="${mxc}" alt=":party:" title="party" height="32">`,
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const inline = page.locator('img.mx-emoticon').first();
    await expect(inline).toBeVisible({ timeout: 20_000 });
    await expect(inline).toHaveAttribute('src', /^blob:/);

    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-sticker')).toBeHidden();
    await page.keyboard.press('Escape');

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-stickers').click();
    await page.waitForURL(/\/settings\/stickers(?:\?|$)/, { timeout: 20_000 });
    const sourceInput = page.getByTestId('image-pack-source');
    await sourceInput.fill(roomAlias);
    await expect(sourceInput).toHaveValue(roomAlias);
    await sourceInput.press('Tab');
    await expect(
      page.getByText('Enter a Matrix room ID or alias, such as'),
    ).toBeHidden();
    await page.getByTestId('find-image-packs').click();
    const candidates = page.getByTestId('available-image-pack');
    await expect(candidates).toHaveCount(2, { timeout: 30_000 });
    const funPack = candidates.filter({ hasText: 'Fun pack' });
    await expect(funPack).toContainText('Stable');
    const installButton = funPack.getByTestId('install-image-pack');
    if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
      expect((await sourceInput.boundingBox())?.height).toBeGreaterThanOrEqual(
        44,
      );
      expect(
        (await installButton.boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    }
    await installButton.click();
    await expect(page.getByTestId('installed-image-pack')).toContainText(
      'Fun pack',
    );
    await expect(page.getByTestId('image-pack-notice')).toContainText(
      'available in all rooms',
    );

    // A separately installed client signed into the same account receives the
    // stable account-data reference without sharing browser/app storage.
    const deviceB = await secondaryApp.launch();
    await login(deviceB, {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession);
    await openRoom(deviceB, roomName);
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

    // Usage preferences are a namespaced extension on the stable reference.
    // Disabling stickers removes the pack immediately without uninstalling it.
    const installedPack = page
      .getByTestId('installed-image-pack')
      .filter({ hasText: 'Fun pack' });
    await installedPack
      .getByTestId('image-pack-usage-sticker')
      .getByRole('checkbox')
      .click();
    await expect(page.getByTestId('image-pack-notice')).toContainText(
      'usage was updated',
    );

    await leaveSettings(page);
    await openRoom(page, roomName);
    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-sticker')).toBeHidden({
      timeout: 20_000,
    });
    await page.keyboard.press('Escape');

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-stickers').click();
    const disabledPack = page
      .getByTestId('installed-image-pack')
      .filter({ hasText: 'Fun pack' });
    await disabledPack
      .getByTestId('image-pack-usage-sticker')
      .getByRole('checkbox')
      .click();
    await expect(page.getByTestId('image-pack-notice')).toContainText(
      'usage was updated',
    );

    await leaveSettings(page);
    await openRoom(page, roomName);

    // Publish a second pack in the active chat so the same picker proves the
    // distinction between globally installed and room-scoped sources.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(chatRoomId)}/state/m.room.image_pack/local`,
      {
        headers,
        data: {
          pack: { display_name: 'Local pack', usage: ['sticker'] },
          images: {
            local: {
              url: mxc,
              body: 'Local pixel',
              info: { mimetype: 'image/png', w: 1, h: 1 },
            },
          },
        },
      },
    );

    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-sticker')).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId('insert-sticker').click();
    await expect(page.getByTestId('manage-image-packs')).toBeVisible();
    const globalPack = page
      .getByTestId('sticker-pack')
      .filter({ hasText: 'Fun pack' });
    const localPack = page
      .getByTestId('sticker-pack')
      .filter({ hasText: 'Local pack' });
    await expect(globalPack.getByTestId('sticker-pack-scope')).toHaveText(
      'All rooms',
    );
    await expect(localPack.getByTestId('sticker-pack-scope')).toHaveText(
      'This room',
      { timeout: 20_000 },
    );

    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(chatRoomId)}/state/m.room.image_pack/local`,
      { headers, data: {} },
    );
    await expect(localPack).toHaveCount(0, { timeout: 20_000 });
    await page.getByTestId('sticker-party').click();

    const sticker = page.locator('.msg--sticker').last();
    await expect(sticker).toBeVisible({ timeout: 20_000 });
    await expect(sticker.locator('img')).toHaveAttribute('src', /^blob:/);
    await waitForSent(sticker);

    const messages = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(chatRoomId)}/messages?dir=b&limit=20`,
        { headers },
      )
      .then((response) => response.json());
    expect(
      messages.chunk.some(
        (event: { type?: string; content?: { url?: string } }) =>
          event.type === 'm.sticker' && event.content?.url === mxc,
      ),
    ).toBe(true);

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-stickers').click();
    const packToRemove = page
      .getByTestId('installed-image-pack')
      .filter({ hasText: 'Fun pack' });
    await packToRemove.getByTestId('remove-image-pack').click();
    await page.getByRole('button', { name: 'Remove pack' }).click();
    await expect(packToRemove).toHaveCount(0);
    await expect(page.locator('#installed-packs-title')).toBeFocused();
    await expect(page.getByTestId('image-pack-notice')).toContainText(
      'removed from your account',
    );

    const accountData = await request
      .get(
        `${hs}/_matrix/client/v3/user/${encodeURIComponent(auth.user_id as string)}/account_data/m.image_pack.rooms`,
        { headers },
      )
      .then((response) => response.json());
    expect(accountData).toEqual({ rooms: {} });

    const sourceState = await request.get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(packRoomId)}/state/m.room.image_pack/fun`,
      { headers: publisherHeaders },
    );
    expect(sourceState.ok()).toBe(true);

    await leaveSettings(page);
    await openRoom(page, roomName);
    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-sticker')).toBeHidden({
      timeout: 20_000,
    });
  });
});
