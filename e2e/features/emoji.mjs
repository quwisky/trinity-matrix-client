// Emoji composer e2e — `:shortcode` autocomplete + inline conversion + the
// ngx-emoji-mart picker, driven through the real in-room composer.
//
// Four scenarios in one seeded plaintext room:
//
//   1. Autocomplete menu → accept with Enter → send: type ":joy"; the suggestion
//      menu ([data-testid=emoji-autocomplete]) shows a ":joy:" row with 😂; Enter
//      accepts (the textarea now holds 😂, menu gone); Enter again sends → the
//      timeline shows a 😂 message.
//
//   2. Inline conversion: typing a complete ":tada:" converts to 🎉 in place
//      (no menu interaction); Enter sends → the timeline shows a 🎉 message.
//
//   3. Non-shortcode is left alone: typing ":qwerty:" stays literal (no emoji),
//      proving conversion is strict.
//
//   4. The emoji-mart picker: the emoji button opens <emoji-mart>; clicking an
//      emoji inserts its native character into the composer and closes the picker.
//
// Env:
//   TRINITY_HS    default https://localhost:8448
//   TRINITY_USER  default verify-e2e
//   TRINITY_PASS  default verify-e2e-pass-123
//   HEADED=1 / SLOWMO=ms  for debugging
//
// `pnpm e2e:emoji` builds dev, starts the harness, runs this, and tears down.
// MUST run sequentially with other e2e scripts (shared docker stack + www/ build).
import { mkdir } from 'node:fs/promises';
import { serve } from '../support/serve.mjs';
import { chromium } from 'playwright';

// Node's fetch (CS-API helpers) must accept Caddy's self-signed cert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = 8132;
const APP = `http://localhost:${PORT}`;

const HS = process.env.TRINITY_HS ?? 'https://localhost:8448';
const USER = process.env.TRINITY_USER ?? 'verify-e2e';
const PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';
const HEADED = process.env.HEADED === '1';
const SLOWMO = Number(process.env.SLOWMO ?? 0);

const RUN_ID = Date.now().toString(36);
const ROOM = `Emoji-${RUN_ID}`;

const STEP_TIMEOUT = 30_000;
const SETUP_TIMEOUT = 60_000;

const log = (m) => console.log(`[emoji] ${m}`);

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
    throw new Error(`login ${user} → ${res.status} ${await res.text()}`);
  }
  return res.json();
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

/** Focus the composer textarea, type `text` keystroke-by-keystroke (so every
 *  input event fires and the autocomplete tracks), waiting on the textarea. */
async function typeInComposer(page, textarea, text) {
  await textarea.click();
  await page.keyboard.type(text, { delay: 40 });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir('e2e/.artifacts', { recursive: true });

  // ── CS-API pre-setup: one plaintext room to chat in ────────────────────────
  const { access_token: token } = await apiLogin(USER, PASS);
  log('api login ok');
  const { room_id: roomId } = await csPost(
    token,
    '/_matrix/client/v3/createRoom',
    { name: ROOM, preset: 'private_chat' }, // plaintext → instant local echo
  );
  log(`created room ${roomId} ("${ROOM}")`);

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

  // Re-fetch HS requests at the CDP layer where ignoreHTTPSErrors applies.
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

    // Open the seeded room from the sidebar.
    log('waiting for the seeded room in the sidebar');
    const channel = page.locator('.channel', { hasText: ROOM });
    await channel.first().waitFor({ state: 'visible', timeout: SETUP_TIMEOUT });
    await channel.first().click();

    const textarea = page.locator('textarea.composer__input').first();
    await textarea.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    const menu = page.locator('[data-testid="emoji-autocomplete"]');
    log('room open, composer ready ✓');

    // ── SCENARIO 1: autocomplete → accept → send ──────────────────────────
    log('--- Scenario 1: ":joy" autocomplete → Enter accept → Enter send ---');
    await typeInComposer(page, textarea, ':joy');

    await menu.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    const firstCode = page.locator('.composer__emoji-suggestion-code').first();
    await firstCode.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    const codeText = (await firstCode.textContent())?.trim();
    if (codeText !== ':joy:') {
      throw new Error(
        `first suggestion label is "${codeText}", expected ":joy:"`,
      );
    }
    log('suggestion menu shows ":joy:" ✓');

    await page.keyboard.press('Enter'); // accept the highlighted 😂
    await menu.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
    const accepted = await textarea.inputValue();
    if (!accepted.includes('😂')) {
      throw new Error(`composer is "${accepted}", expected it to contain 😂`);
    }
    log('Enter accepted the emoji (composer holds 😂, menu gone) ✓');

    await page.keyboard.press('Enter'); // send "😂"
    const joyMsg = page.locator('.msg', { hasText: '😂' });
    await joyMsg.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('😂 message rendered in the timeline ✓');
    log('PASS scenario 1');

    // ── SCENARIO 2: inline :shortcode: conversion → send ──────────────────
    log('--- Scenario 2: ":tada:" inline conversion → send ---');
    await typeInComposer(page, textarea, ':tada:');
    await page.waitForFunction(
      () => {
        const ta = document.querySelector('textarea.composer__input');
        return !!ta && ta.value.includes('🎉') && !ta.value.includes(':tada');
      },
      undefined,
      { timeout: STEP_TIMEOUT, polling: 100 },
    );
    log('":tada:" converted to 🎉 in place ✓');

    await page.keyboard.press('Enter'); // send "🎉"
    const tadaMsg = page.locator('.msg', { hasText: '🎉' });
    await tadaMsg.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('🎉 message rendered in the timeline ✓');
    log('PASS scenario 2');

    // ── SCENARIO 3: a non-shortcode is left literal ───────────────────────
    log('--- Scenario 3: ":qwerty:" stays literal ---');
    await typeInComposer(page, textarea, ':qwerty:');
    const literal = await textarea.inputValue();
    if (literal !== ':qwerty:') {
      throw new Error(`composer is "${literal}", expected literal ":qwerty:"`);
    }
    // Clear it so it doesn't leak into the next scenario.
    await textarea.fill('');
    log('unknown ":qwerty:" left untouched ✓');
    log('PASS scenario 3');

    // ── SCENARIO 4: the emoji-mart picker inserts a native emoji ──────────
    log('--- Scenario 4: emoji-mart picker → search → insert ---');
    await page.getByRole('button', { name: 'Insert emoji' }).click();
    const picker = page.locator('emoji-mart');
    await picker.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    log('emoji-mart picker open ✓');

    // Drive selection through the picker's search box: emoji-mart lazy-renders
    // grid emojis only when scrolled into view, but search results render in a
    // visible category at the top — a reliable, clickable target.
    const search = picker.locator('.emoji-mart-search input');
    await search.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await search.fill('joy');

    const result = picker.locator('.emoji-mart-emoji:visible').first();
    await result.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
    await result.click();

    // The picker closes and the composer gains a (native) emoji character.
    await picker.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
    const picked = await textarea.inputValue();
    if (picked.trim().length === 0) {
      throw new Error(
        'composer is empty after picking from the emoji-mart picker',
      );
    }
    log(`picker inserted "${picked}" and closed ✓`);
    log('PASS scenario 4');

    // -----------------------------------------------------------------------
    console.log('\nRESULT: PASS');
    exit = 0;
  } catch (err) {
    console.error('\n[emoji] error:', err.message);
    await page
      .screenshot({ path: 'e2e/.artifacts/emoji-failure.png' })
      .catch(() => {});
    console.log('\nRESULT: FAIL');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exit);
}

main().catch((err) => {
  console.error('[emoji] fatal:', err);
  process.exit(1);
});
