import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { failOnRenderError } from '@docs/markdown/fail-on-render-error.mjs';
import { publicPageSchema } from '@docs/validation/frontmatter';

export const collections = {
  docs: defineCollection({
    loader: failOnRenderError(docsLoader()),
    schema: docsSchema({ extend: publicPageSchema('developer') }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
