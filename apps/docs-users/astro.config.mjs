import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://quwisky.github.io',
  base: '/trinity-matrix-client/users',
  outDir: new URL('../../dist/docs/users/', import.meta.url),
  integrations: [
    starlight({
      title: 'Trinity User Guide',
    }),
  ],
});
