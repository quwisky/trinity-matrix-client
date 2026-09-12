import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import explicitHeadingIds from '@trinity/docs/markdown/explicit-heading-ids.mjs';
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

const docsRoot = fileURLToPath(new URL('../../tools/docs/', import.meta.url));

export default defineConfig({
  site: 'https://quwisky.github.io',
  base: '/trinity-matrix-client/developers',
  outDir: fileURLToPath(
    new URL('../../dist/docs/developers/', import.meta.url),
  ),
  markdown: {
    processor: unified({ remarkPlugins: [explicitHeadingIds] }),
  },
  vite: {
    resolve: { alias: { '@trinity/docs': docsRoot } },
  },
  integrations: [
    starlight({
      title: 'Trinity Developer Guide',
      logo: {
        src: '@trinity/docs/shared-assets/trinity-mark.svg',
        alt: 'Trinity',
      },
      customCss: ['@trinity/docs/shared-theme/trinity.css'],
      disable404Route: true,
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Prerequisites', link: '/start/prerequisites/' },
            { label: 'Clone and install', link: '/start/clone-and-install/' },
            { label: 'Run Trinity', link: '/start/run-trinity/' },
            { label: 'Repository tour', link: '/start/repository-tour/' },
            {
              label: 'Make your first change',
              link: '/start/make-your-first-change/',
            },
          ],
        },
        {
          label: 'Architecture',
          items: [
            {
              label: 'System overview',
              link: '/architecture/system-overview/',
            },
            {
              label: 'Capability ownership',
              link: '/architecture/capability-ownership/',
            },
            {
              label: 'Dependency boundaries',
              link: '/architecture/dependency-boundaries/',
            },
            {
              label: 'State and reactivity',
              link: '/architecture/state-and-reactivity/',
            },
            {
              label: 'Matrix integration',
              link: '/architecture/matrix-integration/',
            },
            {
              label: 'Encryption and trust',
              link: '/architecture/encryption-and-trust/',
            },
            {
              label: 'Workspace and navigation',
              link: '/architecture/workspace-and-navigation/',
            },
            {
              label: 'Host capabilities',
              link: '/architecture/host-capabilities/',
            },
            {
              label: 'UI and theming',
              link: '/architecture/ui-and-theming/',
            },
          ],
        },
      ],
      components: {
        Banner: '@trinity/docs/shared-components/ChannelBanner.astro',
        Footer: '@trinity/docs/shared-components/SiteFooter.astro',
      },
    }),
  ],
});
