import { defineConfig } from 'vite';

import { createVitestConfig } from '../../vite.base.config.ts';

// No `passWithNoTests`: deleting every composition-root spec should fail, not pass.
export default defineConfig(() => createVitestConfig(import.meta.dirname));
