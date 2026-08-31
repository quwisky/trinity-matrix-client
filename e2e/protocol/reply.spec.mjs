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
    throw protocolResponseFailure(`${method} ${path}`, res);
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
// Main
// ---------------------------------------------------------------------------

async function main(protocolBrowser) {
  // 1. Seed the room + original message via the CS API before the browser runs.
  const { originalEventId } = await setupRoom();
  log(`originalEventId=${originalEventId}`);
  log(`serving www on ${APP} (homeserver=${HS})`);

  const page = await protocolBrowser.newAuthenticatedPage({ label: 'reply' });

  let exit = 1;
  try {
    // 2. Open the seeded room.
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
    await clickRowToolbar(
      rootMsgRow.first(),
      rootMsgRow.first().getByRole('button', {
        name: 'Reply',
        exact: true,
      }),
    );

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
    console.log('\nRESULT: FAIL');
    throw err;
  }
  expect(exit).toBe(0);
}

test('renders a reply with its author and quoted preview', async ({
  protocolBrowser,
  protocolCredentials,
  resourceNamespace,
}) => {
  HS = protocolCredentials.hs;
  USER = protocolCredentials.user;
  PASS = protocolCredentials.pass;
  RUN_ID = resourceNamespace.role('reply');
  ROOM_NAME = `Reply E2E ${RUN_ID}`;
  ORIGINAL_MSG = `Original message ${RUN_ID}`;
  REPLY_TEXT = `My reply ${RUN_ID}`;
  await main(protocolBrowser);
});
