// Two-client self-verification over Matrix QR reciprocation.
//
// Device A renders the real SDK QR payload. Device B's production camera scanner
// reads that image from a synthetic canvas MediaStream, avoiding physical camera
// hardware while still exercising rendering, decoding, and scanQRCode end to end.
import { mkdir } from 'node:fs/promises';
import { serve } from '../support/serve.mjs';
import { chromium } from 'playwright';

const PORT = 8127;
const APP = `http://localhost:${PORT}`;
const HS = process.env.TRINITY_HS ?? 'https://localhost:8448';
const USER = process.env.TRINITY_USER ?? 'verify-e2e';
const PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';
const HEADED = process.env.HEADED === '1';
const SLOWMO = Number(process.env.SLOWMO ?? 0);
const STAGE_TIMEOUT = 60_000;
const SETUP_TIMEOUT = 90_000;
const log = (message) => console.log(`[verify-qr] ${message}`);

async function fillLabeledInput(page, label, value) {
  const input = page.getByLabel(label, { exact: true });
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill(value);
}

async function stageOf(scope) {
  const page = scope.getByTestId('verify-page');
  if ((await page.count()) === 0) return null;
  return page.first().getAttribute('data-stage');
}

async function waitForStage(scope, stages, timeout = STAGE_TIMEOUT) {
  const wanted = Array.isArray(stages) ? stages : [stages];
  await scope
    .getByTestId('verify-page')
    .first()
    .waitFor({ state: 'attached', timeout });
  await scope.waitForFunction(
    (values) => {
      const page = document.querySelector('[data-testid="verify-page"]');
      return !!page && values.includes(page.getAttribute('data-stage'));
    },
    wanted,
    { timeout, polling: 200 },
  );
}

async function login(page, who) {
  log(`${who}: loading app`);
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
}

async function setUpEncryption(page) {
  log('A: setting up encryption');
  await page.goto(`${APP}/encryption/setup`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('button', { name: 'Set up encryption' }).click();

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
}

/** Install a camera seam backed by a canvas containing the other device's QR. */
async function installSyntheticCamera(page) {
  await page.addInitScript(() => {
    let stream;
    let resolveImage;
    const imageReady = new Promise((resolve) => {
      resolveImage = resolve;
    });

    window.__trinitySetQrCameraImage = async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      stream = canvas.captureStream(5);
      resolveImage();
    };

    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...mediaDevices,
        getUserMedia: async () => {
          await imageReady;
          return stream;
        },
      },
    });
  });
}

async function main() {
  await mkdir('e2e/.artifacts', { recursive: true });
  const server = await serve('www', PORT);
  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo: SLOWMO,
    args: ['--disable-dev-shm-usage'],
  });
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  await installSyntheticCamera(B);

  for (const [page, who] of [
    [A, 'A'],
    [B, 'B'],
  ]) {
    page.on('pageerror', (error) =>
      console.log(`  [${who}:error] ${error.message}`),
    );
  }

  let exit = 1;
  try {
    await login(A, 'A (device 1)');
    await setUpEncryption(A);
    await login(B, 'B (device 2)');

    log('B: starting verification');
    await B.goto(`${APP}/encryption/verify`, {
      waitUntil: 'domcontentloaded',
    });
    await B.getByTestId('verify-start').click();

    await waitForStage(A, ['requested', 'ready']);
    if ((await stageOf(A)) === 'requested') {
      await A.getByTestId('verify-accept').click();
    }
    await waitForStage(A, 'ready');
    await waitForStage(B, 'ready');

    log('A: revealing QR only after explicit action');
    await A.getByTestId('verify-show-qr').click();
    await waitForStage(A, 'qr-shown');
    const qrUrl = await A.getByTestId('verify-qr').getAttribute('src');
    if (!qrUrl?.startsWith('data:image/gif;base64,')) {
      throw new Error('A did not render the verification QR data URL');
    }
    await B.evaluate((url) => window.__trinitySetQrCameraImage(url), qrUrl);

    log('B: scanning A through the synthetic camera seam');
    await B.getByTestId('verify-scan-qr').click();
    await waitForStage(A, 'qr-confirm');
    await waitForStage(B, 'waiting');
    if (
      (await B.getByTestId('verify-page').getAttribute('data-stage')) === 'done'
    ) {
      throw new Error('B claimed success before A reciprocated');
    }
    if ((await A.getByTestId('verify-qr').count()) !== 0) {
      throw new Error('A retained the QR image after it was scanned');
    }

    log('A: confirming the in-person scan');
    await A.getByTestId('verify-confirm-qr').click();
    await waitForStage(A, 'done');
    await waitForStage(B, 'done');
    log('both devices reached done through QR reciprocation');

    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[verify-qr] error:', err.message);
    console.error(`  A stage=${await stageOf(A)} url=${A.url()}`);
    console.error(`  B stage=${await stageOf(B)} url=${B.url()}`);
    await A.screenshot({ path: 'e2e/.artifacts/A-qr-failure.png' }).catch(
      () => {},
    );
    await B.screenshot({ path: 'e2e/.artifacts/B-qr-failure.png' }).catch(
      () => {},
    );
    console.log('\nRESULT: FAIL');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error('[verify-qr] fatal:', err);
  process.exit(1);
});
