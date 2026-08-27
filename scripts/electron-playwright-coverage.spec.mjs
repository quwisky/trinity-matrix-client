import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

describe('Electron Playwright image-pack coverage', () => {
  it('owns the disposable Synapse lifecycle', () => {
    const config = read('e2e/playwright.electron.config.mts');
    expect(config).toContain(
      "globalSetup: './playwright/support/global-setup.mts'",
    );
    expect(config).toContain(
      "globalTeardown: './playwright/support/global-teardown.mts'",
    );
    expect(config).toContain('ignoreHTTPSErrors: true');
  });

  it('runs the canonical manager journey through the desktop shell', () => {
    const electronSpec = read(
      'e2e/electron/image-pack-management.electron.spec.mts',
    );
    expect(electronSpec).toContain('runImagePackManagementJourney');
    expect(electronSpec).toContain('navigate: electronNavigate');
    expect(electronSpec).toContain("'trinity://app/'");
  });

  it('keeps platform lifecycle outside the shared journey', () => {
    const journey = read(
      'e2e/playwright/support/image-pack-management-journey.mts',
    );
    expect(journey).toContain('runImagePackManagementJourney');
    expect(journey).not.toMatch(/\btest\s*(?:\.|\()/);

    const webSpec = read('e2e/playwright/stickers-custom-emoji.spec.mts');
    expect(webSpec).toContain("from './support/fixtures.mts'");
    expect(webSpec).toContain('verifyInstalledOnSecondClient');
  });
});
