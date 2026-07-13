import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers recording + sending a voice message (composer-voice → record → send →
// m.audio with the MSC3245 voice marker), rendered in the timeline as a voice player
// (data-testid="voice-message"). Chromium is launched with a fake microphone so
// getUserMedia + MediaRecorder work headless. Needs Synapse (Docker); self-skips.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

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

test.describe('Voice messages', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('records and sends a voice message', async ({ page, request }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}vox`;
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

    // Start recording; the recording bar appears.
    await page.getByTestId('composer-voice').click();
    await expect(page.getByTestId('composer-voice-recording')).toBeVisible({
      timeout: 15_000,
    });

    // Capture ~1.2s of the fake tone, then send.
    await page.waitForTimeout(1200);
    await page.getByTestId('composer-voice-send').click();

    // The clip uploads and renders in the timeline as a voice player.
    await expect(page.getByTestId('voice-message').first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
