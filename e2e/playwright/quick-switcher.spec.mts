import { test, expect } from '@playwright/test';
import { login, synapseSession } from './support/app.mts';

// The quick switcher's whole point is open-and-type, so the acceptance test types
// without clicking into the field first: the characters must land in the search input.
//
// The dialog names that input with `data-autofocus` and QuickSwitcherService passes it
// as the CDK dialog's `autoFocus` selector. A component-side `focus()` cannot do this
// job — CDK focuses after attach and would override it with the first tabbable element,
// which here is the header's Cancel button (issue #11).
//
// Needs a Synapse homeserver (Docker) for the login; self-skips otherwise.
const session = synapseSession();

test.describe('Quick switcher', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('opens with the search field focused, so typing goes straight into it', async ({
    page,
  }) => {
    await login(page, session);

    await page.getByTestId('open-switcher').click();

    const search = page.getByPlaceholder('Search rooms, spaces, people');
    await expect(search).toBeVisible({ timeout: 15_000 });
    await expect(search).toBeFocused({ timeout: 10_000 });

    // The real acceptance: no click into the field, the keystrokes just arrive.
    await page.keyboard.type('trinity');
    await expect(search).toHaveValue('trinity');
  });
});
