import {
  createMarkdownProcessor,
  parseFrontmatter,
} from '@astrojs/markdown-remark';
import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import explicitHeadingIds from '../tools/docs/markdown/explicit-heading-ids.mjs';
import manifestVersions, {
  readManifestVersions,
  resolveManifestVersion,
} from '../tools/docs/markdown/manifest-versions.mjs';

// The pages own which packages appear, under which heading and in which order; the
// docs build reads every version from the manifests. This guards the page against a
// row that names no declared package, not against a manifest that moved on.
const workspaceRoot = join(import.meta.dirname, '..');
const docsRoot = 'apps/docs-developers/src/content/docs';
const stackPath = `${docsRoot}/reference/technology-stack.md`;
const prerequisitesPath = `${docsRoot}/start/prerequisites.md`;
const manifests = readManifestVersions(workspaceRoot);

const read = (path) => readFileSync(join(workspaceRoot, path), 'utf8');
const REFERENCE_CELL = /^`version:([^`]+)`$/;

const sourceRows = (() => {
  const tables = read(stackPath)
    .split(/\n(?!\|)/)
    .map((block) => block.split('\n').filter((line) => line.startsWith('|')))
    .filter((lines) => lines.length > 0);
  return tables.flatMap((lines) =>
    lines.slice(2).map((line) => {
      const [label, version] = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { label: label.replaceAll('`', ''), version };
    }),
  );
})();

const render = async (path, versions) => {
  const processor = await createMarkdownProcessor({
    remarkPlugins: [explicitHeadingIds, [manifestVersions, versions]],
    syntaxHighlight: false,
  });
  const { code } = await processor.render(
    parseFrontmatter(read(path)).content,
    {
      fileURL: pathToFileURL(join(workspaceRoot, path)),
    },
  );
  return code;
};

const renderedRows = (html) =>
  [...JSDOM.fragment(html).querySelectorAll('tbody tr')].map((row) => {
    const [label, version] = [...row.querySelectorAll('td')].map(
      (cell) => cell.textContent ?? '',
    );
    return { label, version };
  });

const expectedRows = (versions) =>
  sourceRows.map(({ label, version }) => ({
    label,
    version: resolveManifestVersion(
      versions,
      version.match(REFERENCE_CELL)?.[1] ?? '',
    ),
  }));

const pnpmVersion = (versions) =>
  resolveManifestVersion(versions, 'packageManager');

// What a Renovate branch changes: every declared version, and nothing in the docs.
const bumped = {
  node: '^99.1.0',
  packageManager: 'pnpm@99.2.0',
  packages: Object.fromEntries(
    Object.keys(manifests.packages).map((name) => [name, '99.3.0']),
  ),
  electronPackages: Object.fromEntries(
    Object.keys(manifests.electronPackages).map((name) => [name, '99.4.0']),
  ),
};

describe('developer technology stack reference', () => {
  it('finds the stack rows in the page tables', () => {
    expect(sourceRows.length).toBeGreaterThan(0);
  });

  it.each(sourceRows)(
    'reads the $label version from a package the manifests declare',
    ({ version }) => {
      const reference = version.match(REFERENCE_CELL)?.[1];
      expect(
        reference,
        `${stackPath} version cells must be \`version:<package>\` references`,
      ).toBeDefined();
      expect(() => resolveManifestVersion(manifests, reference)).not.toThrow();
    },
  );

  it('renders every row with the version its manifest declares', async () => {
    const html = await render(stackPath, manifests);

    expect(renderedRows(html)).toEqual(expectedRows(manifests));
    expect(html).not.toContain('version:');
  });

  it('follows a manifest bump without a docs edit', async () => {
    const html = await render(stackPath, bumped);

    expect(renderedRows(html)).toEqual(expectedRows(bumped));
  });
});

describe('developer prerequisites', () => {
  it.each([
    ['current', manifests],
    ['bumped', bumped],
  ])(
    'renders the Node.js and pnpm versions of the %s manifests',
    async (_, versions) => {
      const html = await render(prerequisitesPath, versions);

      expect(html).toContain(`<code>${versions.node}</code>`);
      expect(html).toContain(`<code>${pnpmVersion(versions)}</code>`);
      expect(html).not.toContain('version:');
    },
  );
});

describe('developer site Markdown pipeline', () => {
  // Astro logs a Markdown plugin error and publishes the page with an empty body, so
  // an unresolvable reference on any page has to fail here rather than in the build.
  it('resolves every version reference on every developer page', () => {
    const references = readdirSync(join(workspaceRoot, docsRoot), {
      recursive: true,
    })
      .filter((path) => /\.mdx?$/.test(path))
      .flatMap((path) =>
        [...read(join(docsRoot, path)).matchAll(/`version:([^`]*)`/g)].map(
          ([, selector]) => ({ path, selector }),
        ),
      );

    expect(references.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'reference/technology-stack.md',
        'start/prerequisites.md',
      ]),
    );
    for (const { path, selector } of references) {
      expect(
        () => resolveManifestVersion(manifests, selector),
        `${docsRoot}/${path}`,
      ).not.toThrow();
    }
  });

  it('reads the manifests when the site builds', () => {
    const config = read('apps/docs-developers/astro.config.mjs');

    expect(config).toContain('@docs/markdown/manifest-versions.mjs');
    expect(config).toMatch(
      /\[\s*manifestVersions,\s*readManifestVersions\(workspaceRoot\)\s*\]/,
    );
  });
});
