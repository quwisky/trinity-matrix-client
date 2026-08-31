import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts'],
  fullyParallel: false,
  workers: 1,
  retries: 2,
  timeout: 120_000,
  outputDir: '../dist/.playwright/android/test-output',
  use: {
    // Canonical journeys default to the wide shell. Mobile specs retain their own
    // viewport/touch overrides while Capacitor still reports the Android platform.
    viewport: { width: 1280, height: 720 },
    hasTouch: false,
    isMobile: false,
  },
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: '../dist/.playwright/android/report', open: 'never' },
    ],
  ],
  projects: [{ name: 'android-webview' }],
});
