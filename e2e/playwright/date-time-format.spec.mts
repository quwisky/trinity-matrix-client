import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// Covers issue #22: the Settings → Appearance dropdowns that choose how times and dates are
// written. The unit tests cover the formatting itself; what only a real browser can prove is
// the CDK-overlay round-trip (open the dropdown, pick an option) and that the choice reaches
// an already-rendered timeline and survives a reload.
// Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

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

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
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

/**
 * Pick an option from one of the format dropdowns.
 *
 * The option list lives in a CDK overlay that only exists while the trigger is open — which
 * is precisely why this lives in e2e rather than in the component spec.
 */
async function chooseFormat(
  page: Page,
  select: string,
  option: string,
): Promise<void> {
  await page.getByTestId(select).locator('button').first().click();
  const item = page.getByTestId(option);
  await item.waitFor({ state: 'visible', timeout: 15_000 });
  await item.click();
  await expect(item).toHaveCount(0); // the overlay closed
}

/** The timestamp on the first message row in the open room. */
function firstTimestamp(page: Page) {
  return page.locator('trn-message-row .msg__time').first();
}

test.describe('Date and time format', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a 24-hour clock and an ISO date reach the timeline and survive a reload', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}fmt`;
    const user = `fmt-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Format ${runId}`;
    const body = `timestamped ${runId}`;

    await registerUser(request, user, pass);
    const me = await apiLogin(request, hs, user, pass);
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: me.headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}`,
      { headers: me.headers, data: { msgtype: 'm.text', body } },
    );

    await login(page, { available: true, hs, user, pass });
    await openRoom(page, roomName);
    await expect(firstTimestamp(page)).toBeVisible({ timeout: 20_000 });

    // Settings → Appearance → both dropdowns.
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-appearance').click();
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    await chooseFormat(page, 'time-format-select', 'time-format-h24');
    await chooseFormat(page, 'date-format-select', 'date-format-iso');

    // The sample line reflects both choices immediately, with no reload.
    await expect(page.getByTestId('date-time-showing')).toContainText(
      '2026-07-24, 15:45',
    );

    // …and so does the timeline behind it: an ISO date and a 24-hour clock, no AM/PM.
    await page.goto('/rooms');
    await openRoom(page, roomName);
    await expect(firstTimestamp(page)).toHaveText(
      /^\d{4}-\d{2}-\d{2}, \d{2}:\d{2}$/,
      {
        timeout: 20_000,
      },
    );
    await expect(firstTimestamp(page)).not.toContainText(/AM|PM/);

    // The choice is persisted, not session state.
    await page.reload();
    await openRoom(page, roomName);
    await expect(firstTimestamp(page)).toHaveText(
      /^\d{4}-\d{2}-\d{2}, \d{2}:\d{2}$/,
      {
        timeout: 20_000,
      },
    );
  });
});
