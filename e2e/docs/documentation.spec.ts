import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';

const pagesBase = '/trinity-matrix-client';

interface AxeNodeResult {
  readonly html: string;
  readonly target: readonly (string | readonly string[])[];
}

interface AxeViolation {
  readonly help: string;
  readonly id: string;
  readonly nodes: readonly AxeNodeResult[];
}

const axeViolations = async (page: Page): Promise<readonly AxeViolation[]> =>
  page.evaluate(async (source) => {
    const script = document.createElement('script');
    script.textContent = source;
    document.head.append(script);
    const result = await window.axe.run(document);
    return result.violations;
  }, axe.source);

const formatViolations = (violations: readonly AxeViolation[]): string[] =>
  violations.flatMap((violation) =>
    violation.nodes.map(
      (node) =>
        `${violation.id}: ${violation.help} at ${JSON.stringify(node.target)} (${node.html})`,
    ),
  );

test('routes readers from the Pages root with keyboard-visible choices', async ({
  page,
}) => {
  await page.goto('./');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Trinity documentation' }),
  ).toBeVisible();
  const audiences = page.getByRole('navigation', {
    name: 'Documentation audiences',
  });
  const users = audiences.getByRole('link', { name: /Use Trinity/ });
  const developers = audiences.getByRole('link', { name: /Develop Trinity/ });
  await expect(users).toHaveAttribute('href', './users/');
  await expect(developers).toHaveAttribute('href', './developers/');

  await page.keyboard.press('Tab');
  await expect(users).toBeFocused();
  await expect(users).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${pagesBase}/users/`);
});

test('keeps release users on the WIP page and links across the Pages base', async ({
  page,
}) => {
  await page.goto('users/');

  await expect(
    page.getByRole('complementary', { name: 'Documentation channel' }),
  ).toContainText('Work in progress');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Trinity is still in development',
    }),
  ).toBeVisible();
  const developerGuide = page
    .getByRole('main')
    .getByRole('link', { name: 'developer guide' });
  await expect(developerGuide).toHaveAttribute(
    'href',
    `${pagesBase}/developers/`,
  );
  await developerGuide.click();
  await expect(page).toHaveURL(`${pagesBase}/developers/`);
});

test('navigates developer onboarding and exposes the develop channel', async ({
  page,
}) => {
  await page.goto('developers/');

  await expect(
    page.getByRole('complementary', { name: 'Documentation channel' }),
  ).toContainText('Develop branch');
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Prerequisites' })
    .click();
  await expect(page).toHaveURL(`${pagesBase}/developers/start/prerequisites/`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Prerequisites' }),
  ).toBeVisible();

  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
});

test('keeps each Starlight search inside its content channel', async ({
  page,
}) => {
  await page.goto('developers/');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('textbox', { name: 'Search' }).fill('Nx');
  const developerResults = page.locator('#starlight__search a');
  await expect(developerResults.first()).toBeVisible();
  for (const href of await developerResults.evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')),
  )) {
    expect(href).toMatch(/^\/trinity-matrix-client\/developers\//);
  }

  await page.goto('users/');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('textbox', { name: 'Search' }).fill('Nx');
  await expect(page.locator('#starlight__search')).toContainText(
    /No results|zero results/i,
  );
  await expect(page.locator('#starlight__search a')).toHaveCount(0);
});

test('serves a recoverable 404 and rejects decoded traversal', async ({
  page,
  request,
}) => {
  const response = await page.goto('missing/topic/');
  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Page not found' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Developer guide' }),
  ).toHaveAttribute('href', `${pagesBase}/developers/`);

  for (const path of ['%2e%2e/package.json', '%2e%2e%5cpackage.json']) {
    const traversal = await request.get(
      `http://127.0.0.1:4178${pagesBase}/${path}`,
    );
    expect(traversal.status()).toBe(404);
    expect(await traversal.text()).not.toContain('"name": "trinity"');
  }
});

test('loads representative pages without broken assets', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(response.url());
  });

  for (const path of [
    './',
    'users/',
    'developers/',
    'developers/architecture/system-overview/',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }

  expect(failures).toEqual([]);
});

test('keeps the developer guide usable at a mobile viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('developers/');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Develop Trinity' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByRole('button', { name: /Menu/i })).toBeVisible();
});

test('has no automated accessibility violations in shared layouts', async ({
  page,
}) => {
  for (const path of ['./', 'users/', 'developers/', 'missing/topic/']) {
    await page.goto(path);
    const violations = await axeViolations(page);
    expect(formatViolations(violations), path).toEqual([]);
  }
});

declare global {
  interface Window {
    axe: {
      run(context: Document): Promise<{ violations: AxeViolation[] }>;
    };
  }
}
