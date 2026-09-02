import { expect, test, type Locator } from '@playwright/test';
import { renderedColour, renderedRecipeStyle } from './recipe-appearance.mts';
import {
  STORYBOOK_THEME_PREVIEWS,
  expectStorybookThemeRoot,
  storybookThemeGlobals,
} from './theme-preview.mts';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;

const renderedBox = (locator: Locator) =>
  locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      display: style.display,
      height: bounds.height,
      width: bounds.width,
    };
  });

const computedDimensions = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: Number.parseFloat(style.height),
      width: Number.parseFloat(style.width),
    };
  });

test('canonical recipes preserve valid compatibility rendering', async ({
  page,
}) => {
  await page.goto(story('components-icon--compatibility-length'));
  await expect(page.getByTestId('icon-canonical-lg')).toBeVisible();
  expect(await renderedBox(page.getByTestId('icon-canonical-lg'))).toEqual(
    await renderedBox(page.getByTestId('icon-legacy-lg')),
  );

  await page.goto(story('components-avatar--compatibility-geometry'));
  await expect(page.getByTestId('avatar-canonical')).toBeVisible();
  const canonicalAvatar = await renderedBox(
    page.getByTestId('avatar-canonical').locator('hlm-avatar'),
  );
  expect(canonicalAvatar).toEqual(
    await renderedBox(page.getByTestId('avatar-legacy').locator('hlm-avatar')),
  );
  expect(canonicalAvatar).toEqual(
    await renderedBox(page.getByTestId('avatar-exact').locator('hlm-avatar')),
  );

  await page.goto(story('components-badge--compatibility-default'));
  await expect(page.getByTestId('badge-canonical-neutral')).toBeVisible();
  expect(
    await renderedRecipeStyle(page.getByTestId('badge-canonical-neutral')),
  ).toEqual(
    await renderedRecipeStyle(page.getByTestId('badge-legacy-default')),
  );

  await page.goto(story('components-banner--compatibility-tone'));
  await expect(page.getByTestId('banner-canonical')).toBeVisible();
  expect(
    await renderedRecipeStyle(
      page.getByTestId('banner-canonical').locator('.banner'),
    ),
  ).toEqual(
    await renderedRecipeStyle(
      page.getByTestId('banner-legacy').locator('.banner'),
    ),
  );

  await page.goto(story('components-empty-state--compatibility-names'));
  await expect(page.getByTestId('empty-canonical')).toBeVisible();
  expect(
    await renderedRecipeStyle(
      page.getByTestId('empty-canonical').locator(':scope > div'),
    ),
  ).toEqual(
    await renderedRecipeStyle(
      page.getByTestId('empty-legacy').locator(':scope > div'),
    ),
  );
});

test('canonical ordinal sizes render the bounded component subsets', async ({
  page,
}) => {
  await page.goto(story('components-icon--canonical-sizes'));
  for (const [size, pixels] of [
    ['2xs', 12],
    ['xs', 14],
    ['sm', 16],
    ['md', 18],
    ['lg', 20],
    ['xl', 24],
    ['2xl', 32],
  ] as const) {
    const icon = page.getByTestId(`icon-${size}`);
    await expect(icon).toBeVisible();
    expect(await renderedBox(icon)).toMatchObject({
      display: 'inline-flex',
      height: pixels,
      width: pixels,
    });
  }

  await page.goto(story('components-avatar--canonical-sizes'));
  for (const [size, pixels] of [
    ['2xs', 16],
    ['xs', 20],
    ['sm', 24],
    ['md', 28],
    ['lg', 32],
    ['xl', 40],
    ['2xl', 48],
  ] as const) {
    expect(
      await renderedBox(
        page.getByTestId(`avatar-${size}`).locator('hlm-avatar'),
      ),
    ).toMatchObject({ height: pixels, width: pixels });
  }

  await page.goto(story('components-spinner--canonical-recipes'));
  for (const [size, pixels] of [
    ['xs', 12],
    ['sm', 14],
    ['md', 16],
    ['lg', 20],
  ] as const) {
    const spinner = page.getByTestId(`spinner-${size}`);
    expect(await renderedBox(spinner)).toMatchObject({
      display: 'inline-flex',
    });
    // The spinner rotates continuously, so getBoundingClientRect() is the
    // transformed axis-aligned box. Its computed layout size is the contract.
    expect(await computedDimensions(spinner.locator('ng-icon'))).toMatchObject({
      height: pixels,
      width: pixels,
    });
  }

  await page.goto(story('components-progress--canonical-recipes'));
  for (const [testId, pixels] of [
    ['progress-accent-xs', 2],
    ['progress-success-sm', 4],
    ['progress-warning-md', 6],
  ] as const) {
    expect(
      await renderedBox(page.getByTestId(testId).locator('[role=progressbar]')),
    ).toMatchObject({ height: pixels });
  }
  expect(
    await page
      .getByTestId('progress-indeterminate')
      .locator('[role=progressbar]')
      .getAttribute('aria-valuenow'),
  ).toBeNull();
});

for (const preview of STORYBOOK_THEME_PREVIEWS) {
  test(`${preview.theme.id} ${preview.mode.id} content statuses resolve through semantic tokens`, async ({
    page,
  }) => {
    await page.goto(
      `${story('components-content-recipe-matrix--semantic-statuses')}&globals=${storybookThemeGlobals(preview)}`,
    );
    await expectStorybookThemeRoot(page, preview);
    await expect(page.getByTestId('matrix-avatar-online')).toBeVisible();

    for (const [testId, token] of [
      ['matrix-icon-neutral', '--trinity-text'],
      ['matrix-icon-accent', '--trinity-link'],
      ['matrix-icon-muted', '--trinity-text-muted'],
      ['matrix-icon-danger', '--trinity-danger'],
    ] as const) {
      expect(await renderedColour(page.getByTestId(testId), 'color')).toEqual(
        await renderedColour(page.getByTestId(testId), token),
      );
    }

    for (const [testId, token] of [
      ['matrix-avatar-online', '--trinity-status-success-surface'],
      ['matrix-avatar-away', '--trinity-status-warning-surface'],
      ['matrix-avatar-offline', '--trinity-control-muted-foreground'],
    ] as const) {
      const avatar = page.getByTestId(testId);
      expect(
        await renderedColour(
          avatar.locator('.presence-dot'),
          'backgroundColor',
        ),
      ).toEqual(await renderedColour(avatar, token));
    }

    for (const [testId, surface, foreground] of [
      [
        'matrix-badge-neutral',
        '--trinity-status-neutral-surface',
        '--trinity-status-neutral-foreground',
      ],
      [
        'matrix-badge-success',
        '--trinity-status-success-surface',
        '--trinity-status-success-surface-foreground',
      ],
      [
        'matrix-badge-warning',
        '--trinity-status-warning-surface',
        '--trinity-status-warning-surface-foreground',
      ],
    ] as const) {
      const badge = page.getByTestId(testId);
      expect(await renderedColour(badge, 'backgroundColor')).toEqual(
        await renderedColour(badge, surface),
      );
      expect(await renderedColour(badge, 'color')).toEqual(
        await renderedColour(badge, foreground),
      );
    }

    for (const [testId, token] of [
      ['matrix-progress-accent', '--trinity-state-attention-surface'],
      ['matrix-progress-success', '--trinity-status-success-surface'],
      ['matrix-progress-warning', '--trinity-status-warning-surface'],
      ['matrix-progress-danger', '--trinity-status-danger-surface'],
    ] as const) {
      const progress = page.getByTestId(testId);
      expect(
        await renderedColour(
          progress.locator('[data-slot=progress-indicator]'),
          'backgroundColor',
        ),
      ).toEqual(await renderedColour(progress, token));
    }

    for (const [testId, token] of [
      ['matrix-spinner-neutral', '--trinity-text'],
      ['matrix-spinner-muted', '--trinity-text-muted'],
      ['matrix-spinner-accent', '--trinity-link'],
      ['matrix-spinner-danger', '--trinity-danger'],
    ] as const) {
      const spinner = page.getByTestId(testId);
      expect(
        await renderedColour(spinner.locator('hlm-spinner'), 'color'),
      ).toEqual(await renderedColour(spinner, token));
    }

    const banner = page.getByTestId('matrix-banner-accent');
    expect(
      await renderedColour(banner.locator('.banner'), 'backgroundColor'),
    ).toEqual(
      await renderedColour(banner, '--trinity-state-attention-surface'),
    );
    expect(await renderedColour(banner.locator('.banner'), 'color')).toEqual(
      await renderedColour(banner, '--trinity-state-attention-foreground'),
    );

    const empty = page.getByTestId('matrix-empty-danger');
    expect(await renderedColour(empty.locator('p.text-13'), 'color')).toEqual(
      await renderedColour(empty, '--trinity-danger'),
    );
  });
}

test('tooltip position stays behavioral on the semantic tooltip surface', async ({
  page,
}) => {
  await page.goto(story('components-tooltip--positions'));
  const trigger = page.getByTestId('tooltip-top');
  const tooltip = page.getByRole('tooltip');
  // BrnTooltip installs its trigger listeners after Angular's next render. Storybook
  // can expose the button just before that callback runs, so retry the real keyboard
  // interaction instead of adding a timing sleep or opening the overlay directly.
  await expect(async () => {
    await trigger.blur();
    await trigger.focus();
    await expect(tooltip).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 5_000 });
  await expect(tooltip).toHaveAttribute('data-side', 'top');
  expect(await renderedColour(tooltip, 'backgroundColor')).toEqual(
    await renderedColour(trigger, '--trinity-tooltip-surface'),
  );
  expect(await renderedColour(tooltip, 'color')).toEqual(
    await renderedColour(trigger, '--trinity-tooltip-foreground'),
  );
});
