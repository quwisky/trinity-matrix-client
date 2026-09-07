import { defineConfig } from 'vite';

import { createVitestConfig } from '../../../vite.base.config.ts';

export default defineConfig(() =>
  createVitestConfig(import.meta.dirname, {
    test: { environment: 'node', setupFiles: [] },
  }),
);
