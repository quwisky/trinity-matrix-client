import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateMarkdownLinks } from './markdown-links.mjs';

const temporaryDirectories = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'trinity-docs-links-'));
  temporaryDirectories.push(root);
  return root;
};

const writePage = (root, path, body) => {
  const destination = join(root, path);
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, body, 'utf8');
};

const site = (root) => [
  {
    name: 'developers',
    root,
    base: '/trinity-matrix-client/developers',
  },
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Markdown links and headings', () => {
  it('accepts links to existing pages and explicit heading IDs', async () => {
    const root = fixture();
    writePage(root, 'index.md', '[Install](./guide/#install)\n');
    writePage(root, 'guide/index.md', '## Install {#install}\n');

    await expect(validateMarkdownLinks(site(root))).resolves.toBeUndefined();
  });

  it('does not interpret YAML frontmatter as a document heading', async () => {
    const root = fixture();
    writePage(
      root,
      'index.md',
      '---\ntitle: Documentation home\n---\n\nWelcome.\n',
    );

    await expect(validateMarkdownLinks(site(root))).resolves.toBeUndefined();
  });

  it('resolves reference-style Markdown links', async () => {
    const root = fixture();
    writePage(
      root,
      'index.md',
      '[Install][guide]\n\n[guide]: ./guide/#install\n',
    );
    writePage(root, 'guide/index.md', '## Install {#install}\n');

    await expect(validateMarkdownLinks(site(root))).resolves.toBeUndefined();
  });

  it('rejects a link to a missing page', async () => {
    const root = fixture();
    writePage(root, 'index.md', '[Missing](./missing/)\n');

    await expect(validateMarkdownLinks(site(root))).rejects.toThrow(
      /missing page/,
    );
  });

  it('rejects a Markdown heading without an explicit ID', async () => {
    const root = fixture();
    writePage(root, 'index.md', '## Install\n');

    await expect(validateMarkdownLinks(site(root))).rejects.toThrow(
      /explicit heading ID/,
    );
  });

  it('rejects duplicate routes', async () => {
    const root = fixture();
    writePage(root, 'guide.md', 'Guide\n');
    writePage(root, 'guide/index.mdx', 'Guide again\n');

    await expect(validateMarkdownLinks(site(root))).rejects.toThrow(
      /duplicate route/,
    );
  });
});
