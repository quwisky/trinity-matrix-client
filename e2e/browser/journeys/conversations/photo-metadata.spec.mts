import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';

// A photo sent from the composer reaches the homeserver without its location (#1140),
// unless the person chose Settings → Privacy → Keep photo metadata (#1178), which never
// applies to their profile photo. Uploads round-trip through the real disposable Synapse;
// the journey then downloads what the server stored and inspects the bytes. Requires the
// Synapse homeserver.
const session = homeserverSession();

/** A real, decodable 8x8 JPEG with no metadata of its own. */
const JPEG_8X8 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAUUYf//Z',
  'base64',
);

const LOCATION_NOTE = '52.5200N';

/**
 * A big-endian Exif TIFF: IFD0 holds Orientation 6 and a GPS IFD pointer; the GPS IFD holds
 * GPSLatitudeRef "N" and a note with the coordinates as text, so they are easy to find.
 */
// prettier-ignore
const EXIF_TIFF = Buffer.concat([
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]),
  Buffer.from([0x00, 0x02]),
  Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00]),
  Buffer.from([0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  // GPS IFD at 0x26
  Buffer.from([0x00, 0x02]),
  Buffer.from([0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x4e, 0x00, 0x00, 0x00]),
  Buffer.from([0x00, 0x1b, 0x00, 0x07, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x44]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from(LOCATION_NOTE, 'latin1'),
]);

function app1(payload: Buffer): Buffer {
  const length = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]),
    payload,
  ]);
}

/** The 8x8 JPEG with a GPS-bearing Exif segment right after SOI. */
const PHOTO_WITH_LOCATION = Buffer.concat([
  JPEG_8X8.subarray(0, 2),
  app1(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), EXIF_TIFF])),
  JPEG_8X8.subarray(2),
]);

/** What the upload must carry instead: an Exif segment holding only Orientation 6. */
// prettier-ignore
const ORIENTATION_ONLY = app1(
  Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from([
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]),
  ]),
);

interface ApiUser {
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return { headers: { Authorization: `Bearer ${json.access_token}` } };
}

/** Register a fresh user with a plain, unencrypted room to send into. */
async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: HomeserverSession & { user: string; pass: string };
  roomName: string;
  roomId: string;
  api: ApiUser;
}> {
  const user = `exif-${runId}`;
  const pass = `exif-pass-${runId}`;
  const roomName = `Photo metadata E2E ${runId}`;
  await registerUser(request, user, pass);
  const api = await apiLogin(request, hs, user, pass);
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: api.headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  return { reader: { available: true, hs, user, pass }, roomName, roomId, api };
}

interface ImageEvent {
  type?: string;
  content?: { msgtype?: string; url?: string; info?: { size?: number } };
}

/** The newest `m.image` in a room, or null if none has landed yet. */
async function latestImage(
  request: APIRequestContext,
  hs: string,
  api: ApiUser,
  roomId: string,
): Promise<ImageEvent | null> {
  const json = await request
    .get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
      { headers: api.headers },
    )
    .then((r) => r.json());
  return (
    ((json.chunk ?? []) as ImageEvent[]).find(
      (e) => e.type === 'm.room.message' && e.content?.msgtype === 'm.image',
    ) ?? null
  );
}

async function openSeededRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

/** Attach the located photo in the open room's composer and send it. */
async function sendPhoto(page: Page): Promise<void> {
  await page.getByTestId('composer-insert').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('insert-attach').click();
  await (
    await chooser
  ).setFiles({
    name: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    buffer: PHOTO_WITH_LOCATION,
  });
  await expect(page.getByTestId('composer-pending')).toContainText(
    'IMG_0001.jpg',
  );
  await page.getByTestId('composer-send').click();
}

/** The newest `m.image` in the room, once it lands, with the bytes the server stored. */
async function storedImage(
  request: APIRequestContext,
  hs: string,
  api: ApiUser,
  roomId: string,
): Promise<{ event: ImageEvent; stored: Buffer }> {
  await expect
    .poll(async () => (await latestImage(request, hs, api, roomId)) !== null, {
      timeout: 60_000,
    })
    .toBe(true);
  const event = (await latestImage(request, hs, api, roomId)) as ImageEvent;
  const mxc = event.content?.url ?? '';
  expect(mxc).toMatch(/^mxc:\/\//);
  return { event, stored: await downloadMedia(request, hs, api, mxc) };
}

async function downloadMedia(
  request: APIRequestContext,
  hs: string,
  api: ApiUser,
  mxc: string,
): Promise<Buffer> {
  const download = await request.get(
    `${hs}/_matrix/client/v1/media/download/${mxc.slice('mxc://'.length)}`,
    { headers: api.headers },
  );
  expect(download.ok()).toBe(true);
  return download.body();
}

/** The `avatar_url` of the signed-in API user's profile, or '' while none is set. */
async function profileAvatar(
  request: APIRequestContext,
  hs: string,
  api: ApiUser,
): Promise<string> {
  const { user_id } = await request
    .get(`${hs}/_matrix/client/v3/account/whoami`, { headers: api.headers })
    .then((r) => r.json());
  const profile = await request.get(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(user_id)}/avatar_url`,
    { headers: api.headers },
  );
  if (!profile.ok()) return '';
  return ((await profile.json()).avatar_url as string | undefined) ?? '';
}

test.describe('Photo metadata', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test('uploads a photo without its location, keeping its orientation', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = testResourceId('run');
    const { reader, roomName, roomId, api } = await seedRoom(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await openSeededRoom(page, roomName);
    await sendPhoto(page);

    const { event, stored } = await storedImage(request, hs, api, roomId);
    expect(stored.includes(Buffer.from(LOCATION_NOTE, 'latin1'))).toBe(false);
    expect(stored.includes(EXIF_TIFF)).toBe(false);
    // Orientation survives, so the photo still displays the right way up.
    expect(stored.includes(ORIENTATION_ONLY)).toBe(true);
    // The pixels are untouched: everything after SOI and the Exif is the original JPEG.
    expect(stored.subarray(2 + ORIENTATION_ONLY.length)).toEqual(
      JPEG_8X8.subarray(2),
    );
    expect(event.content?.info?.size).toBe(stored.length);
  });

  test('keeps a sent photo unchanged once the person opts in, but never their profile photo', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = testResourceId('run');
    const { reader, roomName, roomId, api } = await seedRoom(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await openSettingsSection(page, 'privacy');
    const keep = page.getByRole('switch', { name: 'Keep photo metadata' });
    await expect(keep).not.toBeChecked({ timeout: 20_000 });
    await keep.click();
    await expect(keep).toBeChecked({ timeout: 10_000 });

    // A profile photo is public and stays up, so it is stripped whatever the setting says.
    await page.getByTestId('settings-nav-profile').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('change-avatar').click();
    await (
      await chooser
    ).setFiles({
      name: 'me.jpg',
      mimeType: 'image/jpeg',
      buffer: PHOTO_WITH_LOCATION,
    });
    await expect
      .poll(async () => profileAvatar(request, hs, api), { timeout: 30_000 })
      .toMatch(/^mxc:\/\//);
    const avatar = await downloadMedia(
      request,
      hs,
      api,
      await profileAvatar(request, hs, api),
    );
    expect(avatar.includes(Buffer.from(LOCATION_NOTE, 'latin1'))).toBe(false);
    expect(avatar.includes(ORIENTATION_ONLY)).toBe(true);

    await closeSettings(page);
    await openSeededRoom(page, roomName);
    await sendPhoto(page);

    // The message attachment goes up byte for byte, location and all.
    const { event, stored } = await storedImage(request, hs, api, roomId);
    expect(stored).toEqual(PHOTO_WITH_LOCATION);
    expect(event.content?.info?.size).toBe(PHOTO_WITH_LOCATION.length);
  });
});
