import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the message "View source" context action (msg-more → msg-view-source): a dialog
// (data-testid="message-source") shows the event's raw JSON. Needs Synapse (Docker).
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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Message source', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows an event’s raw JSON in the view-source dialog', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}src`;
    const user = `src-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Source ${runId}`;
    const body = `inspect me ${runId}`;

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
    await openRoom(page, roomName);

    const composer = page.getByTestId('composer-input');
    await composer.fill(body);
    await composer.press('Enter');
    const row = page.locator('.scroll .msg', { hasText: body });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });

    // Open the overflow menu → View source.
    await row.first().hover();
    await row.first().getByTestId('msg-more').click();
    await page.getByTestId('msg-view-source').click();

    // The dialog shows the raw event JSON — the event type and the message body.
    const dialog = page.getByTestId('message-source');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const json = dialog.getByTestId('message-source-json');
    await expect(json).toContainText('m.room.message');
    await expect(json).toContainText(body);

    // ...on a surface of its own. A CDK overlay is a bare positioned box, so a dialog
    // that doesn't paint a card renders transparent and its JSON is drawn straight over
    // the conversation behind it. Only a real browser computes this: jsdom has no paint,
    // so the unit spec can assert the classes but never their effect.
    const surface = await dialog.evaluate((el) => {
      const style = getComputedStyle(el);
      // Chromium reports `rgb(r, g, b)` when fully opaque and `rgba(r, g, b, a)`
      // otherwise — an unpainted element is `rgba(0, 0, 0, 0)`. Read the alpha only
      // when there is a fourth channel; otherwise the blue channel would pose as one.
      const channels = style.backgroundColor.match(/[\d.]+/g) ?? [];
      return {
        backgroundColor: style.backgroundColor,
        opaque: channels.length === 4 ? Number(channels[3]) === 1 : true,
        hasBorder: parseFloat(style.borderTopWidth) > 0,
        hasShadow: style.boxShadow !== 'none',
      };
    });
    expect(surface.opaque, `background was ${surface.backgroundColor}`).toBe(
      true,
    );
    expect(surface.hasBorder).toBe(true);
    expect(surface.hasShadow).toBe(true);
  });
});
