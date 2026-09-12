import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  site: 'https://quwisky.github.io',
  base: '/trinity-matrix-client/developers',
  outDir: fileURLToPath(
    new URL('../../dist/docs/developers/', import.meta.url),
  ),
  integrations: [
    starlight({
      title: 'Trinity Developer Guide',
    }),
  ],
});
