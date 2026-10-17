import {
  testResourceId,
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { isBlobAlive, playToEnd } from '../../support/media-playback.mts';
import { apiLogin } from '../../../support/account.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';

// Covers recording + sending a voice message (+ tray → Voice message → record → send →
// m.audio with the MSC3245 voice marker), rendered in the timeline as a voice player
// (data-testid="voice-message"). Chromium is launched with a fake microphone so
// getUserMedia + MediaRecorder work headless. Needs Synapse (Docker); self-skips.
const session = homeserverSession();

// A fake audio device (a tone) so getUserMedia/MediaRecorder produce real bytes
// offline, and auto-accept the mic permission prompt.
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test.describe('Voice messages', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('records and sends a voice message', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}vox`;
    const user = `vox-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Voice ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    const restingFieldHeight =
      (await page.getByTestId('composer-field').boundingBox())?.height ?? 0;
    expect(restingFieldHeight).toBeGreaterThan(0);

    // Start recording from the composer's `+` tray; the recording bar appears.
    await page.getByTestId('composer-insert').click();
    await page.getByTestId('insert-voice').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-voice-recording')).toBeVisible({
      timeout: 15_000,
    });
    const recordingHeight =
      (await page.getByTestId('composer-voice-recording').boundingBox())
        ?.height ?? 0;
    expect(Math.abs(recordingHeight - restingFieldHeight)).toBeLessThan(1);
    await expect(page.getByTestId('composer-field')).not.toBeVisible();
    await expect(page.getByTestId('composer-voice-cancel')).toBeFocused();
    const recordingStatus = page.getByText('Voice recording started', {
      exact: true,
    });
    await expect(recordingStatus).toHaveAttribute('role', 'status');

    // Capture ~1.2s of the fake tone, then send.
    await page.waitForTimeout(1200);
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('composer-voice-send')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-input')).toBeFocused();

    // The clip uploads and renders in the timeline as a voice player, with its length
    // from the event and nothing fetched until it is played.
    const player = page.getByTestId('voice-message').first();
    await expect(player).toBeVisible({ timeout: 30_000 });
    await expect(player.getByTestId('voice-time')).toHaveText(/^\d+:\d\d$/);
    await expect(player.locator('audio')).toHaveCount(0);

    // Playing fetches the clip and plays it to its end; it is then freed again.
    const play = player.getByRole('button', { name: 'Play voice message' });
    const clip = await playToEnd(page, 'audio', () => play.click());
    expect(clip).toMatch(/^blob:/);
    await expect(play).toBeVisible();
    await expect(player.locator('audio')).toHaveCount(0);
    expect(await isBlobAlive(page, clip, 'audio')).toBe(false);
  });
});

// Dropped from the profile: `use({ defaultBrowserType })` inside a describe forces a new worker.
const { defaultBrowserType: _browser, ...pixel5 } = devices['Pixel 5'];

/** A voice message as another client sends it: MSC3245 marker, MSC1767 waveform. */
async function sendVoice(
  request: APIRequestContext,
  hs: string,
  headers: Record<string, string>,
  roomId: string,
  txnId: string,
  durationMs: number,
): Promise<void> {
  // Never fetched: the player reads its length and waveform from the event alone.
  const { content_uri } = await request
    .post(`${hs}/_matrix/media/v3/upload?filename=voice.ogg`, {
      headers: { ...headers, 'Content-Type': 'audio/ogg' },
      data: Buffer.from('OggS'),
    })
    .then((r) => r.json());
  const waveform = Array.from({ length: 60 }, (_, i) =>
    Math.round(512 + 480 * Math.sin(i / 3)),
  );
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      headers,
      data: {
        msgtype: 'm.audio',
        body: 'Voice message',
        url: content_uri,
        info: { mimetype: 'audio/ogg', size: 4, duration: durationMs },
        'org.matrix.msc1767.audio': { duration: durationMs, waveform },
        'org.matrix.msc3245.voice': {},
      },
    },
  );
  expect(res.ok()).toBe(true);
}

/**
 * Where each voice player's parts sit, and whether anything clips them: the bubble, every
 * ancestor that hides overflow, and the viewport.
 */
function measurePlayers(page: Page) {
  return page.getByTestId('voice-message').evaluateAll((players) =>
    players.map((player) => {
      const box = player.getBoundingClientRect();
      const time = player.querySelector<HTMLElement>('.voice__time')!;
      const play = player
        .querySelector('.voice__play')!
        .getBoundingClientRect();
      const wave = player
        .querySelector('.voice__wave')!
        .getBoundingClientRect();
      const timeBox = time.getBoundingClientRect();
      // The nearest edge of the bubble or of a clipping ancestor, whichever is tighter.
      let clipLeft = 0;
      let clipRight = document.documentElement.clientWidth;
      for (let el = player.parentElement; el; el = el.parentElement) {
        if (getComputedStyle(el).overflowX === 'visible') continue;
        const r = el.getBoundingClientRect();
        clipLeft = Math.max(clipLeft, r.left);
        clipRight = Math.min(clipRight, r.right);
      }
      return {
        text: time.textContent?.trim(),
        playInside:
          play.left >= box.left - 0.5 && play.right <= wave.left + 0.5,
        waveBeforeTime: wave.right <= timeBox.left + 0.5,
        timeInside: timeBox.right <= box.right + 0.5,
        bubbleUnclipped:
          box.left >= clipLeft - 0.5 && box.right <= clipRight + 0.5,
        bars: player.querySelectorAll('.voice__bar').length,
      };
    }),
  );
}

test.describe('Voice messages on a narrow phone', () => {
  test.use(pixel5);
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps the play button and the full duration inside the bubble', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}voxn`;
    const user = `voxn-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Voice narrow ${runId}`;

    await registerUser(request, user, pass);
    const me = await apiLogin(request, hs, user, pass);
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: me.headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    await sendVoice(request, hs, me.headers, room_id, `${runId}-short`, 7_000);
    await sendVoice(request, hs, me.headers, room_id, `${runId}-long`, 754_000);

    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);
    await expect(page.getByTestId('voice-message')).toHaveCount(2, {
      timeout: 30_000,
    });

    for (const width of [390, 360, 320]) {
      await page.setViewportSize({ width, height: 844 });
      // Poll the whole geometry: the wave is sampled down after the resize settles.
      const fits = {
        playInside: true,
        waveBeforeTime: true,
        timeInside: true,
        bubbleUnclipped: true,
      };
      await expect
        .poll(() => measurePlayers(page), { message: `${width}px wide` })
        .toMatchObject([
          { text: '0:07', ...fits },
          { text: '12:34', ...fits },
        ]);
      for (const player of await measurePlayers(page)) {
        expect(player.bars, `${player.text} at ${width}px`).toBeGreaterThan(0);
        // 60 bars cannot fit here, so the waveform must have been sampled down.
        if (width === 320) {
          expect(player.bars, `${player.text} at ${width}px`).toBeLessThan(60);
        }
      }
    }
  });
});
