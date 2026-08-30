import { type StorybookConfig } from '@storybook/angular-vite';

/**
 * One Storybook for the whole public component tier.
 *
 * The stories are globbed out of the sibling libraries rather than written here, so each one
 * lives beside the component it documents — the same place its spec does. This project owns
 * no source of its own; it exists only so the `@nx/storybook/plugin` has somewhere to infer
 * the `storybook` / `build-storybook` targets from.
 *
 * The grouped public tier is the default scope. Two capability-owned presentational components
 * keep their existing isolated visual contracts, so their exact Conversations directories are
 * included without sweeping stateful feature pages. The vendored Helm kit remains excluded.
 */
const config: StorybookConfig = {
  stories: [
    '../../*/src/**/*.stories.@(ts|tsx|mdx)',
    '../../../feature/rooms/src/lib/media-bubble/*.stories.@(ts|tsx|mdx)',
    '../../../feature/rooms/src/lib/message-toolbar/*.stories.@(ts|tsx|mdx)',
  ],
  addons: ['@storybook/addon-a11y'],
  framework: {
    name: '@storybook/angular-vite',
    options: {
      // On by default, and it shells out to a compodoc that is not installed — the build
      // prints "Generating documentation with Compodoc: undefined" and carries on. The
      // component docblocks are better read in the source than in a generated JSON blob.
      compodoc: false,
    },
  },
};

export default config;
