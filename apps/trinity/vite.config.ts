import { defineConfig } from 'vite';

import { createVitestConfig } from '../../vite.base.config';

export default defineConfig(() =>
  createVitestConfig(__dirname, { test: { passWithNoTests: true } }),
);
