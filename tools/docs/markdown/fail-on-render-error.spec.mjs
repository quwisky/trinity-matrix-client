import { describe, expect, it } from 'vitest';
import { failOnRenderError } from './fail-on-render-error.mjs';

// The slice of Astro's loader store the guard reads and writes.
const storeOf = (entries) => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    values: () => [...byId.values()],
    delete: (id) => byId.delete(id),
    has: (id) => byId.has(id),
  };
};

const rendered = { html: '<p>Body</p>', metadata: {} };

const loaderStoring = (entries) => ({
  name: 'starlight-docs-loader',
  load: async (context) => {
    context.loaded = entries;
  },
});

const load = async (entries) => {
  const store = storeOf(entries);
  const context = { store };
  await failOnRenderError(loaderStoring(entries)).load(context);
  return { context, store };
};

describe('failOnRenderError', () => {
  it('keeps the wrapped loader name and runs it with the same context', async () => {
    const entries = [{ id: 'start', filePath: 'docs/start.md', rendered }];
    const { context } = await load(entries);

    expect(failOnRenderError(loaderStoring(entries)).name).toBe(
      'starlight-docs-loader',
    );
    expect(context.loaded).toBe(entries);
  });

  it('accepts rendered entries, including an empty page, and deferred ones', async () => {
    await expect(
      load([
        { id: 'start', filePath: 'docs/start.md', rendered },
        {
          id: 'empty',
          filePath: 'docs/empty.md',
          rendered: { html: '', metadata: {} },
        },
        { id: 'mdx', filePath: 'docs/mdx.mdx', deferredRender: true },
      ]),
    ).resolves.toBeDefined();
  });

  it('fails the sync for every entry Markdown rendering left without a body', async () => {
    const store = storeOf([
      { id: 'start', filePath: 'docs/start.md', rendered },
      { id: 'prerequisites', filePath: 'docs/prerequisites.md' },
      { id: 'stack', filePath: 'docs/stack.md' },
    ]);

    const sync = failOnRenderError(loaderStoring([])).load({ store });

    await expect(sync).rejects.toThrow(
      /docs\/prerequisites\.md, docs\/stack\.md/,
    );
    await expect(sync).rejects.toThrow(/Error rendering/);
  });

  it('drops the unrendered entries so the next sync renders them again', async () => {
    const store = storeOf([
      { id: 'start', filePath: 'docs/start.md', rendered },
      { id: 'prerequisites', filePath: 'docs/prerequisites.md' },
    ]);

    await expect(
      failOnRenderError(loaderStoring([])).load({ store }),
    ).rejects.toThrow();

    expect(store.has('prerequisites')).toBe(false);
    expect(store.has('start')).toBe(true);
  });

  it('lets an error from the wrapped loader through unchanged', async () => {
    const error = new Error('schema mismatch');
    const failing = {
      name: 'starlight-docs-loader',
      load: async () => {
        throw error;
      },
    };

    await expect(
      failOnRenderError(failing).load({ store: storeOf([]) }),
    ).rejects.toBe(error);
  });
});
