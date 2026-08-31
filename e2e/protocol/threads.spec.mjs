// Thread lifecycle e2e — reply-in-thread happy path + regression for lazy creation.
//
// Drives the real thread flows against a live homeserver via three scenarios:
//
//   1. First reply creates + shows the thread: open "Reply in thread" on a root
//      message, send a reply → the reply appears in the thread view and a "1 reply"
//      indicator appears on the root in the main timeline.
//
//   2. Reopen an existing thread: close the thread view, click the indicator →
//      the thread reopens showing both the root and the reply.
//
//   3. Abandon creates nothing (lazy-creation regression): open "Reply in thread"
//      on a second message, close without sending → no thread indicator appears.
//
// The Nx target defaults to disposable attempt-scoped credentials. Explicit
// remote mode accepts TRINITY_HS/TRINITY_USER/TRINITY_PASS; HEADED/SLOWMO aid debugging.
//
// `pnpm e2e:threads` builds dev, starts the harness, runs this, and tears down.
import { applicationOrigin } from '../support/session.mts';
import { clickRowToolbar } from '../support/app.mts';
import { protocolResponseFailure } from './diagnostics.mts';
import { test, expect } from './fixtures.mts';

const APP = applicationOrigin();

let HS;
let USER;
let PASS;

// Each run gets its own unique names so re-runs don't collide.
let RUN_ID;
let ROOM_NAME;
let ROOT_MSG;
let NO_THREAD_MSG;
let REPLY_TEXT;

const SETUP_TIMEOUT = 90_000;
const STEP_TIMEOUT = 30_000;

const log = (m) => console.log(`[threads] ${m}`);

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
    throw protocolResponseFailure(`${method} ${path}`, res);
  }
  return res.json();
}

/**
 * Log in via the CS API, create a plain (non-encrypted) room, send two
 * messages, and return identifiers needed by the browser scenarios.
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
      // No encryption state — keeps the test focused on threads, not E2EE.
    },
  });
  log(`created room ${roomId} ("${ROOM_NAME}")`);

  // Root message — this is the one we'll start a thread on.
  const { event_id: rootEventId } = await api(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/trn-root-${RUN_ID}`,
    {
      token,
      method: 'PUT',
      body: { msgtype: 'm.text', body: ROOT_MSG },
    },
  );
  log(`sent root message ${rootEventId}`);

  // Second message — used by scenario 3 (abandon without sending).
  const { event_id: noThreadEventId } = await api(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/trn-nothread-${RUN_ID}`,
    {
      token,
      method: 'PUT',
      body: { msgtype: 'm.text', body: NO_THREAD_MSG },
    },
  );
  log(`sent second message ${noThreadEventId}`);

  return { roomId, rootEventId, noThreadEventId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(protocolBrowser) {
  // 1. Seed the room + messages via the CS API before the browser runs.
  const { rootEventId, noThreadEventId } = await setupRoom();
  log(`rootEventId=${rootEventId}  noThreadEventId=${noThreadEventId}`);
  log(`serving www on ${APP} (homeserver=${HS})`);

  const page = await protocolBrowser.newAuthenticatedPage({ label: 'threads' });

  let exit = 1;
  try {
    // 2. Open the seeded room.
    log(`opening room "${ROOM_NAME}"`);
    const channel = page.locator('.channel', { hasText: ROOM_NAME });
    await channel.first().click({ timeout: SETUP_TIMEOUT });

    // Wait for both seeded messages to sync and render.
    log('waiting for seeded messages to sync');
    const rootMsgRow = page.locator(
      `.msg[data-mid=${JSON.stringify(rootEventId)}]`,
    );
    const noThreadRow = page.locator(
      `.msg[data-mid=${JSON.stringify(noThreadEventId)}]`,
    );
    await rootMsgRow
      .first()
      .waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
    await noThreadRow
      .first()
      .waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
    log('seeded messages visible in timeline');

    // -----------------------------------------------------------------------
    // SCENARIO 1: first reply creates + shows the thread.
    // -----------------------------------------------------------------------
    log('--- Scenario 1: first reply creates + shows the thread ---');

    await clickRowToolbar(
      rootMsgRow.first(),
      rootMsgRow.first().getByRole('button', { name: 'Reply in thread' }),
    );

    // Thread modal opens — the "Close thread" button is the reliable open signal.
    log('waiting for thread modal to open');
    const closeBtn = page.getByRole('button', { name: 'Close thread' });
    await closeBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    const thread = page.getByTestId('thread-view');
    await thread.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('thread modal open');

    // Type and send a reply into the thread composer.
    const threadTextarea = thread.getByTestId('composer-input');
    await threadTextarea.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await threadTextarea.click();
    await threadTextarea.fill(REPLY_TEXT);
    await threadTextarea.press('Enter');
    log(`sent reply "${REPLY_TEXT}"`);

    // Assert: the reply appears in the thread view.
    log('waiting for reply to appear in thread view');
    const replyInThread = thread
      .locator('.msg')
      .filter({ hasText: REPLY_TEXT });
    await replyInThread
      .first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('PASS scenario 1: reply visible in thread view');

    // -----------------------------------------------------------------------
    // SCENARIO 2: close → thread indicator → reopen shows root + reply.
    // -----------------------------------------------------------------------
    log('--- Scenario 2: close then reopen ---');

    await closeBtn.click();
    await closeBtn.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
    log('thread modal closed');

    // Wait for the thread indicator to appear on the root message in the
    // main timeline (triggered by ThreadEvent.NewReply → refreshSummaries).
    log('waiting for thread indicator on root message');
    await page.waitForFunction(
      (rootText) => {
        const msgs = [...document.querySelectorAll('.msg')];
        const rootEl = msgs.find((m) => m.textContent?.includes(rootText));
        if (!rootEl) return false;
        const indicator = rootEl.querySelector('.msg__thread');
        if (!indicator) return false;
        const countEl = indicator.querySelector('.msg__thread-count');
        return countEl?.textContent?.includes('reply') ?? false;
      },
      ROOT_MSG,
      { timeout: STEP_TIMEOUT, polling: 500 },
    );
    log('thread indicator visible on root message');

    // Click the indicator to reopen the thread.
    const threadIndicator = rootMsgRow.first().locator('.msg__thread');
    await threadIndicator.click();

    log('waiting for thread to reopen');
    await closeBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('thread modal reopened');

    // Both the root message and the reply must be present in the thread view.
    await thread
      .locator('.msg')
      .filter({ hasText: ROOT_MSG })
      .first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await thread
      .locator('.msg')
      .filter({ hasText: REPLY_TEXT })
      .first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('PASS scenario 2: thread reopened with root + reply visible');

    // -----------------------------------------------------------------------
    // SCENARIO 3: abandon (close without sending) creates nothing.
    // -----------------------------------------------------------------------
    log('--- Scenario 3: abandon creates nothing ---');

    await closeBtn.click();
    await closeBtn.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
    log('thread modal closed (after scenario 2)');

    // Hover the second message and open "Reply in thread" without sending.
    await clickRowToolbar(
      noThreadRow.first(),
      noThreadRow.first().getByRole('button', { name: 'Reply in thread' }),
    );

    log('waiting for thread modal to open for second message');
    await closeBtn.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    // Verify the thread view opened: the modal must contain the second message
    // as its root, and no reply rows beyond it (new thread, never sent to).
    await thread
      .locator('.msg')
      .filter({ hasText: NO_THREAD_MSG })
      .first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('thread view for second message confirmed open (no replies yet)');

    // Close WITHOUT typing anything.
    await closeBtn.click();
    await closeBtn.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
    log('thread modal closed without sending');

    // Allow 2 s for any stray async updates that might incorrectly create a
    // thread summary and render an indicator.
    await new Promise((r) => setTimeout(r, 2000));

    // Assert: no thread indicator on the second message.
    const abandonIndicator = noThreadRow.first().locator('.msg__thread');
    const indicatorCount = await abandonIndicator.count();
    if (indicatorCount !== 0) {
      throw new Error(
        `Expected no thread indicator on "${NO_THREAD_MSG}" after abandon, ` +
          `but found ${indicatorCount} indicator(s)`,
      );
    }
    log('PASS scenario 3: no thread indicator after abandon');

    // -----------------------------------------------------------------------
    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.log('\nRESULT: FAIL');
    throw err;
  }
  expect(exit).toBe(0);
}

test('creates, reopens, and abandons threads correctly', async ({
  protocolBrowser,
  protocolCredentials,
  resourceNamespace,
}) => {
  HS = protocolCredentials.hs;
  USER = protocolCredentials.user;
  PASS = protocolCredentials.pass;
  RUN_ID = resourceNamespace.role('threads');
  ROOM_NAME = `Threads E2E ${RUN_ID}`;
  ROOT_MSG = `Root message ${RUN_ID}`;
  NO_THREAD_MSG = `No-thread message ${RUN_ID}`;
  REPLY_TEXT = `First reply ${RUN_ID}`;
  await main(protocolBrowser);
});
