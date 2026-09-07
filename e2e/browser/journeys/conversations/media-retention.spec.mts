import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import type { TestInfo } from '@playwright/test';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

const session = synapseSession();
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface EncryptedAttachmentForTest {
  data: ArrayBuffer;
  info: {
    url: string;
    v: 'v2';
    key: JsonWebKey;
    iv: string;
    hashes: { sha256: string };
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '');
}

async function encryptAttachmentForTest(
  plaintext: ArrayBuffer,
): Promise<EncryptedAttachmentForTest> {
  const iv = new Uint8Array(16);
  globalThis.crypto.getRandomValues(iv.subarray(0, 8));
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', key);
  const data = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key,
    plaintext,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return {
    data,
    info: {
      url: '',
      v: 'v2',
      key: jwk,
      iv: encodeBase64(iv),
      hashes: { sha256: encodeBase64(new Uint8Array(digest)) },
    },
  };
}

interface SeededRooms {
  credentials: SynapseSession;
  roomA: string;
  roomB: string;
}

async function requireOk(
  response: Awaited<ReturnType<APIRequestContext['post']>>,
  operation: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${operation} returned ${response.status()}: ${await response.text()}`,
    );
  }
}

async function seedRoomsWithAttachments(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<SeededRooms> {
  const user = `media-retention-${runId}`;
  const pass = `${user}-pass`;
  const roomA = `Media retention A ${runId}`;
  const roomB = `Media retention B ${runId}`;
  await registerUser(request, user, pass);

  const loginResponse = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  await requireOk(loginResponse, 'log in seeded user');
  const { access_token: token } = (await loginResponse.json()) as {
    access_token: string;
  };
  const headers = { Authorization: `Bearer ${token}` };
  const roomIds = new Map<string, string>();

  for (const name of [roomA, roomB]) {
    const response = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name },
    });
    await requireOk(response, `create ${name}`);
    roomIds.set(name, ((await response.json()) as { room_id: string }).room_id);
  }

  const sendImage = async (
    filename: string,
    encrypted: boolean,
  ): Promise<void> => {
    const roomId = roomIds.get(roomA)!;
    const attachment = encrypted
      ? await encryptAttachmentForTest(Uint8Array.from(PNG_1X1).buffer)
      : undefined;
    const bytes = attachment
      ? Buffer.from(attachment.data)
      : Buffer.from(Uint8Array.from(PNG_1X1));
    const uploadResponse = await request.post(
      `${hs}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      {
        headers: {
          ...headers,
          'Content-Type': encrypted ? 'application/octet-stream' : 'image/png',
        },
        data: bytes,
      },
    );
    await requireOk(uploadResponse, `upload ${filename}`);
    const { content_uri: mxc } = (await uploadResponse.json()) as {
      content_uri: string;
    };
    const content = encrypted
      ? {
          msgtype: 'm.image',
          body: filename,
          info: { mimetype: 'image/png', size: PNG_1X1.length, w: 1, h: 1 },
          file: { ...attachment!.info, url: mxc },
        }
      : {
          msgtype: 'm.image',
          body: filename,
          url: mxc,
          info: { mimetype: 'image/png', size: PNG_1X1.length, w: 1, h: 1 },
        };
    const sendResponse = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${filename}`,
      { headers, data: content },
    );
    await requireOk(sendResponse, `send ${filename}`);
  };

  await sendImage('retained-plain.png', false);
  await sendImage('retained-encrypted.png', true);
  return { credentials: { available: true, hs, user, pass }, roomA, roomB };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const room = page.locator('.channel', { hasText: roomName }).first();
  await room.waitFor({ state: 'visible', timeout: 30_000 });
  await room.click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });
}

async function expectReadyImage(page: Page, filename: string): Promise<void> {
  const bubbles = page.getByTestId('media-bubble');
  const bubble = bubbles
    .filter({ has: page.locator(`img[alt="${filename}"]`) })
    .or(bubbles.filter({ hasText: filename }))
    .first();
  await expect(bubble).toHaveAttribute('data-media-state', 'ready', {
    timeout: 60_000,
  });
  const image = page.locator(`img[alt="${filename}"]`);
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).complete),
    )
    .toBe(true);
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
}

async function openAndCloseLightbox(
  page: Page,
  filename: string,
): Promise<void> {
  await page.getByRole('button', { name: `Open image ${filename}` }).click();
  const dialog = page.getByRole('dialog', { name: filename });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const image = dialog.locator('img.lightbox__image');
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).complete),
    )
    .toBe(true);
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByTestId('lightbox-close').click();
  await expect(dialog).toBeHidden();
}

test.describe('Retained conversation media', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('reloads plaintext and encrypted images after A to B to A navigation', async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    const runId = `${testResourceId('run')}retained`;
    const seeded = await seedRoomsWithAttachments(
      request,
      session.hs as string,
      runId,
    );
    await login(page, seeded.credentials);

    await openRoom(page, seeded.roomA);
    await expectReadyImage(page, 'retained-plain.png');
    await expectReadyImage(page, 'retained-encrypted.png');
    await openAndCloseLightbox(page, 'retained-plain.png');
    await openAndCloseLightbox(page, 'retained-encrypted.png');

    for (let round = 0; round < 2; round += 1) {
      await openRoom(page, seeded.roomB);
      await openRoom(page, seeded.roomA);
      await expectReadyImage(page, 'retained-plain.png');
      await expectReadyImage(page, 'retained-encrypted.png');
      await openAndCloseLightbox(page, 'retained-plain.png');
      await openAndCloseLightbox(page, 'retained-encrypted.png');
    }

    await testInfo.attach('retained-media-after-return', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
