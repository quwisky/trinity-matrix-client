// Reply header + preview e2e — regression for two reply-rendering bug fixes.
//
// Drives a single real reply flow against a live homeserver:
//
//   1. A reply keeps its own author header (avatar + name) even when it is a
//      same-sender continuation candidate (the reply immediately follows the
//      same sender's own recent message). Previously the reply was grouped
//      as a headerless continuation, so its author appeared to go missing.
//
//   2. The reply renders a reply-preview line quoting the message it replies
//      to (the quoted sender's name + avatar + a snippet of the quoted body).
//
// The Nx target defaults to disposable attempt-scoped credentials. Explicit
// remote mode accepts TRINITY_HS/TRINITY_USER/TRINITY_PASS; HEADED/SLOWMO aid debugging.
//
// `pnpm e2e:reply` builds dev, starts the harness, runs this, and tears down.
import { waitForRooms } from '../support/navigation.mjs';
import { applicationOrigin } from '../support/session.mts';
import { test, expect } from './fixtures.mts';

const APP = applicationOrigin();

let HS;
let USER;
let PASS;
let IGNORE_HTTP_ERRORS;

// Each run gets its own unique names so re-runs don't collide.
let RUN_ID;
let ROOM_NAME;
let ORIGINAL_MSG;
let REPLY_TEXT;

const SETUP_TIMEOUT = 90_000;
const STEP_TIMEOUT = 30_000;

const log = (m) => console.log(`[reply] ${m}`);

// ---------------------------------------------------------------------------
// CS API helpers
// ---------------------------------------------------------------------------

async function api(path, { token, body, method = 'POST' } = {}) {
  const opts = {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${HS}${path}`, opts);
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Log in via the CS API, create a plain (non-encrypted) room, and send one
 * message — the message the browser will reply to. Because it's the only
 * (and therefore most recent) message from this sender, it's also what
 * makes the reply a same-sender continuation candidate.
 */
async function setupRoom() {
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
      preset: 'private_chat',
      // No encryption state — keeps the test focused on reply rendering, not E2EE.
    },
  });
  log(`created room ${roomId} ("${ROOM_NAME}")`);

  // Root message — this is the one we'll reply to.
  const { event_id: originalEventId } = await api(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/trn-original-${RUN_ID}`,
    {
      token,
      method: 'PUT',
      body: { msgtype: 'm.text', body: ORIGINAL_MSG },
    },
  );
  log(`sent original message ${originalEventId}`);

  return { roomId, originalEventId };
}

// ---------------------------------------------------------------------------
// UI helpers (mirrors threads.mjs / send-media.mjs / verify-sas.mjs)
// ---------------------------------------------------------------------------

/** Fill a native `<input hlmInput>` by its associated `<label for="…">`. */
async function fillLabeledInput(page, label, value) {
  // Exact match: the password field's "Show password" reveal button (aria-label) otherwise
  // also matches a substring `getByLabel('Password')`, tripping strict mode. Same fix as
  // e2e/support/app.mts:34 and verify-sas.mjs:45.
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
  await waitForRooms(page);
  log('logged in → /rooms');
}

/**
 * Hover over a message row, wait for the floating toolbar to become interactive,
 * then click the named button inside it. `opts` is forwarded to `getByRole` so
 * callers can request an exact-name match — the toolbar also has a "Reply in
 * thread" button, which is a superstring of "Reply" and would otherwise match too.
 */
async function hoverAndClickToolbar(page, msgLocator, buttonName, opts = {}) {
  // Keep the mouse over the message so the CSS :hover state stays active.
  await msgLocator.hover({ force: true });
  const btn = msgLocator.getByRole('button', { name: buttonName, ...opts });
  // The toolbar transitions from opacity:0 to opacity:1 on hover; wait for it
  // to be visible (CSS transition ~100 ms) before clicking.
  await btn.waitFor({ state: 'visible', timeout: 5_000 });
  await btn.click({ force: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(browser, testInfo) {
  // 1. Seed the room + original message via the CS API before the browser runs.
  const { originalEventId } = await setupRoom();
  log(`originalEventId=${originalEventId}`);
  log(`serving www on ${APP} (homeserver=${HS})`);

  // ignoreHTTPSErrors so the app can talk to Caddy's self-signed TLS front.
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: IGNORE_HTTP_ERRORS,
    viewport: { width: 1280, height: 720 },
  });

  // Production builds include Angular's ngsw service worker. The SW intercepts
  // ALL fetch requests including cross-origin calls to https://localhost:8448.
  // In the SW's execution context, `ignoreHTTPSErrors` does not apply, so
  // Caddy's self-signed cert causes every homeserver request to get a 504.
  // Playwright's context.route() hooks in at the CDP network layer (below the
  // SW) and re-fetches via route.fetch(), which DOES honour ignoreHTTPSErrors,
  // restoring 200 responses. This is a no-op when the build is dev (no SW).
  await ctx.route(`${HS}/**`, async (route) => {
    try {
      const response = await route.fetch({
        ignoreHTTPSErrors: IGNORE_HTTP_ERRORS,
      });
      await route.fulfill({ response });
    } catch {
      await route.fallback();
    }
  });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [page:error] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [console.error] ${m.text()}`);
  });

  let exit = 1;
  try {
    // 2. Log in and open the seeded room.
    await login(page);

    log(`opening room "${ROOM_NAME}"`);
    const channel = page.locator('.channel', { hasText: ROOM_NAME });
    await channel.first().click({ timeout: SETUP_TIMEOUT });

    // Wait for the seeded root message to sync and render.
    log('waiting for seeded message to sync');
    const rootMsgRow = page.locator('.msg').filter({ hasText: ORIGINAL_MSG });
    await rootMsgRow
      .first()
      .waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
    log('seeded message visible in timeline');

    // -----------------------------------------------------------------------
    // Reply to the root message from the composer (not "Reply in thread").
    // -----------------------------------------------------------------------
    log('--- Reply to the root message ---');

    // Match "Reply" exactly — the toolbar also has "Reply in thread", which
    // would otherwise satisfy a substring match on "Reply".
    await hoverAndClickToolbar(page, rootMsgRow.first(), 'Reply', {
      exact: true,
    });

    // Confirm the composer reply banner appears.
    log('waiting for the composer reply banner');
    const banner = page.locator('.composer__banner', {
      hasText: 'Replying to',
    });
    await banner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('reply banner visible ("Replying to …")');

    // Type and send the reply into the MAIN composer (not any modal).
    const composerInput = page.locator('.composer__input');
    await composerInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await composerInput.click();
    await composerInput.fill(REPLY_TEXT);
    await composerInput.press('Enter');
    log(`sent reply "${REPLY_TEXT}"`);

    // Wait for the reply row to appear in the timeline.
    log('waiting for reply to appear in the timeline');
    const replyRow = page
      .locator('.msg')
      .filter({ hasText: REPLY_TEXT })
      .first();
    await replyRow.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('reply visible in timeline');

    // -----------------------------------------------------------------------
    // FIX 1: the reply shows its own header, not a headerless continuation.
    // -----------------------------------------------------------------------
    log('--- Fix 1: reply shows its own author header ---');

    const author = replyRow.locator('.msg__author');
    await author.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    const authorText = (await author.textContent())?.trim();
    if (!authorText) {
      throw new Error(
        'Expected the reply row to render .msg__author with the sender name, ' +
          'but it was empty or missing',
      );
    }
    log(`reply .msg__author visible ("${authorText}") ✓`);

    const headerAvatarCount = await replyRow.locator('.msg__avatar').count();
    if (headerAvatarCount < 1) {
      throw new Error(
        `Expected the reply row to render at least one .msg__avatar (header ` +
          `avatar), but found ${headerAvatarCount}`,
      );
    }
    log(`reply .msg__avatar present (count=${headerAvatarCount}) ✓`);

    const isContinuation = await replyRow.evaluate((el) =>
      el.classList.contains('msg--cont'),
    );
    if (isContinuation) {
      throw new Error(
        'Expected the reply row NOT to carry the .msg--cont continuation ' +
          'class (it should always break grouping), but it does — the ' +
          'author header would be hidden',
      );
    }
    log('reply row does not carry .msg--cont ✓');
    log('PASS fix 1: reply keeps its own header (not a continuation)');

    // -----------------------------------------------------------------------
    // FIX 2: the reply renders a reply-preview quoting the original message.
    // -----------------------------------------------------------------------
    log('--- Fix 2: reply renders a quoted reply-preview ---');

    const preview = replyRow.locator('.msg__reply');
    await preview.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('reply .msg__reply preview visible ✓');

    const previewAvatarCount = await replyRow
      .locator('.msg__reply-avatar')
      .count();
    if (previewAvatarCount < 1) {
      throw new Error(
        `Expected the reply preview to render at least one .msg__reply-avatar, ` +
          `but found ${previewAvatarCount}`,
      );
    }
    log(`reply .msg__reply-avatar present (count=${previewAvatarCount}) ✓`);

    const previewAuthor = replyRow.locator('.msg__reply-author');
    const previewAuthorText = (await previewAuthor.textContent())?.trim();
    if (!previewAuthorText) {
      throw new Error(
        'Expected the reply preview to render .msg__reply-author with the ' +
          'quoted sender name, but it was empty or missing',
      );
    }
    log(`reply .msg__reply-author visible ("${previewAuthorText}") ✓`);

    const previewBody = replyRow.locator('.msg__reply-body');
    const previewBodyText = (await previewBody.textContent())?.trim() ?? '';
    if (!previewBodyText.includes(ORIGINAL_MSG)) {
      throw new Error(
        `Expected the reply preview .msg__reply-body to contain the quoted ` +
          `original text "${ORIGINAL_MSG}", but got "${previewBodyText}"`,
      );
    }
    log(`reply .msg__reply-body quotes the original message ✓`);
    log('PASS fix 2: reply preview quotes the original message');

    // -----------------------------------------------------------------------
    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[reply] error:', err.message);
    await page
      .screenshot({ path: testInfo.outputPath('reply-failure.png') })
      .catch(() => {});
    console.log('\nRESULT: FAIL');
    throw err;
  } finally {
    await ctx.close();
  }
  expect(exit).toBe(0);
}

test('renders a reply with its author and quoted preview', async ({
  browser,
  protocolCredentials,
  resourceNamespace,
}, testInfo) => {
  HS = protocolCredentials.hs;
  USER = protocolCredentials.user;
  PASS = protocolCredentials.pass;
  IGNORE_HTTP_ERRORS = protocolCredentials.mode === 'disposable';
  RUN_ID = resourceNamespace.role('reply');
  ROOM_NAME = `Reply E2E ${RUN_ID}`;
  ORIGINAL_MSG = `Original message ${RUN_ID}`;
  REPLY_TEXT = `My reply ${RUN_ID}`;
  await main(browser, testInfo);
});
