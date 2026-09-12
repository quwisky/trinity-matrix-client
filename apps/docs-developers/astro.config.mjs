import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://quwisky.github.io',
  base: '/trinity-matrix-client/developers',
  outDir: new URL('../../dist/docs/developers/', import.meta.url),
  integrations: [
    starlight({
      title: 'Trinity Developer Guide',
    }),
  ],
});
