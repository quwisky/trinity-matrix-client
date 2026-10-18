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
import {
  registerUser,
  apiLogin,
  type ApiUser,
} from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import { createRoom } from '../../support/space-journey.mts';

// A photo (#1140) or video (#1179) sent from the composer reaches the homeserver without
// its location, unless the person chose Settings → Privacy → Keep photo and video metadata
// (#1178), which never applies to their profile photo. Uploads round-trip through the real disposable
// Synapse; the journey then downloads what the server stored and inspects the bytes.
// Requires the Synapse homeserver.
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

/**
 * A real one-second 64x64 H.264 QuickTime movie written by AVFoundation, with an iPhone's
 * metadata: `moov/meta` keys for the ISO 6709 location, make, model, software and creation
 * date, and a `udta/©xyz` location atom. `moov` follows `mdat`, as cameras write it.
 */
const MOVIE_WITH_LOCATION = Buffer.from(
  'AAAAFGZ0eXBxdCAgAAAAAHF0ICAAAAAId2lkZQAABJdtZGF0AAAANgYFLUdWStxcTEM/lO/FETzRQ6gBAAADAAEDAAADAAECAAHmAAsAAAMAAAMAAAMA3AwDkSsBgAAAAEIluCAf3gjlTP+CzB6bUNuzFeOietABEo8M/nvv8ZJ4W4C4X4gXt2czavD6eChMQMkGAAAXlAr/+AZMI+iThpCXt+EAAAAoIeEQX/5ADR0f/8eD/0IFYj/GX85rpzy19ckl6bTuGi63uACQoFv7OAAAABwhqIKEv/0udi9T/2cRsdlpLg6svrtJqAAJ1W5hAAAAFQGowY///qzGztzbnYmXDpAAKSV+YAAAABoBqMOP//23r2ERGJ7eSKNcnh8JiEAELfABYAAAACoh4yGiJf/+UwlUn//HD/1L9JS/zs2ONsZgeTm+bNVrTP5bYmwATlbKVtQAAAAqIakGhL/9LnYuVPmex3p0otr8P2xqPbDA6vahGnC+X+t30ONgAJyp2cDAAAAAJgGpRYk//jcxxL+GBZiEU16hW+K2wK/hd0uhrgkO2J2CQAUR1BTYAAAAGwGpR4k//jcxxSw+J0NOpz9fsSt6q6wAMrq9BgAAACkh5SmiJf/+UwlUn//F/9S9F1+dmxuZrFLPXvii3hCb1riWAAnK2UragAAAABsBqYmJP/43McUsPidDTqc/X7ErequsADK6vQYAAAAmIeYwS//+UwlUn///+psesfGbItNM6y0faKDwZRsbafAA/li3iDAAAAARAanLiT9cnuczDHKuAAymrlAAAAAmIec4S//+UwlUn/N8cJu4ZlE1szWKWevfFFvCE3rXEsABOVspW1AAAAARAaoNiT9cnuczDHKuAAymrlAAAAAhIehAS//8flqmNVc6GfcVkf96jLaZ5dBQl19kAEvWLd4MAAAAEQGqT4k/XJ7nMwxyrgAMpq5QAAAAJSHpSEv//v9o7//rfcf6/OzY0QVilnr3xRbwhN61xLAATlbKVtQAAAARAaqRiT9cnuczDHKuAAymrlAAAAAmIepQS//+UwlUn/8/6mx6x8Zsi00zrLR9ooPBlGxtp8AD+WLeIMAAAAARAarTiT9cnuczDHKuAAymrlAAAAAnIetYS//+UwlUn//B/1Lj/X52bGiCsUs9e+KLeEJvWuJYACcrZStqAAAAEQGrFYk/XJ7nMwxyrgAMpq5QAAAAJyHsYEv//lMJVJ//xt/1Nj1j4zZFppnWWj7RQeDKNjbT4AH8sW8QYAAAABEBq1eJP1ye5zMMcq4ADKauUAAAACkh7WhL//5TCVSf/8dH/UvyNr/OzY4uBmB5Ob5s1WtM/ltibABOVspW1AAAABEBq5mJP1ye5zMMcq4ADKauUAAAACch7nBL//5TCVSf/8eJ/1Nj1j4zZFppnWWj7RQeDKNjbT4AH8sW8QYAAAARAavbiT9cnuczDHKuAAymrlAAAAAaBgUVR1ZK3FxMQz+U78URPNFDqAMAAAMAAYAAAABCJbgQAX/xAnPcn8DtD32qQFZ+kTLkAAoTd7U6vuyjGuYgWiBRkrG/2Z686/Ccn2wzLiAACkudSuoBodSVKpQKKoqAAAAGw21vb3YAAABsbXZoZAAAAADm8Ns75vDbPAAAAlgAAAJYAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAARsdHJhawAAAFx0a2hkAAAAD+bw2zvm8Ns8AAAAAQAAAAAAAAJYAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAQAAAAAAARHRhcHQAAAAUY2xlZgAAAAAAQAAAAEAAAAAAABRwcm9mAAAAAABAAAAAQAAAAAAAFGVub2YAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAJYAAAAAAABAAAAAAOgbWRpYQAAACBtZGhkAAAAAObw2zvm8Ns8AAACWAAAAlhVxAAAAAAAMWhkbHIAAAAAbWhscnZpZGVhcHBsAAAAAAAAAAAQQ29yZSBNZWRpYSBWaWRlbwAAA0dtaW5mAAAAFHZtaGQAAAABAECAAIAAgAAAAAA4aGRscgAAAABkaGxyYWxpc2FwcGwAAAAAAAAAABdDb3JlIE1lZGlhIERhdGEgSGFuZGxlcgAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAxhbGlzAAAAAQAAAs9zdGJsAAAAkXN0c2QAAAAAAAAAAQAAAIFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAgAAAAIAAEAAQABIAAAASAAAAAAAAAABBUguMjY0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAJ2F2Y0MBZAAL/+EADCdkAAusVlDDeBBhFAEABCjuPLD9+PgAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAeAAAAFAAAAQBjdHRzAAAAAAAAAB4AAAABAAAAAAAAAAEAAAA8AAAAAQAAAAAAAAAB////2AAAAAH////sAAAAAQAAADwAAAABAAAAAAAAAAH////YAAAAAf///+wAAAABAAAAFAAAAAH////sAAAAAQAAABQAAAAB////7AAAAAEAAAAUAAAAAf///+wAAAABAAAAFAAAAAH////sAAAAAQAAABQAAAAB////7AAAAAEAAAAUAAAAAf///+wAAAABAAAAFAAAAAH////sAAAAAQAAABQAAAAB////7AAAAAEAAAAUAAAAAf///+wAAAABAAAAFAAAAAH////sAAAAAQAAAAAAAAAgY3NsZwAAAAAAAAAo////2AAAADwAAAAAAAACWAAAABhzdHNzAAAAAAAAAAIAAAABAAAAHgAAACpzZHRwAAAAACAQEBgYEBAYGBAYEBgQGBAYEBgQGBAYEBgQGBAYIAAAABxzdHNjAAAAAAAAAAEAAAABAAAAHgAAAAEAAACMc3RzegAAAAAAAAAAAAAAHgAAAIAAAAAsAAAAIAAAABkAAAAeAAAALgAAAC4AAAAqAAAAHwAAAC0AAAAfAAAAKgAAABUAAAAqAAAAFQAAACUAAAAVAAAAKQAAABUAAAAqAAAAFQAAACsAAAAVAAAAKwAAABUAAAAtAAAAFQAAACsAAAAVAAAAZAAAABRzdGNvAAAAAAAAAAEAAAAkAAAAJnVkdGEAAAAeqXh5egASf/8rNTIuNTIwMCswMTMuNDA1MC8AAAG9bWV0YQAAACJoZGxyAAAAAAAAAABtZHRhAAAAAAAAAAAAAAAAAAAAAADJa2V5cwAAAAAAAAAFAAAALG1kdGFjb20uYXBwbGUucXVpY2t0aW1lLmxvY2F0aW9uLklTTzY3MDkAAAAgbWR0YWNvbS5hcHBsZS5xdWlja3RpbWUubWFrZQAAACFtZHRhY29tLmFwcGxlLnF1aWNrdGltZS5tb2RlbAAAACRtZHRhY29tLmFwcGxlLnF1aWNrdGltZS5zb2Z0d2FyZQAAAChtZHRhY29tLmFwcGxlLnF1aWNrdGltZS5jcmVhdGlvbmRhdGUAAADKaWxzdAAAADIAAAABAAAAKmRhdGEAAAABAAAAACs1Mi41MjAwKzAxMy40MDUwKzAzNC4wMDAvAAAAHQAAAAIAAAAVZGF0YQAAAAEAAAAAQXBwbGUAAAAlAAAAAwAAAB1kYXRhAAAAAQAAAABpUGhvbmUgMTUgUHJvAAAAHgAAAAQAAAAWZGF0YQAAAAEAAAAAMTcuNC4xAAAAMAAAAAUAAAAoZGF0YQAAAAEAAAAAMjAyNi0xMC0wMVQxMjozNDo1NiswMjAw',
  'base64',
);

/** Offset and end of the top-level `moov` box. */
function moovRange(bytes: Buffer): { start: number; end: number } {
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(pos);
    if (bytes.toString('latin1', pos + 4, pos + 8) === 'moov') {
      return { start: pos, end: pos + size };
    }
    pos += size;
  }
  throw new Error('no moov box');
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
  const roomId = await createRoom(request, hs, api, roomName);
  return { reader: { available: true, hs, user, pass }, roomName, roomId, api };
}

interface ImageEvent {
  type?: string;
  content?: { msgtype?: string; url?: string; info?: { size?: number } };
}

/** The newest media message of `msgtype` in a room, or null if none has landed yet. */
async function latestImage(
  request: APIRequestContext,
  hs: string,
  api: ApiUser,
  roomId: string,
  msgtype = 'm.image',
): Promise<ImageEvent | null> {
  const json = await request
    .get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
      { headers: api.headers },
    )
    .then((r) => r.json());
  return (
    ((json.chunk ?? []) as ImageEvent[]).find(
      (e) => e.type === 'm.room.message' && e.content?.msgtype === msgtype,
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

/** Attach `file` in the open room's composer and send it. */
async function sendFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.getByTestId('composer-insert').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('insert-attach').click();
  await (await chooser).setFiles(file);
  await expect(page.getByTestId('composer-pending')).toContainText(file.name);
  await page.getByTestId('composer-send').click();
}

/** Attach the located photo in the open room's composer and send it. */
async function sendPhoto(page: Page): Promise<void> {
  await sendFile(page, {
    name: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    buffer: PHOTO_WITH_LOCATION,
  });
}

/** The newest `msgtype` message in the room, once it lands, with the bytes the server stored. */
async function storedImage(
  request: APIRequestContext,
  hs: string,
  api: ApiUser,
  roomId: string,
  msgtype = 'm.image',
): Promise<{ event: ImageEvent; stored: Buffer }> {
  await expect
    .poll(
      async () =>
        (await latestImage(request, hs, api, roomId, msgtype)) !== null,
      { timeout: 60_000 },
    )
    .toBe(true);
  const event = (await latestImage(
    request,
    hs,
    api,
    roomId,
    msgtype,
  )) as ImageEvent;
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

  test('uploads a video without its location, keeping every sample byte', async ({
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
    await sendFile(page, {
      name: 'IMG_0002.MOV',
      mimeType: 'video/quicktime',
      buffer: MOVIE_WITH_LOCATION,
    });

    const { event, stored } = await storedImage(
      request,
      hs,
      api,
      roomId,
      'm.video',
    );

    for (const value of ['+52.5200+013.4050', 'iPhone 15 Pro', '17.4.1']) {
      expect(stored.includes(Buffer.from(value, 'latin1')), value).toBe(false);
    }
    // The creation date stays, and so does every byte outside moov: same length, same
    // offsets, the samples untouched.
    expect(stored.includes(Buffer.from('2026-10-01T12:34:56', 'latin1'))).toBe(
      true,
    );
    expect(stored.length).toBe(MOVIE_WITH_LOCATION.length);
    const moov = moovRange(MOVIE_WITH_LOCATION);
    expect(stored.subarray(0, moov.start)).toEqual(
      MOVIE_WITH_LOCATION.subarray(0, moov.start),
    );
    expect(event.content?.info?.size).toBe(stored.length);
  });

  test('keeps a sent photo and video unchanged once the person opts in, but never their profile photo', async ({
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
    const keep = page.getByRole('switch', {
      name: 'Keep photo and video metadata',
    });
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

    // So does a video: the same movie the default upload is shown above to blank.
    await sendFile(page, {
      name: 'IMG_0002.MOV',
      mimeType: 'video/quicktime',
      buffer: MOVIE_WITH_LOCATION,
    });
    const video = await storedImage(request, hs, api, roomId, 'm.video');
    expect(video.stored).toEqual(MOVIE_WITH_LOCATION);
    expect(
      video.stored.includes(Buffer.from('+52.5200+013.4050', 'latin1')),
    ).toBe(true);
    expect(video.event.content?.info?.size).toBe(MOVIE_WITH_LOCATION.length);
  });
});
