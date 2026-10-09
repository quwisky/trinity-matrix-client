import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

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
const session = homeserverSession();

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
    const runId = `${testResourceId('run')}s`;
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

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);

    // Ctrl/Cmd+F lands in the header field; typing there opens the panel with the same
    // query and leaves the caret where it was.
    const headerField = page.getByTestId('header-search');
    await page.keyboard.press('ControlOrMeta+f');
    await expect(headerField).toBeFocused({ timeout: 10_000 });
    await page.keyboard.type('hello');

    const query = page.getByPlaceholder('Search this conversation');
    await expect(query).toBeVisible({ timeout: 15_000 });
    await expect(query).toHaveValue('hello');
    await expect(headerField).toBeFocused();

    // Escape clears the field and takes focus out of it.
    await page.keyboard.press('Escape');
    await expect(headerField).toHaveValue('');
    await expect(headerField).not.toBeFocused();
  });

  test('below the members breakpoint search opens in the panel field', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}n`;
    const user = `search-narrow-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Search narrow ${runId}`;

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

    await page.setViewportSize({ width: 900, height: 700 });
    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openRoom(page, roomName);

    // Ctrl/Cmd+F opens the search panel and lands in its own field.
    await page.keyboard.press('ControlOrMeta+f');
    const query = page.getByPlaceholder('Search this conversation');
    await expect(query).toBeFocused({ timeout: 10_000 });
    await page.keyboard.type('hello');
    await expect(query).toHaveValue('hello');

    // Closing keeps the query; reopening from the icon still focuses the panel field.
    await page.keyboard.press('Escape');
    await expect(query).toBeHidden();
    await page.getByTestId('search-messages').click();
    await expect(query).toHaveValue('hello');
    await expect(query).toBeFocused({ timeout: 10_000 });
  });
});
