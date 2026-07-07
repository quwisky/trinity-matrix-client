import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// Node's fetch (the CS-API room seeding below) must accept the disposable
// Synapse + Caddy harness's self-signed cert — same bypass global-setup applies
// in the main process, and the legacy e2e/features/*.mjs runners set at their own
// module scope; set again here so it holds regardless of whether Playwright's
// worker process inherits the main process's later `process.env` mutations.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const session = synapseSession();

// Below Tailwind's `md` breakpoint (768px) the shell's server-rail + channel
// sidebar — `<aside class="shell-side">` in rooms.page.html — stops being a
// static column and becomes a fixed, slide-in drawer toggled by the header
// hamburger (`data-testid="open-menu"`, itself `md:hidden`). That's the only
// viewport band where the drawer exists at all, so every test below runs at a
// phone-sized viewport instead of the suite's default 1280×720.
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const ROOM_NAME = `Mobile drawer ${Date.now()}`;

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

/** The responsive drawer `<aside>` — a static column at md+, a slide-in panel below. */
const shellSide = (page: Page) => page.locator('.shell-side');

test.describe('Mobile navigation drawer', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test.use({ viewport: MOBILE_VIEWPORT });

  // Every test here does a full UI login in beforeEach (~10-20s), then waits for the
  // seeded room to arrive via initial sync. Under the suite's parallel load a cold
  // login + Rust-crypto init + first sync + m.direct processing can exceed the
  // default 30s per-test budget, so give these login-heavy tests headroom plus one
  // retry for the rare tail. Scoped to this describe — no effect on other specs.
  test.describe.configure({ timeout: 60_000, retries: 1 });

  // Seed once for the whole file (shared account, same as navigation/settings
  // specs) — every test below just needs *a* room to tap.
  test.beforeAll(async () => {
    const { token, userId } = await apiLogin(
      session.hs as string,
      session.user as string,
      session.pass as string,
    );
    await seedRoom(session.hs as string, token, userId, ROOM_NAME);
  });

  test.beforeEach(async ({ page }) => {
    await login(page, session);
  });

  test('the hamburger is the mobile affordance and opens the closed drawer', async ({
    page,
  }) => {
    const channel = page.locator('button.channel', { hasText: ROOM_NAME });
    await channel.first().waitFor({ state: 'attached', timeout: 30_000 });

    // `data-testid="open-menu"` carries `md:hidden` on the button — only visible
    // below the `md` breakpoint.
    await expect(page.getByTestId('open-menu')).toBeVisible();

    // Closed by default: `<aside class="shell-side">` renders `-translate-x-full`
    // (drawerOpen() starts false, so no `translate-x-0` override), which
    // translates it fully off the left edge of the 390px viewport.
    //
    // `toBeVisible()` would NOT catch this: a transformed-off-screen element
    // still has a non-zero bounding box and no `visibility:hidden`/
    // `display:none`, so Playwright's actionability visibility check reports it
    // as "visible" either way. `toBeInViewport()` instead uses the browser's real
    // IntersectionObserver, which *does* reflect the rendered (post-transform)
    // position — the correct tool for a CSS-transform drawer. Checked on both the
    // aside itself and the channel row inside it, so this also stands in for
    // "the row isn't a clickable target while the drawer is closed".
    await expect(shellSide(page)).not.toBeInViewport();
    await expect(channel.first()).not.toBeInViewport();

    await page.getByTestId('open-menu').click();

    // Open: the drawer slides to translate-x-0 and its channel row is now a
    // real, on-screen (and therefore actionable) target.
    await expect(shellSide(page)).toBeInViewport();
    await expect(channel.first()).toBeInViewport();
  });

  test('picking a room selects it and closes the drawer again', async ({
    page,
  }) => {
    const channel = page.locator('button.channel', { hasText: ROOM_NAME });
    await channel.first().waitFor({ state: 'attached', timeout: 30_000 });

    await page.getByTestId('open-menu').click();
    await expect(shellSide(page)).toBeInViewport();

    await channel.first().click();

    // onSelectRoom() calls closeDrawer() — the aside slides back off-screen —
    // and the picked room becomes the active room in the toolbar heading.
    await expect(shellSide(page)).not.toBeInViewport();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      ROOM_NAME,
    );
  });

  test('tapping the backdrop closes the drawer without selecting a room', async ({
    page,
  }) => {
    const channel = page.locator('button.channel', { hasText: ROOM_NAME });
    await channel.first().waitFor({ state: 'attached', timeout: 30_000 });

    await page.getByTestId('open-menu').click();
    await expect(shellSide(page)).toBeInViewport();

    // The backdrop (`data-testid="drawer-backdrop"`) covers the *whole* viewport
    // (`inset-0`) while the drawer is open, but the 352px-wide aside sits above it
    // (z-40 vs z-30) over the left portion. Click well to the right of the
    // aside's width (x=371 of the 390px viewport) so the hit-test actually lands
    // on the backdrop, not the drawer itself — tapping it (not a room) must close
    // the drawer and leave Home (no active room) untouched.
    await page
      .getByTestId('drawer-backdrop')
      .click({ position: { x: 371, y: 400 } });

    await expect(shellSide(page)).not.toBeInViewport();
    await expect(page.getByText('Trinity', { exact: true })).toBeVisible();
  });
});
