import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.full.config.mts';
import { ELECTRON_SMOKE_SUITE } from '../support/host-suites.mts';
import { e2eReportConfig } from '../support/playwright-config.mts';

/** Docker-independent Electron shell protocol and security proof. */
export default defineConfig({
  ...electronConfig,
  ...e2eReportConfig(ELECTRON_SMOKE_SUITE),
  testMatch: 'app.electron.spec.mts',
});
