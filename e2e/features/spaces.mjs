// Spaces create/manage e2e — three scenarios against a live homeserver.
//
//   1. Create a space → the named pill appears in the server rail; sidebar
//      title updates; server-side confirms type=m.space.
//
//   2. With that space active, create a channel → the room row appears in the
//      sidebar list; server-side confirms m.space.child (via + suggested),
//      m.space.parent (canonical), and m.room.encryption on the child.
//
//   3. Leave the space → returns to Home (sidebar title = "Home"); the space
//      pill disappears from the rail; sidebar actions are hidden; server-side
//      confirms space membership=leave and child membership still=join.
//
// No encryption setup is needed — these flows only create rooms and write
// m.space.child / m.space.parent state events.
//
// Env:
//   TRINITY_HS    default https://localhost:8448 (bundled Synapse + Caddy)
//   TRINITY_USER  default verify-e2e
//   TRINITY_PASS  default verify-e2e-pass-123
//   HEADED=1 / SLOWMO=ms  for debugging
//
// `pnpm e2e:spaces` builds dev, starts the harness, runs this, and tears down.
// MUST run sequentially with other e2e scripts (shared docker stack + www/).
import { mkdir } from 'node:fs/promises';
import { waitForRooms } from '../support/navigation.mjs';
import {
  applicationOrigin,
  invocationResourceId,
} from '../support/session.mts';
import { chromium } from 'playwright';

// Node's fetch (CS-API helpers) must accept Caddy's self-signed cert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const APP = applicationOrigin();

const HS = process.env.TRINITY_HS ?? 'https://localhost:8448';
const USER = process.env.TRINITY_USER ?? 'verify-e2e';
const PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';
const HEADED = process.env.HEADED === '1';
const SLOWMO = Number(process.env.SLOWMO ?? 0);

// Unique names per run so re-runs and re-used servers never produce stale matches.
const RUN_ID = invocationResourceId('spaces');
const SPACE_NAME = `Space ${RUN_ID}`;
const CHANNEL_NAME = `chan-${RUN_ID}`;

const STEP_TIMEOUT = 30_000;

const log = (m) => console.log(`[spaces] ${m}`);

// ---------------------------------------------------------------------------
// CS-API helpers (raw fetch; NODE_TLS_REJECT_UNAUTHORIZED='0' covers the cert)
// ---------------------------------------------------------------------------

async function apiLogin() {
  const res = await fetch(`${HS}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: PASS,
    }),
  });
  if (!res.ok) throw new Error(`api login → ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, user_id, … }
}

async function get(token, path) {
  const res = await fetch(`${HS}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    ok: res.ok,
    status: res.status,
    body: res.ok ? await res.json() : null,
  };
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

async function joinedRooms(token) {
  const { body } = await get(token, '/_matrix/client/v3/joined_rooms');
  return body?.joined_rooms ?? [];
}

/**
 * Poll joined rooms until one matches `name` and the space/non-space
 * predicate, then return its room id. `isSpace=true` finds a room with
 * `m.room.create` content `type === 'm.space'`; `isSpace=false` finds a
 * regular room.
 */
async function findRoomIdByName(token, name, isSpace) {
  return poll(async () => {
    const rooms = await joinedRooms(token);
    for (const id of rooms) {
      const cr = await get(
        token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.create`,
      );
      if (!cr.ok) continue;
      const roomIsSpace = cr.body?.type === 'm.space';
      if (Boolean(isSpace) !== Boolean(roomIsSpace)) continue;
      const nr = await get(
        token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`,
      );
      if (nr.ok && nr.body?.name === name) return id;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// UI helpers (mirrors threads.mjs / send-media.mjs)
// ---------------------------------------------------------------------------

/** Fill a native `<input hlmInput>` by its associated `<label for="…">`. */
async function fillLabeledInput(page, label, value) {
  // Exact match: the password field's "Show password" reveal button (aria-label) otherwise
  // also matches a substring `getByLabel('Password')`, tripping strict mode. Same fix as
  // e2e/support/app.mts:34.
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
 * Interact with TrnAlertService's confirm/prompt dialog (<trn-alert-dialog> in
 * a CDK dialog — replaces Ionic's <ion-alert>): wait for it to appear,
 * optionally fill the text input identified by `placeholder`, click
 * `buttonName`, then wait for the dialog to dismiss. Pass `placeholder=null`
 * for confirmation-only dialogs (Leave).
 */
async function fillAlertAndConfirm(page, placeholder, value, buttonName) {
  const alert = page.locator('trn-alert-dialog');
  await alert.waitFor({ state: 'visible', timeout: 15_000 });
  if (placeholder && value) {
    await alert.locator(`input[placeholder="${placeholder}"]`).fill(value);
  }
  await alert.getByRole('button', { name: buttonName }).click();
  await alert.waitFor({ state: 'detached', timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir('e2e/.artifacts', { recursive: true });

  const { access_token: token, user_id: userId } = await apiLogin();
  log(`api login ok; userId=${userId}`);
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

  // Service-worker / TLS bypass: production www/ ships an Angular service worker
  // that intercepts ALL fetches including cross-origin calls to Caddy's
  // self-signed https://localhost:8448. In the SW execution context
  // `ignoreHTTPSErrors` does not apply, so every homeserver request gets a 504.
  // Playwright's context.route() hooks in at the CDP network layer (below the SW)
  // and re-fetches via route.fetch(), which DOES honour ignoreHTTPSErrors,
  // restoring 200 responses. This is a no-op on dev builds (no SW registered).
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

    // -----------------------------------------------------------------------
    // SCENARIO 1: Create a space → pill appears in the server rail
    // -----------------------------------------------------------------------
    log(`--- Scenario 1: create space "${SPACE_NAME}" ---`);

    // The "+" pill at the end of the server rail.
    await page.click('button.pill.add');
    await fillAlertAndConfirm(page, 'Space name', SPACE_NAME, 'Create');

    // The space pill appears once the create request completes and the
    // SpacesService sync listener fires (ClientEvent.Room → refresh()).
    const spacePill = page.locator(`button[aria-label="${SPACE_NAME}"]`);
    await spacePill.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('space pill visible in rail ✓');

    // Once the spaces() signal is updated, activeSpaceName() resolves to the
    // real name (it falls back to "Home" until sync). waitForFunction is the
    // robust wait here since the element is always present (text changes).
    await page.waitForFunction(
      (name) =>
        document.querySelector('span.sidebar__title')?.textContent?.trim() ===
        name,
      SPACE_NAME,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log(`sidebar title = "${SPACE_NAME}" ✓`);

    // Server-side: confirm the room carries type=m.space in m.room.create.
    const spaceId = await findRoomIdByName(token, SPACE_NAME, true);
    const createEvt = await get(
      token,
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.create`,
    );
    if (createEvt.body?.type !== 'm.space') {
      throw new Error(
        `Expected m.room.create type m.space, got ${createEvt.body?.type}`,
      );
    }
    log(`space verified server-side: ${spaceId} (type=m.space) ✓`);
    log('PASS scenario 1');

    // -----------------------------------------------------------------------
    // SCENARIO 2: Create a channel inside the active space
    // -----------------------------------------------------------------------
    log(`--- Scenario 2: create channel "${CHANNEL_NAME}" ---`);

    // sidebar__actions are gated on spaceActive() === true (activeSpaceId !== null).
    // applyCreateSpace sets activeSpaceId immediately on success, so the button is
    // already visible; the waitFor below is a safety net.
    const createChannelBtn = page.locator(
      'button[aria-label="Create a channel"]',
    );
    await createChannelBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await createChannelBtn.click();
    await fillAlertAndConfirm(page, 'Channel name', CHANNEL_NAME, 'Create');

    // The channel row appears once the room is created and the m.space.child
    // state event fires SpacesService.onStateEvent → refresh() → childRoomIds().
    const channelRow = page.locator('button.channel', {
      hasText: CHANNEL_NAME,
    });
    await channelRow
      .first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('channel row visible in sidebar ✓');

    // Server-side: resolve the child room id.
    const childId = await findRoomIdByName(token, CHANNEL_NAME, false);
    log(`child room id: ${childId}`);

    // m.space.child link on the space (via + suggested).
    const childLink = await poll(async () => {
      const r = await get(
        token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
      );
      return r.ok ? r.body : null;
    });
    if (!Array.isArray(childLink.via) || childLink.via.length === 0) {
      throw new Error('m.space.child: missing or empty via');
    }
    if (childLink.suggested !== true) {
      throw new Error('m.space.child: expected suggested=true');
    }
    log('m.space.child link verified (via + suggested) ✓');

    // m.space.parent (reverse) link on the child (canonical).
    const parentLink = await poll(async () => {
      const r = await get(
        token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(childId)}/state/m.space.parent/${encodeURIComponent(spaceId)}`,
      );
      return r.ok ? r.body : null;
    });
    if (parentLink?.canonical !== true) {
      throw new Error('m.space.parent: expected canonical=true');
    }
    log('m.space.parent link verified (canonical) ✓');

    // E2EE: createRoomInSpace sets m.room.encryption in initial_state (Megolm).
    const enc = await poll(async () => {
      const r = await get(
        token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(childId)}/state/m.room.encryption`,
      );
      return r.ok ? r.body : null;
    });
    if (enc?.algorithm !== 'm.megolm.v1.aes-sha2') {
      throw new Error(
        `Expected E2EE algorithm m.megolm.v1.aes-sha2, got ${enc?.algorithm}`,
      );
    }
    log('child room E2EE verified (m.megolm.v1.aes-sha2) ✓');
    log('PASS scenario 2');

    // -----------------------------------------------------------------------
    // SCENARIO 3: Leave the space → return to Home + pill disappears
    // -----------------------------------------------------------------------
    log('--- Scenario 3: leave space ---');

    // Leave moved into the header overflow: open it, then pick the row. Driven by testid
    // rather than aria-label — the row carries a text label now, and the label is the thing
    // most likely to be reworded.
    await page.click('[data-testid="space-actions-overflow"]');
    await page.click('[data-testid="space-leave"]');
    // Leave alert has no text input — just Cancel and Leave buttons.
    await fillAlertAndConfirm(page, null, null, 'Leave');

    // applyLeaveSpace calls spaces.leaveSpace() and on completion sets activeSpaceId(null)
    // → spaceActive() = false. The title is then "Direct Messages", NOT "Home":
    // `sidebarTitle()` (rooms.page.ts) reads
    //   recentView() ? 'Recent activity' : roomsView() ? 'Rooms'
    //     : activeSpaceId() ? activeSpaceName() : 'Direct Messages'
    // and onSelectSpace(null) clears both views on the way past. "Home" survives only as
    // activeSpaceName()'s fallback, which is not what renders here — it stopped being this
    // title in bd16dc25 (2026-07-04, the DM/Rooms rail split), and this assertion has been
    // unreachable ever since. See #54.
    await page.waitForFunction(
      () =>
        document.querySelector('span.sidebar__title')?.textContent?.trim() ===
        'Direct Messages',
      undefined,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log('sidebar title = "Direct Messages" ✓');

    // The space pill disappears once the RoomEvent.MyMembership event syncs
    // and SpacesService drops it from the spaces() read model.
    await page.waitForFunction(
      (spaceName) =>
        document.querySelectorAll(`button[aria-label="${spaceName}"]`)
          .length === 0,
      SPACE_NAME,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log('space pill gone from rail ✓');

    // sidebar__actions are hidden when spaceActive() is false.
    const createChannelCount = await createChannelBtn.count();
    if (createChannelCount !== 0) {
      throw new Error(
        `Expected create-channel button absent, but count=${createChannelCount}`,
      );
    }
    log('sidebar actions hidden (create-channel button absent) ✓');

    // Server-side: space membership is now 'leave'.
    await poll(async () => {
      const r = await get(
        token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.member/${encodeURIComponent(userId)}`,
      );
      return r.ok && r.body?.membership === 'leave' ? true : null;
    });
    log('space membership=leave (server-side) ✓');

    // Child room membership is unaffected — leaveSpace() only leaves the space,
    // not its children. The child must still be 'join'.
    const childMember = await get(
      token,
      `/_matrix/client/v3/rooms/${encodeURIComponent(childId)}/state/m.room.member/${encodeURIComponent(userId)}`,
    );
    if (childMember.body?.membership !== 'join') {
      throw new Error(
        `Expected child membership join, got ${childMember.body?.membership}`,
      );
    }
    log('child membership=join (unaffected by leaving space) ✓');
    log('PASS scenario 3');

    // -----------------------------------------------------------------------
    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[spaces] error:', err.message);
    await page
      .screenshot({ path: 'e2e/.artifacts/spaces-failure.png' })
      .catch(() => {});
    console.log('\nRESULT: FAIL');
  } finally {
    await browser.close();
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error('[spaces] fatal:', err);
  process.exit(1);
});
