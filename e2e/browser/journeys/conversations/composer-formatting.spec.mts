import {
  devices,
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  seedPreference,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';
import { captureScreenshot } from '../../../support/screenshot.mts';

// Covers the composer's formatting affordances (issue #29, second half): the toolbar, the
// rebindable chords behind it, markdown-aware Shift+Enter, and the preview toggle.
//
// These assert on the TEXTAREA's value rather than on a sent message — the point is what the
// composer does to what you are writing. Needs a Synapse homeserver (Docker); self-skips
// otherwise.
const session = synapseSession();
const mobile = devices['Pixel 5'];

/** Register, create a room, sign in and open it. Returns the composer locator. */
async function openComposer(
  page: Page,
  request: APIRequestContext,
  tag: string,
  messageCount = 0,
  openInitially = true,
) {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
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
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  for (let index = 0; index < messageCount; index++) {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${index}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // Keep the first sync page taller than the viewport so the simple list does not
        // immediately backfill the second page merely to fill empty space. The test below
        // controls that pagination explicitly and asserts its exact 20 -> 40 boundary.
        data: {
          msgtype: 'm.text',
          body: `Anchor message ${index}\nAnchor detail ${index}\nAnchor tail ${index}`,
        },
      },
    );
  }

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
  return {
    composer: openInitially
      ? await openRoom()
      : page.getByTestId('composer-input'),
    openRoom,
  };
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

  test('every action is on the bar, with nothing behind a menu', async ({
    page,
    request,
  }) => {
    // This used to open the kebab first. The overflow existed because the bar was always
    // there and had to earn its row; a bar that appears when you select something can afford
    // to show all nine, and an action behind a menu is one nobody discovers.
    const { composer } = await openComposer(page, request, 'ov');

    await composer.fill('one');
    await selectWord(page, 'one');

    await expect(page.getByTestId('format-more')).toHaveCount(0);
    await page.getByTestId('format-quote').click();

    await expect(composer).toHaveValue('> one');
  });

  test('unpinned, the bar comes and goes with the selection', async ({
    page,
    request,
  }) => {
    // The contextual behaviour, end to end. Unpinning is now "stop keeping it open" rather
    // than "never show it": the second preference decides whether a selection still raises it,
    // and it defaults on for anyone who had not already opted out.
    const { composer } = await openComposer(page, request, 'ct');
    await composer.fill('say hello there');

    // Unpin from the bar itself — the `Aa` control, which is where you notice you want it.
    await page.getByTestId('format-pin').click();
    await expect(page.getByTestId('format-bold')).toHaveCount(0);

    await selectWord(page, 'hello');
    await expect(page.getByTestId('format-bold')).toBeVisible();

    // And it applies to the selection that raised it.
    await page.getByTestId('format-bold').click();
    await expect(composer).toHaveValue('say **hello** there');
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
    await openSettingsSection(page, 'shortcuts');
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
    const { openRoom } = await openComposer(page, request, 'ht');

    await expect(page.getByTestId('format-bold')).toBeVisible();

    await openSettingsSection(page, 'appearance');
    const toolbarToggle = page
      .getByTestId('composer-show-toolbar')
      .locator('trn-switch');
    await expect(toolbarToggle).toBeVisible({ timeout: 15_000 });
    await toolbarToggle.click();

    // Settings is a full-page route, so leave it before looking for the rail.
    await page.goto('/rooms');
    const back = await openRoom();

    // Unchecking the settings box unpins it, and with no selection there is nothing to raise
    // it — so the row is gone, which is what this test has always been about.
    await expect(page.getByTestId('format-bold')).toHaveCount(0);
    // The legacy Preview toggle disappears, but Aa still offers Preview independently.
    await expect(page.getByTestId('composer-preview-toggle')).toHaveCount(0);
    await back.fill('**Preview without the toolbar**');
    const formatSurface = page
      .getByTestId('composer-format-menu')
      .or(page.getByRole('dialog', { name: 'Format message' }));
    await page.getByTestId('composer-format').click();
    await formatSurface.getByTestId('format-preview').click();
    await expect(
      page.getByTestId('composer-preview').locator('strong'),
    ).toHaveText('Preview without the toolbar');
    await expect(page.getByTestId('composer-preview-toggle')).toHaveCount(0);
    await page.getByTestId('composer-format').click();
    await formatSurface.getByTestId('format-preview').click();
    await expect(back).toBeFocused();

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

  test('the toolbar lines up with the controls it sits above', async ({
    page,
    request,
  }) => {
    // Rewritten rather than deleted, and re-aimed at the field's BUTTONS.
    //
    // It used to assert the first format button aligned with the textarea's own left edge:
    // `971f95ae` added two hand-computed custom properties (44px and 88px, restated as 48/96
    // at the touch breakpoint) to indent the row past buttons that flanked the input from
    // OUTSIDE, so bold sat over the first character it would format.
    //
    // The buttons are inside the field now, so the field is the control and the text starts a
    // button-width into it. That reversal is deliberate: bold no longer sits over the first
    // character, it sits over the `+`. What replaces the arithmetic is the field's own
    // `padding-inline`, which the toolbar copies — so the invariant worth guarding is that the
    // two rows agree on their controls, and it fails if either padding drifts.
    const { composer } = await openComposer(page, request, 'al');
    await expect(composer).toBeVisible();

    const insert = await page.getByTestId('composer-insert').boundingBox();
    const send = await page.getByTestId('composer-send').boundingBox();
    const firstButton = await page.getByTestId('format-bold').boundingBox();
    const previewToggle = await page
      .getByTestId('composer-preview-toggle')
      .boundingBox();
    if (!insert || !send || !firstButton || !previewToggle) {
      throw new Error('composer controls or toolbar buttons not laid out');
    }

    // Leading: bold over the `+`. Trailing: the preview toggle over send.
    expect(Math.abs(firstButton.x - insert.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(previewToggle.x + previewToggle.width - (send.x + send.width)),
    ).toBeLessThanOrEqual(1);
  });

  test('the field forwards a press on itself, and rings only for the input', async ({
    page,
    request,
  }) => {
    // Both follow from the box moving off the textarea onto a container bigger than it, and
    // neither is visible to a unit test: one needs layout to have a dead zone at all, the
    // other needs a real focus ring.
    const { composer } = await openComposer(page, request, 'fp');
    await composer.fill('one\ntwo\nthree\nfour\nfive');

    const zone = await page.evaluate(() => {
      const field = document
        .querySelector('[data-testid="composer-field"]')!
        .getBoundingClientRect();
      const emoji = document
        .querySelector('.composer__emoji')!
        .getBoundingClientRect();
      return {
        // Inside the field, in the emoji button's column, well above the button itself —
        // empty field that looks like part of the input. Measured at 87px tall on this draft.
        x: Math.round(emoji.x + emoji.width / 2),
        y: Math.round(field.y + 8),
      };
    });

    const field = page.getByTestId('composer-field');

    await page.getByTestId('composer-send').focus();
    // Assert the focus landed before asserting what it does NOT draw: `.focus()` on a disabled
    // button is a silent no-op, and the negative below would then pass for the wrong reason.
    await expect(page.getByTestId('composer-send')).toBeFocused();
    // A focused BUTTON inside the field must not draw the input's ring: `:focus-within` would.
    await expect(field).not.toHaveCSS('outline-style', 'solid');

    await page.mouse.click(zone.x, zone.y);

    await expect(composer).toBeFocused();
    await expect(field).toHaveCSS('outline-style', 'solid');
  });

  test('the bar shows what the selection already carries', async ({
    page,
    request,
  }) => {
    // `aria-pressed` on the nine is derived from the marks around the selection, so it says
    // something true about the text rather than about the last button pressed. Only a real
    // browser has a real selection, and only the rendered attribute proves the whole chain:
    // textarea event -> composer `detectFormat` -> toggle group -> the DOM.
    const { composer } = await openComposer(page, request, 'mk');
    const bold = page.getByTestId('format-bold');
    const italic = page.getByTestId('format-italic');

    await composer.fill('say hello there');
    await selectWord(page, 'hello');
    await expect(bold).toHaveAttribute('aria-pressed', 'false');

    // Bolding the selection makes Bold true of it — and the button follows the text.
    await bold.click();
    await expect(composer).toHaveValue('say **hello** there');
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await expect(italic).toHaveAttribute('aria-pressed', 'false');

    // And pressing it again removes the marks, which is exactly what "pressed" promised.
    await bold.click();
    await expect(composer).toHaveValue('say hello there');
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
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
    // A ONE-LINE draft, deliberately. The preview renders markdown, so a multi-line raw text
    // and its rendered form legitimately differ in line count and therefore in height — the
    // drift this guards is the structural one, where the same content measured differently
    // depending on which element was showing. Tightening this into "any draft keeps the
    // height" would assert something that must not hold.
    //
    // The EMPTY draft is the second case, and it is not a corner: the toggle carries no
    // `disabled`, and an empty draft renders no line box at all, so without the preview's
    // `min-height` the row falls back to the 40px buttons and reports the same historical 43
    // against 40 from the other side.
    const { composer } = await openComposer(page, request, 'ph');
    const field = page.getByTestId('composer-field');
    const toggle = page.getByTestId('composer-preview-toggle');

    /** Height across one preview round trip. Tolerance is sub-pixel rounding, not slack in
     *  the invariant: `autoGrow` writes an integer `scrollHeight` while the preview's box is
     *  a computed `line-height`, so at a non-16px root the two land either side of a pixel. */
    const heightAcrossToggle = async (draft: string) => {
      await composer.fill(draft);
      const writing = (await field.boundingBox())?.height ?? 0;
      expect(writing).toBeGreaterThan(0);

      await toggle.click();
      await expect(page.getByTestId('composer-preview')).toBeVisible();
      const previewing = (await field.boundingBox())?.height ?? 0;

      await toggle.click();
      await expect(composer).toBeVisible();
      return { writing, previewing };
    };

    for (const draft of ['**bold** and `code`', '']) {
      const { writing, previewing } = await heightAcrossToggle(draft);
      expect(Math.abs(previewing - writing)).toBeLessThan(1);
    }
  });

  test('composer growth preserves the simple timeline anchor', async ({
    page,
    request,
  }) => {
    // Configure the simple list before first opening the seeded room. Opening it once and
    // then reloading lets its viewport-fill backfill cache all 40 events, so the reload no
    // longer begins at the 20-event initial-sync boundary this test is meant to paginate.
    const { composer, openRoom } = await openComposer(
      page,
      request,
      'ah',
      40,
      false,
    );
    const scroller = page.locator('.scroll');

    await seedPreference(page, 'trinity.flags.virtual-timeline', 'false');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openRoom();
    await expect(page.locator('trn-simple-message-list')).toBeVisible();
    await expect(page.locator('.msg__text')).toHaveCount(20, {
      timeout: 30_000,
    });
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('.msg__text')).toHaveCount(40, {
      timeout: 30_000,
    });

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await composer.fill('one line');
    await composer.fill('one\ntwo\nthree\nfour\nfive\nsix');
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(1);

    await composer.fill('short again');
    await scroller.evaluate((element) => {
      element.scrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight - 200,
      );
      element.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeGreaterThanOrEqual(199);
    const before = await scroller.evaluate((element) => element.scrollTop);
    await composer.fill('one\ntwo\nthree\nfour\nfive\nsix');
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(before);
  });
});

// The bar at phone size, which the suite above structurally cannot see: the project is
// Desktop Chrome at 1280, and the 44px touch minimums only apply under `(pointer: coarse)` —
// so `hasTouch` here is not decoration, it is the half that makes the buttons big enough to
// overflow. Nine of them plus two rules is 470px of content against about 358px of bar.
test.describe('Composer formatting on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.describe.configure({ timeout: 60_000 });

  test('the whole bar stays on screen, including the pin and the preview toggle', async ({
    page,
    request,
  }) => {
    // `.chat-body` is `overflow: hidden`, so anything past the right edge is not merely
    // off-screen but unreachable — and the two that fall off the end are the pin and the
    // preview toggle, the second of which is the only way to reach a preview on a phone.
    await openComposer(page, request, 'ph-narrow');

    const width = page.viewportSize()?.width ?? 0;
    expect(width).toBeGreaterThan(0);

    const controls = [
      'format-bold',
      'format-italic',
      'format-strike',
      'format-code',
      'format-codeblock',
      'format-quote',
      'format-link',
      'format-list',
      'format-tasklist',
      'format-pin',
      'composer-preview-toggle',
    ];
    for (const id of controls) {
      const box = await page.getByTestId(id).boundingBox();
      if (!box) {
        throw new Error(`${id} is not laid out`);
      }
      // Half a pixel of slack for sub-pixel rounding, not for a button hanging off the edge.
      expect(
        box.x + box.width,
        `${id} runs past the right edge`,
      ).toBeLessThanOrEqual(width + 0.5);
      expect(box.x, `${id} runs past the left edge`).toBeGreaterThanOrEqual(
        -0.5,
      );
    }

    // And it wrapped rather than scrolled: the row is taller than one button, which is the
    // mechanism the assertions above depend on.
    const bar = await page.locator('.toolbar').boundingBox();
    expect(bar?.height ?? 0).toBeGreaterThan(50);
  });
});

// The replacement interaction is covered additively here so the existing keyboard, list,
// preview, and toolbar regressions remain useful while the feature lands.
test.describe('On-demand composer formatting', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.skip(
    process.env['TRINITY_E2E_PLATFORM'] === 'android',
    'Android uses the mobile action-sheet surface below',
  );

  test('opens the desktop Format popover, applies selected text, and restores focus', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'menu');
    await composer.fill('say hello there');
    await selectWord(page, 'hello');
    await page.getByTestId('composer-format').click();

    const menu = page.getByTestId('composer-format-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('format-bold')).toBeVisible();
    await expect(menu.getByTestId('format-preview')).toBeVisible();
    await test.info().attach('composer-format-desktop', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });
    await menu.getByTestId('format-bold').click();

    await expect(composer).toHaveValue('say **hello** there');
    await expect(menu).toBeHidden();
    await expect(composer).toBeFocused();
  });

  test('cancel preserves both the draft and the selected range', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'cancel-menu');
    await composer.fill('say hello');
    await selectWord(page, 'hello');
    await page.getByTestId('composer-format').click();
    await expect(page.getByTestId('composer-format-menu')).toBeVisible();
    await page
      .getByTestId('composer-format-menu')
      .getByTestId('format-cancel')
      .click();

    await expect(composer).toHaveValue('say hello');
    await expect(page.getByTestId('composer-format')).toBeFocused();
    await expect(composer).toHaveJSProperty('selectionStart', 4);
    await expect(composer).toHaveJSProperty('selectionEnd', 9);
  });

  test('applies all nine formatting actions from one menu', async ({
    page,
    request,
  }) => {
    const actions = [
      ['bold', 'one **word**'],
      ['italic', 'one *word*'],
      ['strike', 'one ~~word~~'],
      ['code', 'one `word`'],
      ['codeblock', 'one \n```\nword\n```'],
      ['quote', '> one word'],
      ['link', 'one [word]()'],
      ['list', '- one word'],
      ['tasklist', '- [ ] one word'],
    ] as const;
    const { composer } = await openComposer(page, request, 'menu-actions');

    for (const [action, expected] of actions) {
      await composer.fill('one word');
      await selectWord(page, 'word');
      await page.getByTestId('composer-format').click();
      await page
        .getByTestId('composer-format-menu')
        .getByTestId(`format-${action}`)
        .click();
      await expect(composer).toHaveValue(expected);
    }
  });

  test('inserts a Markdown pair at the caret when no text is selected', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'menu-caret');
    await composer.fill('hello');
    await composer.press('End');
    await page.getByTestId('composer-format').click();
    await page
      .getByTestId('composer-format-menu')
      .getByTestId('format-bold')
      .click();

    await expect(composer).toHaveValue('hello****');
    await expect(composer).toBeFocused();
  });

  test('previews from the Format menu and round-trips the draft', async ({
    page,
    request,
  }) => {
    const { composer } = await openComposer(page, request, 'menu-preview');
    await composer.fill('**bold** and `code`');
    await selectWord(page, 'bold');
    await page.getByTestId('composer-format').click();
    await page
      .getByTestId('composer-format-menu')
      .getByTestId('format-preview')
      .click();

    const preview = page.getByTestId('composer-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('strong')).toHaveText('bold');
    await expect(preview.locator('code')).toHaveText('code');

    await page.getByTestId('composer-format').click();
    await page
      .getByTestId('composer-format-menu')
      .getByTestId('format-preview')
      .click();
    await expect(preview).toBeHidden();
    await expect(composer).toHaveValue('**bold** and `code`');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty('selectionStart', 2);
    await expect(composer).toHaveJSProperty('selectionEnd', 6);
  });
});

test.describe('On-demand composer formatting on mobile', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({
    viewport: mobile.viewport,
    userAgent: mobile.userAgent,
    deviceScaleFactor: mobile.deviceScaleFactor,
    isMobile: mobile.isMobile,
    hasTouch: mobile.hasTouch,
  });

  test('uses a bounded touch action sheet and applies selected text', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const { composer } = await openComposer(page, request, 'menu-mobile');
    await composer.fill('say hello');
    await selectWord(page, 'hello');
    const trigger = page.getByTestId('composer-format');
    const target = await trigger.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(44);
    expect(target?.height).toBeGreaterThanOrEqual(44);
    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, trigger);

    const dialog = page.getByRole('dialog', { name: 'Format message' });
    const sheet = dialog.getByTestId('action-sheet-surface');
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    // Allow subpixel rounding in the installed WebView device-scale ratio.
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 0.5);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 0.5);
    await test.info().attach('composer-format-mobile', {
      body: await captureScreenshot(page, () => page.screenshot()),
      contentType: 'image/png',
    });

    await touchPlatform.tap(page, dialog.getByTestId('format-italic'));
    await expect(composer).toHaveValue('say *hello*');
    await expect(sheet).toBeHidden();
    await expect(composer).toBeFocused();
  });

  test('cancels and previews on mobile without losing the selected text', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const { composer } = await openComposer(
      page,
      request,
      'menu-mobile-preview',
    );
    await composer.fill('**bold** and plain');
    await selectWord(page, 'bold');
    const trigger = page.getByTestId('composer-format');
    const dialog = page.getByRole('dialog', { name: 'Format message' });

    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, trigger);
    await touchPlatform.tap(page, dialog.getByTestId('format-cancel'));
    await expect(dialog).toBeHidden();
    await expect(composer).toHaveValue('**bold** and plain');
    await expect(composer).toHaveJSProperty('selectionStart', 2);
    await expect(composer).toHaveJSProperty('selectionEnd', 6);

    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, trigger);
    await touchPlatform.tap(page, dialog.getByTestId('format-preview'));
    const preview = page.getByTestId('composer-preview');
    await expect(preview.locator('strong')).toHaveText('bold');
    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, trigger);
    await touchPlatform.tap(page, dialog.getByTestId('format-preview'));
    await expect(preview).toBeHidden();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty('selectionStart', 2);
    await expect(composer).toHaveJSProperty('selectionEnd', 6);
    await expect(page.getByTestId('composer-send')).toBeVisible();
  });
  test('keeps Format and Send reachable at compact width with larger text', async ({
    page,
    request,
    touchPlatform,
  }) => {
    const { composer } = await openComposer(page, request, 'menu-larger');
    await touchPlatform.dismissKeyboard(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await seedPreference(page, 'trinity.text-scale', 'larger');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(composer).toBeVisible();
    await expect(page.locator('html')).toHaveCSS('font-size', '20px');
    await composer.fill('compact draft');
    for (const id of ['composer-format', 'composer-send']) {
      const control = page.getByTestId(id);
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320.5);
    }
    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, page.getByTestId('composer-format'));
    const dialog = page.getByRole('dialog', { name: 'Format message' });
    await touchPlatform.tap(page, dialog.getByTestId('format-preview'));
    await expect(page.getByTestId('composer-preview')).toHaveText(
      'compact draft',
    );
    await touchPlatform.dismissKeyboard(page);
    await touchPlatform.tap(page, page.getByTestId('composer-format'));
    await touchPlatform.tap(page, dialog.getByTestId('format-preview'));
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('compact draft');
  });
});
