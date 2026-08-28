// Room/DM creation + invite flows e2e — five scenarios against a live homeserver.
//
//   1. Create a room → the room appears in the sidebar channel list;
//      CS-API confirms alice joined the room.
//
//   2. Start a DM with a second user (BOB) → the DM room appears in the sidebar;
//      CS-API confirms m.direct maps BOB to the room and BOB has a pending invite.
//
//   3. Invite BOB to the room from scenario 1 → CS-API confirms BOB has a pending
//      invite membership for that room.
//
//   4. Accept an incoming invite → BOB pre-seeds an invite via the CS-API; the app
//      shows it in the Invites group; click Accept → room appears in channel list;
//      CS-API confirms membership = 'join'.
//
//   5. Decline an incoming invite → BOB pre-seeds a second invite; click Decline →
//      invite disappears; CS-API confirms membership = 'leave'.
//
// The second user is registered via Synapse's shared-secret admin endpoint before
// the browser session starts.
//
// Env:
//   TRINITY_HS    default https://localhost:8448 (bundled Synapse + Caddy)
//   TRINITY_USER  default verify-e2e
//   TRINITY_PASS  default verify-e2e-pass-123
//   HEADED=1 / SLOWMO=ms  for debugging
//
// `pnpm e2e:rooms` builds dev, starts the harness, runs this, and tears down.
// MUST run sequentially with other e2e scripts (shared docker stack + www/ build).
import { mkdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { serve } from '../support/serve.mjs';
import { REGISTRATION_SHARED_SECRET, SYNAPSE_HTTP } from '../synapse/start.mjs';
import { chromium } from 'playwright';

// Node's fetch (CS-API helpers) must accept Caddy's self-signed cert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = 8130;
const APP = `http://localhost:${PORT}`;

const HS = process.env.TRINITY_HS ?? 'https://localhost:8448';
const USER = process.env.TRINITY_USER ?? 'verify-e2e';
const PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';
const SERVER_NAME = 'localhost';
const HEADED = process.env.HEADED === '1';
const SLOWMO = Number(process.env.SLOWMO ?? 0);

// Unique names per run so re-runs never collide with stale rooms.
const RUN_ID = Date.now().toString(36);
const ROOM_NAME = `Room ${RUN_ID}`;
const BOB_USER = `bob-${RUN_ID}`;
const BOB_PASS = `bob-pass-${RUN_ID}`;
const BOB_ID = `@${BOB_USER}:${SERVER_NAME}`;
const ACCEPT_ROOM_NAME = `Accept ${RUN_ID}`;
const DECLINE_ROOM_NAME = `Decline ${RUN_ID}`;

const STEP_TIMEOUT = 30_000;

const log = (m) => console.log(`[rooms] ${m}`);

// ---------------------------------------------------------------------------
// CS-API helpers
// ---------------------------------------------------------------------------

/**
 * Register a user via Synapse's shared-secret admin endpoint (bypasses the
 * normal auth flow — works on the disposable test Synapse only). Idempotent:
 * "already exists" is treated as success.
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

async function csGet(token, path) {
  const res = await fetch(`${HS}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    ok: res.ok,
    status: res.status,
    body: res.ok ? await res.json() : null,
  };
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
 * Wait for TrnAlertService's confirm/prompt dialog (<trn-alert-dialog> in a CDK
 * dialog — replaces Ionic's <ion-alert>), optionally fill a text input, click a
 * button, then wait for the dialog to dismiss. Pass placeholder=null for
 * confirm-only dialogs.
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

/**
 * Wait for TrnActionSheetService's bottom sheet (<trn-action-sheet> in a CDK
 * dialog — replaces Ionic's <ion-action-sheet>) to appear, click a named
 * button, then wait for it to dismiss.
 */
async function clickActionSheetButton(page, buttonText) {
  const sheet = page.locator('trn-action-sheet');
  await sheet.waitFor({ state: 'visible', timeout: 15_000 });
  await sheet.getByRole('button', { name: buttonText }).click();
  await sheet.waitFor({ state: 'detached', timeout: 15_000 });
}

/**
 * Interact with the UserPickerComponent modal (a CDK dialog — replaces
 * Ionic's <ion-modal>): wait for it to appear, type an MXID into its native
 * free-text field (char-by-char so every input event fires and Angular's
 * canConfirm() computed re-evaluates), click the confirm button, then wait for
 * the modal to dismiss.
 *
 * The confirm button is a plain `<button trnBtn>` in the modal header whose
 * text matches `confirmLabelText`; Playwright's click() already waits for it
 * to lose its `disabled` attribute (actionability), so no manual poll is
 * needed — `[disabled]="!canConfirm()"` clears once the MXID validates.
 */
async function fillUserPickerAndConfirm(page, mxid, confirmLabelText) {
  const modal = page.locator('.cdk-dialog-container');
  await modal.waitFor({ state: 'visible', timeout: 15_000 });

  // UserPickerComponent's free-text field — a native <input hlmInput> with a
  // fixed default placeholder (no ion-searchbar shadow DOM to pierce anymore).
  const searchInput = modal.getByPlaceholder('@user:server or a name');
  await searchInput.waitFor({ state: 'visible', timeout: 10_000 });

  // Type character-by-character so every keystroke's (input) event fires and
  // the term signal — and canConfirm() — update on each one.
  await searchInput.click();
  await page.keyboard.type(mxid, { delay: 30 });

  await modal
    .getByRole('button', { name: confirmLabelText, exact: true })
    .click();

  // Wait for the dialog to dismiss.
  await page.waitForFunction(
    () => document.querySelectorAll('.cdk-dialog-container').length === 0,
    undefined,
    { timeout: 15_000, polling: 200 },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir('e2e/.artifacts', { recursive: true });

  // ── CS-API pre-setup: register BOB + seed invite rooms ────────────────────
  log(`registering second user @${BOB_USER}:${SERVER_NAME}`);
  await registerUser(BOB_USER, BOB_PASS);

  const { access_token: bobToken, user_id: bobId } = await apiLogin(
    BOB_USER,
    BOB_PASS,
  );
  log(`BOB api login ok (${bobId})`);

  const { access_token: aliceToken, user_id: aliceId } = await apiLogin(
    USER,
    PASS,
  );
  log(`alice api login ok (${aliceId})`);

  // BOB creates rooms that will carry incoming invites for alice (scenarios 4+5).
  const { room_id: acceptRoomId } = await csPost(
    bobToken,
    '/_matrix/client/v3/createRoom',
    {
      name: ACCEPT_ROOM_NAME,
      preset: 'private_chat',
    },
  );
  log(`BOB created AcceptRoom: ${acceptRoomId} ("${ACCEPT_ROOM_NAME}")`);

  const { room_id: declineRoomId } = await csPost(
    bobToken,
    '/_matrix/client/v3/createRoom',
    {
      name: DECLINE_ROOM_NAME,
      preset: 'private_chat',
    },
  );
  log(`BOB created DeclineRoom: ${declineRoomId} ("${DECLINE_ROOM_NAME}")`);

  // BOB invites alice to both rooms so they appear in her Invites section.
  await csPost(
    bobToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(acceptRoomId)}/invite`,
    { user_id: aliceId },
  );
  log(`BOB invited alice to AcceptRoom`);
  await csPost(
    bobToken,
    `/_matrix/client/v3/rooms/${encodeURIComponent(declineRoomId)}/invite`,
    { user_id: aliceId },
  );
  log(`BOB invited alice to DeclineRoom`);

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

  // Service-worker / TLS bypass (same rationale as spaces.mjs / threads.mjs).
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

    // Wait for the initial sync to deliver both pre-seeded invites from BOB.
    log('waiting for pre-seeded invites to appear in sidebar');
    await page.waitForFunction(
      () => document.querySelectorAll('.invite').length >= 2,
      undefined,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log('2 pre-seeded invites visible ✓');

    // ── SCENARIO 1: Create a room ─────────────────────────────────────────
    log(`--- Scenario 1: create room "${ROOM_NAME}" ---`);

    // The Home "+" button (aria-label set when spaceActive() is false).
    await page.click('button[aria-label="New room or direct message"]');

    // trn-action-sheet: "New message" with "Create a room" / "Start a direct
    // message" / "Cancel" buttons.
    await clickActionSheetButton(page, 'Create a room');

    // trn-alert-dialog: header "Create a room", input placeholder "Room name".
    await fillAlertAndConfirm(page, 'Room name', ROOM_NAME, 'Create');

    // The room appears in the sidebar channel list once sync delivers it.
    const roomBtn = page.locator('button.channel', { hasText: ROOM_NAME });
    await roomBtn.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log(`room "${ROOM_NAME}" visible in sidebar ✓`);

    // CS-API: alice is a joined member of a room with this name.
    const createdRoomId = await poll(async () => {
      const { body } = await csGet(
        aliceToken,
        '/_matrix/client/v3/joined_rooms',
      );
      const ids = body?.joined_rooms ?? [];
      for (const id of ids) {
        const nr = await csGet(
          aliceToken,
          `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`,
        );
        if (nr.ok && nr.body?.name === ROOM_NAME) return id;
      }
      return null;
    });
    log(`CS-API: "${ROOM_NAME}" confirmed as joined room ${createdRoomId} ✓`);
    log('PASS scenario 1');

    // ── SCENARIO 2: Start a DM with BOB ──────────────────────────────────
    log(`--- Scenario 2: start DM with ${BOB_ID} ---`);

    const channelsBefore = await page.locator('button.channel').count();

    await page.click('button[aria-label="New room or direct message"]');
    await clickActionSheetButton(page, 'Start a direct message');

    // UserPickerComponent modal: title "Start a direct message", confirm "Message".
    await fillUserPickerAndConfirm(page, BOB_ID, 'Message');

    // A new .channel button should appear (the DM room, auto-selected by onStartDm).
    await page.waitForFunction(
      (before) => document.querySelectorAll('button.channel').length > before,
      channelsBefore,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log('DM room appeared in sidebar ✓');

    // CS-API: alice's m.direct account data maps BOB_ID to the new DM room.
    const dmRoomId = await poll(async () => {
      const { body } = await csGet(
        aliceToken,
        `/_matrix/client/v3/user/${encodeURIComponent(aliceId)}/account_data/m.direct`,
      );
      const rooms = body?.[BOB_ID] ?? [];
      return rooms.length > 0 ? rooms[rooms.length - 1] : null;
    });
    log(`CS-API: m.direct maps ${BOB_ID} → ${dmRoomId} ✓`);

    // CS-API: BOB has a pending invite in the DM room. Alice is the room creator
    // and can read the full room state, so we use her token — an invited-but-not-
    // joined BOB gets 403 from the state endpoint.
    await poll(async () => {
      const { body } = await csGet(
        aliceToken,
        `/_matrix/client/v3/rooms/${encodeURIComponent(dmRoomId)}/state/m.room.member/${encodeURIComponent(BOB_ID)}`,
      );
      return body?.membership === 'invite' ? true : null;
    });
    log(`CS-API: BOB has invite membership in DM room ✓`);
    log('PASS scenario 2');

    // ── SCENARIO 3: Invite BOB to the room from scenario 1 ───────────────
    log(`--- Scenario 3: invite ${BOB_ID} to "${ROOM_NAME}" ---`);

    // Navigate to the room from scenario 1 (click it in the sidebar).
    // After scenario 2 the DM room is auto-selected; we need scenario-1 room active
    // so the "Invite people" button appears in the toolbar for the correct room.
    await page
      .locator('button.channel', { hasText: ROOM_NAME })
      .first()
      .click();

    // The "Invite people" button is gated on activeRoom() being non-null.
    const inviteBtn = page.getByTestId('invite-people');
    await inviteBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await inviteBtn.click();

    // UserPickerComponent modal: title "Invite to Room …", confirm "Invite".
    await fillUserPickerAndConfirm(page, BOB_ID, 'Invite');

    // CS-API: BOB now has a pending invite to the room from scenario 1. Alice is
    // the room owner and can read the full state, so her token is used.
    await poll(async () => {
      const { body } = await csGet(
        aliceToken,
        `/_matrix/client/v3/rooms/${encodeURIComponent(createdRoomId)}/state/m.room.member/${encodeURIComponent(BOB_ID)}`,
      );
      return body?.membership === 'invite' ? true : null;
    });
    log(`CS-API: BOB has pending invite to "${ROOM_NAME}" ✓`);
    log('PASS scenario 3');

    // ── SCENARIO 4: Accept an incoming invite ─────────────────────────────
    log(`--- Scenario 4: accept invite to "${ACCEPT_ROOM_NAME}" ---`);

    const channelsBefore4 = await page.locator('button.channel').count();

    // Find the .invite row that contains the ACCEPT_ROOM_NAME, then click its
    // Accept button. Using the row-scoped approach avoids brittle aria-label
    // concatenation and works regardless of minor SDK room-name variations.
    const acceptRow = page.locator('.invite').filter({
      has: page.locator('.invite__name', { hasText: ACCEPT_ROOM_NAME }),
    });
    const acceptBtn = acceptRow.locator('button.invite__btn.accept');
    await acceptBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await acceptBtn.click();

    // The room moves from Invites to the channel list (onAcceptInvite calls
    // onSelectRoom after the join).
    await page.waitForFunction(
      (before) => document.querySelectorAll('button.channel').length > before,
      channelsBefore4,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log(`"${ACCEPT_ROOM_NAME}" appeared in channel list ✓`);

    // CS-API: alice's membership in the AcceptRoom is now 'join'.
    await poll(async () => {
      const { body } = await csGet(
        aliceToken,
        `/_matrix/client/v3/rooms/${encodeURIComponent(acceptRoomId)}/state/m.room.member/${encodeURIComponent(aliceId)}`,
      );
      return body?.membership === 'join' ? true : null;
    });
    log(`CS-API: membership in AcceptRoom = 'join' ✓`);
    log('PASS scenario 4');

    // ── SCENARIO 5: Decline an incoming invite ────────────────────────────
    log(`--- Scenario 5: decline invite to "${DECLINE_ROOM_NAME}" ---`);

    const declineRow = page.locator('.invite').filter({
      has: page.locator('.invite__name', { hasText: DECLINE_ROOM_NAME }),
    });
    const declineBtn = declineRow.locator('button.invite__btn.decline');
    await declineBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await declineBtn.click();

    // The invite disappears from the Invites group (InvitesService removes it on
    // the next sync → RoomEvent.MyMembership=leave → refresh()).
    await page.waitForFunction(
      (name) => {
        const names = [...document.querySelectorAll('.invite__name')];
        return !names.some((el) => (el.textContent ?? '').includes(name));
      },
      DECLINE_ROOM_NAME,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log(`"${DECLINE_ROOM_NAME}" removed from Invites section ✓`);

    // CS-API: alice's membership in the DeclineRoom is now 'leave'.
    await poll(async () => {
      const { body } = await csGet(
        aliceToken,
        `/_matrix/client/v3/rooms/${encodeURIComponent(declineRoomId)}/state/m.room.member/${encodeURIComponent(aliceId)}`,
      );
      return body?.membership === 'leave' ? true : null;
    });
    log(`CS-API: membership in DeclineRoom = 'leave' ✓`);
    log('PASS scenario 5');

    // -----------------------------------------------------------------------
    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[rooms] error:', err.message);
    await page
      .screenshot({ path: 'e2e/.artifacts/rooms-failure.png' })
      .catch(() => {});
    console.log('\nRESULT: FAIL');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error('[rooms] fatal:', err);
  process.exit(1);
});
