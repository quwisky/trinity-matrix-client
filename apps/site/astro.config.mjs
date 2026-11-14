import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

const docsRoot = fileURLToPath(new URL('../../tools/docs/', import.meta.url));

export default defineConfig({
  site: 'https://trinity.trinityproject.dev',
  base: '/',
  outDir: fileURLToPath(new URL('../../dist/site/', import.meta.url)),
  vite: {
    resolve: { alias: { '@docs': docsRoot } },
  },
});
