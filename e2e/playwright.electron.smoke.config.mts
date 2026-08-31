import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.electron.config.mts';

/**
 * Docker-independent Electron shell proof. It deliberately has no Synapse setup:
 * the selected app journey covers launch, the custom scheme, crypto WASM, protocol
 * negotiation, IPC isolation, secure storage, CORS and dark styling without an account.
 */
export default defineConfig({
  ...electronConfig,
  testMatch: 'app.electron.spec.mts',
});
