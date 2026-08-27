import { test, expect, type Page } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the room-upgrade / tombstone banner (data-testid="tombstone-banner"): a room
// with an m.room.tombstone shows a banner whose "Go to the new room" (tombstone-go) joins
// and opens the successor. Uses distinctly-named old/new rooms so each is identifiable.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Room tombstone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows the upgrade banner and moves to the successor room', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}tb`;
    const user = `tomb-${runId}`;
    const pass = `${user}-pass`;
    const oldName = `OldRoom ${runId}`;
    const newName = `NewRoom ${runId}`;

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
    const auth = { Authorization: `Bearer ${token}` };
    const createRoom = (name: string) =>
      request
        .post(`${hs}/_matrix/client/v3/createRoom`, {
          headers: auth,
          data: { name, preset: 'private_chat' },
        })
        .then((r) => r.json())
        .then((j) => j.room_id as string);

    const oldRoom = await createRoom(oldName);
    const newRoom = await createRoom(newName);
    // Tombstone the old room, pointing at the (distinctly-named) successor.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(oldRoom)}/state/m.room.tombstone/`,
      {
        headers: auth,
        data: {
          body: 'This room has been upgraded.',
          replacement_room: newRoom,
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, oldName);

    // The old room shows the upgrade banner.
    await expect(page.getByTestId('tombstone-banner')).toBeVisible({
      timeout: 20_000,
    });

    // And it stacks ABOVE the chat row rather than sharing it. `.chat-body` is a flex row of
    // [timeline, right-hand panel] whose children are sized by content, so a full-width notice
    // put in there competes with the timeline for horizontal space instead of sitting over it:
    // measured at 779px of a 928px row, which left the timeline 149px and the composer's text
    // column nothing at all. `openRoom` above does catch that today — a collapsed composer is
    // not `toBeVisible()` — but only as a side effect of a gate that is there for sync timing.
    // This says what is actually being guarded, so it survives a refactor of that helper.
    const banner = page.getByTestId('tombstone-banner');
    expect(await banner.evaluate((host) => !!host.closest('.chat-body'))).toBe(
      false,
    );
    const timelineShare = await page.evaluate(() => {
      const row = document.querySelector('.chat-body')?.getBoundingClientRect();
      const list = document
        .querySelector(
          '.chat-body trn-simple-message-list, .chat-body trn-virtual-message-list',
        )
        ?.getBoundingClientRect();
      return row && list && row.width > 0 ? list.width / row.width : 0;
    });
    // Half, not most: the right-hand panel is a legitimate row citizen and takes about a
    // quarter at this viewport (measured 0.74 with the member list up). The bug left the
    // timeline 149px of 928 — 0.16 — so half separates the two with room to spare either way.
    expect(timelineShare).toBeGreaterThan(0.5);

    // Go to the successor: the banner clears (the live successor has no tombstone).
    await page.getByTestId('tombstone-go').click();
    await expect(page.getByTestId('tombstone-banner')).toBeHidden({
      timeout: 20_000,
    });
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });
});
