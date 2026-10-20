import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  homeserverSession,
  login,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';
import { solidPng } from '../../support/png.mts';

const session = homeserverSession();

interface Account {
  readonly user: string;
  readonly pass: string;
  readonly userId: string;
  readonly headers: Record<string, string>;
}

async function account(
  request: APIRequestContext,
  user: string,
): Promise<Account> {
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const { userId, accessToken } = await passwordLogin(
    request,
    session.hs as string,
    user,
    pass,
  );
  return {
    user,
    pass,
    userId,
    headers: { Authorization: `Bearer ${accessToken}` },
  };
}

async function upload(
  request: APIRequestContext,
  owner: Account,
  name: string,
): Promise<string> {
  const response = await request.post(
    `${session.hs}/_matrix/media/v3/upload?filename=${name}.png`,
    {
      headers: { ...owner.headers, 'Content-Type': 'image/png' },
      data: solidPng(32, 32, [200, 120, 40]),
    },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).content_uri as string;
}

async function signIn(page: Page, owner: Account): Promise<void> {
  await login(page, {
    available: true,
    hs: session.hs,
    user: owner.user,
    pass: owner.pass,
  });
}

const tile = (page: Page, code: string) =>
  page.getByTestId('personal-pack-tile').and(page.getByLabel(`:${code}:`));

test.describe('Your emoji', () => {
  test.skip(!session.available, 'needs the disposable homeserver (Docker)');

  test('uploads in Settings, sends from the picker and saves a received sticker', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const run = testResourceId('your-emoji');
    const owner = await account(request, `yours-${run}`);
    const friend = await account(request, `friend-${run}`);
    const roomName = `Your emoji ${run}`;
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: owner.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [friend.userId],
        },
      })
      .then((response) => response.json())
      .then((json) => json.room_id as string);
    const joined = await request.post(
      `${hs}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { headers: friend.headers, data: {} },
    );
    expect(joined.ok()).toBe(true);

    await signIn(page, owner);
    await openSettingsSection(page, 'stickers');
    await expect(
      page.getByText(
        'Add images to use your own emoji and stickers in every room.',
      ),
    ).toBeVisible({ timeout: 20_000 });

    const dialog = page.getByTestId('add-to-pack-dialog');
    await page.getByTestId('personal-pack-files').setInputFiles({
      name: 'fox.png',
      mimeType: 'image/png',
      buffer: solidPng(64, 64, [230, 120, 30]),
    });
    await expect(page.getByTestId('add-to-pack-shortcode')).toHaveValue('fox');
    await expect(page.getByTestId('add-to-pack-preview')).toBeVisible();
    await page.getByTestId('add-to-pack-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(tile(page, 'fox')).toContainText('Emoji');

    // A second fox is a clash, never an overwrite.
    await page.getByTestId('personal-pack-files').setInputFiles({
      name: 'fox.png',
      mimeType: 'image/png',
      buffer: solidPng(64, 64, [30, 120, 230]),
    });
    await page.getByTestId('add-to-pack-confirm').click();
    await expect(page.getByTestId('add-to-pack-shortcode-error')).toHaveText(
      'You already have :fox:. Choose another shortcode.',
    );
    await page.getByTestId('add-to-pack-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('personal-pack-tile')).toHaveCount(1);

    await closeSettings(page);
    await openNamedRoom(page, roomName);
    await page.getByTestId('composer-expressions').click();
    const yourEmoji = page.getByTestId('your-emoji');
    await expect(yourEmoji.getByTestId('add-images-tile')).toBeVisible();
    await yourEmoji.getByRole('button', { name: ':fox:' }).click();
    await expect(page.getByTestId('composer-input')).toHaveValue(/:fox:/);
    await sendComposerLines(page, [' sent from Trinity']);

    const sent = page.locator('.msg', { hasText: 'sent from Trinity' }).last();
    const emoticon = sent.locator('img.mx-emoticon');
    await expect(emoticon).toHaveAttribute('alt', ':fox:', { timeout: 20_000 });
    await expect(emoticon).toHaveAttribute('src', /^blob:/);

    const stickerUrl = await upload(request, friend, 'otter');
    const sticker = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.sticker/${run}`,
      {
        headers: friend.headers,
        data: {
          body: 'otter',
          url: stickerUrl,
          info: { mimetype: 'image/png', w: 32, h: 32 },
        },
      },
    );
    expect(sticker.ok()).toBe(true);
    const stickerRow = page.locator('.msg--sticker').last();
    await expect(stickerRow.locator('img')).toHaveAttribute('src', /^blob:/, {
      timeout: 20_000,
    });

    await clickRowMenuItem(stickerRow, page.getByTestId('msg-add-to-emoji'));
    await expect(page.getByTestId('add-to-pack-shortcode')).toHaveValue(
      'otter',
    );
    await expect(page.getByTestId('add-to-pack-preview')).toBeVisible();
    await page.getByTestId('add-to-pack-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    // Saved: the menu no longer offers it, and Settings lists it.
    await stickerRow.hover();
    await stickerRow.getByTestId('msg-more').click();
    await expect(page.getByTestId('msg-add-to-emoji')).toBeHidden();
    await page.keyboard.press('Escape');
    await openSettingsSection(page, 'stickers');
    await expect(tile(page, 'otter')).toBeVisible({ timeout: 20_000 });

    // Saving a received image reuses its mxc instead of uploading it again.
    const pack = await request
      .get(
        `${hs}/_matrix/client/v3/user/${encodeURIComponent(owner.userId)}/account_data/m.image_pack`,
        { headers: owner.headers },
      )
      .then((response) => response.json());
    expect(pack.images.otter.url).toBe(stickerUrl);
  });

  test('renames and deletes, and another device follows', async ({
    page,
    request,
    secondaryApp,
  }) => {
    const hs = session.hs as string;
    const run = testResourceId('your-emoji');
    const owner = await account(request, `edits-${run}`);
    const url = await upload(request, owner, 'fox');
    const seeded = await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(owner.userId)}/account_data/m.image_pack`,
      {
        headers: owner.headers,
        data: {
          pack: { display_name: 'Your emoji' },
          images: {
            fox: {
              url,
              info: { mimetype: 'image/png', w: 32, h: 32 },
              usage: ['emoticon'],
            },
          },
        },
      },
    );
    expect(seeded.ok()).toBe(true);

    await signIn(page, owner);
    await openSettingsSection(page, 'stickers');
    const other = await secondaryApp.launch();
    await signIn(other, owner);
    await openSettingsSection(other, 'stickers');
    await expect(tile(other, 'fox')).toBeVisible({ timeout: 20_000 });

    await tile(page, 'fox').click();
    await page.getByRole('menuitem', { name: 'Rename shortcode' }).click();
    const rename = page.getByLabel('New shortcode for :fox:');
    await expect(rename).toBeFocused();
    await rename.fill('vixen');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(tile(page, 'vixen')).toBeVisible({ timeout: 20_000 });
    await expect(tile(page, 'fox')).toHaveCount(0);
    await expect(tile(other, 'vixen')).toBeVisible({ timeout: 20_000 });
    await expect(tile(other, 'fox')).toHaveCount(0);

    await tile(page, 'vixen').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', {
      name: 'Remove :vixen: from your emoji?',
    });
    await confirm.getByRole('button', { name: 'Remove' }).click();
    const empty =
      'Add images to use your own emoji and stickers in every room.';
    await expect(page.getByText(empty)).toBeVisible({ timeout: 20_000 });
    await expect(other.getByText(empty)).toBeVisible({ timeout: 20_000 });

    // Delete removes the entry only; the media stays on the server.
    const media = await request.get(
      `${hs}/_matrix/client/v1/media/download/${url.slice('mxc://'.length)}`,
      { headers: owner.headers },
    );
    expect(media.ok()).toBe(true);
  });
});
