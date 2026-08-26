import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './android',
  testMatch: '**/*.spec.mts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 120_000,
  outputDir: '../dist/.playwright/android/test-output',
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: '../dist/.playwright/android/report', open: 'never' },
    ],
  ],
  projects: [{ name: 'android-webview' }],
});
