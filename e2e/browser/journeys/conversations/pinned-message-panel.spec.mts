import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers the pinned-messages panel end to end: the room toolbar's pin button
// (`data-testid="open-pinned"`) opens PinnedPanelService's side panel
// (`data-testid="pinned-panel"`), which lists every `m.room.pinned_events` entry
// (`data-testid="pinned-item"`) projected live by the exact Conversation pins child. Unpinning
// (`data-testid="pinned-unpin"`) rewrites the state event and the row drops out of the
// live projection WITHOUT closing the panel — the property the unit spec asserts
// against a mock, exercised here against a real homeserver round-trip.
//
// The pin state is seeded server-side rather than through the UI, so the test asserts
// the read/unpin path rather than re-testing pinning itself.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise, like the other
// authenticated web e2e specs.
const session = homeserverSession();

/**
 * A room containing two messages, both pinned via `m.room.pinned_events` (pin order =
 * array order). Two so unpinning one leaves a non-empty panel to assert against —
 * proving the row dropped rather than the panel merely emptying.
 */
async function seedPinnedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: HomeserverSession;
  roomName: string;
  keepBody: string;
  unpinBody: string;
}> {
  const user = `pinner-${runId}`;
  const pass = `pinner-pass-${runId}`;
  const roomName = `Pinned Room ${runId}`;
  const unpinBody = `unpin-me-${runId}`;
  const keepBody = `keep-me-${runId}`;

  await registerUser(request, user, pass);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  const auth = { Authorization: `Bearer ${access_token}` };

  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: auth,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json());

  const send = async (body: string): Promise<string> => {
    const res = await request.put(
      `${hs}/_matrix/client/v3/rooms/${room_id}/send/m.room.message/${body}`,
      { headers: auth, data: { msgtype: 'm.text', body } },
    );
    const { event_id } = await res.json();
    return event_id;
  };
  const unpinId = await send(unpinBody);
  const keepId = await send(keepBody);

  await request.put(
    `${hs}/_matrix/client/v3/rooms/${room_id}/state/m.room.pinned_events/`,
    { headers: auth, data: { pinned: [unpinId, keepId] } },
  );

  return {
    reader: { available: true, hs, user, pass },
    roomName,
    keepBody,
    unpinBody,
  };
}

test.describe('Pinned messages panel', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('lists pinned messages and unpins one in place', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}p`;

    const { reader, roomName, keepBody, unpinBody } = await seedPinnedRoom(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();

    const room = page.locator('.channel', { hasText: roomName });
    await room.first().waitFor({ state: 'visible', timeout: 30_000 });
    await room.first().click();

    // The toolbar pin button opens the side panel with both pins, in pin order.
    await page.getByTestId('open-pinned').click();
    const panel = page.getByTestId('pinned-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pinned-item')).toHaveCount(2);

    // The panel's top bar: the same 56px the room header is, with its title inset from
    // the panel's edge. Measured, because the classes cannot say it — this bar carried
    // `safe-top safe-left safe-right p-3`, and those helpers are UNLAYERED rules in
    // global.scss while `p-3` is a LAYERED utility, so each replaced the padding on its
    // side instead of adding to it. The bar rendered 45px tall with its title flush
    // against the border. jsdom applies no cascade and no layers, so only a browser sees
    // it, and the height alone would not: it was the missing INSET that showed.
    const chatBar = await page
      .locator('trn-page-header header')
      .first()
      .boundingBox();
    const panelBar = await panel.locator('.panel-header').boundingBox();
    const panelTitle = await panel.locator('.panel-header h2').boundingBox();
    expect(chatBar).not.toBeNull();
    expect(panelBar).not.toBeNull();
    expect(panelTitle).not.toBeNull();

    expect(panelBar!.height).toBe(chatBar!.height);
    expect(panelTitle!.x - panelBar!.x).toBeCloseTo(12, 0);
    // And the title is centred in the bar rather than riding its top edge.
    const above = panelTitle!.y - panelBar!.y;
    const below =
      panelBar!.y + panelBar!.height - (panelTitle!.y + panelTitle!.height);
    expect(Math.abs(above - below)).toBeLessThan(2);

    // Unpin the first: the state event is rewritten and the live projection drops the
    // row — while the panel STAYS open (an unpin is not a jump).
    // Scope to the row (.pin-item wraps the jump button + its unpin sibling) so the
    // two pins can never be confused.
    const unpinRow = page.locator('.pin-item', { hasText: unpinBody });
    await unpinRow.getByTestId('pinned-unpin').click({ timeout: 10_000 });

    await expect(page.getByTestId('pinned-item')).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(keepBody);
    await expect(panel).not.toContainText(unpinBody);
  });

  // A pin older than the client's initial-sync window (`initialSyncLimit: 20`, plus the viewport-fill backfill) is not in
  // the loaded timeline, but `m.room.pinned_events` still names it: the panel has to
  // fetch it, and jumping to it has to page it in.
  test('lists a pin outside the loaded timeline and jumps to it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}po`;
    const user = `old-pinner-${runId}`;
    const pass = `old-pinner-pass-${runId}`;
    const roomName = `Old Pin Room ${runId}`;
    const oldBody = `old-pin-${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const auth = { Authorization: `Bearer ${access_token}` };
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    const send = async (txn: string, body: string): Promise<string> => {
      const res = await request.put(
        `${hs}/_matrix/client/v3/rooms/${room_id}/send/m.room.message/${txn}`,
        { headers: auth, data: { msgtype: 'm.text', body } },
      );
      return (await res.json()).event_id as string;
    };
    const oldId = await send(`old-${runId}`, oldBody);
    for (let i = 0; i < 100; i++) {
      await send(`filler-${runId}-${i}`, `filler ${runId} ${i}`);
    }
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${room_id}/state/m.room.pinned_events/`,
      { headers: auth, data: { pinned: [oldId] } },
    );

    await login(page, { available: true, hs, user, pass });
    await page.getByTestId('rail-rooms').click();
    const room = page.locator('.channel', { hasText: roomName });
    await room.first().waitFor({ state: 'visible', timeout: 30_000 });
    await room.first().click();
    await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

    const oldRow = page.locator('.scroll .msg[data-mid]', {
      hasText: oldBody,
    });
    // Precondition: the pin really is outside the loaded timeline.
    await expect(oldRow).toHaveCount(0);

    await page.getByTestId('open-pinned').click();
    const item = page.getByTestId('pinned-item');
    await expect(item).toHaveCount(1, { timeout: 30_000 });
    await expect(item).toContainText(oldBody);
    await expect(oldRow).toHaveCount(0);

    await item.click();
    await expect(oldRow.first()).toBeInViewport({ timeout: 30_000 });
  });
});
