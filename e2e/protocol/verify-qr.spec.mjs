// Two-client self-verification over Matrix QR reciprocation.
//
// Device A renders the real SDK QR payload. Device B's production camera scanner
// reads that image from a synthetic canvas MediaStream, avoiding physical camera
// hardware while still exercising rendering, decoding, and scanQRCode end to end.
import { waitForRooms } from '../support/navigation.mjs';
import { applicationOrigin } from '../support/session.mts';
import { test, expect } from './fixtures.mts';

const APP = applicationOrigin();
let HS;
let USER;
let PASS;
const STAGE_TIMEOUT = 60_000;
const SETUP_TIMEOUT = 90_000;
const log = (message) => console.log(`[verify-qr] ${message}`);

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
  await waitForRooms(page);
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

async function main(protocolBrowser) {
  const A = await protocolBrowser.newAuthenticatedPage({ label: 'device-a' });
  const B = await protocolBrowser.newPage({ label: 'device-b' });
  await installSyntheticCamera(B);

  let exit = 1;
  try {
    await setUpEncryption(A);
    await protocolBrowser.login(B);

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
    console.error(`  A stage=${await stageOf(A)} url=${A.url()}`);
    console.error(`  B stage=${await stageOf(B)} url=${B.url()}`);
    console.log('\nRESULT: FAIL');
    throw err;
  }
  expect(exit).toBe(0);
}

test('verifies two devices through QR reciprocation', async ({
  protocolBrowser,
  protocolCredentials,
}, testInfo) => {
  // probe-582: fail only the first managed retry; --fail-on-flaky-tests must keep the job red.
  if (testInfo.retry === 0) expect('probe-582-retry').toBe('probe-582-pass');
  HS = protocolCredentials.hs;
  USER = protocolCredentials.user;
  PASS = protocolCredentials.pass;
  await main(protocolBrowser);
});
