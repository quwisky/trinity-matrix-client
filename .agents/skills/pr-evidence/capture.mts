/**
 * Capture dark-theme phone and desktop screenshots of app routes for PR evidence.
 *
 *   node .agents/skills/pr-evidence/capture.mts --base http://localhost:4200 \
 *     --out dist/pr-evidence/1234 [--hs <url> --user <u> --pass <p>] /rooms /settings ...
 *
 * Reuses the redesign-evidence viewports and the browser journeys' UI login.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { DESIGN_VIEWPORTS } from '../../../e2e/browser/support/design-viewports.mts';
import { login } from '../../../e2e/support/app.mts';

const { values, positionals: routes } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://localhost:4200' },
    out: { type: 'string', default: 'dist/pr-evidence' },
    hs: { type: 'string' },
    user: { type: 'string' },
    pass: { type: 'string' },
  },
});

mkdirSync(values.out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const name of ['phone-pixel-5', 'desktop-wide'] as const) {
    const context = await browser.newContext({
      ...DESIGN_VIEWPORTS[name],
      baseURL: values.base,
      colorScheme: 'dark',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    if (values.hs) {
      await login(page, { available: true, hs: values.hs, user: values.user, pass: values.pass });
    }
    for (const route of routes.length ? routes : ['/']) {
      await page.goto(route, { waitUntil: 'networkidle' });
      const slug = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
      const file = join(values.out, `${slug}-${name}-dark.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(file);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
