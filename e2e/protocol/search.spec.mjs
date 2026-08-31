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
//      select it → an account-qualified DM opens and the header shows the user.
//
// The Nx target defaults to disposable attempt-scoped credentials. Explicit remote mode
// additionally requires TRINITY_SECONDARY_USER/TRINITY_SECONDARY_PASS.
//
// `pnpm e2e:search` builds dev, starts the harness, runs this, and tears down.
import { applicationOrigin } from '../support/session.mts';
import { protocolResponseFailure } from './diagnostics.mts';
import { test, expect } from './fixtures.mts';

const APP = applicationOrigin();

let HS;
let USER;
let PASS;
let USER_ID;

// Unique names per run so re-runs never collide with stale rooms.
let RUN_ID;
// Scenario 1 — two rooms for the quick-switcher jump test.
let ROOM_A;
let ROOM_B;
// Scenario 2 — plaintext room with a seeded message that has a distinctive token.
let SEARCH_ROOM;
// The token is a short, unique string with no spaces so it matches exactly.
let TOKEN;
// Scenario 3 — second user for the directory → DM path.
let BOB_USER;
let BOB_PASS;
let BOB_ID;

const STEP_TIMEOUT = 30_000;
const SETUP_TIMEOUT = 60_000;

const log = (m) => console.log(`[search] ${m}`);

// ---------------------------------------------------------------------------
// CS-API helpers
// ---------------------------------------------------------------------------

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
    throw protocolResponseFailure(`login ${user}`, res);
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
    throw protocolResponseFailure(`POST ${path}`, res);
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
    throw protocolResponseFailure(`PUT ${path}`, res);
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

/**
 * Open the quick-switcher's CDK dialog, interact with it, then wait for it to
 * dismiss. Returns the dialog locator so callers can scope further queries to
 * it. In-room search lives in the shell's complementary panel instead.
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

async function main(protocolBrowser) {
  // ── CS-API pre-setup ───────────────────────────────────────────────────────
  const { access_token: aliceToken, user_id: aliceId } = await apiLogin(
    USER,
    PASS,
  );
  USER_ID = aliceId;
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

  // Scenario 3: seed the fixture-owned BOB account into the user directory.
  const { access_token: bobToken, user_id: bobId } = await apiLogin(
    BOB_USER,
    BOB_PASS,
  );
  BOB_ID = bobId;
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
  log(`serving www on ${APP} (homeserver=${HS})`);

  const page = await protocolBrowser.newAuthenticatedPage({ label: 'search' });

  let exit = 1;
  try {
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
    const searchPanel = page.getByRole('complementary', {
      name: 'Search messages',
    });
    await searchPanel.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('message-search panel open');

    // Type the distinctive token into the message-search's native input.
    const searchInput2 = searchPanel.getByPlaceholder(
      'Search this conversation',
    );
    await searchInput2.waitFor({ state: 'visible', timeout: 10_000 });
    await searchInput2.click();
    await page.keyboard.type(TOKEN, { delay: 30 });

    // A [data-testid="result"] row should appear with the token in its text.
    const searchResult = searchPanel.locator('[data-testid="result"]');
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

    // Click the result → panel dismisses with eventId → RoomsPage sets
    // messageSearchTarget → MessageListComponent.jumpTo() scrolls [data-mid].
    await searchResult.first().click();
    await searchPanel.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
    log('message-search panel dismissed ✓');

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

    const roomRouteBefore = page.url();
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
    log('directory "Person" result for BOB visible ✓');

    // Click the Person result to start the DM.
    const personResult = modal3.locator('.qs-row').filter({
      has: page.getByText('Person', { exact: true }),
    });
    await personResult.first().click();

    // Modal dismisses; RoomsPage.jumpTo creates a DM then calls onSelectRoom.
    await waitForModalGone(page);
    log('switcher modal dismissed (DM creation in progress) ✓');

    // Workspace opens the created room in Home. The sidebar's Home list depends
    // on the separately arriving m.direct account data, so its row count is not
    // the navigation contract; the account-qualified room route is.
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/rooms/') &&
        url.searchParams.get('account') === USER_ID &&
        url.searchParams.get('view') === 'home' &&
        url.href !== roomRouteBefore,
      { timeout: STEP_TIMEOUT },
    );
    log('account-qualified DM route opened ✓');

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
    console.log('\nRESULT: FAIL');
    throw err;
  }
  expect(exit).toBe(0);
}

test('covers room, message, and directory search journeys', async ({
  protocolBrowser,
  protocolCredentials,
  resourceNamespace,
}) => {
  HS = protocolCredentials.hs;
  USER = protocolCredentials.user;
  PASS = protocolCredentials.pass;
  expect(protocolCredentials.secondary).toBeDefined();
  BOB_USER = protocolCredentials.secondary.user;
  BOB_PASS = protocolCredentials.secondary.pass;
  RUN_ID = resourceNamespace.role('search');
  ROOM_A = `Alpha-${RUN_ID}`;
  ROOM_B = `Beta-${RUN_ID}`;
  SEARCH_ROOM = `Search-${RUN_ID}`;
  TOKEN = `XSRCH${RUN_ID}`;
  await main(protocolBrowser);
});
