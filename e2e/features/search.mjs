// Search feature e2e — quick-switcher + in-room message search.
//
// Three scenarios:
//
//   1. Quick Switcher → jump to a room: seed two rooms; open the switcher (click
//      open-switcher button or Ctrl/Cmd+K); type one room's name; a result row
//      appears; click it → the room is open (the header heading shows its name).
//
//   2. In-room message search → jump to a message: open a plaintext room seeded
//      with several messages (one with a distinctive token); click search-messages;
//      type the token; the matching result row appears; click it → the timeline
//      [data-mid="<eventId>"] element is visible (jumpTo scroll triggered).
//
//   3. Quick Switcher → directory person → DM: register a 2nd user (admin API);
//      type their username in the switcher; a "Person" directory result appears;
//      select it → a DM channel opens and the header title shows the user.
//
// Env:
//   TRINITY_HS    default https://localhost:8448
//   TRINITY_USER  default verify-e2e
//   TRINITY_PASS  default verify-e2e-pass-123
//   HEADED=1 / SLOWMO=ms  for debugging
//
// `pnpm e2e:search` builds dev, starts the harness, runs this, and tears down.
// MUST run sequentially with other e2e scripts (shared docker stack + www/ build).
import { mkdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { serve } from '../support/serve.mjs';
import { REGISTRATION_SHARED_SECRET, SYNAPSE_HTTP } from '../synapse/start.mjs';
import { chromium } from 'playwright';

// Node's fetch (CS-API helpers) must accept Caddy's self-signed cert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = 8131;
const APP = `http://localhost:${PORT}`;

const HS = process.env.TRINITY_HS ?? 'https://localhost:8448';
const USER = process.env.TRINITY_USER ?? 'verify-e2e';
const PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';
const SERVER_NAME = 'localhost';
const HEADED = process.env.HEADED === '1';
const SLOWMO = Number(process.env.SLOWMO ?? 0);

// Unique names per run so re-runs never collide with stale rooms.
const RUN_ID = Date.now().toString(36);
// Scenario 1 — two rooms for the quick-switcher jump test.
const ROOM_A = `Alpha-${RUN_ID}`;
const ROOM_B = `Beta-${RUN_ID}`;
// Scenario 2 — plaintext room with a seeded message that has a distinctive token.
const SEARCH_ROOM = `Search-${RUN_ID}`;
// The token is a short, unique string with no spaces so it matches exactly.
const TOKEN = `XSRCH${RUN_ID}`;
// Scenario 3 — second user for the directory → DM path.
const BOB_USER = `bob-${RUN_ID}`;
const BOB_PASS = `bobpass-${RUN_ID}`;
const BOB_ID = `@${BOB_USER}:${SERVER_NAME}`;

const STEP_TIMEOUT = 30_000;
const SETUP_TIMEOUT = 60_000;

const log = (m) => console.log(`[search] ${m}`);

// ---------------------------------------------------------------------------
// CS-API helpers
// ---------------------------------------------------------------------------

/**
 * Register a user via Synapse's shared-secret admin endpoint. Idempotent: "already
 * exists" is treated as success (mirrors rooms.mjs).
 */
async function registerUser(username, password) {
  const nonceRes = await fetch(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`);
  if (!nonceRes.ok) {
    throw new Error(
      `register nonce → ${nonceRes.status} ${await nonceRes.text()}`,
    );
  }
  const { nonce } = await nonceRes.json();
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await fetch(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, username, password, admin: false, mac }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (/already.*exists|user.*taken/i.test(text)) {
      log(`@${username}:${SERVER_NAME} already exists — reusing`);
      return;
    }
    throw new Error(`register ${username} → ${res.status} ${text}`);
  }
  log(`registered @${username}:${SERVER_NAME}`);
}

async function apiLogin(user, pass) {
  const res = await fetch(`${HS}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    }),
  });
  if (!res.ok) {
    throw new Error(`login ${user} → ${res.status} ${await res.text()}`);
  }
  return res.json(); // { access_token, user_id, … }
}

async function csPost(token, path, body) {
  const res = await fetch(`${HS}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : {};
}

/** PUT a room event with an idempotent txnId — used for send/m.room.message. */
async function csPut(token, path, body) {
  const res = await fetch(`${HS}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PUT ${path} → ${res.status} ${await res.text()}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : {};
}

/** Retry `fn` until it returns a truthy value or the attempt limit is reached. */
async function poll(fn, { tries = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('poll timed out');
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

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

/**
 * Open a CDK dialog (quick-switcher / message-search — replaces Ionic's
 * <ion-modal>), interact with it, then wait for it to dismiss. Returns the
 * dialog locator so callers can scope further queries to it.
 */
async function waitForModal(page) {
  const modal = page.locator('.cdk-dialog-container');
  await modal.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  return modal;
}

async function waitForModalGone(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('.cdk-dialog-container').length === 0,
    undefined,
    { timeout: STEP_TIMEOUT, polling: 200 },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir('e2e/.artifacts', { recursive: true });

  // ── CS-API pre-setup ───────────────────────────────────────────────────────
  const { access_token: aliceToken } = await apiLogin(USER, PASS);
  log(`alice api login ok`);

  // Scenario 1: two rooms for quick-switcher jump.
  const { room_id: roomAId } = await csPost(
    aliceToken,
    '/_matrix/client/v3/createRoom',
    { name: ROOM_A, preset: 'private_chat' },
  );
  log(`created ROOM_A: ${roomAId} ("${ROOM_A}")`);

  const { room_id: roomBId } = await csPost(
    aliceToken,
    '/_matrix/client/v3/createRoom',
    { name: ROOM_B, preset: 'private_chat' },
  );
  log(`created ROOM_B: ${roomBId} ("${ROOM_B}")`);

  // Scenario 2: plaintext room with seeded messages.
  const { room_id: searchRoomId } = await csPost(
    aliceToken,
    '/_matrix/client/v3/createRoom',
    {
      name: SEARCH_ROOM,
      preset: 'private_chat',
      // No encryption state — plaintext so both loaded + server search paths work.
    },
  );
  log(`created SEARCH_ROOM: ${searchRoomId} ("${SEARCH_ROOM}")`);

  const txn = `srch-${RUN_ID}`;

  const { event_id: _preId } = await csPut(
    aliceToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(searchRoomId)}/send/m.room.message/${txn}-pre`,
    { msgtype: 'm.text', body: `Pre ${RUN_ID}` },
  );

  const { event_id: tokenEventId } = await csPut(
    aliceToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(searchRoomId)}/send/m.room.message/${txn}-token`,
    { msgtype: 'm.text', body: TOKEN },
  );
  log(`sent token message ${tokenEventId} body="${TOKEN}"`);

  await csPut(
    aliceToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(searchRoomId)}/send/m.room.message/${txn}-post`,
    { msgtype: 'm.text', body: `Post ${RUN_ID}` },
  );

  // Scenario 3: register BOB and seed BOB into the user directory.
  log(`registering second user @${BOB_USER}:${SERVER_NAME}`);
  await registerUser(BOB_USER, BOB_PASS);
  const { access_token: bobToken } = await apiLogin(BOB_USER, BOB_PASS);
  log(`BOB api login ok`);

  // BOB creates a public room → Synapse indexes BOB in the user directory.
  await csPost(bobToken, '/_matrix/client/v3/createRoom', {
    preset: 'public_chat',
    name: `Bob-stub-${RUN_ID}`,
  });
  log(`BOB created a public room (user-directory seed)`);

  // Poll the user directory until BOB is indexed (Synapse indexes asynchronously).
  log('waiting for BOB to appear in user directory…');
  await poll(
    async () => {
      const res = await fetch(`${HS}/_matrix/client/v3/user_directory/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ search_term: BOB_USER, limit: 10 }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      return (body.results ?? []).some((u) => u.user_id === BOB_ID)
        ? true
        : null;
    },
    { tries: 30, delayMs: 1000 },
  );
  log(`BOB is in user directory ✓`);

  // ── Browser setup ──────────────────────────────────────────────────────────
  const server = await serve('www', PORT);
  log(`serving www on ${APP} (homeserver=${HS} user=${USER})`);

  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo: SLOWMO,
    args: ['--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  });

  // Service-worker / TLS bypass: context.route() re-fetches HS requests at the
  // CDP layer where ignoreHTTPSErrors applies (same rationale as rooms.mjs).
  await ctx.route(`${HS}/**`, async (route) => {
    try {
      const response = await route.fetch({ ignoreHTTPSErrors: true });
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
    await login(page);

    // Wait for the seeded rooms to sync and appear in the sidebar so the local
    // switcher corpus is populated before we start typing.
    log('waiting for seeded rooms to appear in sidebar');
    const searchRoomChannel = page.locator('.channel', {
      hasText: SEARCH_ROOM,
    });
    await searchRoomChannel
      .first()
      .waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
    log('seeded rooms visible in sidebar ✓');

    // ── SCENARIO 1: Quick Switcher → jump to ROOM_A ───────────────────────
    log(`--- Scenario 1: quick switcher → "${ROOM_A}" ---`);

    // Open the switcher via the header button (data-testid="open-switcher").
    await page.getByTestId('open-switcher').click();
    const modal1 = await waitForModal(page);
    log('quick-switcher modal open');

    // Type ROOM_A into the quick-switcher's native search input (click it, then
    // keyboard.type so every (input) event fires on every keystroke).
    const switcherInput1 = modal1.getByPlaceholder(
      'Search rooms, spaces, people',
    );
    await switcherInput1.waitFor({ state: 'visible', timeout: 10_000 });
    await switcherInput1.click();
    await page.keyboard.type(ROOM_A, { delay: 30 });

    // A result row for ROOM_A should appear immediately (local computed match).
    const resultA = modal1.locator('.qs-row').filter({ hasText: ROOM_A });
    await resultA.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log(`result row "${ROOM_A}" visible in switcher ✓`);

    // Click the result → modal dismisses, RoomsPage.jumpTo() opens the room.
    await resultA.first().click();
    await waitForModalGone(page);
    log('switcher modal dismissed ✓');

    // The room header's heading should now show the active room name (still
    // the rooms toolbar h1 — see rooms.page.html).
    await page.waitForFunction(
      (name) => {
        const el = document.querySelector('header h1');
        return !!el && el.textContent.includes(name);
      },
      ROOM_A,
      { timeout: STEP_TIMEOUT, polling: 200 },
    );
    log(`room header shows "${ROOM_A}" ✓`);
    log('PASS scenario 1');

    // ── SCENARIO 2: In-room message search → jump to TOKEN message ─────────
    log(`--- Scenario 2: in-room message search → "${TOKEN}" ---`);

    // Navigate to SEARCH_ROOM by clicking it in the sidebar.
    await searchRoomChannel.first().click();

    // The "Search messages" header button is only rendered when activeRoom() is set.
    const searchMsgsBtn = page.getByTestId('search-messages');
    await searchMsgsBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });

    // Wait for the distinctive token message to sync and render in the timeline.
    const tokenRow = page.locator('.msg', { hasText: TOKEN });
    await tokenRow
      .first()
      .waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
    log(`token message "${TOKEN}" visible in timeline ✓`);

    // Open in-room message search.
    await searchMsgsBtn.click();
    const modal2 = await waitForModal(page);
    log('message-search modal open');

    // Type the distinctive token into the message-search's native input.
    const searchInput2 = modal2.getByPlaceholder('Search this conversation');
    await searchInput2.waitFor({ state: 'visible', timeout: 10_000 });
    await searchInput2.click();
    await page.keyboard.type(TOKEN, { delay: 30 });

    // A [data-testid="result"] row should appear with the token in its text.
    const searchResult = modal2.locator('[data-testid="result"]');
    await searchResult
      .first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log(`search result row visible ✓`);

    const resultText = await searchResult.first().textContent();
    if (!resultText?.includes(TOKEN)) {
      throw new Error(
        `search result text doesn't contain "${TOKEN}": "${resultText?.trim()}"`,
      );
    }
    log(`result confirms token "${TOKEN}" ✓`);

    // Click the result → modal dismisses with eventId → RoomsPage sets
    // messageSearchTarget → MessageListComponent.jumpTo() scrolls [data-mid].
    await searchResult.first().click();
    await waitForModalGone(page);
    log('message-search modal dismissed ✓');

    // [data-mid="${tokenEventId}"] must be visible in the timeline (the element
    // is in the DOM and CSS-rendered; jumpTo() has scrolled it into view).
    const jumpedMsg = page.locator(`[data-mid="${tokenEventId}"]`);
    await jumpedMsg.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log(`[data-mid="${tokenEventId}"] visible in timeline ✓`);

    // Verify the element is actually within the scroll container's visible area.
    const inScrollView = await page.evaluate((id) => {
      const el = document.querySelector(`[data-mid="${id}"]`);
      if (!el) return false;
      // .scroll is MessageListComponent's scrollable container.
      const scrollEl = el.closest('.scroll');
      if (!scrollEl) return true; // no scroll container — visible by default
      const elRect = el.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      // Allow ±20 px tolerance for smooth-scroll animation timing.
      return (
        elRect.top <= scrollRect.bottom + 20 &&
        elRect.bottom >= scrollRect.top - 20
      );
    }, tokenEventId);
    if (!inScrollView) {
      throw new Error(
        `[data-mid="${tokenEventId}"] not scrolled into the visible scroll area`,
      );
    }
    log(`[data-mid="${tokenEventId}"] is within scroll container view ✓`);
    log('PASS scenario 2');

    // ── SCENARIO 3: Quick Switcher → directory person → DM ───────────────
    log(`--- Scenario 3: quick switcher → BOB person → DM ---`);

    const channelsBefore = await page.locator('button.channel').count();

    await page.getByTestId('open-switcher').click();
    const modal3 = await waitForModal(page);
    log('quick-switcher modal open (scenario 3)');

    // Type BOB_USER (e.g. "bob-1mxxxxxx") to trigger the debounced directory
    // search — the term is >2 chars so searchPeople() fires after 250 ms.
    const switcherInput3 = modal3.getByPlaceholder(
      'Search rooms, spaces, people',
    );
    await switcherInput3.waitFor({ state: 'visible', timeout: 10_000 });
    await switcherInput3.click();
    await page.keyboard.type(BOB_USER, { delay: 30 });

    // Wait for a result row (.qs-row) whose trailing kind-label span reads
    // "Person" (kind='user') — the label is a plain <span>, no longer an
    // <ion-note>, but still light-DOM content of trn-quick-switcher.
    await page.waitForFunction(
      (bobUser) => {
        const qs = document.querySelector('trn-quick-switcher');
        if (!qs) return false;
        const rows = [...qs.querySelectorAll('.qs-row')];
        for (const row of rows) {
          const hasPersonLabel = [...row.querySelectorAll('span')].some(
            (n) => n.textContent?.trim() === 'Person',
          );
          const hasUserText = row.textContent?.includes(bobUser);
          if (hasPersonLabel && hasUserText) return true;
        }
        return false;
      },
      BOB_USER,
      { timeout: STEP_TIMEOUT, polling: 300 },
    );
    log(`directory "Person" result for BOB ("${BOB_USER}") visible ✓`);

    // Click the Person result to start the DM.
    const personResult = modal3.locator('.qs-row').filter({
      has: page.getByText('Person', { exact: true }),
    });
    await personResult.first().click();

    // Modal dismisses; RoomsPage.jumpTo creates a DM then calls onSelectRoom.
    await waitForModalGone(page);
    log('switcher modal dismissed (DM creation in progress) ✓');

    // A new .channel button should appear (the DM room added to the sidebar).
    await page.waitForFunction(
      (before) => document.querySelectorAll('button.channel').length > before,
      channelsBefore,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log('DM channel appeared in sidebar ✓');

    // The room header's heading should show BOB's name (localpart or full
    // MXID — both contain BOB_USER's localpart, e.g.
    // "@bob-1mxxxxxx:localhost" ⊇ "bob-1mxxxxxx"). Still the toolbar h1
    // post-migration — see rooms.page.html.
    await page.waitForFunction(
      (bobUser) => {
        const el = document.querySelector('header h1');
        return (
          !!el && el.textContent.toLowerCase().includes(bobUser.toLowerCase())
        );
      },
      BOB_USER,
      { timeout: STEP_TIMEOUT, polling: 300 },
    );
    log(`room header shows BOB identifier ✓`);
    log('PASS scenario 3');

    // -----------------------------------------------------------------------
    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[search] error:', err.message);
    await page
      .screenshot({ path: 'e2e/.artifacts/search-failure.png' })
      .catch(() => {});
    console.log('\nRESULT: FAIL');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error('[search] fatal:', err);
  process.exit(1);
});
