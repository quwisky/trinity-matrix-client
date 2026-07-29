import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for "Mark as unread" (MSC2867). Flagging a room writes `m.marked_unread`
// into that room's account data — so it follows the user to their other devices — and the
// room reads as unread in the list until it is opened.
//
// The flag is asserted BOTH server-side and in the UI: the room's own notification counts
// stay at zero throughout, so the account-data write is the only thing that could be
// making the row look unread. Needs a Synapse homeserver (Docker); self-skips otherwise.
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

/** Open the room row's ⋮ menu in the channel list. */
async function openRoomMenu(page: Page, roomName: string): Promise<void> {
  const row = page.locator('.channel-row', { hasText: roomName }).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.hover();
  await row.getByRole('button', { name: `Options for ${roomName}` }).click();
}

test.describe('Mark as unread', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('flags a read room, and opening it clears the flag', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}u`;
    const user = `unread-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Mark Unread E2E ${runId}`;

    await registerUser(request, user, pass);
    const json = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const auth = { Authorization: `Bearer ${json.access_token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: roomName },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    /** The room's marked-unread account data as the server holds it. */
    const flag = async (): Promise<boolean | undefined> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/user/${encodeURIComponent(json.user_id)}/rooms/${encodeURIComponent(roomId)}/account_data/m.marked_unread`,
        { headers: auth },
      );
      return res.ok() ? ((await res.json()).unread as boolean) : undefined;
    };
    expect(await flag()).toBeUndefined(); // nothing to begin with

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession);
    await page.getByTestId('rail-rooms').click();

    // The room is read and empty, so it carries no badge of any kind.
    const row = page.locator('.channel', { hasText: roomName }).first();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(row.locator('.channel__badge')).toHaveCount(0);

    await openRoomMenu(page, roomName);
    await page.getByTestId('room-mark-unread').click();

    // It round-trips: the flag is on the account, which is what carries it to the
    // user's other devices.
    await expect.poll(flag, { timeout: 20_000 }).toBe(true);

    // …and the row says so with a dot rather than a "0" — there is no count behind it.
    const dot = row.locator('[data-testid="room-unread-dot"]');
    await expect(dot).toBeVisible({ timeout: 20_000 });
    await expect(dot).toHaveText('');

    // Opening the room is the user dealing with it, so the flag goes. Trinity acks on
    // open through a focus-gated path, which is why the clear is wired to the selection
    // itself — this is the assertion that would catch it being wired to the ack instead.
    await row.click();
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 20_000 });

    await expect.poll(flag, { timeout: 20_000 }).toBe(false);
    await expect(page.locator('[data-testid="room-unread-dot"]')).toHaveCount(
      0,
    );
  });
});
