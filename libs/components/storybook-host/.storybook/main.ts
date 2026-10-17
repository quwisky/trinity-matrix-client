import { type StorybookConfig } from '@storybook/angular-vite';

/**
 * One Storybook for the whole public component tier. Stories are globbed out of the sibling
 * libraries so each lives beside its component; this project owns no source and exists so
 * `@nx/storybook/plugin` can infer the `storybook` / `build-storybook` targets.
 *
 * Two capability-owned presentational components keep their isolated visual contracts, so
 * their exact Conversations directories are included without sweeping stateful feature pages.
 * The vendored Helm kit stays excluded.
 */
const config: StorybookConfig = {
  stories: [
    '../../*/src/**/*.stories.@(ts|tsx|mdx)',
    '../../../feature/rooms/src/lib/media-bubble/*.stories.@(ts|tsx|mdx)',
    '../../../feature/rooms/src/lib/message-toolbar/*.stories.@(ts|tsx|mdx)',
    '../../../application/runtime/src/lib/application-root/system-status/*.stories.@(ts|tsx|mdx)',
  ],
  addons: ['@storybook/addon-a11y'],
  framework: {
    name: '@storybook/angular-vite',
    options: {
      // Off: it shells out to a compodoc that is not installed ("Generating documentation with
      // Compodoc: undefined").
      compodoc: false,
    },
  },
};

export default config;
