import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the text-size setting (Settings → Appearance → Text size). The lever is the ROOT
// font size, applied as a percentage, so everything that inherits from it scales.
//
// The assertion that matters is the COMPUTED size of a real message, not the value on
// <html>. `.msg__text` sets no font-size of its own and inherits — but that is a property of
// a stylesheet, and a stylesheet can change. Asserting the root alone would keep passing if
// some component later hard-coded a size onto the message body, which is exactly the
// regression this setting exists to avoid.
//
// It also pins the deliberate LIMIT: chrome that hard-codes px does not scale (147 such
// declarations remain, to be converted surface by surface), so the setting's own note says
// so. This asserts the sidebar room name stays fixed — if that ever changes, the note is
// wrong and should be removed with it.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

/** Pick an option from one of the Appearance selects (a CDK overlay). */
async function choose(
  page: Page,
  select: string,
  option: string,
): Promise<void> {
  await page.getByTestId(select).locator('button').first().click();
  const item = page.getByTestId(option);
  await item.waitFor({ state: 'visible', timeout: 15_000 });
  await item.click();
  await expect(item).toHaveCount(0);
}

const px = (locator: ReturnType<Page['locator']>) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

/**
 * The room-list column and the chat column must butt up against each other: no overlap
 * (which hides controls) and no gap (which is just wrong). Measured from the live boxes
 * rather than from the CSS, because the bug was a unit mismatch between a rem slot and its
 * px contents — something no stylesheet reading makes obvious.
 */
async function expectColumnsMeet(page: Page, label = 'larger'): Promise<void> {
  const list = await page.locator('.sidebar').first().boundingBox();
  const chat = await page.locator('.main').first().boundingBox();
  if (!list || !chat) {
    throw new Error(`columns not rendered at ${label}`);
  }
  // A sub-pixel tolerance only: fractional layout is fine, 44px of overlap is not.
  expect(Math.abs(list.x + list.width - chat.x), label).toBeLessThan(2);
}

test.describe('Text size', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('scales message text, persists, and leaves fixed chrome alone', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ts`;
    const user = `scale-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Scale ${runId}`;
    const body = `readable text ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}`,
      { headers, data: { msgtype: 'm.text', body } },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const message = page.locator('.msg__text', { hasText: body }).first();
    await expect(message).toBeVisible({ timeout: 20_000 });
    const roomNameEl = page.locator('.channel__name').first();

    const before = await px(message);
    const chromeBefore = await px(roomNameEl);
    // The default must leave <html> untouched, so the browser's own setting still wins.
    expect(
      await page.evaluate(() => document.documentElement.style.fontSize),
    ).toBe('');

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-appearance').click();
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    await choose(page, 'text-scale-select', 'text-scale-larger');

    expect(
      await page.evaluate(() => document.documentElement.style.fontSize),
    ).toBe('125%');

    // Back to the room: the MESSAGE is actually bigger. This is the whole claim — the root
    // value alone would pass even if the body had its own hard-coded size.
    await page.goto('/rooms');
    await openRoom(page, roomName);
    const scaled = page.locator('.msg__text', { hasText: body }).first();
    await expect(scaled).toBeVisible({ timeout: 20_000 });
    expect(await px(scaled)).toBeGreaterThan(before);

    // The documented limit: sidebar chrome hard-codes px and deliberately does not scale.
    expect(await px(page.locator('.channel__name').first())).toBe(chromeBefore);

    // The columns still MEET. Tailwind's `w-*` are rem, so the list column's slot scales
    // with the root while the rail (72px) and sidebar (280px) inside it do not — as
    // `md:w-88` the slot shrank to 308px at Small and the chat column painted over the room
    // list, clipping the filter box and every row's ⋮ out of reach. Asserting font sizes
    // alone would never have seen it.
    await expectColumnsMeet(page);

    // Every step, not just the one above: the overlap was worst at Small, which a test that
    // only ever picked Larger would have missed entirely.
    for (const step of ['small', 'default', 'large'] as const) {
      await page.getByTestId('open-settings').click();
      await page.getByTestId('settings-nav-appearance').click();
      await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
      await choose(page, 'text-scale-select', `text-scale-${step}`);
      await page.goto('/rooms');
      await openRoom(page, roomName);
      await expectColumnsMeet(page, step);
    }

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-appearance').click();
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    await choose(page, 'text-scale-select', 'text-scale-larger');
    await page.goto('/rooms');
    await openRoom(page, roomName);

    // Persisted, not session state.
    await page.reload();
    await openRoom(page, roomName);
    const afterReload = page.locator('.msg__text', { hasText: body }).first();
    await expect(afterReload).toBeVisible({ timeout: 20_000 });
    expect(await px(afterReload)).toBeGreaterThan(before);
  });
});
