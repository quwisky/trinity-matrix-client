import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers "leave a room": each room row's kebab (`.channel__menu`) opens a Helm
// dropdown-menu (CDK overlay) with a destructive "Leave room" item
// (`data-testid="room-leave"`). Picking it confirms via TrnAlertService
// (`data-testid="alert-confirm"`) and calls RoomsService.leave → client.leave,
// after which the room drops out of the joined room list (RoomsService filters
// to `getMyMembership() === 'join'` and refreshes on RoomEvent.MyMembership).
//
// Seeds one reader with two plain rooms so leaving one leaves a non-empty list
// to assert against. Needs a Synapse homeserver (Docker) and self-skips
// otherwise, like the other authenticated web e2e specs.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const nonceRes = await request.get(
    `${SYNAPSE_HTTP}/_synapse/admin/v1/register`,
  );
  const { nonce } = await nonceRes.json();
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

async function seedTwoRooms(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; leaveName: string; keepName: string }> {
  const readerUser = `leaver-${runId}`;
  const readerPass = `leaver-pass-${runId}`;
  const leaveName = `Leave Me ${runId}`;
  const keepName = `Keep Me ${runId}`;

  await registerUser(request, readerUser, readerPass);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: readerUser },
        password: readerPass,
      },
    })
    .then((r) => r.json());

  for (const name of [leaveName, keepName]) {
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { name, preset: 'private_chat' },
    });
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    leaveName,
    keepName,
  };
}

// Open a room row's kebab menu (hover-revealed on the row, opened into a CDK
// overlay at page root), scoped to THAT row so multiple rows can't be confused.
async function openRoomMenu(page: Page, roomName: string): Promise<void> {
  const row = page.locator('.channel-row', {
    has: page.locator('.channel', { hasText: roomName }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 30_000 });
  await row.first().hover();
  await row.first().locator('.channel__menu').click();
  await page
    .getByTestId('room-leave')
    .waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('Leave a room', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('leaving a room removes it from the list while others stay', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}l`;

    const { reader, leaveName, keepName } = await seedTwoRooms(
      request,
      hs,
      runId,
    );

    await login(page, reader);
    await page.getByTestId('rail-rooms').click();

    const leaveRow = page.locator('.channel', { hasText: leaveName });
    const keepRow = page.locator('.channel', { hasText: keepName });
    await leaveRow.first().waitFor({ state: 'visible', timeout: 30_000 });
    await keepRow.first().waitFor({ state: 'visible', timeout: 30_000 });

    // Leave the first room via its kebab → "Leave room" → confirm.
    await openRoomMenu(page, leaveName);
    await page.getByTestId('room-leave').click();
    await page.getByTestId('alert-confirm').click();

    // The left room drops out of the list (leave round-trips through
    // client.leave + the MyMembership-driven refresh); the other room stays.
    await expect(leaveRow).toHaveCount(0, { timeout: 30_000 });
    await expect(keepRow.first()).toBeVisible();
  });
});

/**
 * The destructive menu item has to stay legible, and legible WHEREVER it is placed.
 *
 * Helm paints `bg-destructive/10..30` under its own destructive text, which is translucent
 * and therefore takes the surface beneath it — so the same control measured 5.37:1 over a
 * card and 4.28:1 at rest over the rail, under AA. The tint is pinned opaque against that
 * (`--trinity-danger-tint`), and the property worth guarding is not "above 4.5 here" but
 * "the same everywhere": a ratio that moves with placement is the bug coming back.
 */
test.describe('Destructive menu item contrast', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('reads the same on any surface, in both modes', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}dc`;
    const { reader, leaveName } = await seedTwoRooms(request, hs, runId);
    await login(page, reader);
    await openRoomMenu(page, leaveName);

    /** Composited contrast of an element's label, resolved by the page's own canvas. */
    const contrastOf = (testId: string) =>
      page.getByTestId(testId).evaluate((el) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          throw new Error('no 2d context');
        }
        const paint = (colour: string) => {
          ctx.fillStyle = colour;
          ctx.fillRect(0, 0, 1, 1);
        };
        const pixel = () => {
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return { r, g, b, a };
        };
        const opaque = (colour: string) => {
          ctx.clearRect(0, 0, 1, 1);
          paint(colour);
          return pixel().a === 255;
        };
        const stack: string[] = [];
        let node: HTMLElement | null = el.parentElement;
        let base: string | null = null;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (opaque(bg)) {
            base = bg;
            break;
          }
          stack.unshift(bg);
          node = node.parentElement;
        }
        if (base === null) {
          throw new Error('no opaque ancestor');
        }
        ctx.clearRect(0, 0, 1, 1);
        for (const layer of [
          base,
          ...stack,
          getComputedStyle(el).backgroundColor,
        ]) {
          paint(layer);
        }
        const bg = pixel();
        paint(getComputedStyle(el).color);
        const text = pixel();
        const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
          const ch = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
        };
        const [hi, lo] = [lum(text), lum(bg)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      });

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains('dark'),
          ),
        )
        .toBe(scheme === 'dark');

      const rest = await contrastOf('room-leave');
      expect(
        rest,
        `${scheme}: destructive item at rest`,
      ).toBeGreaterThanOrEqual(4.5);

      await page.getByTestId('room-leave').hover();

      // The assertion that can actually regress, and it belongs on the HOVERED state: a
      // menu item paints no tint at rest, so the text sits straight on --popover there.
      // This item is on --popover either way, where the translucent tint always passed — a
      // ratio alone would have stayed green through the entire bug. What was wrong is that
      // the tint took its surface AT ALL, and opacity states that directly: revert to
      // `bg-destructive/10` and the alpha here drops below 1.
      const alpha = await page
        .getByTestId('room-leave')
        .evaluate(
          (el) =>
            (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? [])[3] ??
            '1',
        );
      expect(Number(alpha), `${scheme}: the hover tint must be opaque`).toBe(1);

      const hovered = await contrastOf('room-leave');
      expect(
        hovered,
        `${scheme}: destructive item hovered`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
