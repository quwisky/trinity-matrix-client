import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Both search dialogs must open ready to type: the quick switcher (Ctrl/Cmd+K, from the
// sidebar's ⌘ button) and in-room message search (the room header's magnifier). Each
// test types WITHOUT clicking into the field first — that is the whole acceptance, and
// the only layer that can prove it, since jsdom can't run CDK's real focus pass.
//
// Regression for issue #11: the dialogs name their input with `data-autofocus` and their
// services pass it as the CDK dialog's `autoFocus` selector. A component-side `focus()`
// cannot do this job — CDK focuses after attach and took the header's dismiss button,
// the first tabbable element in both templates.
//
// Needs a Synapse homeserver (Docker); self-skips otherwise.
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

test.describe('Search dialogs', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('the quick switcher opens with its search field focused', async ({
    page,
  }) => {
    await login(page, session);

    await page.getByTestId('open-switcher').click();

    const search = page.getByPlaceholder('Search rooms, spaces, people');
    await expect(search).toBeVisible({ timeout: 15_000 });
    await expect(search).toBeFocused({ timeout: 10_000 });

    // No click into the field — the keystrokes just arrive.
    await page.keyboard.type('trinity');
    await expect(search).toHaveValue('trinity');
  });

  test('in-room search opens with its query field focused', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}s`;
    const user = `search-focus-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Search focus ${runId}`;

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

    await page.getByTestId('search-messages').click();

    const query = page.getByPlaceholder('Search this conversation');
    await expect(query).toBeVisible({ timeout: 15_000 });
    await expect(query).toBeFocused({ timeout: 10_000 });

    await page.keyboard.type('hello');
    await expect(query).toHaveValue('hello');
  });
});
