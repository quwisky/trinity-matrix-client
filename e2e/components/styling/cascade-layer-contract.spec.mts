import { expect, test, type Locator, type Page } from '@playwright/test';

interface CascadeProbe {
  readonly panel: Locator;
  readonly primary: Locator;
  readonly danger: Locator;
  readonly disabledToken: Locator;
  readonly disabled: Locator;
  readonly routed: Locator;
  readonly nativeTextarea: Locator;
  readonly trinityTextarea: Locator;
}

async function installProbe(page: Page): Promise<CascadeProbe> {
  await page.goto('/login');
  await page.locator('body').waitFor();

  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.id = 'cascade-panel';
    panel.className = 'panel-header bg-primary text-destructive';

    const primary = document.createElement('div');
    primary.id = 'cascade-primary';
    primary.style.backgroundColor = 'var(--primary)';

    const danger = document.createElement('div');
    danger.id = 'cascade-danger';
    danger.style.color = 'var(--trinity-danger)';

    const disabled = document.createElement('button');
    disabled.id = 'cascade-disabled';
    disabled.className = 'disabled:opacity-50';
    disabled.disabled = true;

    const disabledToken = document.createElement('div');
    disabledToken.id = 'cascade-disabled-token';
    disabledToken.style.opacity = 'var(--trinity-disabled-opacity)';

    const outlet = document.createElement('router-outlet');
    const routed = document.createElement('section');
    routed.id = 'cascade-routed';
    routed.className = 'hidden';

    const nativeTextarea = document.createElement('textarea');
    nativeTextarea.id = 'cascade-native-textarea';

    const trinityTextarea = document.createElement('textarea');
    trinityTextarea.id = 'cascade-trinity-textarea';
    trinityTextarea.dataset['slot'] = 'textarea';
    trinityTextarea.className =
      'outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

    document.body.append(
      panel,
      primary,
      danger,
      disabledToken,
      disabled,
      outlet,
      routed,
      nativeTextarea,
      trinityTextarea,
    );
  });

  return {
    panel: page.locator('#cascade-panel'),
    primary: page.locator('#cascade-primary'),
    danger: page.locator('#cascade-danger'),
    disabledToken: page.locator('#cascade-disabled-token'),
    disabled: page.locator('#cascade-disabled'),
    routed: page.locator('#cascade-routed'),
    nativeTextarea: page.locator('#cascade-native-textarea'),
    trinityTextarea: page.locator('#cascade-trinity-textarea'),
  };
}

const computed = (locator: Locator, property: 'backgroundColor' | 'color') =>
  locator.evaluate(
    (element, name) => getComputedStyle(element)[name],
    property,
  );

test('compiled cascade preserves defaults, utilities, and invariants', async ({
  page,
}) => {
  const probe = await installProbe(page);

  // `panel-header` is an authored component default. The generated utility owns the
  // contextual background because `utilities` follows `components`.
  expect(await computed(probe.panel, 'backgroundColor')).toBe(
    await computed(probe.primary, 'backgroundColor'),
  );

  // The destructive ink correction is a deliberate invariant, so `overrides` follows the
  // original `text-destructive` utility and resolves to the measured semantic role.
  expect(await computed(probe.panel, 'color')).toBe(
    await computed(probe.danger, 'color'),
  );

  // Disabled strength is a semantic invariant; the override tier prevents a caller from
  // introducing a second disabled recipe with an arbitrary utility value.
  await expect(probe.disabled).toHaveCSS(
    'opacity',
    await probe.disabledToken.evaluate(
      (element) => getComputedStyle(element).opacity,
    ),
  );

  // Component defaults no longer reverse a caller's shell utility.
  await expect(probe.routed).toHaveCSS('display', 'none');

  await probe.nativeTextarea.focus();
  await expect(probe.nativeTextarea).toHaveCSS('outline-style', 'solid');

  await probe.trinityTextarea.focus();
  await expect(probe.trinityTextarea).toHaveCSS('outline-style', 'none');
  expect(
    await probe.trinityTextarea.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    ),
  ).not.toBe('none');
});
