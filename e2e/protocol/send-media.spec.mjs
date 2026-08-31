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
// The Nx target defaults to disposable attempt-scoped credentials. Explicit
// remote mode accepts TRINITY_HS/TRINITY_USER/TRINITY_PASS; HEADED/SLOWMO aid debugging.
//
// `pnpm e2e:media` builds dev, starts the harness, runs this, and tears down.
import { waitForRooms } from '../support/navigation.mjs';
import { applicationOrigin } from '../support/session.mts';
import { protocolResponseFailure } from './diagnostics.mts';
import { test, expect } from './fixtures.mts';

const APP = applicationOrigin();

let HS;
let USER;
let PASS;
let ROOM_NAME;

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
    throw protocolResponseFailure(path, res);
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
  await waitForRooms(page);
  log('encryption set up → /rooms');
}

async function main(protocolBrowser) {
  const roomId = await createEncryptedRoom();
  log(`serving www on ${APP} (homeserver=${HS})`);

  const page = await protocolBrowser.newAuthenticatedPage({ label: 'media' });

  let exit = 1;
  try {
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

    // ORDER, read back off the timeline. This is the claim the whole `concatMap` design
    // exists for, and until now only a unit test with a scripted sender checked it — against
    // a real homeserver the uploads finish at genuinely different times, which is the case
    // that would actually reorder them. The filename survives as the image's alt text
    // (`content.filename ?? content.body`), so the DOM can be asked what arrived when.
    const order = await page.$$eval(
      '[data-testid="media-bubble"] img[alt]',
      (imgs) => imgs.map((img) => img.getAttribute('alt')),
    );
    const batchOrder = order.filter((name) => name?.startsWith('batch-'));
    if (batchOrder.join(',') !== 'batch-1.png,batch-2.png,batch-3.png') {
      throw new Error(
        `batch arrived out of order: ${JSON.stringify(batchOrder)}`,
      );
    }
    log(`batch arrived in the order staged (${batchOrder.join(' → ')}) ✓`);

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

    // Fifth: a batch in which one file genuinely FAILS, which is the claim the per-item
    // outcome design exists for — one bad file costs you that file and not the other. Every
    // other case here is a happy path, so the "Not sent" marker and the per-row retry had
    // never run against a real server. The upload is failed at the network layer rather than
    // by reconfiguring Synapse, so the shared harness is untouched and one request is hit.
    await page.locator('textarea.composer__input').press('Escape');
    await page
      .getByTestId('composer-pending')
      .first()
      .waitFor({ state: 'detached', timeout: 10_000 });

    let failNextUpload = true;
    await page.route('**/_matrix/media/*/upload*', async (route) => {
      if (failNextUpload) {
        failNextUpload = false;
        await route.abort('failed');
        return;
      }
      await route.fallback();
    });

    log('sending two files, the first of which cannot be uploaded');
    await page.getByTestId('composer-file-input').setInputFiles([
      { name: 'doomed.png', mimeType: 'image/png', buffer: PNG_1x1 },
      { name: 'survivor.png', mimeType: 'image/png', buffer: PNG_1x1 },
    ]);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="composer-pending"]').length ===
        2,
      undefined,
      { timeout: 15_000, polling: 100 },
    );
    await page.locator('textarea.composer__input').press('Enter');

    // The one that failed stays, marked, with a retry of its own; the one that went out
    // leaves. Exactly one row, and it is the doomed one.
    await page
      .getByTestId('composer-pending-failed')
      .waitFor({ state: 'visible', timeout: 30_000 });
    const failedRows = await page
      .getByTestId('composer-pending')
      .allInnerTexts();
    if (failedRows.length !== 1 || !failedRows[0].includes('doomed.png')) {
      throw new Error(
        `expected only doomed.png left staged, got ${JSON.stringify(failedRows)}`,
      );
    }
    if (!/not sent/i.test(failedRows[0])) {
      throw new Error(`row is not marked as failed: "${failedRows[0]}"`);
    }
    await page
      .getByTestId('composer-pending-retry')
      .waitFor({ state: 'visible', timeout: 10_000 });
    log('the failed file stayed, marked "Not sent"; its sibling went out ✓');

    // Retry: the interception has spent itself, so this one goes through.
    await page.getByTestId('composer-pending-retry').click();
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="media-bubble"] img[alt]'),
        ).some((img) => img.getAttribute('alt') === 'doomed.png'),
      undefined,
      { timeout: 90_000, polling: 250 },
    );
    await page
      .getByTestId('composer-pending')
      .first()
      .waitFor({ state: 'detached', timeout: 15_000 });
    log('retry delivered it and cleared the row ✓');
    await page.unroute('**/_matrix/media/*/upload*');

    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.log('\nRESULT: FAIL');
    throw err;
  }
  expect(exit).toBe(0);
}

test('sends encrypted media, captions, batches, and retries', async ({
  protocolBrowser,
  protocolCredentials,
  resourceNamespace,
}) => {
  HS = protocolCredentials.hs;
  USER = protocolCredentials.user;
  PASS = protocolCredentials.pass;
  ROOM_NAME = `Media ${resourceNamespace.role('media')}`;
  await main(protocolBrowser);
});
