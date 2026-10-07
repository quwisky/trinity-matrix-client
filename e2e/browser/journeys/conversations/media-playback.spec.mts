import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import type { TestInfo } from '@playwright/test';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { encryptAttachmentForTest } from '../../support/encrypted-attachment.mts';

// Video and audio attachments load only when played: the timeline shows a poster (video) or a
// player row (audio), fetches nothing for the clip itself, and fetches and plays it on the
// reader's press. Covers plaintext and encrypted clips, mouse and keyboard. Needs a homeserver.
const session = homeserverSession();

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// A 1.2 s, 64x48 VP8 clip recorded from a canvas, so Chromium can decode it without codecs.
const WEBM = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAS5EU2bdLlNu4tT' +
    'q4QVSalmU6yBbk27i1OrhBZUrmtTrIGTTbuLU6uEH0O2dVOsgdRNu4xTq4QcU7trU6yCBKfsrgAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBE' +
    'iYREif76TYCGQ2hyb21lV0GGQ2hyb21lFlSua7yuuteBAXPFh2vcIvUl9/qDgQFV7oEBhoVWX1ZQ' +
    'OOCdsIFAuoEwU8CBAVWwkFWxgQFVuYECVbqBDVW7gQEfQ7Z1AQAAAAAAA8fngQCg4aGygQAAANAC' +
    'AJ0BKkAAMAAHBwiFhYiZhIglggJ08ma6NHm/FnfA/ueLuT9L3/O34g/UFyB1oaqmqO6BAaWjsAIA' +
    'nQEqQAAwAAqHCIWFiJmEiDgCAAaOT8zHm/FYAP7rrgCgx6GmgQBjAFECABwRPAAYB2AQN2HmmYAj' +
    '6q/8AP6H18Qu9jbfIpFi8AB1oZmml+6BAaWS0QEAKhHAABgAGFgv9AAIjAAA+4EAoMWhpIEAyAAR' +
    'AgAcEPgAGAAaT/QMABEMBVOA/u4nH/4tDrQ60M/S1HWhmaaX7oEBpZLRAQAqEcAAGAAYWC/0AAiM' +
    'AAD7gWOgyaGogQEsABECABwQ4AAYABpP9AwAEQwFU4D+7JeP/FodaHWho6+b7HsxwHWhmaaX7oEB' +
    'pZLRAQAqEcAAGAAYWC/0AAiMAAD7gcigzaGrgQGRAFECABwQvAAYB0gIHDvzDQAR9Vf+AP7prf/8' +
    'guWF1yNf+YJX5BuuQHWhmaaX7oEBpZLRAQAqEcAAGAAYWC/0AAiMAAD7ggEsoMuhqYEB9QARAgAc' +
    'EKAAGAAaT/QMABEMBVOA/u1wPwzlhUsPrf/PzO7cX85gdaGZppfugQGlktEBACoRkAAYABhYL/QA' +
    'CIwAAPuCAZGgzqGsgQJZABECABwQhAAYABpP9AwAEQwFU4D+8Az/WfJHpJEA/+xm/Rm/Rm/rKAB1' +
    'oZmml+6BAaWS0QEAKhF4ABgAGFgv9AAIjAAA+4IB9aDLoaqBAr4AEQIAHBBwABgAGk/0DAAU+qqo' +
    'gP7eEn/ziWOp3d2f/zYFc1z7mgB1oZimlu6BAaWRsQEAKhEgFGAAYWC/0AAiMAD7ggJZoNShsoED' +
    'IgBRAgAcEFwAGAxRSyDblHAWO1X81gD++TbP/72C+7Bfdgv9mPRmORY49QYLEaIAdaGZppfugQGl' +
    'ktEBACoRcAAYABhYL/QACIwAAPuCAr6gz6GtgQOGABECABwQTAAYABpP9AwAFPqqqID+9uYH/7xn' +
    '+4z/cZ/8vv/5Ka/xtx2AdaGZppfugQGlktEBACoRYAAYABhYL/QACIwAAPuCAyKg06GxgQPrABEC' +
    'ABwQQAAYABpP9AwAFPqqqID+8dyP/3ZP9sn+2T/3jP/4E78Cd+BO/8AAAHWhmaaX7oEBpZLRAQAq' +
    'EVAAGAAYWC/0AAiMAAD7ggOGoM+hrYEETwARAgAcEDQAGAAaT/QMABT6qqiA/va+B/+B+XThjw//' +
    'mXnzLz5l5/zEwHWhmaaX7oEBpZLRAQAqETwAGAAYWC/0AAiMAAD7ggPrHFO7a427i7OBALeG94EB' +
    '8YHU',
  'base64',
);

/** Half a second of 8-bit mono 8 kHz PCM, the smallest thing a media element will play. */
function wav(): Buffer {
  const samples = 4000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples, 40);
  const tone = Buffer.from(
    Array.from({ length: samples }, (_, i) => 128 + (i % 16 < 8 ? 40 : -40)),
  );
  return Buffer.concat([header, tone]);
}

interface Clip {
  readonly kind: 'video' | 'audio';
  readonly filename: string;
  readonly encrypted: boolean;
  /** Whether the event bundles a poster thumbnail (video only). */
  readonly thumbnail: boolean;
  /** Filled while seeding: the media id the homeserver stored the clip under. */
  mediaId?: string;
}

const CLIPS: Clip[] = [
  {
    kind: 'video',
    filename: 'plain-poster.webm',
    encrypted: false,
    thumbnail: true,
  },
  {
    kind: 'video',
    filename: 'secret-plain-placeholder.webm',
    encrypted: true,
    thumbnail: false,
  },
  {
    kind: 'audio',
    filename: 'plain-note.wav',
    encrypted: false,
    thumbnail: false,
  },
  {
    kind: 'audio',
    filename: 'secret-note.wav',
    encrypted: true,
    thumbnail: false,
  },
];

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

async function seedClips(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ credentials: HomeserverSession; room: string; clips: Clip[] }> {
  const user = `media-playback-${runId}`;
  const pass = `${user}-pass`;
  const room = `Media playback ${runId}`;
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
  const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers,
    data: { name: room },
  });
  await requireOk(created, 'create room');
  const { room_id: roomId } = (await created.json()) as { room_id: string };

  const upload = async (filename: string, bytes: Buffer, type: string) => {
    const response = await request.post(
      `${hs}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      { headers: { ...headers, 'Content-Type': type }, data: bytes },
    );
    await requireOk(response, `upload ${filename}`);
    return ((await response.json()) as { content_uri: string }).content_uri;
  };

  const clips = CLIPS.map((clip) => ({ ...clip }));
  for (const clip of clips) {
    const plaintext = clip.kind === 'video' ? WEBM : wav();
    const mimetype = clip.kind === 'video' ? 'video/webm' : 'audio/wav';
    const attachment = clip.encrypted
      ? await encryptAttachmentForTest(Uint8Array.from(plaintext).buffer)
      : undefined;
    const mxc = await upload(
      clip.filename,
      attachment ? Buffer.from(attachment.data) : plaintext,
      clip.encrypted ? 'application/octet-stream' : mimetype,
    );
    clip.mediaId = mxc.split('/').pop();
    const info: Record<string, unknown> = {
      mimetype,
      size: plaintext.length,
      duration: clip.kind === 'video' ? 1200 : 500,
      ...(clip.kind === 'video' ? { w: 64, h: 48 } : {}),
    };
    if (clip.thumbnail) {
      info['thumbnail_url'] = await upload('poster.png', PNG_1X1, 'image/png');
      info['thumbnail_info'] = { mimetype: 'image/png', w: 1, h: 1 };
    }
    const content = {
      msgtype: clip.kind === 'video' ? 'm.video' : 'm.audio',
      body: clip.filename,
      info,
      ...(attachment
        ? { file: { ...attachment.info, url: mxc } }
        : { url: mxc }),
    };
    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${clip.filename}`,
      { headers, data: content },
    );
    await requireOk(sent, `send ${clip.filename}`);
  }
  return { credentials: { available: true, hs, user, pass }, room, clips };
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

/** Whether a media element has started to play (the clips are short enough to have ended). */
async function hasPlayed(media: Locator): Promise<boolean> {
  return media.evaluate((el) => {
    const element = el as HTMLMediaElement;
    return element.currentTime > 0 || element.ended;
  });
}

const VIEWPORTS = [
  { name: 'desktop', size: { width: 1280, height: 900 } },
  { name: 'phone', size: { width: 390, height: 844 } },
];

test.describe('Video and audio load only when played', () => {
  test.skip(!session.available, 'needs a homeserver (Docker)');

  for (const { name, size } of VIEWPORTS) {
    test(`fetches a clip on play, not on render (${name})`, async ({
      page,
      request,
    }, testInfo: TestInfo) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: 'dark' });
      const runId = `${testResourceId('run')}play`;
      const seeded = await seedClips(request, session.hs as string, runId);
      const requested: string[] = [];
      page.on('request', (req) => requested.push(req.url()));
      const fetched = (clip: Clip) =>
        requested.some((url) => url.includes(`/${clip.mediaId}`));
      const shot = async (label: string) =>
        testInfo.attach(`${name}-${label}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });

      await login(page, seeded.credentials);
      await openRoom(page, seeded.room);

      const [poster, placeholder, plainAudio, secretAudio] = seeded.clips;
      const playVideo = (clip: Clip) =>
        page.getByRole('button', { name: `Play video ${clip.filename}` });
      const playAudio = (clip: Clip) =>
        page.getByRole('button', { name: `Play audio ${clip.filename}` });

      // Everything is on screen as a play control; no media element exists yet.
      for (const clip of [poster, placeholder]) {
        await expect(playVideo(clip)).toBeVisible({ timeout: 60_000 });
      }
      for (const clip of [plainAudio, secretAudio]) {
        await expect(playAudio(clip)).toBeVisible({ timeout: 60_000 });
      }
      await expect(page.locator('video, audio')).toHaveCount(0);
      // The poster is the event's own thumbnail, fetched and drawn without the clip.
      await expect(playVideo(poster).locator('img')).toHaveJSProperty(
        'complete',
        true,
        { timeout: 30_000 },
      );
      await expect(playVideo(poster)).toContainText('0:01');
      await expect(playAudio(plainAudio)).toContainText('0:01');
      await shot('before-play');
      expect(seeded.clips.filter(fetched)).toEqual([]);

      // Playing a video fetches only that video, then plays it.
      await playVideo(poster).click();
      const video = page.locator('video');
      await expect(video).toHaveCount(1, { timeout: 60_000 });
      await expect(video).toHaveAttribute('src', /^blob:/);
      await expect.poll(() => hasPlayed(video), { timeout: 30_000 }).toBe(true);
      await shot('video-played');
      expect(fetched(poster)).toBe(true);
      expect(fetched(placeholder)).toBe(false);
      expect(fetched(plainAudio)).toBe(false);

      // An encrypted video decrypts on play, and its placeholder never fetched a poster.
      await playVideo(placeholder).click();
      await expect(page.locator('video')).toHaveCount(2, { timeout: 60_000 });
      await expect
        .poll(() => hasPlayed(page.locator('video').nth(1)), {
          timeout: 30_000,
        })
        .toBe(true);

      // Audio from the keyboard: focus the row's control and press Enter.
      await playAudio(plainAudio).focus();
      await shot('audio-before-play');
      await page.keyboard.press('Enter');
      const audio = page.locator('audio');
      await expect(audio).toHaveCount(1, { timeout: 60_000 });
      await expect(audio).toHaveAttribute('src', /^blob:/);
      await expect.poll(() => hasPlayed(audio), { timeout: 30_000 }).toBe(true);
      await shot('audio-played');
      expect(fetched(secretAudio)).toBe(false);

      await playAudio(secretAudio).click();
      await expect(page.locator('audio')).toHaveCount(2, { timeout: 60_000 });
      await expect
        .poll(() => hasPlayed(page.locator('audio').nth(1)), {
          timeout: 30_000,
        })
        .toBe(true);
    });
  }
});
