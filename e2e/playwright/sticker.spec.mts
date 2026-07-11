import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers sending a sticker from a MSC2545 image pack: the composer's sticker button
// (data-testid="composer-sticker") opens the picker (data-testid="sticker-picker"),
// choosing an option (data-testid="sticker-option") sends an m.sticker, and the
// timeline renders it as an image (data-testid="sticker-image"). A personal pack is
// seeded via account data referencing an uploaded image. Needs Synapse; self-skips.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

// A 1×1 transparent PNG, uploaded to the media repo to back the seeded sticker.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' +
  '+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Stickers', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('sends a sticker from an image pack', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}stk`;
    const user = `stk-${runId}`;
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
      .then((r) => r.json());
    const token = auth.access_token as string;
    const userId = auth.user_id as string;
    const headers = { Authorization: `Bearer ${token}` };

    // Upload the image backing the sticker, then seed the user's personal pack.
    const mxc = await request
      .post(`${hs}/_matrix/media/v3/upload?filename=blob.png`, {
        headers: { ...headers, 'Content-Type': 'image/png' },
        data: Buffer.from(PNG_BASE64, 'base64'),
      })
      .then((r) => r.json())
      .then((j) => j.content_uri as string);

    await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/im.ponies.user_emotes`,
      {
        headers,
        data: {
          pack: { display_name: 'E2E Pack', usage: ['sticker'] },
          images: {
            e2e_blob: {
              url: mxc,
              body: 'E2E Sticker',
              info: { w: 1, h: 1, mimetype: 'image/png' },
            },
          },
        },
      },
    );

    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // Open the sticker picker and pick the seeded sticker.
    await page.getByTestId('composer-sticker').click();
    await expect(page.getByTestId('sticker-picker')).toBeVisible({
      timeout: 15_000,
    });
    const option = page.getByTestId('sticker-option').first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();

    // The picker closes and the sticker renders in the timeline as an image.
    await expect(page.getByTestId('sticker-picker')).toBeHidden();
    await expect(page.getByTestId('sticker-image').first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
