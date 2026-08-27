import { test, expect, type Page } from './support/fixtures.mts';
import {
  isAndroidE2E,
  login,
  preferenceKeys,
  seedPreference,
  synapseSession,
} from './support/app.mts';
import {
  AA_NORMAL_TEXT,
  measureContrast,
  resolveTokenSrgb,
} from './support/contrast.mts';

// End-to-end for "Clear all data" (issue #96): the escape hatch on the login page for an
// install whose local state is wedged, when devtools are not an option — which is to say
// on iOS, Android and the desktop shell, always.
//
// Driven against a real homeserver because the thing being asserted is that real state
// EXISTED and is then GONE. A wipe test that never proves there was anything to wipe is the
// classic vacuous pass, so each case snapshots the pre-state first and fails if it is empty.
//
// Two coverage gaps, stated rather than implied, both covered by unit tests instead:
//
//   1. The Playwright webServer builds the `development` configuration, where
//      `provideServiceWorker` is disabled (it is gated on `environment.production`), so
//      nothing here exercises the service-worker/Cache Storage phase.
//   2. On web the raw `localStorage.clear()` subsumes `Preferences.clear()` — both wipe the
//      same `CapacitorStorage.`-prefixed keys — so this spec cannot tell them apart, and
//      deleting the Preferences call alone leaves it green. It still matters on iOS and
//      Android, where Preferences is UserDefaults/SharedPreferences rather than the
//      WebView's localStorage, so it is pinned in local-data-wipe.service.spec.ts instead.
//
// Both were found by injecting the defect and watching this spec pass anyway.
const session = synapseSession();

/** Every CapacitorStorage-namespaced key currently in localStorage. */
function storageKeys(page: Page): Promise<string[]> {
  return preferenceKeys(page).then((keys) =>
    keys.map((key) => `CapacitorStorage.${key}`),
  );
}

/** Every IndexedDB database name, or [] where the browser cannot enumerate. */
function databaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    if (typeof indexedDB.databases !== 'function') {
      return [];
    }
    const dbs = await indexedDB.databases();
    return dbs.map((d) => d.name).filter((n): n is string => !!n);
  });
}

/**
 * Wait for our namespace to empty, tolerating the document swap.
 *
 * NOT `waitForURL`: the restart replaces `/login` with `/`, which Angular routes straight
 * back to `/login` — so a URL predicate matching either is already true before anything
 * happens, and the assertions would run against a page mid-wipe. Poll the outcome instead.
 * `evaluate` throws while the execution context is being torn down, which is expected here
 * rather than a failure.
 */
async function waitForEmptyStorage(page: Page): Promise<void> {
  await expect
    .poll(async () => (await storageKeys(page).catch(() => null))?.length, {
      timeout: 30_000,
    })
    .toBe(0);
}

/** Type a word into the erase confirmation and press its confirm button. */
async function confirmErase(page: Page, word: string): Promise<void> {
  const dialog = page.locator('trn-alert-dialog', {
    hasText: 'Erase all Trinity data',
  });
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  await dialog.locator('input').fill(word);
  await dialog.getByTestId('alert-confirm').click();
}

test.describe('Clear all data', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('erases a signed-in install and restarts into an empty app', async ({
    page,
  }) => {
    await login(page, session);

    // Prove there is something to erase. Without this the assertions below would pass just
    // as happily against an install that had never stored anything.
    const before = {
      keys: await storageKeys(page),
      dbs: await databaseNames(page),
    };
    // The key carries the full MXID, not the localpart `session.user` holds.
    if (!isAndroidE2E) {
      expect(
        before.keys.some((k) =>
          k.startsWith('CapacitorStorage.secure.matrix.accessToken:@'),
        ),
      ).toBe(true);
    }
    expect(before.keys).toContain('CapacitorStorage.matrix.accounts');
    expect(
      before.dbs.some((n) => n.startsWith('matrix-js-sdk:trinity-sync:@')),
    ).toBe(true);
    expect(before.dbs.some((n) => n.endsWith('::matrix-sdk-crypto'))).toBe(
      true,
    );

    // Deliberately from ?add: the clients are LIVE, holding open the very databases the
    // wipe has to delete. That is the state the bounded-delete path exists for, and the
    // one a signed-out test would never reach.
    await page.goto('/login?add', { waitUntil: 'networkidle' });

    // A mistyped word must erase nothing at all.
    await page.getByTestId('clear-all-data').click();
    await confirmErase(page, 'yes please');
    await expect(page.getByText(/Type ERASE exactly/)).toBeVisible();
    expect(await storageKeys(page)).toContain(
      'CapacitorStorage.matrix.accounts',
    );

    // Lower case on purpose — the gate normalises before comparing.
    await page.getByTestId('clear-all-data').click();
    await confirmErase(page, 'erase');

    // The app replaces itself with a fresh document at the app root.
    await waitForEmptyStorage(page);
    await page.waitForLoadState('networkidle');

    // Assert in the NEW document: nothing of ours survived.
    const after = await expect
      .poll(() => databaseNames(page).catch(() => null), { timeout: 30_000 })
      .not.toBeNull()
      .then(() => databaseNames(page));
    for (const name of before.dbs) {
      expect(after).not.toContain(name);
    }
    // And it really is a signed-out app, not a cached view of a signed-in one.
    await expect(page.getByLabel('Homeserver')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('erases a signed-out install whose settings are wedged', async ({
    page,
  }) => {
    // The case the issue is actually about: cannot sign in, so there is no account to read
    // — but a bad preference (here a dead push gateway) is still on disk with no way to
    // reach it from the UI.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await seedPreference(
      page,
      'trinity.push.gateway',
      'https://dead.example/_matrix/push/v1/notify',
    );
    expect(await storageKeys(page)).toContain(
      'CapacitorStorage.trinity.push.gateway',
    );

    await page.getByTestId('clear-all-data').click();
    await confirmErase(page, 'ERASE');

    // waitForEmptyStorage already proves the namespace is empty, which subsumes any
    // not.toContain on a single key.
    await waitForEmptyStorage(page);
    await page.waitForLoadState('networkidle');
  });
});

/**
 * The escape hatch has to LOOK destructive — deliberately outside the Synapse describe
 * above, because that is true of a signed-out install with no homeserver at all, so this
 * runs on every PR rather than only where Docker does.
 *
 * The unit test beside this one can only assert class names: jsdom has no Tailwind and no
 * theme tokens, so a `text-danger` that resolved to nothing, or to the near-black maroon
 * documented in theme/spartan.css, stays green there. This is the only layer that reads the
 * colour a person actually gets.
 *
 * Both palettes, because the argument for this styling is surface-specific — `amethyst`
 * overrides `--trinity-sidebar`, the very surface the ratio is measured against, while
 * leaving `--trinity-danger` alone.
 */
const PALETTES = [
  { id: 'trinity', attribute: null },
  { id: 'amethyst', attribute: 'amethyst' },
] as const;

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`Clear all data — destructive styling (${scheme})`, () => {
    // Set on the CONTEXT rather than patched onto a live page, so the scheme is already
    // right when ThemeService runs in provideAppInitializer, before the first paint.
    test.use({ colorScheme: scheme });

    for (const palette of PALETTES) {
      test(`stays a legible danger red on ${palette.id}`, async ({ page }) => {
        // The palette is restored from Preferences on boot, so seed it the way the app
        // stores it rather than reaching into ThemeService.
        await seedPreference(page, 'trinity.palette', palette.id);
        await page.goto('/login', { waitUntil: 'networkidle' });
        const button = page.getByTestId('clear-all-data');
        await button.waitFor({ state: 'visible', timeout: 20_000 });

        // Without this the theme could silently fail to apply and every assertion below
        // would re-measure the light/default case twice and still pass — and dark is where
        // the token trap actually lives.
        await expect
          .poll(() =>
            page.evaluate(() => ({
              dark: document.documentElement.classList.contains('dark'),
              theme: document.documentElement.getAttribute('data-theme'),
            })),
          )
          .toEqual({ dark: scheme === 'dark', theme: palette.attribute });

        const danger = await resolveTokenSrgb(
          page,
          'clear-all-data',
          '--trinity-danger',
        );

        for (const state of ['rest', 'hover'] as const) {
          if (state === 'hover') {
            // Ghost's hover paints a translucent `--muted` UNDER a label that
            // `hover:text-danger` keeps red; both halves only exist at this layer.
            await button.hover();
          }
          const measured = await measureContrast(page, 'clear-all-data');
          const where = `${palette.id}/${scheme}/${state}`;

          // Legibility alone would not say this looks DESTRUCTIVE: plain `--foreground` is
          // near-black and clears the ratio comfortably while reading as an ordinary link.
          // Pinning the label to the danger token is what makes this a styling test.
          expect(measured.text, `${where}: label is the danger token`).toEqual(
            danger,
          );

          expect(
            measured.ratio,
            `${where}: ${measured.ratio.toFixed(2)}:1 over ${measured.layers.join(' + ')}`,
          ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        }
      });
    }
  });
}
