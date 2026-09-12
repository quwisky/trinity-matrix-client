import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import explicitHeadingIds from '@docs/markdown/explicit-heading-ids.mjs';
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
    resolve: { alias: { '@docs': docsRoot } },
  },
  integrations: [
    starlight({
      title: 'Trinity Developer Guide',
      logo: {
        src: '@docs/shared-assets/trinity-mark.svg',
        alt: 'Trinity',
      },
      customCss: ['@docs/shared-theme/trinity.css'],
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
        {
          label: 'Development',
          items: [
            {
              label: 'Angular components',
              link: '/development/angular-components/',
            },
            {
              label: 'Signals and RxJS',
              link: '/development/signals-and-rxjs/',
            },
            {
              label: 'Forms and validation',
              link: '/development/forms-and-validation/',
            },
            {
              label: 'Data-access services',
              link: '/development/data-access-services/',
            },
            {
              label: 'Public UI components',
              link: '/development/public-ui-components/',
            },
            {
              label: 'Styling and responsive UI',
              link: '/development/styling-and-responsive-ui/',
            },
            {
              label: 'Matrix features',
              link: '/development/matrix-features/',
            },
            {
              label: 'Platform integrations',
              link: '/development/platform-integrations/',
            },
          ],
        },
        {
          label: 'Testing',
          items: [
            {
              label: 'Testing strategy',
              link: '/testing/testing-strategy/',
            },
            { label: 'Unit tests', link: '/testing/unit-tests/' },
            {
              label: 'Component and browser tests',
              link: '/testing/component-and-browser-tests/',
            },
            {
              label: 'Matrix E2E tests',
              link: '/testing/matrix-e2e-tests/',
            },
            {
              label: 'Desktop and native tests',
              link: '/testing/desktop-and-native-tests/',
            },
            {
              label: 'Diagnose failures',
              link: '/testing/diagnose-failures/',
            },
          ],
        },
      ],
      components: {
        Banner: '@docs/shared-components/ChannelBanner.astro',
        Footer: '@docs/shared-components/SiteFooter.astro',
      },
    }),
  ],
});
