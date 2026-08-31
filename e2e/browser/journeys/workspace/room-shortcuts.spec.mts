import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers the web-available keyboard room-switching shortcuts (issue #12): Ctrl/Cmd+'
// hops through the most-recently-VISITED stack (alt-tab, cycling deeper; Shift reverses),
// Alt+↑/↓ walks the visible list, and Alt+Shift+↑/↓ jumps to the prev/next unread room.
//
// Ctrl/Cmd+1…9 and Ctrl+Tab are DESKTOP-shell only (the browser reserves them), so they
// are covered by the unit tests (rooms.page.spec.ts), not this Chromium/web spec.
//
// CI is Linux, so the accelerator is Control (the app binds both Control and Meta).
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

interface ApiUser {
  token: string;
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const { access_token: token, user_id: userId } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return { token, userId, headers: { Authorization: `Bearer ${token}` } };
}

async function createRoom(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  name: string,
  invite: string[] = [],
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: user.headers,
      data: { name, preset: 'private_chat', invite },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
}

test.describe('Keyboard room switching', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('hops through visited rooms, and walks the list and the unread rooms', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}k`;
    const user = `hotkeys-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const reader = await apiLogin(request, hs, user, pass);

    // Three rooms the reader will visit, plus a fourth left unread by a second user.
    const a = `Alpha ${runId}`;
    const b = `Bravo ${runId}`;
    const c = `Charlie ${runId}`;
    const unreadName = `Unread ${runId}`;
    await createRoom(request, hs, reader, a);
    await createRoom(request, hs, reader, b);
    await createRoom(request, hs, reader, c);
    const senderUser = `sender-${runId}`;
    await registerUser(request, senderUser, `${senderUser}-pass`);
    const sender = await apiLogin(
      request,
      hs,
      senderUser,
      `${senderUser}-pass`,
    );
    const unreadId = await createRoom(request, hs, reader, unreadName, [
      sender.userId,
    ]);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(unreadId)}/join`,
      { headers: sender.headers },
    );
    for (let i = 0; i < 3; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(unreadId)}/send/m.room.message/k-${runId}-${i}`,
        {
          headers: sender.headers,
          data: { msgtype: 'm.text', body: `hi ${i} ${runId}` },
        },
      );
    }

    await login(page, { available: true, hs, user, pass } as SynapseSession);

    // The active room is the one carrying `.channel.active` in the sidebar.
    const active = page.locator('trn-channel-sidebar .channel.active');
    const open = async (name: string): Promise<void> => {
      await page.locator('.channel', { hasText: name }).first().click();
      await expect(active).toHaveText(new RegExp(name), { timeout: 15_000 });
    };

    // The seeded message must have landed as an unread before we test the jump to it.
    // Wait on the row flipping to `.unread` (same propagation wait as unread-badges).
    await expect(
      page.locator('.channel.unread', { hasText: unreadName }),
    ).toBeVisible({ timeout: 30_000 });

    // Visit A → B → C — the visited stack is [C, B, A]. (The unread room is never
    // visited, so it stays out of the stack and stays unread through the hop below.)
    await open(a);
    await open(b);
    await open(c);

    // Ctrl+' hops back, and again cycles deeper — C → B → A — then Shift steps forward
    // through the same frozen order.
    await page.keyboard.press("Control+'");
    await expect(active).toHaveText(new RegExp(b), { timeout: 10_000 });
    await page.keyboard.press("Control+'");
    await expect(active).toHaveText(new RegExp(a));
    await page.keyboard.press("Control+Shift+'");
    await expect(active).toHaveText(new RegExp(b));

    // Alt+Shift+↓ jumps to the unread room, wherever it sits in the list. Done before the
    // list walk below, since opening the unread room clears its unread state.
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect(active).toHaveText(new RegExp(unreadName), {
      timeout: 10_000,
    });

    // Alt+↓/↑ walk the visible list (display order, independent of the MRU): a step down
    // moves to a different room, and the matching step up returns — true at any position,
    // wrapping included.
    await open(a);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(active).not.toHaveText(new RegExp(a));
    await page.keyboard.press('Alt+ArrowUp');
    await expect(active).toHaveText(new RegExp(a)); // back where we started
  });
});
