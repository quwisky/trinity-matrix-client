import { test, expect, type Locator } from '../../../fixtures.mts';
import { login, synapseSession } from '../../../support/app.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// A switch has to LOOK like the value it holds, and that claim can only be made in a
// browser.
//
// No unit test can see this and none ever will: jsdom applies no CSS, so `className`
// contains exactly the tokens the author wrote and every assertion about them passes
// whether or not a single rule matches. The measurement has to be `getComputedStyle` in a
// real engine, which is what this file is for.
//
// The public control keeps semantics on a native checkbox with `role="switch"`; its
// following presentational span owns track paint, and that span's child owns thumb travel.
// Measure those exact owners while asserting state through the native control.
const session = synapseSession();

/** The native control that owns checked, disabled, focus and keyboard semantics. */
const control = (row: Locator): Locator => row.getByRole('switch');

/** The presentational sibling that owns the track background. */
const track = (row: Locator): Locator =>
  row.locator('trn-switch > span[aria-hidden="true"]');

/** The thumb, whose travel is what a reader actually reads the state from. */
const thumb = (row: Locator): Locator => track(row).locator(':scope > span');

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
 * The track carries a colour transition, so an immediate read catches the colour part-way and
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
    await openSettingsSection(page, 'privacy');
  });

  test('the track and the thumb both change when it is toggled', async ({
    page,
  }) => {
    const row = page.getByTestId('privacy-send-read-receipts');
    await expect(control(row)).toBeVisible({ timeout: 20_000 });

    // Whatever it starts as — the preference persists, so this must not assume.
    const wasChecked = await control(row).isChecked();
    const before = {
      background: await settled(track(row), 'background-color'),
      offset: await thumbOffset(row),
    };

    await row.click();
    if (wasChecked) {
      await expect(control(row)).not.toBeChecked({ timeout: 10_000 });
    } else {
      await expect(control(row)).toBeChecked({ timeout: 10_000 });
    }

    const after = {
      background: await settled(track(row), 'background-color'),
      offset: await thumbOffset(row),
    };

    // The two claims that were false. Both are asserted because they are two separate
    // rules on two separate elements: the track's fill lives on its span, the thumb's
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
    await expect(control(receipts)).toBeVisible({ timeout: 20_000 });

    const receiptsState = await control(receipts).isChecked();
    if ((await control(previews).isChecked()) === receiptsState) {
      await previews.click();
      if (receiptsState) {
        await expect(control(previews)).not.toBeChecked({ timeout: 10_000 });
      } else {
        await expect(control(previews)).toBeChecked({ timeout: 10_000 });
      }
    }

    expect(await settled(track(receipts), 'background-color')).not.toBe(
      await settled(track(previews), 'background-color'),
    );
  });
});
