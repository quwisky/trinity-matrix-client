import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  devices,
  type APIRequestContext,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the sidebar's touch affordances, which no other spec can see: every other
// authenticated spec runs the desktop Chromium project, where `hover: hover` and
// `pointer: fine` hold and the room row's ⋮ is revealed by :hover.
//
// This exists because a refactor broke exactly this and shipped green. Extracting the room
// list into SidebarRoomListComponent moved `.channel__menu` into a child component but left
// `@media (hover: none) { .channel__menu { opacity: 1 } }` in the PARENT stylesheet. Under
// Angular's emulated encapsulation a rule is attributed to its own component's elements, so
// the parent's copy silently matched nothing and every room's ⋮ rendered fully transparent
// on phones and tablets — invisible, though still hit-testable. Unit tests click
// `.channel__menu` directly and never consult a media query, so nothing caught it.
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

// A mobile descriptor, which is what makes Chromium report `hover: none` and
// `pointer: coarse` — the two media features the rules under test key off.
test.use({ ...devices['Pixel 5'] });

test.describe('Sidebar on a touch device', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('reveals each room’s ⋮ and gives it a 44px target', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}t`;
    const user = `touch-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Touch ${runId}`;

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
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);

    // Confirm the emulation actually took, or every assertion below would be about the
    // desktop rules and the spec would pass while proving nothing.
    const coarse = await page.evaluate(() => ({
      noHover: matchMedia('(hover: none)').matches,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
    }));
    expect(coarse).toEqual({ noHover: true, coarsePointer: true });

    await page.getByTestId('rail-rooms').click();
    const row = page.locator('.channel-row', {
      has: page.locator('.channel', { hasText: roomName }),
    });
    await row.first().waitFor({ state: 'visible', timeout: 30_000 });

    const kebab = row.first().locator('.channel__menu');
    // Visible without any hover — there is no hover on this device to give.
    //
    // Polled, not read once. The row is visible as soon as it is laid out, but the ⋮ is
    // revealed through opacity, so a single getComputedStyle can sample the reveal
    // mid-transition and read something like 0.4. That is what made this spec flaky in
    // CI: it failed on the first attempt and passed on the retry, which looks like a
    // product bug and is really a missing wait.
    await expect
      .poll(
        () => kebab.evaluate((el) => Number(getComputedStyle(el).opacity)),
        { timeout: 10_000 },
      )
      .toBe(1);

    // And large enough to hit: the coarse-pointer bump has to reach it too. Measured
    // only once the opacity above has settled, so the box is its final one.
    const box = await kebab.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    // It really opens the menu — an opacity check alone would not prove the row is usable.
    await kebab.click();
    await expect(page.getByTestId('room-low-priority')).toBeVisible({
      timeout: 10_000,
    });
  });
});
