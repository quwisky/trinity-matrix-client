import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

describe('Electron Playwright image-pack coverage', () => {
  it('joins the support-owned disposable Synapse lifecycle', () => {
    const config = read('e2e/electron/playwright.full.config.mts');
    const project = read('e2e/electron/project.json');
    const hostProject = read('electron/project.json');
    expect(config).not.toContain('globalSetup');
    expect(config).not.toContain('globalTeardown');
    expect(config).toContain('ignoreHTTPSErrors: true');
    expect(project).toContain('support/run-playwright.mts');
    expect(project).toContain('--resource=electron --resource=synapse');
    expect(hostProject).toContain('trinity-e2e-electron:full');
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
    const journey = read('e2e/support/image-pack-management-journey.mts');
    expect(journey).toContain('runImagePackManagementJourney');
    expect(journey).not.toMatch(/\btest\s*(?:\.|\()/);

    const webSpec = read(
      'e2e/browser/journeys/conversations/stickers-custom-emoji.spec.mts',
    );
    expect(webSpec).toContain("from '../../../fixtures.mts'");
    expect(webSpec).toContain('verifyInstalledOnSecondClient');
  });
});
