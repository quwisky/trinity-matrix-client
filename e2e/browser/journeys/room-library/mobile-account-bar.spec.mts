import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { createRoom } from '../../support/space-journey.mts';

// The account bar floats over the server rail and room list on phones as it does on desktop
// (#1863 follow-up). CSS is invisible to jsdom, so this reads the real boxes: the last space
// and the last room scroll clear of the bar, the bar spans the rail and the list with a margin
// each side, nothing scrolls sideways, and a room opened from the list has no bar.
//
// Needs a homeserver (Docker or native) and self-skips otherwise.
const session = homeserverSession();
const SPACES = 13;
const ROOMS = 18;

async function seedAccount(
  page: Page,
  request: Parameters<typeof registerUser>[0],
): Promise<void> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}b`;
  const user = `bar-${runId}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const accessToken = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json())
    .then((j) => j.access_token as string);
  await Promise.all([
    ...Array.from({ length: SPACES }, (_, i) =>
      createRoom(request, hs, { accessToken }, `Space ${runId} ${i}`, {
        space: true,
      }),
    ),
    ...Array.from({ length: ROOMS }, (_, i) =>
      createRoom(request, hs, { accessToken }, `Room ${runId} ${i}`),
    ),
  ]);
  await login(page, { available: true, hs, user, pass });
  await page.getByTestId('rail-rooms').click();
  await expect(page.locator('.sidebar__scroll .channel').first()).toBeVisible({
    timeout: 60_000,
  });
}

async function expectBarClearsEverything(page: Page): Promise<void> {
  const geometry = await page.evaluate(async () => {
    const q = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`missing ${selector}`);
      return element;
    };
    const rail = q('.rail-scroll');
    const rooms = q('.sidebar__scroll');
    // The room list is windowed, so scroll until the end is real.
    for (let i = 0; i < 6; i++) {
      rail.scrollTop = rail.scrollHeight;
      rooms.scrollTop = rooms.scrollHeight;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const atEnd = (e: HTMLElement) =>
      e.scrollTop + e.clientHeight >= e.scrollHeight - 1;
    const bar = q('.userbar').getBoundingClientRect();
    const shell = q('.shell-side').getBoundingClientRect();
    const bottomOf = (e: Element | null) =>
      (e as HTMLElement).getBoundingClientRect().bottom;
    const host = q('trn-sidebar-user-panel');
    // The real final items, with each scroller proven to sit at its end.
    const lastIcon = rail.lastElementChild;
    const lastRoom = rooms.lastElementChild;
    const bottomClearance = (safe: string) => {
      q('.shell-side').style.setProperty(
        '--trinity-navigation-safe-area-bottom',
        safe,
      );
      return {
        distance:
          window.innerHeight - q('.userbar').getBoundingClientRect().bottom,
        space3: parseFloat(getComputedStyle(host).insetInlineStart),
      };
    };
    const edges = {
      lastIconBottom: bottomOf(lastIcon),
      lastRoomBottom: bottomOf(lastRoom),
      railRight: q('.rail').getBoundingClientRect().right,
      roomLeft: q('.sidebar').getBoundingClientRect().left,
    };
    const state = {
      railOverflows: rail.scrollHeight > rail.clientHeight,
      roomsOverflow: rooms.scrollHeight > rooms.clientHeight,
      railAtEnd: atEnd(rail),
      roomsAtEnd: atEnd(rooms),
      sideways: [rail, rooms, document.documentElement].map(
        (e) => e.scrollWidth - e.clientWidth,
      ),
    };
    const forced = bottomClearance('34px');
    return {
      bar: {
        left: bar.left,
        right: bar.right,
        top: bar.top,
        bottom: bar.bottom,
      },
      shell: { left: shell.left, right: shell.right, bottom: shell.bottom },
      ...edges,
      ...state,
      position: getComputedStyle(host).position,
      forced,
    };
  });
  expect(geometry.position).toBe('absolute');
  expect({
    railOverflows: geometry.railOverflows,
    roomsOverflow: geometry.roomsOverflow,
    railAtEnd: geometry.railAtEnd,
    roomsAtEnd: geometry.roomsAtEnd,
  }).toEqual({
    railOverflows: true,
    roomsOverflow: true,
    railAtEnd: true,
    roomsAtEnd: true,
  });
  expect(geometry.lastIconBottom).toBeLessThanOrEqual(geometry.bar.top - 1);
  expect(geometry.lastRoomBottom).toBeLessThanOrEqual(geometry.bar.top - 1);
  expect(geometry.bar.left - geometry.shell.left).toBeGreaterThanOrEqual(8);
  expect(geometry.shell.right - geometry.bar.right).toBeGreaterThanOrEqual(8);
  expect(geometry.bar.left).toBeLessThan(geometry.railRight);
  expect(geometry.bar.right).toBeGreaterThan(geometry.roomLeft);
  expect(geometry.shell.bottom - geometry.bar.bottom).toBeGreaterThanOrEqual(8);
  // The safe area is counted once: card bottom to viewport bottom is the safe area plus space-3.
  expect(geometry.forced.distance).toBe(34 + geometry.forced.space3);
  expect(geometry.sideways).toEqual([0, 0, 0]);
}

test.describe('Account bar on a phone', () => {
  test.skip(!session.available, 'needs a homeserver');
  test.describe.configure({ timeout: 180_000 });

  test('floats over the rail and the room list at 390x844', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedAccount(page, request);
    await expectBarClearsEverything(page);

    await page.locator('.sidebar__scroll .channel').first().click();
    await expect(page.getByTestId('back-to-rooms')).toBeVisible();
    await expect(page.locator('.userbar')).toBeHidden();
  });

  test('keeps the same geometry on desktop', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedAccount(page, request);
    await expectBarClearsEverything(page);
  });
});
