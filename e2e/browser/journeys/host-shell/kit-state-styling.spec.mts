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

/**
 * A pseudo-element's computed value.
 *
 * The settings dialogs use the `line` tab variant, whose active indicator is an underline
 * drawn as `::after` — the same class list sets `data-active:bg-transparent` for that
 * variant on purpose, so the trigger's own background is transparent whether or not it is
 * open, and asserting on it tests nothing.
 */
const pseudoStyleOf = (locator: Locator, property: string): Promise<string> =>
  locator.evaluate(
    (element, name) =>
      getComputedStyle(element, '::after').getPropertyValue(name),
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

    const tabs = page.locator('[role="tab"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
    expect(await tabs.count()).toBeGreaterThan(1);

    const active = page.locator('[role="tab"][data-state="active"]').first();
    await expect(active).toBeVisible();
    const inactive = page
      .locator('[role="tab"][data-state="inactive"]')
      .first();
    await expect(inactive).toBeVisible();

    // The claim the reader makes with their eyes, and the one that was false: the open tab
    // is underlined (`data-active:after:opacity-100`) and its label is brighter
    // (`data-active:text-foreground`). Both variants were dead, so all three tabs looked
    // the same.
    // Polled, not read once: the trigger carries `transition-all` and the underline
    // `after:transition-opacity`. This passes today only because the initially-active tab
    // renders active from first paint and never animates — an assumption that dies the
    // moment this test clicks a tab, and it costs nothing to not depend on it.
    await expect.poll(() => pseudoStyleOf(active, 'opacity')).toBe('1');
    await expect.poll(() => pseudoStyleOf(inactive, 'opacity')).toBe('0');
    expect(await styleOf(active, 'color')).not.toBe(
      await styleOf(inactive, 'color'),
    );
  });

  test('a vertical separator has a width', async ({ page, request }) => {
    test.setTimeout(150_000);
    await openRoom(page, request, 's');

    // The formatting bar is contextual: a selection raises it.
    const composer = page.getByTestId('composer-input');
    await composer.fill('say hello there');
    await composer.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(4, 9);
    });
    await expect(page.getByTestId('format-bold')).toBeVisible({
      timeout: 10_000,
    });

    // Scoped to the toolbar. A document-wide `[data-slot="separator"]` is unambiguous today
    // but would start failing against correct code the day a HORIZONTAL separator renders
    // earlier in the room view.
    const rule = page
      .locator('trn-composer-toolbar [data-slot="separator"]')
      .first();
    await expect(rule).toHaveAttribute('data-orientation', 'vertical');

    // A rule with no width is not a rule. `data-vertical:w-px` is the only thing that gives
    // it one — the base class is `inline-flex shrink-0 bg-border`, which has no size of its
    // own, so a broken pairing renders a 0px element that is still "visible" to Playwright.
    const box = await rule.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
  });
});
