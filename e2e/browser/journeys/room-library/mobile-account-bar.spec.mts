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
const SPACES = 16;
const ROOMS = 30;

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
  for (let i = 0; i < SPACES; i++) {
    await createRoom(request, hs, { accessToken }, `Space ${runId} ${i}`, {
      space: true,
    });
  }
  for (let i = 0; i < ROOMS; i++) {
    await createRoom(request, hs, { accessToken }, `Room ${runId} ${i}`);
  }
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
    // The windowed list renders a slice, so scroll until the end is real.
    for (let i = 0; i < 6; i++) {
      rail.scrollTop = rail.scrollHeight;
      rooms.scrollTop = rooms.scrollHeight;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const bar = q('.userbar').getBoundingClientRect();
    const shell = q('.shell-side').getBoundingClientRect();
    const lastSpace = rail.lastElementChild as HTMLElement;
    const lastRoom = rooms.querySelector<HTMLElement>(
      '.channel-row:last-of-type, .channel:last-of-type',
    );
    const rows = [...rooms.querySelectorAll<HTMLElement>('.channel')];
    const lastRow = rows[rows.length - 1] ?? lastRoom;
    // The rail's final child is the add button, so test the last real space as well.
    const spaces = [...rail.querySelectorAll<HTMLElement>('button, a')];
    const lastIcon = spaces[spaces.length - 1] ?? lastSpace;
    const doc = document.documentElement;
    return {
      bar: {
        left: bar.left,
        right: bar.right,
        top: bar.top,
        bottom: bar.bottom,
      },
      shell: { left: shell.left, right: shell.right, bottom: shell.bottom },
      railRight: q('.rail').getBoundingClientRect().right,
      roomLeft: q('.sidebar').getBoundingClientRect().left,
      lastIconBottom: lastIcon.getBoundingClientRect().bottom,
      lastRoomBottom: lastRow.getBoundingClientRect().bottom,
      position: getComputedStyle(q('trn-sidebar-user-panel')).position,
      sideways: [rail, rooms, doc].map((e) => e.scrollWidth - e.clientWidth),
      viewport: window.innerWidth,
    };
  });
  expect(geometry.position).toBe('absolute');
  expect(geometry.lastIconBottom).toBeLessThanOrEqual(geometry.bar.top - 1);
  expect(geometry.lastRoomBottom).toBeLessThanOrEqual(geometry.bar.top - 1);
  expect(geometry.bar.left - geometry.shell.left).toBeGreaterThanOrEqual(8);
  expect(geometry.shell.right - geometry.bar.right).toBeGreaterThanOrEqual(8);
  expect(geometry.bar.left).toBeLessThan(geometry.railRight);
  expect(geometry.bar.right).toBeGreaterThan(geometry.roomLeft);
  expect(geometry.shell.bottom - geometry.bar.bottom).toBeGreaterThanOrEqual(8);
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
});
