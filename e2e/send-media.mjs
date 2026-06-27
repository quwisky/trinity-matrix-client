// Send-media (encrypted upload) e2e — note-to-self.
//
// Drives the real send path against a live homeserver: create an E2EE room via
// the CS API, log into the app as that user, set up encryption, open the room,
// pick a file through the composer's hidden <input>, and assert the app renders
// its OWN sent attachment — i.e. it uploaded the ciphertext, then downloaded and
// DECRYPTED it back into an <img> (data-media-state="ready"). One context is
// enough: a device decrypts the media it sent itself.
//
// Env (same as verify-sas):
//   TRINITY_HS    default https://localhost:8448 (bundled Synapse+Caddy)
//   TRINITY_USER  default verify-e2e
//   TRINITY_PASS  default verify-e2e-pass-123
//   HEADED=1 / SLOWMO=ms  for debugging
//
// `pnpm e2e:media` builds dev, starts the harness, runs this, and tears down.
import { mkdir } from 'node:fs/promises';
import { serve } from './support/serve.mjs';
import { chromium } from 'playwright';

// Node's fetch (room setup) must accept Caddy's self-signed cert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = 8127;
const APP = `http://localhost:${PORT}`;

const HS = process.env.TRINITY_HS ?? 'https://localhost:8448';
const USER = process.env.TRINITY_USER ?? 'verify-e2e';
const PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';
const HEADED = process.env.HEADED === '1';
const SLOWMO = Number(process.env.SLOWMO ?? 0);
const ROOM_NAME = 'Media E2E';

const SETUP_TIMEOUT = 90_000;

// A 1×1 PNG — small, real, decodable bytes for the upload→decrypt round-trip.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const log = (m) => console.log(`[send-media] ${m}`);

async function api(path, { token, body } = {}) {
  const res = await fetch(`${HS}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Log in via the CS API and create an encrypted room; return its id. */
async function createEncryptedRoom() {
  const { access_token: token } = await api('/_matrix/client/v3/login', {
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: PASS,
    },
  });
  const { room_id: roomId } = await api('/_matrix/client/v3/createRoom', {
    token,
    body: {
      name: ROOM_NAME,
      preset: 'trusted_private_chat',
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ],
    },
  });
  log(`created encrypted room ${roomId}`);
  return roomId;
}

/** Fill an Ionic <ion-input label="…"> by targeting its inner native input. */
async function fillIonInput(page, label, value) {
  const input = page.locator(`ion-input[label="${label}"] input`);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.click();
  await input.fill(value);
}

/** Log in: type the homeserver, Continue, fill credentials, Sign in → /rooms. */
async function login(page) {
  log('loading app');
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
  await fillIonInput(page, 'Homeserver', HS);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillIonInput(page, 'Username', USER);
  await fillIonInput(page, 'Password', PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
  log('logged in → /rooms');
}

/** Set up encryption (UIA password alert → recovery key → continue). */
async function setUpEncryption(page) {
  log('opening /encryption/setup');
  await page.goto(`${APP}/encryption/setup`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up encryption' }).click();

  const alert = page.locator('ion-alert');
  const key = page.locator('code.key');
  const appeared = await Promise.race([
    alert
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'alert')
      .catch(() => null),
    key
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'key')
      .catch(() => null),
  ]);
  if (appeared === 'alert') {
    await alert.locator('input[type="password"]').fill(PASS);
    await alert.getByRole('button', { name: 'Confirm' }).click();
  }
  await key.waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
  await page
    .getByRole('checkbox', { name: /I've saved my recovery key/ })
    .click();
  await page.getByRole('button', { name: 'Continue to Trinity' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
  log('encryption set up → /rooms');
}

async function main() {
  await mkdir('e2e/.artifacts', { recursive: true });
  const roomId = await createEncryptedRoom();
  const server = await serve('www', PORT);
  log(`serving www on ${APP} (homeserver=${HS} user=${USER})`);

  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo: SLOWMO,
    args: ['--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [error] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [console.error] ${m.text()}`);
  });

  let exit = 1;
  try {
    await login(page);
    await setUpEncryption(page);

    // Open the synced encrypted room from the sidebar.
    log(`opening room "${ROOM_NAME}"`);
    const channel = page.locator('.channel', { hasText: ROOM_NAME });
    await channel.first().click({ timeout: 60_000 });

    // Pick a file through the composer's hidden <input> (no native dialog).
    log('attaching a 1×1 PNG via the composer file input');
    await page.getByTestId('composer-file-input').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });

    // The app uploads the ciphertext, sends m.image, renders the echo, then
    // downloads + decrypts its own attachment back into the bubble.
    log('waiting for the media bubble to resolve (upload → decrypt → render)');
    const bubble = page.getByTestId('media-bubble').first();
    await bubble.waitFor({ state: 'attached', timeout: 60_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="media-bubble"]');
        return !!el && el.getAttribute('data-media-state') === 'ready';
      },
      undefined,
      { timeout: 60_000, polling: 250 },
    );
    log(
      `media bubble ready (kind=${await bubble.getAttribute('data-media-kind')}) ✓`,
    );

    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[send-media] error:', err.message);
    await page
      .screenshot({ path: 'e2e/.artifacts/send-media-failure.png' })
      .catch(() => {});
    console.log('\nRESULT: FAIL');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error('[send-media] fatal:', err);
  process.exit(1);
});
