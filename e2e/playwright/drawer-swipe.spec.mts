import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// The drawer gesture, on the only kind of device that has one.
//
// Below the `members` breakpoint the shell's right-hand slot is a fixed overlay; above it the
// slot is a column sharing the row and there is nothing to swipe. Every other authenticated
// spec runs the desktop project, where the drawer does not exist and `pointerType` is `mouse`
// — which the directive ignores on purpose, since a mouse has the toolbar button.
//
// The unit spec pins the arithmetic against synthetic events. What only a real device profile
// can show is whether the gesture is REACHABLE: whether the browser hands us the horizontal
// moves at all, or consumes them as a scroll. That is what `touch-action: pan-y` on the chat
// body is for, and it is invisible to jsdom.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
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
  await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
}

/** A touch drag, delivered as several moves so the directive sees the gesture. */
async function swipe(page: Page, fromX: number, toX: number, y: number) {
  await page.dispatchEvent('.chat-body', 'pointerdown', {
    clientX: fromX,
    clientY: y,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
  });
  for (const x of [fromX + (toX - fromX) / 2, toX]) {
    await page.dispatchEvent('.chat-body', 'pointermove', {
      clientX: x,
      clientY: y,
      pointerType: 'touch',
      pointerId: 1,
      isPrimary: true,
    });
  }
  await page.dispatchEvent('.chat-body', 'pointerup', {
    clientX: toX,
    clientY: y,
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
  });
}

test.use({ ...devices['Pixel 5'] });

test.describe('Drawer swipe on a touch device', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('swipes the member list open from the right edge, and swipes it away', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sw`;
    const user = `swipe-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Swipe ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    const members = page.locator('.chat-members');
    // A phone seeds the slot closed — the drawer must not render open on a mobile load.
    await expect(members).toBeHidden();

    const size = page.viewportSize()!;
    const y = Math.round(size.height / 2);

    // In from the right edge, past the commit threshold.
    await swipe(page, size.width - 4, Math.round(size.width * 0.3), y);
    await expect(members).toBeVisible({ timeout: 10_000 });

    // And away again, from anywhere on the drawer.
    await swipe(page, Math.round(size.width * 0.4), size.width - 4, y);
    await expect(members).toBeHidden({ timeout: 10_000 });
  });

  test('leaves the drawer alone for a swipe that starts away from the edge', async ({
    page,
    request,
  }) => {
    // Otherwise every leftward flick over the timeline would summon the roster, and the
    // timeline is the surface people swipe over most.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}nw`;
    const user = `noswipe-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `NoSwipe ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    const size = page.viewportSize()!;
    await swipe(
      page,
      Math.round(size.width / 2),
      20,
      Math.round(size.height / 2),
    );

    await expect(page.locator('.chat-members')).toBeHidden();
  });
});
