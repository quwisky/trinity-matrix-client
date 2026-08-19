// Send-media (encrypted upload + MSC2530 caption) e2e — note-to-self.
//
// Drives the real send path against a live homeserver: create an E2EE room via
// the CS API, log into the app as that user, set up encryption, open the room,
// pick a file through the composer's hidden <input> — which STAGES it for a
// caption (not an immediate upload) — type a markdown caption, press Enter, and
// assert the app renders its OWN sent attachment (uploaded ciphertext, then
// downloaded + DECRYPTED back into an <img>, data-media-state="ready") WITH the
// caption rendered below it (markdown applied). One context is enough: a device
// decrypts the media + caption it sent itself.
//
// Env (same as verify-sas):
//   TRINITY_HS    default https://localhost:8448 (bundled Synapse+Caddy)
//   TRINITY_USER  default verify-e2e
//   TRINITY_PASS  default verify-e2e-pass-123
//   HEADED=1 / SLOWMO=ms  for debugging
//
// `pnpm e2e:media` builds dev, starts the harness, runs this, and tears down.
import { mkdir } from 'node:fs/promises';
import { serve } from '../support/serve.mjs';
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
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1x1 = Buffer.from(PNG_1x1_B64, 'base64');

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

/** Fill a native `<input hlmInput>` by its associated `<label for="…">`. */
async function fillLabeledInput(page, label, value) {
  // Exact match: the password field's "Show password" reveal button (aria-label) otherwise
  // also matches a substring `getByLabel('Password')`, tripping strict mode. Same fix as
  // e2e/playwright/support/app.mts:34 and verify-sas.mjs:45.
  const input = page.getByLabel(label, { exact: true });
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.click();
  await input.fill(value);
}

/** Log in: type the homeserver, Continue, fill credentials, Sign in → /rooms. */
async function login(page) {
  log('loading app');
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
  await fillLabeledInput(page, 'Homeserver', HS);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', USER);
  await fillLabeledInput(page, 'Password', PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
  log('logged in → /rooms');
}

/** Set up encryption (UIA password alert → recovery key → continue). */
async function setUpEncryption(page) {
  log('opening /encryption/setup');
  await page.goto(`${APP}/encryption/setup`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up encryption' }).click();

  // TrnAlertService's UIA password prompt — a CDK dialog hosting
  // <trn-alert-dialog> (replaces Ionic's <ion-alert>).
  const alert = page.locator('trn-alert-dialog');
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

    // Stage a file through the composer's hidden <input> — it's HELD for a
    // caption, not uploaded immediately.
    log('staging a 1×1 PNG via the composer file input');
    await page.getByTestId('composer-file-input').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });
    // The staged-attachment chip appears; nothing is sent yet.
    await page
      .getByTestId('composer-pending')
      .waitFor({ state: 'visible', timeout: 15_000 });
    log('attachment staged (preview chip shown, not yet uploaded) ✓');

    // Type a markdown caption and press Enter — sends file + caption as ONE
    // message (MSC2530: body=caption, filename=pixel.png).
    const composer = page.locator('textarea.composer__input');
    await composer.click();
    await composer.fill('hello **caption** e2e');
    await composer.press('Enter');
    log('typed a caption and pressed Enter');

    // Both halves, in this order and BEFORE any wait that outlives the upload. Everything
    // below — the bubble reaching `ready`, the caption rendering, the chip detaching —
    // happens strictly after `finalize()` clears the bar, so a `detached` wait placed after
    // them matches zero elements and resolves instantly. `visible` first is what makes the
    // `detached` half mean "it went away" rather than "it was never here".
    const uploadBar = page.getByTestId('upload-progress');
    await uploadBar.waitFor({ state: 'visible', timeout: 15_000 });
    await uploadBar.waitFor({ state: 'detached', timeout: 30_000 });
    log('upload bar appeared during the upload and cleared after it ✓');

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

    // The caption renders below the media with markdown applied
    // (**caption** → <strong>) — proving the MSC2530 caption round-trips.
    const captionStrong = page.locator('.msg__text--html strong', {
      hasText: 'caption',
    });
    await captionStrong.waitFor({ state: 'visible', timeout: 15_000 });
    const captionText = await page
      .locator('.msg__body', { has: page.locator('.msg__media') })
      .locator('.msg__text')
      .first()
      .innerText();
    if (!captionText.includes('hello') || !captionText.includes('e2e')) {
      throw new Error(`caption text not found below media: "${captionText}"`);
    }
    log(`caption rendered below the media ("${captionText.trim()}") ✓`);

    // The staged chip is gone once sent.
    await page
      .getByTestId('composer-pending')
      .waitFor({ state: 'detached', timeout: 10_000 });
    log('staged chip cleared after send ✓');

    // Second send: an attachment with NO caption — Enter on an empty caption
    // still sends, and no caption text is rendered.
    log('staging a second file with no caption');
    await page.getByTestId('composer-file-input').setInputFiles({
      name: 'plain.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });
    await page
      .getByTestId('composer-pending')
      .waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('textarea.composer__input').press('Enter');

    // Both media bubbles resolve; the caption count stays at 1 (the first send).
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-testid="media-bubble"][data-media-state="ready"]',
        ).length >= 2,
      undefined,
      { timeout: 60_000, polling: 250 },
    );
    const captionCount = await page
      .locator('.msg__text--html')
      .filter({ hasText: 'caption' })
      .count();
    if (captionCount !== 1) {
      throw new Error(`expected exactly 1 caption, found ${captionCount}`);
    }
    log('second (uncaptioned) media sent — no stray caption ✓');

    // Third send: THREE files and a caption, on ONE press. The batch is what #159 asks for,
    // and the parts a unit test cannot reach are here — that three real uploads to a real
    // homeserver all land, in order, and that a batch caption becomes its own message rather
    // than being repeated on each file or attached to an arbitrary one.
    log('staging three files at once with a caption');
    await page.getByTestId('composer-file-input').setInputFiles([
      { name: 'batch-1.png', mimeType: 'image/png', buffer: PNG_1x1 },
      { name: 'batch-2.png', mimeType: 'image/png', buffer: PNG_1x1 },
      { name: 'batch-3.png', mimeType: 'image/png', buffer: PNG_1x1 },
    ]);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="composer-pending"]').length ===
        3,
      undefined,
      { timeout: 15_000, polling: 100 },
    );
    log('three files staged from one pick ✓');

    const batchComposer = page.locator('textarea.composer__input');
    await batchComposer.fill('three at once');
    await batchComposer.press('Enter');

    // 2 from the earlier sends + 3 from this batch.
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-testid="media-bubble"][data-media-state="ready"]',
        ).length >= 5,
      undefined,
      { timeout: 90_000, polling: 250 },
    );
    log('all three uploads landed from a single press ✓');

    await page
      .getByTestId('composer-pending')
      .first()
      .waitFor({ state: 'detached', timeout: 15_000 });
    log('strip emptied — nothing left behind ✓');

    // Matrix has no multi-attachment event, so a batch caption has no file to belong to: it
    // is posted once, as its own message, rather than repeated on all three.
    // `.msg__text` rather than `.msg__text--html`: the latter is only for rendered markdown,
    // and a batch caption is posted as a plain message. It matches both, since the rich
    // variant carries both classes.
    const batchCaptions = await page
      .locator('.msg__text')
      .filter({ hasText: 'three at once' })
      .count();
    if (batchCaptions !== 1) {
      throw new Error(
        `batch caption should be posted exactly once, found ${batchCaptions}`,
      );
    }
    log('batch caption posted once, as its own message ✓');

    // Fourth: drag-and-drop. jsdom implements neither `DragEvent` nor `DataTransfer`, so the
    // unit tests duck-type both — this is the only place the real ones are exercised, against
    // the real message list, with the real host bindings.
    log('dropping two files onto the conversation');
    const listSelector = (await page
      .locator('trn-virtual-message-list')
      .count())
      ? 'trn-virtual-message-list'
      : 'trn-simple-message-list';
    const list = page.locator(listSelector);

    const dropData = await page.evaluateHandle((base64) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      for (const name of ['drop-1.png', 'drop-2.png']) {
        transfer.items.add(new File([bytes], name, { type: 'image/png' }));
      }
      return transfer;
    }, PNG_1x1_B64);

    await list.dispatchEvent('dragenter', { dataTransfer: dropData });
    await page
      .getByTestId('drop-overlay')
      .waitFor({ state: 'visible', timeout: 10_000 });
    log('drop target shown while dragging ✓');

    // Measured in Chromium because nothing else can: jsdom does not evaluate `color-mix()`,
    // and an invalid one (mixing toward a token the theme never defines) drops the whole
    // declaration silently — the overlay then renders with NO background, which is exactly
    // how this shipped the first time.
    const overlay = await page.evaluate((selector) => {
      const list = document.querySelector(selector);
      const sheet = document.querySelector('[data-testid="drop-overlay"]');
      const frame = document.querySelector('.drop-overlay__frame');
      if (!list || !sheet || !frame) {
        return null;
      }
      const alphaOf = (color) => {
        const inner = color.slice(
          color.indexOf('(') + 1,
          color.lastIndexOf(')'),
        );
        if (inner.includes('/')) {
          return parseFloat(inner.split('/')[1]);
        }
        const parts = inner.split(',').map((p) => parseFloat(p));
        return parts.length > 3 ? parts[3] : 1;
      };
      const l = list.getBoundingClientRect();
      const s = sheet.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      return {
        covers:
          Math.abs(l.top - s.top) < 1 &&
          Math.abs(l.left - s.left) < 1 &&
          Math.abs(l.width - s.width) < 1 &&
          Math.abs(l.height - s.height) < 1,
        alpha: alphaOf(getComputedStyle(sheet).backgroundColor),
        // The frame is what says "this whole region takes the drop", so it has to be most of
        // the area rather than a label-sized box in the middle.
        frameShare: (f.width * f.height) / (l.width * l.height),
      };
    }, listSelector);

    if (!overlay) {
      throw new Error('drop overlay or its frame is not in the DOM');
    }
    if (!overlay.covers) {
      throw new Error('drop overlay does not cover the whole drop area');
    }
    if (!(overlay.alpha > 0.4 && overlay.alpha < 1)) {
      throw new Error(
        `drop overlay background should be translucent, alpha=${overlay.alpha}`,
      );
    }
    if (overlay.frameShare < 0.8) {
      throw new Error(
        `drop frame covers only ${Math.round(overlay.frameShare * 100)}% of the area`,
      );
    }
    log(
      `overlay covers the list, alpha=${overlay.alpha}, frame=${Math.round(overlay.frameShare * 100)}% ✓`,
    );

    await list.dispatchEvent('drop', { dataTransfer: dropData });
    await page
      .getByTestId('drop-overlay')
      .waitFor({ state: 'detached', timeout: 10_000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="composer-pending"]').length ===
        2,
      undefined,
      { timeout: 15_000, polling: 100 },
    );
    log('both dropped files staged, target dismissed ✓');

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
