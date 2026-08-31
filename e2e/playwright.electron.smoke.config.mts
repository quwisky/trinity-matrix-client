import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.electron.config.mts';
import { registeredE2ESuite } from './registry/index.mts';
import { e2eReportConfig } from './support/playwright-config.mts';

/**
 * Docker-independent Electron shell proof. It deliberately has no Synapse setup:
 * the selected app journey covers launch, the custom scheme, crypto WASM, protocol
 * negotiation, IPC isolation, secure storage, CORS and dark styling without an account.
 */
export default defineConfig({
  ...electronConfig,
  ...e2eReportConfig(registeredE2ESuite('electron.smoke')),
  testMatch: 'app.electron.spec.mts',
});
