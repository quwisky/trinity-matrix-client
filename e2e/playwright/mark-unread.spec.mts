import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for "Mark as unread" (MSC2867). Flagging a room writes `m.marked_unread`
// into that room's account data — so it follows the user to their other devices — and the
// room reads as unread in the list until it is opened.
//
// The flag is asserted BOTH server-side and in the UI: the room's own notification counts
// stay at zero throughout, so the account-data write is the only thing that could be
// making the row look unread. Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

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

  test('a flag set elsewhere arrives, survives a reload, and Mark as read clears it', async ({
    page,
    request,
  }) => {
    // The flag is account data precisely so it follows the user between devices, and
    // nothing proved that: this writes it the way another device would — straight to the
    // server, with the app already open — and then reloads to prove it was never local.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}s`;
    const user = `unread2-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Mark Unread Sync ${runId}`;

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

    const flagUrl = `${hs}/_matrix/client/v3/user/${encodeURIComponent(json.user_id)}/rooms/${encodeURIComponent(roomId)}/account_data/m.marked_unread`;
    const flag = async (): Promise<boolean | undefined> => {
      const res = await request.get(flagUrl, { headers: auth });
      return res.ok() ? ((await res.json()).unread as boolean) : undefined;
    };

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const row = page.locator('.channel', { hasText: roomName }).first();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(row.locator('.channel__badge')).toHaveCount(0);

    // Another device flags it. The running app must notice without being touched.
    const written = await request.put(flagUrl, {
      headers: auth,
      data: { unread: true },
    });
    expect(written.ok()).toBe(true);
    await expect(row.locator('[data-testid="room-unread-dot"]')).toBeVisible({
      timeout: 30_000,
    });

    // It is on the account, not in this tab: a reload finds it again.
    await page.reload();
    await page.getByTestId('rail-rooms').click();
    const afterReload = page.locator('.channel', { hasText: roomName }).first();
    await expect(
      afterReload.locator('[data-testid="room-unread-dot"]'),
    ).toBeVisible({ timeout: 30_000 });

    // The other way out: ⋮ → Mark as read, which must clear the flag as well as ack.
    await openRoomMenu(page, roomName);
    await page.getByTestId('room-mark-read').click();

    await expect.poll(flag, { timeout: 20_000 }).toBe(false);
    await expect(page.locator('[data-testid="room-unread-dot"]')).toHaveCount(
      0,
    );
  });
});
