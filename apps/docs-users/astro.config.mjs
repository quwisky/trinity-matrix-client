import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  site: 'https://quwisky.github.io',
  base: '/trinity-matrix-client/users',
  outDir: fileURLToPath(new URL('../../dist/docs/users/', import.meta.url)),
  integrations: [
    starlight({
      title: 'Trinity User Guide',
    }),
  ],
});
