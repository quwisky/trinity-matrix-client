import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for the per-room notification level: the room's ⋮ menu in the channel list
// has a Notifications submenu (All / Mentions / Mute); picking one writes push rules, and
// reopening the submenu shows the persisted selection. Needs a Synapse homeserver (Docker).
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

async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ user: SynapseSession; roomName: string }> {
  const username = `notif-user-${runId}`;
  const password = `${username}-pass`;
  const roomName = `Notify E2E ${runId}`;

  await registerUser(request, username, password);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      },
    })
    .then((r) => r.json());
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: { name: roomName },
  });

  return {
    user: { available: true, hs, user: username, pass: password },
    roomName,
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

const LEVELS = ['all', 'mentions', 'mute'] as const;
type Level = (typeof LEVELS)[number];

// Open the room row's ⋮ menu in the channel list, then its Notifications submenu.
async function openNotifyMenu(page: Page, roomName: string): Promise<void> {
  const row = page.locator('.channel-row', { hasText: roomName }).first();
  await row.hover();
  await row.getByRole('button', { name: `Options for ${roomName}` }).click();
  await page.getByTestId('room-notify').click(); // reveal the Notifications submenu
  await expect(page.getByTestId('room-notify-all')).toBeVisible({
    timeout: 10_000,
  });
}

// Pick a level radio and wait for the service's push-rule cache refresh — the
// `GET /pushrules/` that `applyMode` issues after every write — so the reopened menu
// reflects the persisted choice deterministically (works for every level transition,
// which write different rule endpoints). Selecting a radio also closes the menu.
async function pickLevel(page: Page, level: Level): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (r) =>
        /\/pushrules\/?$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'GET',
      { timeout: 15_000 },
    ),
    page.getByTestId(`room-notify-${level}`).click(),
  ]);
}

// With the Notifications submenu open, assert exactly `level` is the checked radio.
async function expectChecked(page: Page, level: Level): Promise<void> {
  for (const l of LEVELS) {
    await expect(page.getByTestId(`room-notify-${l}`)).toHaveAttribute(
      'aria-checked',
      l === level ? 'true' : 'false',
      { timeout: 15_000 },
    );
  }
}

test.describe('Per-room notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('sets each notification level from the room menu and remembers it', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}n`;
    const { user, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, user);
    await openRoom(page, roomName);

    // A fresh room defaults to "All messages".
    await openNotifyMenu(page, roomName);
    await expectChecked(page, 'all');

    // Walk every level in turn: pick it (which writes push rules + closes the menu),
    // then reopen and confirm it is now the persisted, checked radio. This exercises the
    // add-override (mute), room-rule (mentions), and clear (back to all) write paths.
    for (const level of ['mute', 'mentions', 'all'] as const) {
      await pickLevel(page, level); // menu is already open from the previous reopen
      await openNotifyMenu(page, roomName);
      await expectChecked(page, level);
    }
  });
});
