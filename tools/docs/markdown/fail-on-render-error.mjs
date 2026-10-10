/**
 * Fails the content sync, and with it `astro build`, when Markdown rendering fails.
 *
 * Astro's glob loader catches an error thrown while rendering an entry, such as a remark
 * plugin rejecting its input, logs `Error rendering <entry>` and stores the entry without
 * `rendered`. The build then publishes that page with an empty body and exits 0.
 *
 * @param {import('astro/loaders').Loader} loader the collection's Markdown loader
 * @returns {import('astro/loaders').Loader}
 */
export const failOnRenderError = (loader) => ({
  ...loader,
  load: async (context) => {
    await loader.load(context);
    const unrendered = context.store
      .values()
      .filter((entry) => entry.rendered === undefined && !entry.deferredRender);
    if (unrendered.length === 0) return;
    // A cached entry with an unchanged digest is not rendered again, so drop these and
    // the next sync renders them, and reports the cause, afresh.
    for (const { id } of unrendered) context.store.delete(id);
    const files = unrendered.map((entry) => entry.filePath ?? entry.id);
    throw new Error(
      `Markdown rendering failed for ${files.join(', ')}; ` +
        'the "Error rendering" log above names the cause.',
    );
  },
});
