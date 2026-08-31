import { testResourceId, test, expect, type Page } from '../fixtures.mts';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// Covers recording + sending a voice message (+ tray → Voice message → record → send →
// m.audio with the MSC3245 voice marker), rendered in the timeline as a voice player
// (data-testid="voice-message"). Chromium is launched with a fake microphone so
// getUserMedia + MediaRecorder work headless. Needs Synapse (Docker); self-skips.
const session = synapseSession();

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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

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

    await login(page, { available: true, hs, user, pass } as SynapseSession);
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

    // The clip uploads and renders in the timeline as a voice player.
    await expect(page.getByTestId('voice-message').first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
