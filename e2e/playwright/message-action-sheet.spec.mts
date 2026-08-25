import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// The message action sheet (#220), which no other spec can see. Every authenticated spec
// runs the desktop Chromium project, where a message's actions are a bar revealed by
// :hover — a surface that on a phone covered the message it acted on, closed on any
// scroll, and opened its reaction picker off the top of the scroller.
//
// `devices['Pixel 5']` and not merely `hasTouch`: the branch is chosen by `isMobileOs()`,
// which reads the PLATFORM. A touch-emulated desktop Chromium keeps its desktop user agent
// and would take the desktop path, so a spec written on the `composer-formatting.spec.mts`
// phone pattern would silently assert nothing.
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

/** Press and hold past the 500ms threshold, the way a finger does. */
async function longPress(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`no box for ${selector}`);
  }
  await page.dispatchEvent(selector, 'pointerdown', {
    isPrimary: true,
    pointerType: 'touch',
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  await page.waitForTimeout(700);
}

/** A room with one message, opened, with that row's selector handed back. */
async function openRoomWithMessage(
  page: Page,
  request: APIRequestContext,
  tag: string,
): Promise<string> {
  const hs = session.hs as string;
  const runId = `${Date.now().toString(36)}${tag}`;
  const user = `sheet-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Sheet ${runId}`;

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
  const headers = { Authorization: `Bearer ${access_token}` };
  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json());
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/s-${runId}`,
    { headers, data: { msgtype: 'm.text', body: `act on me ${runId}` } },
  );

  await login(page, { available: true, hs, user, pass } as SynapseSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });

  const row = page.locator('.msg[data-mid]').last();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  return `.msg[data-mid="${await row.getAttribute('data-mid')}"]`;
}

test.use({ ...devices['Pixel 5'] });

test.describe('Message actions on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 90_000 });

  test('a long press opens a sheet, and picking Reply starts a reply', async ({
    page,
    request,
  }) => {
    const rowSel = await openRoomWithMessage(page, request, 'a');

    await longPress(page, rowSel);

    // The sheet, and NOT the hover bar. A revealed toolbar is `opacity: 1` on the row, and
    // a hidden one is `opacity: 0` — which Playwright still reports as visible, so the
    // class is what has to be asserted.
    const sheet = page.locator('trn-action-sheet');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`${rowSel}.msg--revealed`)).toHaveCount(0);

    // It is a named dialog, not a bare one.
    await expect(
      page.locator('[role=dialog][aria-label="Message actions"]'),
    ).toHaveCount(1);

    // Every row is reachable: the list scrolls inside the sheet rather than being clipped
    // by the viewport, which is what it did before it had a max-height and a scroller.
    const sheetBox = await sheet.boundingBox();
    const cancel = sheet.getByText('Cancel');
    const cancelBox = await cancel.boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(cancelBox).not.toBeNull();
    expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(
      (page.viewportSize()?.height ?? 0) + 1,
    );

    // And it does the thing. Reply is the cheapest action to observe end to end.
    await page.getByTestId('sheet-reply').click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      {
        timeout: 10_000,
      },
    );
  });

  test('reacting from the sheet puts the reaction on the message', async ({
    page,
    request,
  }) => {
    // The quick strip exists because reacting is the highest-frequency message action and
    // six full-width text rows would push everything else off the screen. It is also the
    // one part of the sheet that is not a plain button row, so it gets its own check.
    const rowSel = await openRoomWithMessage(page, request, 'b');
    await longPress(page, rowSel);
    await expect(page.locator('trn-action-sheet')).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('[data-testid^="sheet-react-"]').first().click();

    await expect(page.locator('trn-action-sheet')).toHaveCount(0);
    await expect(page.locator(`${rowSel} trn-message-reactions`)).toContainText(
      '👍',
      { timeout: 15_000 },
    );
  });

  test('tapping outside closes the sheet without acting', async ({
    page,
    request,
  }) => {
    // The backdrop is the way out on a phone — there is no Escape key and no hover to
    // move away. Nothing must fire on the way.
    const rowSel = await openRoomWithMessage(page, request, 'c');
    await longPress(page, rowSel);
    const sheet = page.locator('trn-action-sheet');
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    await page
      .locator('.cdk-overlay-backdrop')
      .click({ position: { x: 5, y: 5 } });

    await expect(sheet).toHaveCount(0);
    // No reply started, no reaction added — dismissing is not choosing.
    await expect(page.locator('.composer__banner')).toHaveCount(0);
  });
});
