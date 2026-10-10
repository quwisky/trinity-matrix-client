import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { failOnRenderError } from '@docs/markdown/fail-on-render-error.mjs';
import { publicPageSchema } from '@docs/validation/frontmatter';
import {
  readReleaseManifest,
  validateUserContentState,
} from '@docs/validation/release-manifest.mjs';

const release = readReleaseManifest(
  new URL('../release.json', import.meta.url),
);

validateUserContentState(new URL('./content/docs/', import.meta.url), release);

export const collections = {
  docs: defineCollection({
    loader: failOnRenderError(docsLoader()),
    schema: docsSchema({ extend: publicPageSchema('user', release) }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
