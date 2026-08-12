// Two-client device verification (emoji SAS) e2e.
//
// Drives the *real* flow against a live homeserver: two browser contexts in one
// Chromium = two devices of the SAME Matrix user (isolated IndexedDB ⇒ two crypto
// stores ⇒ two device IDs). Device A sets up encryption (cross-signing + recovery),
// Device B logs in as the same user and starts an SAS verification, A accepts via
// the auto-popped modal, both compare the seven emoji and confirm — asserting both
// reach data-stage="done" and that the emoji names matched.
//
// A confirms first, so the run also covers the half-confirmed window: A waiting on its
// peer (spinner, answer spent) while B is still being asked. Only a two-device run can
// observe that state honestly.
//
// Homeserver is parameterized by env so this runs against anything:
//   TRINITY_HS    homeserver the login form types (default https://localhost:8448,
//                 the bundled Synapse+Caddy harness)
//   TRINITY_USER  username    (default verify-e2e)
//   TRINITY_PASS  password    (default verify-e2e-pass-123)
//   HEADED=1      run headed for debugging
//   SLOWMO=ms     slow down actions for debugging
//
// `pnpm e2e:verify` builds dev, starts the harness, runs this, and tears down.
// Run standalone against an existing HS with:
//   TRINITY_HS=… TRINITY_USER=… TRINITY_PASS=… node e2e/features/verify-sas.mjs
import { mkdir } from 'node:fs/promises';
import { serve } from '../support/serve.mjs';
import { chromium } from 'playwright';

const PORT = 8125;
const APP = `http://localhost:${PORT}`;

const HS = process.env.TRINITY_HS ?? 'https://localhost:8448';
const USER = process.env.TRINITY_USER ?? 'verify-e2e';
const PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';
const HEADED = process.env.HEADED === '1';
const SLOWMO = Number(process.env.SLOWMO ?? 0);

// Generous: real SAS round-trips cross-context to-device traffic through the HS.
const STAGE_TIMEOUT = 60_000;
const SETUP_TIMEOUT = 90_000;

const log = (m) => console.log(`[verify] ${m}`);

/** Fill a native `<input trnInput>` by its associated `<label for="…">`. */
async function fillLabeledInput(page, label, value) {
  // Exact match: the password field's "Show password" reveal button (aria-label)
  // otherwise also matches a substring `getByLabel('Password')`, tripping strict mode.
  const input = page.getByLabel(label, { exact: true });
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.click();
  await input.fill(value);
}

/** Read the verify-page's live stage attribute (or null if the page isn't shown). */
async function stageOf(scope) {
  const el = scope.getByTestId('verify-page');
  if ((await el.count()) === 0) return null;
  return el.first().getAttribute('data-stage');
}

/** Wait until verify-page (page or modal) reaches one of the given stages. */
async function waitForStage(scope, stages, timeout = STAGE_TIMEOUT) {
  const wanted = Array.isArray(stages) ? stages : [stages];
  await scope
    .getByTestId('verify-page')
    .first()
    .waitFor({ state: 'attached', timeout });
  await scope.waitForFunction(
    (want) => {
      const el = document.querySelector('[data-testid="verify-page"]');
      return !!el && want.includes(el.getAttribute('data-stage'));
    },
    wanted,
    { timeout, polling: 200 },
  );
}

/** Log in: type the homeserver, Continue, fill credentials, Sign in → /rooms. */
async function login(page, who) {
  log(`${who}: loading app`);
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
  await page.waitForURL('**/login', { timeout: 15_000 });

  await fillLabeledInput(page, 'Homeserver', HS);
  await page.getByText('Continue', { exact: true }).click();

  // Discovery + loginFlows resolve, then the password form appears.
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', USER);
  await fillLabeledInput(page, 'Password', PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL('**/rooms', { timeout: 30_000 });
  log(`${who}: logged in → /rooms`);
}

/** Device A: set up encryption (UIA password alert → recovery key → continue). */
async function setUpEncryption(page) {
  log('A: opening /encryption/setup');
  // domcontentloaded, not networkidle: once logged in the matrix client runs a
  // sync long-poll, so the network never idles and goto would time out at 30s.
  // We wait on the concrete "Set up encryption" button below instead.
  await page.goto(`${APP}/encryption/setup`, { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Set up encryption' }).click();

  // UIA is *conditional*: depending on the Synapse build / account state the
  // bootstrap may pop the TrnAlertService password dialog (<trn-alert-dialog> in
  // a CDK dialog — replaces Ionic's <ion-alert>), or proceed straight to the
  // recovery key. Race the two — only fill the password if the dialog actually
  // appears, then fall through to waiting for the recovery key either way.
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
    log('A: UIA password prompt');
    await alert.locator('input[type="password"]').fill(PASS);
    await alert.getByRole('button', { name: 'Confirm' }).click();
  } else {
    log('A: no UIA prompt — proceeding to recovery key');
  }

  // Recovery key is shown once; tick "I've saved", then continue.
  await key.waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
  log(`A: recovery key shown (${(await key.innerText()).slice(0, 12)}…)`);

  await page
    .getByRole('checkbox', { name: /I've saved my recovery key/ })
    .click();
  await page.getByRole('button', { name: 'Continue to Trinity' }).click();
  await page.waitForURL('**/rooms', { timeout: 30_000 });
  log('A: encryption set up → /rooms');
}

/** The seven SAS emoji names rendered in a given scope (page or modal frame). */
async function emojiNames(scope) {
  return scope.locator('.emoji__name').allInnerTexts();
}

/**
 * After answering "They match", a device is waiting on its peer: the answer is spent
 * (no double-confirm), the wait is visible and announced, and the emoji stay up so the
 * user can still read them off to the device that hasn't answered yet.
 */
async function assertWaitingOnPeer(scope) {
  const waiting = scope.getByTestId('sas-waiting');
  await waiting.waitFor({ state: 'visible', timeout: STAGE_TIMEOUT });

  await scope
    .getByTestId('sas-match')
    .waitFor({ state: 'detached', timeout: STAGE_TIMEOUT });
  if ((await scope.getByTestId('sas-mismatch').count()) !== 0) {
    throw new Error('"They don\'t match" is still offered after answering');
  }
  if ((await waiting.getAttribute('aria-live')) !== 'polite') {
    throw new Error('the waiting status is not an aria-live region');
  }
  if ((await waiting.locator('trn-spinner').count()) !== 1) {
    throw new Error('no spinner inside the waiting status');
  }
  const names = await emojiNames(scope);
  if (names.length !== 7) {
    throw new Error(`emoji vanished while waiting (${names.length} left)`);
  }
}

async function main() {
  await mkdir('e2e/.artifacts', { recursive: true });
  const server = await serve('www', PORT);
  log(`serving www on ${APP}`);
  log(`homeserver=${HS} user=${USER}`);

  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo: SLOWMO,
    args: ['--disable-dev-shm-usage'],
  });

  // ignoreHTTPSErrors lets the contexts talk to the self-signed Caddy TLS front.
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [page, who] of [
    [A, 'A'],
    [B, 'B'],
  ]) {
    page.on('pageerror', (e) => console.log(`  [${who}:error] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error')
        console.log(`  [${who}:console.error] ${m.text()}`);
    });
  }

  let exit = 1;
  try {
    // 1. Device A: first device — log in and bootstrap crypto.
    await login(A, 'A (device 1)');
    await setUpEncryption(A);

    // 2. Device B: same user, new context ⇒ new device, needs-recovery.
    await login(B, 'B (device 2)');

    // 3. B initiates the SAS verification.
    log('B: starting verification (/encryption/verify)');
    // domcontentloaded, not networkidle: sync long-poll keeps the network busy.
    await B.goto(`${APP}/encryption/verify`, { waitUntil: 'domcontentloaded' });
    await B.getByTestId('verify-start').click();

    // 4. A's host auto-pops the incoming-request modal — accept it.
    log('A: waiting for incoming request modal');
    await waitForStage(A, ['requested', 'ready']);
    // Accept is only present in the 'requested' stage; if A already auto-advanced
    // to 'ready' the accept step is implicit.
    if ((await stageOf(A)) === 'requested') {
      await A.getByTestId('verify-accept').click();
      log('A: accepted');
    }

    // 5. Both become ready; one side starts the emoji SAS. Either device may drive
    //    it — once one calls startVerification the SDK advances both. We click the
    //    "Start emoji verification" button on whichever side surfaces it first, and
    //    only once (a second click would race the in-flight negotiation).
    await waitForStage(A, ['ready', 'waiting', 'sas-shown']);
    await waitForStage(B, ['ready', 'waiting', 'sas-shown']);

    if (
      (await stageOf(A)) !== 'sas-shown' &&
      (await stageOf(B)) !== 'sas-shown'
    ) {
      const startA = A.getByTestId('verify-start-sas');
      const startB = B.getByTestId('verify-start-sas');
      const starter = await Promise.race([
        startA
          .waitFor({ state: 'visible', timeout: STAGE_TIMEOUT })
          .then(() => A),
        startB
          .waitFor({ state: 'visible', timeout: STAGE_TIMEOUT })
          .then(() => B),
      ]);
      log(`${starter === A ? 'A' : 'B'}: starting emoji SAS`);
      await starter.getByTestId('verify-start-sas').click();
    }

    // 6. Both reach sas-shown; assert the seven emoji match across contexts.
    log('waiting for both to show emoji (sas-shown)');
    await waitForStage(A, 'sas-shown');
    await waitForStage(B, 'sas-shown');

    const [emojiA, emojiB] = await Promise.all([emojiNames(A), emojiNames(B)]);
    log(`A emoji: ${emojiA.join(', ')}`);
    log(`B emoji: ${emojiB.join(', ')}`);
    if (emojiA.length !== 7 || emojiB.length !== 7) {
      throw new Error(
        `expected 7 emoji each, got A=${emojiA.length} B=${emojiB.length}`,
      );
    }
    if (JSON.stringify(emojiA) !== JSON.stringify(emojiB)) {
      throw new Error(
        `emoji mismatch across devices:\n  A=${emojiA}\n  B=${emojiB}`,
      );
    }
    log('emoji match across both devices ✓');

    // 7. A answers first. The verification cannot complete until B answers too, so
    //    this is the real two-device window the waiting spinner exists for — and the
    //    only place it can be observed honestly (a single-client test would have to
    //    fake the other side never replying).
    await A.getByTestId('sas-match').click();
    log('A: confirmed "They match"');
    await assertWaitingOnPeer(A);

    // B has not answered, so B must still be *asking* — the wait is per device, not
    // a global "verification is busy" state.
    if ((await B.getByTestId('sas-waiting').count()) !== 0) {
      throw new Error('B shows the waiting spinner without having answered');
    }
    await B.getByTestId('sas-match').waitFor({
      state: 'visible',
      timeout: STAGE_TIMEOUT,
    });
    // A cannot be done while B is still being asked.
    if ((await stageOf(A)) !== 'sas-shown') {
      throw new Error(
        `A left sas-shown before B answered (stage=${await stageOf(A)})`,
      );
    }
    log('A waits, B still asks ✓');

    await B.getByTestId('sas-match').click();
    log('both confirmed "They match"');

    // 8. Both reach done.
    await waitForStage(A, 'done');
    await waitForStage(B, 'done');
    // The spinner belongs to the wait, not to the outcome screen.
    if ((await A.getByTestId('sas-waiting').count()) !== 0) {
      throw new Error('A still shows the waiting spinner after completing');
    }
    log('both reached data-stage="done" ✓');

    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[verify] error:', err.message);
    try {
      console.error(`  A stage=${await stageOf(A)} url=${A.url()}`);
      console.error(`  B stage=${await stageOf(B)} url=${B.url()}`);
      await A.screenshot({ path: 'e2e/.artifacts/A-failure.png' }).catch(
        () => {},
      );
      await B.screenshot({ path: 'e2e/.artifacts/B-failure.png' }).catch(
        () => {},
      );
    } catch {
      /* best effort */
    }
    console.log('\nRESULT: FAIL');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
