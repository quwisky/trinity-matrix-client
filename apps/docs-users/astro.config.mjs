import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import explicitHeadingIds from '@docs/markdown/explicit-heading-ids.mjs';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

const docsRoot = fileURLToPath(new URL('../../tools/docs/', import.meta.url));

export default defineConfig({
  site: 'https://quwisky.github.io',
  base: '/trinity-matrix-client/users',
  outDir: fileURLToPath(new URL('../../dist/docs/users/', import.meta.url)),
  markdown: {
    processor: unified({ remarkPlugins: [explicitHeadingIds] }),
  },
  vite: {
    resolve: { alias: { '@docs': docsRoot } },
  },
  integrations: [
    starlight({
      title: 'Trinity User Guide',
      logo: {
        src: '@docs/shared-assets/trinity-mark.svg',
        alt: 'Trinity',
      },
      customCss: ['@docs/shared-theme/trinity.css'],
      disable404Route: true,
      components: {
        Banner: '@docs/shared-components/ChannelBanner.astro',
        Footer: '@docs/shared-components/SiteFooter.astro',
      },
    }),
  ],
});
