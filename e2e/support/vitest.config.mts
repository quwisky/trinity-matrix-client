import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.spec.mts'],
    pool: 'forks',
    // The developer's shell may export an offset; the specs stub the ones they test.
    env: { TRINITY_E2E_PORT_OFFSET: '' },
  },
});
