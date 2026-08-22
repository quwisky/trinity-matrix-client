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

  test('hiding the toolbar in settings keeps the shortcuts working', async ({
    page,
    request,
  }) => {
    // The setting takes away the ROW, not the capability — so the assertion that matters is
    // that Ctrl+B still formats once the buttons are gone.
    const { composer, openRoom } = await openComposer(page, request, 'ht');

    await expect(page.getByTestId('format-bold')).toBeVisible();

    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-appearance').click();
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    const toolbarToggle = page
      .getByTestId('composer-show-toolbar')
      .locator('trn-checkbox');
    await expect(toolbarToggle).toBeVisible({ timeout: 15_000 });
    await toolbarToggle.click();

    // Settings is a full-page route, so leave it before looking for the rail.
    await page.goto('/rooms');
    const back = await openRoom();

    await expect(page.getByTestId('format-bold')).toHaveCount(0);
    await expect(page.getByTestId('format-more')).toHaveCount(0);
    // The preview toggle lives on the toolbar and goes with it.
    await expect(page.getByTestId('composer-preview-toggle')).toHaveCount(0);

    await back.fill('say hello there');
    await selectWord(page, 'hello');
    await page.keyboard.press('Control+b');
    await expect(back).toHaveValue('say **hello** there');

    // Shift+Enter still continues a list, which was never on the toolbar to begin with.
    await back.fill('');
    await back.click();
    await back.pressSequentially('- one');
    await back.press('Shift+Enter');
    await expect(back).toHaveValue('- one\n- ');

    // And the choice is persisted, not session state.
    await page.reload();
    const reopened = await openRoom();
    await expect(reopened).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('format-bold')).toHaveCount(0);
  });

  test('the toolbar is there until you turn it off', async ({
    page,
    request,
  }) => {
    // The default is what almost every install sees, so it gets its own check rather than
    // riding on the setup of the test above.
    await openComposer(page, request, 'dt');

    await expect(page.getByTestId('format-bold')).toBeVisible();
    await expect(page.getByTestId('composer-preview-toggle')).toBeVisible();
  });

  test('the toolbar lines up with the field it formats', async ({
    page,
    request,
  }) => {
    // Rewritten rather than deleted, and against the FIELD rather than the textarea.
    //
    // It used to assert the first button aligned with the input's own left edge, because the
    // `+`/emoji/send buttons flanked the input from outside and the toolbar indented past them
    // with two hand-computed custom properties (44px, 88px, restated at the touch breakpoint).
    // The buttons are inside the field now, so the field's edge IS the input's box and the
    // indent is zero — which is exactly what makes the arithmetic unnecessary, and exactly why
    // dropping the test rather than re-aiming it would have left the alignment unguarded.
    const { composer } = await openComposer(page, request, 'al');
    await expect(composer).toBeVisible();

    const field = await page.locator('.composer__field').boundingBox();
    const firstButton = await page.getByTestId('format-bold').boundingBox();
    const previewToggle = await page
      .getByTestId('composer-preview-toggle')
      .boundingBox();
    if (!field || !firstButton || !previewToggle) {
      throw new Error('field, first button or preview toggle not laid out');
    }

    expect(Math.abs(firstButton.x - field.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(previewToggle.x + previewToggle.width - (field.x + field.width)),
    ).toBeLessThanOrEqual(1);
  });

  test('toggling the preview does not resize the composer', async ({
    page,
    request,
  }) => {
    // The acceptance criterion for the field, and it could only ever be a browser assertion.
    //
    // The preview used to be the textarea's SIBLING with a `min-height: 40px` guessing at its
    // resting height — which is 43px (a 21px line plus 11px of padding each side), so every
    // toggle shrank the composer by 3px and everything below it moved.
    //
    // Sharing a grid cell removes the second column that could disagree, but not the whole
    // problem: the textarea is `display: none` while previewing, so the cell measures the
    // preview alone and it still has to carry the same vertical padding and type. That is
    // stated once in the stylesheet and checked here — a mutation putting the preview's
    // padding back to 8px reports exactly the historical numbers, 43 against 40.
    const { composer } = await openComposer(page, request, 'ph');
    await composer.fill('**bold** and `code`');

    const field = page.locator('.composer__field');
    const before = (await field.boundingBox())?.height ?? 0;
    expect(before).toBeGreaterThan(0);

    await page.getByTestId('composer-preview-toggle').click();
    await expect(page.getByTestId('composer-preview')).toBeVisible();

    expect((await field.boundingBox())?.height).toBe(before);
  });
});
