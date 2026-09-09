import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// The rest of the `data-*` variant sweep, measured where the cascade decides.
//
// `switch-state.spec.mts` covers the checked pair. These are the other two attributes with
// the same shape — one name, several values — against kit classes written as if each value
// were its own attribute:
//
//   `data-state="active"`      styled as `data-active:bg-background`  (tabs)
//   `data-orientation="vertical"` styled as `data-vertical:w-px`      (separator, toggle group)
//
// Both were dead. Every Room-settings tab computed to `rgba(0, 0, 0, 0)`, so nothing said
// which one was open, and the composer's formatting rules measured `width: 0px` — invisible,
// on the element its own template comment calls "the only place that grouping is stated".
//
// A unit test cannot make either claim: jsdom applies no CSS, so both elements carry exactly
// the classes the author wrote and every assertion about them passes.
const session = synapseSession();

/** A throwaway account with one room, logged in and open. */
async function openRoom(
  page: Page,
  request: APIRequestContext,
  tag: string,
): Promise<void> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
  const user = `kitstyle-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Kit ${runId}`;

  await registerUser(request, user, pass);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: { name: roomName, preset: 'private_chat' },
  });

  await login(page, { available: true, hs, user, pass } as SynapseSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

const styleOf = (locator: Locator, property: string): Promise<string> =>
  locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );

test.describe('Kit state styling', () => {
  test.skip(
    !session.available,
    'requires the disposable Synapse homeserver (Docker)',
  );

  test('the open tab looks different from the closed ones', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await openRoom(page, request, 't');

    await page.getByTestId('open-room-settings').click();
    await expect(page.getByTestId('room-settings')).toBeVisible({
      timeout: 15_000,
    });

    const tabs = page.locator('[data-trn-settings-section]');
    await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
    expect(await tabs.count()).toBeGreaterThan(1);

    const active = page
      .locator('[data-trn-settings-section][aria-current="page"]')
      .first();
    await expect(active).toBeVisible();
    const inactive = page
      .locator('[data-trn-settings-section]:not([aria-current="page"])')
      .first();
    await expect(inactive).toBeVisible();

    // The current settings directory exposes the active page semantically and uses the
    // button's solid/ghost presentation to distinguish it visually.
    await expect(active).toHaveAttribute('aria-current', 'page');
    expect(await styleOf(active, 'color')).not.toBe(
      await styleOf(inactive, 'color'),
    );
  });
});
