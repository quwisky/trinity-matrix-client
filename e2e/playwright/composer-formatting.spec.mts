import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the composer's formatting affordances (issue #29, second half): the toolbar, the
// rebindable chords behind it, markdown-aware Shift+Enter, and the preview toggle.
//
// These assert on the TEXTAREA's value rather than on a sent message — the point is what the
// composer does to what you are writing. Needs a Synapse homeserver (Docker); self-skips
// otherwise.
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

/** Register, create a room, sign in and open it. Returns the composer locator. */
async function openComposer(
  page: Page,
  request: APIRequestContext,
  tag: string,
) {
  const hs = session.hs as string;
  const runId = `${Date.now().toString(36)}${tag}`;
  const user = `fmt-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Format ${runId}`;

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
  /** Open the seeded room from the rail, returning the composer once it is up. */
  const openRoom = async () => {
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    const input = page.getByTestId('composer-input');
    await expect(input).toBeVisible({ timeout: 15_000 });
    return input;
  };
  return { composer: await openRoom(), openRoom };
}

/** Select `word` inside the composer, the way a user dragging over it would. */
async function selectWord(page: Page, word: string): Promise<void> {
  await page.getByTestId('composer-input').evaluate((el, target) => {
    const input = el as HTMLTextAreaElement;
    const at = input.value.indexOf(target);
    input.focus();
    input.setSelectionRange(at, at + target.length);
  }, word);
}

test.describe('Composer formatting', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a toolbar button wraps the selected word', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'tb');

    await composer.fill('say hello there');
    await selectWord(page, 'hello');
    await page.getByTestId('format-bold').click();

    await expect(composer).toHaveValue('say **hello** there');
  });

  test('the overflow carries the actions the toolbar does not show', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'ov');

    await composer.fill('one');
    await selectWord(page, 'one');
    await page.getByTestId('format-more').click();
    await page.getByTestId('format-quote').click();

    await expect(composer).toHaveValue('> one');
  });

  test('a keyboard chord formats, and the rebound one takes over', async ({
    page,
    request,
  }) => {
    const { composer, openRoom } = await openComposer(page, request, 'kb');

    await composer.fill('say hello there');
    await selectWord(page, 'hello');
    // CI is Linux, so Control — the same assumption keyboard-shortcuts-settings makes.
    await page.keyboard.press('Control+b');
    await expect(composer).toHaveValue('say **hello** there');

    // Rebind bold, in the Formatting group the settings list now renders.
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-shortcuts').click();
    await expect(page.getByTestId('shortcut-group-formatting')).toBeVisible();
    await page.getByTestId('shortcut-edit-format.bold').click();
    await page.keyboard.press('Control+Shift+B');
    await expect(page.getByTestId('shortcut-format.bold')).toContainText(
      'Shift',
    );

    // Back in the room the NEW chord formats and the old one no longer does — which is the
    // whole point of the binding being data rather than a template string. Settings is a
    // full-page route, so leave it before looking for the rail.
    await page.goto('/rooms');
    const back = await openRoom();
    await back.fill('say hello there');
    await selectWord(page, 'hello');
    await page.keyboard.press('Control+b');
    await expect(back).toHaveValue('say hello there');

    await page.keyboard.press('Control+Shift+B');
    await expect(back).toHaveValue('say **hello** there');
  });

  test('Shift+Enter continues a list and a second one ends it', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'ls');

    await composer.click();
    await composer.pressSequentially('- one');
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue('- one\n- ');

    await composer.pressSequentially('two');
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue('- one\n- two\n- ');

    // A second Shift+Enter on the now-empty item ends the list rather than adding another.
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue('- one\n- two\n');
  });

  test('the preview shows what will be sent, and toggling back keeps the draft', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'pv');

    await composer.fill('**bold** and `code`');
    await page.getByTestId('composer-preview-toggle').click();

    const preview = page.getByTestId('composer-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('strong')).toHaveText('bold');
    await expect(preview.locator('code')).toHaveText('code');
    await expect(composer).toBeHidden();

    await page.getByTestId('composer-preview-toggle').click();
    await expect(preview).toBeHidden();
    await expect(composer).toHaveValue('**bold** and `code`');
  });

  test('the preview conceals a spoiler, as the recipient will see it', async ({
    page,
    request,
  }) => {
    // /spoiler sends a concealed span rather than the literal text, so previewing the text
    // would be a lie in exactly the case the preview is most useful.
    const { composer } = await openComposer(page, request, 'sp');

    await composer.fill('/spoiler the butler did it');
    await page.getByTestId('composer-preview-toggle').click();

    const spoiler = page.getByTestId('composer-preview').locator('.mx-spoiler');
    await expect(spoiler).toHaveText('the butler did it');
    await expect(spoiler).not.toHaveClass(/is-revealed/);

    await spoiler.click();
    await expect(spoiler).toHaveClass(/is-revealed/);
  });

  test('sending while previewing returns to a usable input', async ({
    page,
    request,
  }) => {
    // The regression this pins: submit left `previewing` on, so the composer sat showing a
    // stale preview of a message that had already gone, with the textarea hidden underneath —
    // an apparently dead composer that swallowed every keystroke.
    const { composer } = await openComposer(page, request, 'ps');

    await composer.fill('**shipped**');
    await page.getByTestId('composer-preview-toggle').click();
    await expect(page.getByTestId('composer-preview')).toBeVisible();

    await page.getByTestId('composer-send').click();

    await expect(page.getByTestId('composer-preview')).toBeHidden();
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue('');

    // Height, not just visibility: `autoGrow` used to re-measure the textarea from a
    // microtask, which in a zoneless app runs before the preview is actually taken off it —
    // so it measured `scrollHeight: 0` and pinned `height: 0px`. `toBeVisible()` passes on
    // that, because `box-sizing: border-box` leaves the padding and border behind.
    const height = await composer.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(height).toBeGreaterThan(20);

    await composer.fill('still typing');
    await expect(composer).toHaveValue('still typing');
  });
});
