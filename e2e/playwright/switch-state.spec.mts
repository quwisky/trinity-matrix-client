import { test, expect, type Locator } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// A switch has to LOOK like the value it holds, and that claim can only be made in a
// browser.
//
// It was false. Every Brn control publishes its state as `data-state="checked"` or
// `data-state="unchecked"`, while the Helm classes styling it are written
// `data-checked:bg-primary` and `data-unchecked:bg-input`. Tailwind reads a bare `data-foo:`
// as an attribute PRESENCE test and compiled `[data-checked]`, which nothing in the tree
// carries — so fourteen rules were emitted, matched nothing, and the switch rendered
// identically on and off. `apps/trinity/src/theme/spartan.css` declares the two variants.
//
// No unit test can see this and none ever will: jsdom applies no CSS, so `className`
// contains exactly the tokens the author wrote and every assertion about them passes
// whether or not a single rule matches. The measurement has to be `getComputedStyle` in a
// real engine, which is what this file is for.
//
// Two things about WHERE to measure, both of which cost a wrong first draft:
//
//  - `brn-switch` is `display: contents` and carries no class of its own. The kit puts the
//    styling AND the `data-state` on the `button[role=switch]` inside it, so that is the
//    element with a background. Measuring the custom element returns `rgba(0, 0, 0, 0)` in
//    every state and the test fails against correct code.
//  - Tailwind v4 emits its translate utilities as the `translate` PROPERTY, not as
//    `transform`. A thumb that has moved still reports `transform: none`.
const session = synapseSession();

/** The element the kit actually styles: `brn-switch` is `display: contents`. */
const track = (row: Locator): Locator => row.locator('button[role="switch"]');

/** The thumb, whose travel is what a reader actually reads the state from. */
const thumb = (row: Locator): Locator => row.locator('brn-switch-thumb');

const styleOf = (locator: Locator, property: string): Promise<string> =>
  locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );

/**
 * How far the thumb sits from the left edge of its track, once it has stopped moving.
 *
 * Measured as geometry rather than parsed out of the computed `translate`: that value is
 * `calc(100% - 2px)` in one state and `none` in the other, so `parseFloat` returns NaN for
 * both and an assertion built on it can only ever fail. What the claim is really about is
 * whether the thumb is at a different place on the track, which is a box comparison.
 */
async function thumbOffset(row: Locator): Promise<number> {
  let previous = -1;
  let offset = -1;
  await expect
    .poll(
      async () => {
        const box = await thumb(row).boundingBox();
        const rail = await track(row).boundingBox();
        offset = (box?.x ?? 0) - (rail?.x ?? 0);
        const stable = Math.abs(offset - previous) < 0.5;
        previous = offset;
        return stable;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  return offset;
}

/**
 * A computed value read after it has stopped moving.
 *
 * The track carries `transition-all`, so an immediate read catches the colour part-way and
 * returns a different alpha every run — two probes of the same checked switch gave
 * `rgba(88, 101, 242, 0.03)` and `rgba(88, 101, 242, 0.176)`. Polling until two consecutive
 * reads AT LEAST ONE INTERVAL APART agree is what makes the comparison about state rather
 * than about timing; two reads inside one frame always agree and prove nothing.
 */
async function settled(locator: Locator, property: string): Promise<string> {
  // Seeded with a value no computed style can ever be, so the FIRST probe can never report
  // "stable" — exactly as `thumbOffset()` seeds -1. Playwright runs a poll callback
  // immediately and only then sleeps, so a pre-read here landed in the same 16.7 ms frame
  // as probe #1; Chrome resolves transition values once per frame, the two agreed, and the
  // helper returned the value sampled at t0 having polled nothing. That could fail against
  // CORRECT code whenever the attribute flip and the read shared a frame.
  let previous = '';
  await expect
    .poll(
      async () => {
        const current = await styleOf(locator, property);
        const stable = current === previous;
        previous = current;
        return stable;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  return previous;
}

test.describe('Switch reflects its value', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test.beforeEach(async ({ page }) => {
    await login(page, session);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-privacy').click();
    await page.waitForURL(/\/settings\/privacy$/, { timeout: 20_000 });
  });

  test('the track and the thumb both change when it is toggled', async ({
    page,
  }) => {
    const row = page.getByTestId('privacy-send-read-receipts');
    await expect(track(row)).toBeVisible({ timeout: 20_000 });

    // Whatever it starts as — the preference persists, so this must not assume.
    const wasChecked = await track(row).getAttribute('data-state');
    const before = {
      background: await settled(track(row), 'background-color'),
      offset: await thumbOffset(row),
    };

    await row.click();
    await expect(track(row)).not.toHaveAttribute(
      'data-state',
      wasChecked ?? '',
      { timeout: 10_000 },
    );

    const after = {
      background: await settled(track(row), 'background-color'),
      offset: await thumbOffset(row),
    };

    // The two claims that were false. Both are asserted because they are two separate
    // rules on two separate elements: the track's fill lives on the button, the thumb's
    // travel on the thumb, and either can break without the other.
    expect(after.background).not.toBe(before.background);

    // The thumb genuinely travels rather than differing by a rounding error. The track is
    // 32px wide and the thumb 16px, so a working switch moves it about 14px; anything under
    // 4px is the thumb standing still.
    expect(Math.abs(after.offset - before.offset)).toBeGreaterThan(4);
  });

  test('two switches in opposite states do not look the same', async ({
    page,
  }) => {
    // The toggle test above would still pass if both states rendered identically and only
    // the attribute moved. This is the reader's actual complaint: side by side, the control
    // does not say which value it holds.
    const receipts = page.getByTestId('privacy-send-read-receipts');
    const previews = page.getByTestId('privacy-link-previews');
    await expect(track(receipts)).toBeVisible({ timeout: 20_000 });

    const receiptsState = await track(receipts).getAttribute('data-state');
    if ((await track(previews).getAttribute('data-state')) === receiptsState) {
      await previews.click();
      await expect(track(previews)).not.toHaveAttribute(
        'data-state',
        receiptsState ?? '',
        { timeout: 10_000 },
      );
    }

    expect(await settled(track(receipts), 'background-color')).not.toBe(
      await settled(track(previews), 'background-color'),
    );
  });
});
