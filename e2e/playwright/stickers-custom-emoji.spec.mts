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

test.describe('MSC2545 stickers and custom emoji', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('discovers a room pack, sends a sticker, and resolves an inline custom emote', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}stk`;
    const user = `sticker-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Stickers ${runId}`;
    await registerUser(request, user, pass);
    const auth = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((response) => response.json());
    const headers = { Authorization: `Bearer ${auth.access_token as string}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json())
      .then((json) => json.room_id as string);

    // A complete 1x1 transparent PNG. Pack media is intentionally homeserver media:
    // MSC2545 references public mxc content even when the room event is encrypted.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const mxc = await request
      .post(`${hs}/_matrix/media/v3/upload?filename=party.png`, {
        headers: { ...headers, 'Content-Type': 'image/png' },
        data: png,
      })
      .then((response) => response.json())
      .then((json) => json.content_uri as string);

    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.image_pack/fun`,
      {
        headers,
        data: {
          pack: { display_name: 'Fun pack', usage: ['sticker', 'emoticon'] },
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
    await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(auth.user_id as string)}/account_data/m.image_pack.rooms`,
      { headers, data: { rooms: { [roomId]: { fun: {} } } } },
    );
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}`,
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
    await page.getByTestId('insert-sticker').click();
    await expect(page.getByTestId('sticker-picker')).toBeVisible();
    await page.getByTestId('sticker-party').click();

    const sticker = page.locator('.msg--sticker').last();
    await expect(sticker).toBeVisible({ timeout: 20_000 });
    await expect(sticker.locator('img')).toHaveAttribute('src', /^blob:/);
    await waitForSent(sticker);

    const messages = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
        { headers },
      )
      .then((response) => response.json());
    expect(
      messages.chunk.some(
        (event: { type?: string; content?: { url?: string } }) =>
          event.type === 'm.sticker' && event.content?.url === mxc,
      ),
    ).toBe(true);
  });
});
