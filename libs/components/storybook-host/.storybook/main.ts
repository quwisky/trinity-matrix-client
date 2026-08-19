import { type StorybookConfig } from '@storybook/angular-vite';

/**
 * One Storybook for the whole public component tier.
 *
 * The stories are globbed out of the sibling libraries rather than written here, so each one
 * lives beside the component it documents — the same place its spec does. This project owns
 * no source of its own; it exists only so the `@nx/storybook/plugin` has somewhere to infer
 * the `storybook` / `build-storybook` targets from.
 *
 * Deliberately scoped to `libs/components/*`: that is the tier feature code actually reaches
 * for. The vendored Helm kit is generated and re-synced from upstream, so stories there would
 * be overwritten; feature pages are too stateful to render in isolation without mocking half
 * the SDK.
 */
const config: StorybookConfig = {
  stories: ['../../*/src/**/*.stories.@(ts|tsx|mdx)'],
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
