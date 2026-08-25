import { createHmac } from 'node:crypto';
import { REGISTRATION_SHARED_SECRET, SYNAPSE_HTTP } from '../synapse/start.mjs';
import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Node's fetch (the CS-API room seeding below) must accept the disposable
// Synapse + Caddy harness's self-signed cert — same bypass global-setup applies
// in the main process, and the legacy e2e/features/*.mjs runners set at their own
// module scope; set again here so it holds regardless of whether Playwright's
// worker process inherits the main process's later `process.env` mutations.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const session = synapseSession();

// Below Tailwind's `md` breakpoint (768px) the shell's server-rail + channel
// sidebar — `<aside class="shell-side">` in rooms.page.html — and the chat become
// separate full-screen pages: the room list is the home page, picking a room opens
// the chat page, and the header's back button (`data-testid="back-to-rooms"`,
// itself `md:hidden`) returns to the list. That master-detail split only exists
// below md, so every test below runs at a phone-sized viewport rather than 1280×720.
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const ROOM_NAME = `Mobile drawer ${Date.now()}`;

// A dedicated user (registered in beforeAll) instead of the shared session account.
// The shared account is bloated by other specs (gif, multi-account,
// timeline-virtualization) that seed rooms into it, so under full-suite load its
// initial /sync was slow enough that ROOM_NAME took >30s (sometimes >90s) to appear —
// the root cause of this file's flakiness. A fresh user syncs a single room, fast.
const runId = `${Date.now().toString(36)}mn`;
const MOBILE_USER = `mobile-user-${runId}`;
const MOBILE_PASS = `${MOBILE_USER}-pass`;
const mobileSession: SynapseSession = {
  available: session.available,
  hs: session.hs,
  user: MOBILE_USER,
  pass: MOBILE_PASS,
};
const ROOM_ATTACH_TIMEOUT = 30_000;

/** Register a fresh user via Synapse's shared-secret admin API (idempotent). */
/**
 * The one local copy left, and the reason it is not the shared `support/account.mts` one.
 *
 * This file registers in `beforeAll`, where Playwright's `request` fixture does not exist —
 * it is test-scoped, and `beforeAll` receives worker-scoped fixtures only. So this one uses
 * global `fetch` and takes no context. Everything it signs still comes from the same place;
 * only the transport differs.
 */
async function registerUser(username: string, password: string): Promise<void> {
  const { nonce } = await fetch(
    `${SYNAPSE_HTTP}/_synapse/admin/v1/register`,
  ).then((r) => r.json());
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await fetch(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, username, password, admin: false, mac }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status} ${text}`);
    }
  }
}

/** CS-API password login (bypasses the UI) — returns the access token + user id. */
async function apiLogin(
  hs: string,
  user: string,
  pass: string,
): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${hs}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    }),
  });
  if (!res.ok) {
    throw new Error(`CS-API login failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; user_id: string };
  return { token: json.access_token, userId: json.user_id };
}

/**
 * Seed a room via the CS API so the sidebar has a real channel to tap, and mark
 * it as a direct message (`m.direct` account data) so it renders in the
 * server rail's default Home view. Deliberately bypasses the create-room UI
 * (the header "+" action sheet + alert dialog) — that flow is already covered
 * end to end by e2e/features/rooms.mjs; this file only needs *a* room to
 * exercise the drawer's open/select/close mechanics, and seeding it before
 * `login()` means it's already part of the account's initial sync rather than
 * something each test has to wait to arrive.
 *
 * The server rail's Home pill shows direct-message rooms only (non-DM rooms
 * live under the Rooms pill, `data-testid="rail-rooms"` — see
 * RoomsPage.visibleRooms()); RoomsService derives `directRoomIds` from the
 * account's `m.direct` map, so tagging the seeded room there is what makes it
 * show up without switching views (which the mobile drawer tests, running the
 * closed-drawer assertion first, don't want to have to do).
 */
async function seedRoom(
  hs: string,
  token: string,
  userId: string,
  name: string,
): Promise<void> {
  const res = await fetch(`${hs}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(
      `CS-API createRoom failed: ${res.status} ${await res.text()}`,
    );
  }
  const { room_id: roomId } = (await res.json()) as { room_id: string };

  // Tag the room as a DM against a placeholder peer (the peer never needs to
  // exist/join — m.direct is just account data mapping a user id to room ids;
  // RoomsService only reads the map's values to build directRoomIds).
  const dmRes = await fetch(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.direct`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ '@ghost:localhost': [roomId] }),
    },
  );
  if (!dmRes.ok) {
    throw new Error(
      `CS-API m.direct account_data failed: ${dmRes.status} ${await dmRes.text()}`,
    );
  }
}

/** The rail + sidebar `<aside>` — a static column at md+, the list page below md. */
const shellSide = (page: Page) => page.locator('.shell-side');

test.describe('Mobile navigation (separate list/chat pages)', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test.use({ viewport: MOBILE_VIEWPORT });

  // Each test does a full UI login in beforeEach (~10-20s cold: Rust-crypto init +
  // first sync). The dedicated user's sync is small, so 60s per test is ample headroom
  // under load; retries inherit the project default. Scoped to this describe.
  test.describe.configure({ timeout: 60_000 });

  // Register a dedicated user and seed its single room once for the whole file, so
  // every test logs into an account whose initial sync is tiny (and therefore fast).
  test.beforeAll(async () => {
    await registerUser(MOBILE_USER, MOBILE_PASS);
    const { token, userId } = await apiLogin(
      mobileSession.hs as string,
      MOBILE_USER,
      MOBILE_PASS,
    );
    await seedRoom(mobileSession.hs as string, token, userId, ROOM_NAME);
  });

  test.beforeEach(async ({ page }) => {
    await login(page, mobileSession);
  });

  test('the room list is the mobile home page', async ({ page }) => {
    const channel = page.locator('button.channel', { hasText: ROOM_NAME });
    await channel
      .first()
      .waitFor({ state: 'attached', timeout: ROOM_ATTACH_TIMEOUT });

    // No room open: the rail + sidebar (room list) fills the screen and its
    // channel rows are real on-screen targets; the chat page — and its back
    // button — are not shown (the list and chat use display:none, so a plain
    // toBeVisible/toBeHidden reflects which page is up).
    await expect(shellSide(page)).toBeVisible();
    await expect(channel.first()).toBeVisible();
    await expect(page.getByTestId('back-to-rooms')).toBeHidden();
  });

  test('picking a room opens the chat page', async ({ page }) => {
    const channel = page.locator('button.channel', { hasText: ROOM_NAME });
    await channel
      .first()
      .waitFor({ state: 'attached', timeout: ROOM_ATTACH_TIMEOUT });

    await channel.first().click();

    // The list page gives way to the chat page: the sidebar is hidden, the picked
    // room is the active room in the toolbar heading, and the back button appears.
    await expect(shellSide(page)).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      ROOM_NAME,
    );
    await expect(page.getByTestId('back-to-rooms')).toBeVisible();
  });

  test('the back button returns to the room list', async ({ page }) => {
    const channel = page.locator('button.channel', { hasText: ROOM_NAME });
    await channel
      .first()
      .waitFor({ state: 'attached', timeout: ROOM_ATTACH_TIMEOUT });

    await channel.first().click();
    await expect(shellSide(page)).toBeHidden();

    await page.getByTestId('back-to-rooms').click();

    // Back on the list page: the sidebar is shown again and no room is open.
    await expect(shellSide(page)).toBeVisible();
    await expect(page.getByTestId('back-to-rooms')).toBeHidden();
  });

  // The composer's narrow layout is decided purely by a media query, so nothing in the
  // unit suite can observe it — jsdom does not lay out. Every other composer spec runs
  // at the 1280px project viewport, i.e. on the *other* side of the breakpoint. Without
  // this test the collapse could stop happening and CI would stay green.
  test('the composer offers its insert actions through the + tray', async ({
    page,
  }) => {
    const channel = page.locator('button.channel', { hasText: ROOM_NAME });
    await channel
      .first()
      .waitFor({ state: 'attached', timeout: ROOM_ATTACH_TIMEOUT });
    await channel.first().click();

    const composerInput = page.getByTestId('composer-input');
    await expect(composerInput).toBeVisible();

    // The insert actions sit behind the single `+` tray trigger; emoji and send stay
    // inline. The old inline action buttons do not exist at any width.
    await expect(page.getByTestId('composer-insert')).toBeVisible();
    for (const id of ['composer-attach', 'composer-poll', 'composer-gif']) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(page.getByTestId('composer-send')).toBeVisible();

    // With only +, input, emoji and send on the row the input keeps its width — well
    // clear of the ~22px it had when every action was inline.
    const box = await composerInput.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(150);

    // The tray opens and its actions are reachable, and Escape closes it.
    await page.getByTestId('composer-insert').click();
    await expect(page.getByTestId('insert-attach')).toBeVisible();
    await expect(page.getByTestId('insert-poll')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('insert-poll')).toBeHidden();
  });
});
