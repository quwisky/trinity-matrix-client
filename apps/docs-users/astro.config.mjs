import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import explicitHeadingIds from '@trinity/docs/markdown/explicit-heading-ids.mjs';
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
    resolve: { alias: { '@trinity/docs': docsRoot } },
  },
  integrations: [
    starlight({
      title: 'Trinity User Guide',
      logo: {
        src: '@trinity/docs/shared-assets/trinity-mark.svg',
        alt: 'Trinity',
      },
      customCss: ['@trinity/docs/shared-theme/trinity.css'],
      disable404Route: true,
      components: {
        Banner: '@trinity/docs/shared-components/ChannelBanner.astro',
        Footer: '@trinity/docs/shared-components/SiteFooter.astro',
      },
    }),
  ],
});
