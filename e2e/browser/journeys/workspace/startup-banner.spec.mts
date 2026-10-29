import { test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { describeFailure } from '../../../support/http-failure.mts';

const session = homeserverSession();

/** One animation frame: the first room row's top, and which global banner held the slot. */
interface SlotFrame {
  readonly t: number;
  readonly row: number | null;
  /** `forecast`: the encryption prompt laid out hidden, before the live status confirms it. */
  readonly slot: 'forecast' | 'status' | 'encryption' | null;
  /** The encryption prompt's box, hidden or shown; null while it is not in the page. */
  readonly banner: { readonly width: number; readonly height: number } | null;
  /** The root font size in px, to show larger text applied from the first frame. */
  readonly rootFont: number;
}

declare global {
  interface Window {
    __slotFrames?: SlotFrame[];
  }
}

/** Installed before the app loads: record every frame until the test reads the list. */
function recordSlotFrames(): void {
  const frames: SlotFrame[] = [];
  window.__slotFrames = frames;
  const frame = (): void => {
    const row = document.querySelector('button.channel');
    const banner = document.querySelector('trn-encryption-banner trn-banner');
    const box = banner?.getBoundingClientRect();
    frames.push({
      t: Math.round(performance.now()),
      row: row ? row.getBoundingClientRect().top : null,
      slot: document.querySelector('trn-encryption-banner [data-forecast]')
        ? 'forecast'
        : banner
          ? 'encryption'
          : document.querySelector('[data-testid="app-capability-summary"]')
            ? 'status'
            : null,
      banner: box ? { width: box.width, height: box.height } : null,
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Installed before the app loads: the browser grants persistent storage, so no notice. */
function grantPersistentStorage(): void {
  Object.defineProperty(StorageManager.prototype, 'persisted', {
    configurable: true,
    value: () => Promise.resolve(true),
  });
}

/**
 * Installed before the app loads: text at 200%, as a browser whose default font size is
 * doubled gives. A constructed stylesheet applies before the first frame, and its
 * `!important` survives Trinity's appearance adapter, which clears an inline root font
 * size at start-up when its own text size is the default.
 */
function doubleTextSize(): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(':root { font-size: 200% !important; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** Wait until this device has recorded which prompt the Account needs, so a restart has it. */
async function expectForecastStored(page: Page, kind: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((wanted) => {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index) ?? '';
          if (
            key.includes('trinity.trust.slot-forecast') &&
            (localStorage.getItem(key) ?? '').includes(wanted)
          ) {
            return true;
          }
        }
        return false;
      }, kind),
    )
    .toBe(true);
}

/** The prompt's box in the last frame it was a forecast and the first frame it showed. */
function revealBoxes(frames: readonly SlotFrame[]): {
  readonly forecast: SlotFrame['banner'];
  readonly shown: SlotFrame['banner'];
} | null {
  const shownAt = frames.findIndex(
    (frame, index) =>
      index > 0 &&
      frame.slot === 'encryption' &&
      frames[index - 1]!.slot === 'forecast',
  );
  return shownAt < 0
    ? null
    : { forecast: frames[shownAt - 1]!.banner, shown: frames[shownAt]!.banner };
}

/** How long a restart's status read is slowed: well under the forecast's 10 s backstop. */
const STATUS_DELAY_MS = 1_000;

/**
 * Hold the live encryption status of the next load: its request waits for `until()`.
 * A restored session reads its status from local crypto state, except for the Account's
 * default secret-storage key, which it fetches from the homeserver: holding that request
 * is what keeps the status unknown while Rooms draws.
 */
async function holdTrustStatus(
  page: Page,
  until: () => Promise<void>,
): Promise<void> {
  await page.route(
    '**/_matrix/client/*/user/*/account_data/m.secret_storage.default_key',
    async (route) => {
      await until();
      await route.fallback();
    },
  );
}

/** Frames from the first one that drew a room row, a couple of frames past `settled`. */
async function framesWithRow(page: Page): Promise<SlotFrame[]> {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const frames = await page.evaluate(() => window.__slotFrames ?? []);
  return frames.slice(frames.findIndex((frame) => frame.row !== null));
}

/*
 * Signing in at phone width, the global banner slot can first hold the "Protected browser
 * storage is unavailable" notice and swap it for the "Set up encryption" prompt once the
 * trust status arrives. The notice's two actions wrap under its message there and the
 * prompt's one action does not, so the swap used to move the room list up by about 26px,
 * under a tap already in flight: the tap was lost or opened the next room. Every frame from
 * the first room row until the prompt is up has to show the row in the same place.
 *
 * Whether the notice is still in the slot when the first row is drawn depends on whether
 * the trust status arrives first, so the sign-in cases accept either order: the notice
 * under the row then the prompt, or the prompt arriving with the row. The held-status case
 * slows the status down, so the swap under a drawn row is always measured too. All of this
 * relies on headless Chromium declining `navigator.storage.persist()`, as it does here and
 * in CI: that limitation is what puts the notice in the slot at all.
 */
test.describe('Global banner slot after sign-in', () => {
  test.skip(
    !session.available,
    'requires the disposable homeserver (Docker or native Synapse)',
  );

  let account: HomeserverSession;

  test.beforeAll(async ({ request, workerResourceNamespace }) => {
    const runId = workerResourceNamespace.role('startup-banner');
    const user = `banner-user-${runId}`;
    const pass = `${user}-pass`;
    const hs = session.hs as string;
    account = { available: true, hs, user, pass };
    await registerUser(request, user, pass);
    const { accessToken, userId } = await passwordLogin(
      request,
      hs,
      user,
      pass,
    );
    const headers = { Authorization: `Bearer ${accessToken}` };
    const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: `Banner room ${runId}` },
    });
    if (!created.ok()) {
      throw new Error(await describeFailure('createRoom', created));
    }
    const { room_id: roomId } = (await created.json()) as { room_id: string };
    // A direct message, so the room is in the default Home list without switching views.
    const direct = await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.direct`,
      { headers, data: { '@ghost:localhost': [roomId] } },
    );
    if (!direct.ok()) {
      throw new Error(await describeFailure('m.direct', direct));
    }
  });

  /** Signs in, waits for the prompt, checks the row never moved; returns the slot changes. */
  async function signInAndMeasure(page: Page): Promise<(string | null)[]> {
    await page.addInitScript(recordSlotFrames);
    await login(page, account);
    // A fresh account has no encryption set up: the prompt is where the slot settles.
    await expect(
      page
        .locator('trn-encryption-banner trn-banner')
        .getByText('Set up encryption to secure your messages.'),
    ).toBeVisible();

    const frames = await framesWithRow(page);
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0]!;
    const moved = frames.filter(
      (frame) => frame.row === null || Math.abs(frame.row - first.row!) > 0.5,
    );
    const swaps = frames.filter(
      (frame, index) => index === 0 || frame.slot !== frames[index - 1]!.slot,
    );
    expect(
      moved,
      `row first drawn at y=${first.row}; slot changes: ${JSON.stringify(swaps)}`,
    ).toEqual([]);
    return swaps.map(({ slot }) => slot);
  }

  for (const width of [320, 390, 600, 1280]) {
    test(`the room list stays put while the slot settles at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const swaps = await signInAndMeasure(page);
      // When trust settles before the first row is drawn, the row and the prompt arrive
      // together; otherwise the notice holds the slot under the row and gives way to the
      // prompt. Either way the row below must not move.
      expect(
        [['status', 'encryption'], ['encryption']],
        `the slot settles on the prompt; slot changes: ${JSON.stringify(swaps)}`,
      ).toContainEqual(swaps);
    });
  }

  test('the room list stays put when the notice gives way under a drawn row at 390px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await holdTrustStatus(
      page,
      () => new Promise((resolve) => setTimeout(resolve, STATUS_DELAY_MS)),
    );
    expect(await signInAndMeasure(page)).toEqual(['status', 'encryption']);
  });

  /*
   * With persistent storage granted the notice never takes the slot, so the prompt
   * arrives in an empty slot and replaces nothing. It then keeps its own one-row height
   * instead of the notice's wrapped two-row height, which would push the room list
   * further down for no swap (#1430).
   */
  test('the prompt keeps its own height when no notice preceded it at 390px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(grantPersistentStorage);
    await page.addInitScript(recordSlotFrames);
    await login(page, account);
    const prompt = page.locator('trn-encryption-banner trn-banner');
    await expect(
      prompt.getByText('Set up encryption to secure your messages.'),
    ).toBeVisible();

    const frames = await page.evaluate(() => window.__slotFrames ?? []);
    expect(
      frames.some(({ slot }) => slot === 'status'),
      'the notice must not hold the slot, or this measures the swap instead',
    ).toBe(false);
    await expect(prompt).toHaveAttribute('data-placement', 'inline');

    const size = await prompt.locator('.banner').evaluate((banner) => {
      const style = getComputedStyle(banner);
      const content = Math.max(
        ...[...banner.children].map(
          (child) => child.getBoundingClientRect().height,
        ),
      );
      return {
        height: banner.getBoundingClientRect().height,
        natural:
          content +
          parseFloat(style.paddingBlockStart) +
          parseFloat(style.paddingBlockEnd),
      };
    });
    test.info().annotations.push({
      type: 'prompt height',
      description: `${size.height}px (one row: ${size.natural}px)`,
    });
    expect(size.height).toBeCloseTo(size.natural, 0);
  });

  /*
   * On a restart the device already knows which prompt the Account needed last time, so
   * the slot holds that prompt, laid out but hidden, from the first frame, and the live
   * status only reveals it in place (#1433). Neither the notice nor an empty slot may come
   * first, and neither the row nor the prompt's box may change when it is revealed.
   *
   * Here the restored session reads its status before Rooms draws, so the read of the
   * secret-storage key is slowed by a second, as on a phone's network; without that the
   * prompt is confirmed before the first row and nothing would be measured. The test
   * checks the forecast really held the slot while the row was on screen.
   */
  for (const width of [320, 390]) {
    for (const text of ['100%', '200%'] as const) {
      test(`after a restart the list stays put while the prompt is confirmed at ${width}px, ${text} text`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await login(page, account);
        await expect(
          page
            .locator('trn-encryption-banner trn-banner')
            .getByText('Set up encryption to secure your messages.'),
        ).toBeVisible();
        await expectForecastStored(page, 'needs-setup');

        // Restart: same storage, fresh page. The forecast is now on disk.
        await holdTrustStatus(
          page,
          () => new Promise((resolve) => setTimeout(resolve, STATUS_DELAY_MS)),
        );
        await page.addInitScript(recordSlotFrames);
        if (text === '200%') {
          await page.addInitScript(doubleTextSize);
        }
        await page.reload();
        await expect(
          page
            .locator('trn-encryption-banner trn-banner')
            .getByText('Set up encryption to secure your messages.'),
        ).toBeVisible();
        await expect(
          page.locator('trn-encryption-banner [data-forecast]'),
        ).toHaveCount(0);

        const frames = await framesWithRow(page);
        expect(frames.length).toBeGreaterThan(0);
        const first = frames[0]!;
        expect(
          [...new Set(frames.map(({ rootFont }) => rootFont))],
          'root font size (px) in every frame from the first row',
        ).toEqual([text === '200%' ? 32 : 16]);
        const swaps = frames.filter(
          (frame, index) =>
            index === 0 || frame.slot !== frames[index - 1]!.slot,
        );
        test.info().annotations.push({
          type: 'slot changes',
          description: JSON.stringify(swaps),
        });
        expect(
          swaps.map(({ slot }) => slot),
          'the forecast held the slot when the first row was drawn, then was revealed; ' +
            `slot changes: ${JSON.stringify(swaps)}`,
        ).toEqual(['forecast', 'encryption']);
        const moved = frames.filter(
          (frame) =>
            frame.row === null || Math.abs(frame.row - first.row!) > 0.5,
        );
        expect(
          moved,
          `row first drawn at y=${first.row}; slot changes: ${JSON.stringify(swaps)}`,
        ).toEqual([]);
        const boxes = revealBoxes(frames);
        test.info().annotations.push({
          type: 'prompt box',
          description: JSON.stringify(boxes),
        });
        expect(boxes?.forecast, 'prompt box while hidden').toBeTruthy();
        expect(boxes!.shown, 'prompt box when revealed').toEqual(
          boxes!.forecast,
        );
      });
    }
  }

  /*
   * With persistent storage granted the notice never takes the slot, so without a
   * forecast the prompt would arrive in an empty slot after the first row and push the
   * list down (#1433, case 3). On a restart the forecast holds the prompt's space from
   * the first frame instead: the slot goes straight from the hidden prompt to the
   * revealed one, the notice never shows, and the row never moves.
   */
  test('after a restart with persistent storage the list stays put while the prompt is confirmed at 390px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(grantPersistentStorage);
    await login(page, account);
    const prompt = page.locator('trn-encryption-banner trn-banner');
    await expect(
      prompt.getByText('Set up encryption to secure your messages.'),
    ).toBeVisible();
    await expectForecastStored(page, 'needs-setup');

    // Restart: same storage, fresh page, persistent storage still granted.
    await holdTrustStatus(
      page,
      () => new Promise((resolve) => setTimeout(resolve, STATUS_DELAY_MS)),
    );
    await page.addInitScript(recordSlotFrames);
    await page.reload();
    await expect(
      prompt.getByText('Set up encryption to secure your messages.'),
    ).toBeVisible();
    await expect(
      page.locator('trn-encryption-banner [data-forecast]'),
    ).toHaveCount(0);

    const frames = await framesWithRow(page);
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0]!;
    const swaps = frames.filter(
      (frame, index) => index === 0 || frame.slot !== frames[index - 1]!.slot,
    );
    test.info().annotations.push({
      type: 'slot changes',
      description: JSON.stringify(swaps),
    });
    expect(
      swaps.map(({ slot }) => slot),
      'the forecast held the empty slot when the first row was drawn, then was ' +
        `revealed, with no notice; slot changes: ${JSON.stringify(swaps)}`,
    ).toEqual(['forecast', 'encryption']);
    const moved = frames.filter(
      (frame) => frame.row === null || Math.abs(frame.row - first.row!) > 0.5,
    );
    expect(
      moved,
      `row first drawn at y=${first.row}; slot changes: ${JSON.stringify(swaps)}`,
    ).toEqual([]);
    const boxes = revealBoxes(frames);
    expect(boxes?.forecast, 'prompt box while hidden').toBeTruthy();
    expect(boxes!.shown, 'prompt box when revealed').toEqual(boxes!.forecast);
  });

  /*
   * The hidden prompt is inert: its action must not take focus before the live status
   * confirms it. Holding the secret-storage key read keeps the prompt a forecast while the
   * keyboard is tried. Once it is released the same prompt is revealed, and only then does
   * Tab reach its action.
   *
   * Time budget: while the status is loading, the forecast holds the slot until the
   * `FORECAST_HOLD_MS` backstop (10 s, in `@trinity/data-access/trust`). Everything from
   * the Account becoming active after the reload to the Tab checks below must fit in that
   * window, or the stored forecast is dropped and there is no hidden prompt left to test.
   */
  test('after a restart the hidden prompt takes no focus until it is confirmed at 390px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account);
    const prompt = page.locator('trn-encryption-banner trn-banner');
    await expect(
      prompt.getByText('Set up encryption to secure your messages.'),
    ).toBeVisible();
    await expectForecastStored(page, 'needs-setup');

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await holdTrustStatus(page, () => released);
    await page.reload();
    try {
      // From here to the Tab checks: within FORECAST_HOLD_MS (10 s) of the Account
      // becoming active, while the forecast still holds the slot.
      await expect(page.locator('button.channel').first()).toBeVisible();
      await expect(
        page.locator('trn-encryption-banner [data-forecast]'),
      ).toBeAttached();
      await expect(prompt).toBeHidden();
      // A focusable stand-in for whatever precedes the banner, placed right before it and
      // out of flow, so Tab from it goes to the banner's action if anything can.
      await page.evaluate(() => {
        const before = document.createElement('span');
        before.tabIndex = 0;
        before.dataset['testid'] = 'before-banner';
        before.style.position = 'absolute';
        before.style.inlineSize = '1px';
        before.style.blockSize = '1px';
        document.querySelector('trn-encryption-banner')!.before(before);
        before.focus();
      });
      await page.keyboard.press('Tab');
      const hidden = await page.evaluate(() => ({
        forecast:
          document.querySelector('trn-encryption-banner [data-forecast]') !==
          null,
        inBanner:
          document.activeElement?.closest('trn-encryption-banner') != null,
        focused: document.activeElement?.outerHTML.slice(0, 80) ?? null,
      }));
      test.info().annotations.push({
        type: 'focus after Tab while hidden',
        description: String(hidden.focused),
      });
      expect(hidden.forecast, 'the prompt was still hidden after Tab').toBe(
        true,
      );
      expect(
        hidden.inBanner,
        `Tab focused ${hidden.focused} inside the hidden prompt`,
      ).toBe(false);
    } finally {
      release();
    }

    const action = prompt.getByRole('button', { name: 'Set up', exact: true });
    await expect(action).toBeVisible();
    await expect(
      page.locator('trn-encryption-banner [data-forecast]'),
    ).toHaveCount(0);
    await page.getByTestId('before-banner').focus();
    await page.keyboard.press('Tab');
    await expect(action, 'the confirmed prompt takes focus').toBeFocused();
  });
});
