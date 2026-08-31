import { defineConfig } from '@playwright/test';
import { ANDROID_INSTALLED_WEBVIEW_SUITE } from '../support/host-suites.mts';
import { e2eReportConfig } from '../support/playwright-config.mts';

export default defineConfig({
  testDir: '..',
  testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts'],
  ...e2eReportConfig(ANDROID_INSTALLED_WEBVIEW_SUITE),
  fullyParallel: false,
  workers: 1,
  retries: 2,
  timeout: 120_000,
  use: {
    // Canonical journeys default to the wide shell. Mobile specs retain their own
    // viewport/touch overrides while Capacitor still reports Android.
    viewport: { width: 1280, height: 720 },
    hasTouch: false,
    isMobile: false,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'android-webview' }],
});
