import {
  createMarkdownProcessor,
  parseFrontmatter,
} from '@astrojs/markdown-remark';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const EXPLICIT_HEADING = /\s+\{#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}\s*$/;
const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const asPath = (value) => (value instanceof URL ? fileURLToPath(value) : value);

const markdownFiles = (root) => {
  const rootPath = asPath(root);
  const files = [];

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (MARKDOWN_EXTENSIONS.has(extname(entry.name))) files.push(path);
    }
  };

  visit(rootPath);
  return files.sort();
};

const routeForFile = (site, path) => {
  let slug = relative(asPath(site.root), path).split(sep).join('/');
  slug = slug.slice(0, -extname(slug).length);
  if (slug === 'index') slug = '';
  else if (slug.endsWith('/index')) slug = slug.slice(0, -'/index'.length);
  return `${site.base}${slug ? `/${slug}` : ''}/`;
};

const normalizedRoute = (pathname) => {
  let route = pathname.replace(/\.(?:md|mdx)$/i, '');
  route = route.replace(/\/index$/i, '/');
  return route.endsWith('/') ? route : `${route}/`;
};

const textContent = (node) => {
  if (typeof node.value === 'string') return node.value;
  return Array.isArray(node.children)
    ? node.children.map((child) => textContent(child)).join('')
    : '';
};

const inspectTree = (path, tree) => {
  const ids = new Set(['_top']);
  const links = [];
  const definitions = new Map();
  const references = [];

  const visit = (node) => {
    if (node.type === 'heading') {
      const explicit = textContent(node).match(EXPLICIT_HEADING);
      if (!explicit) {
        throw new Error(
          `${path} has a Markdown heading without an explicit heading ID.`,
        );
      }
      const id = explicit[1];
      if (ids.has(id)) {
        throw new Error(`${path} repeats heading ID #${id}.`);
      }
      ids.add(id);
    }
    if (node.type === 'link') links.push(node.url);
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
    if (node.type === 'linkReference') references.push(node.identifier);
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };

  visit(tree);
  for (const identifier of references) {
    const target = definitions.get(identifier);
    if (target) links.push(target);
  }

  return { headings: ids, links };
};

const targetRoute = (target, currentRoute) => {
  const url = new URL(target, `https://docs.invalid${currentRoute}`);
  return {
    route: normalizedRoute(decodeURIComponent(url.pathname)),
    hash: decodeURIComponent(url.hash.slice(1)),
  };
};

export const validateMarkdownLinks = async (sites) => {
  const pages = new Map();
  let capturedTree;
  const captureTree = () => (tree) => {
    capturedTree = tree;
  };
  const renderer = await createMarkdownProcessor({
    syntaxHighlight: false,
    remarkPlugins: [captureTree],
  });

  for (const site of sites) {
    for (const path of markdownFiles(site.root)) {
      const route = routeForFile(site, path);
      if (pages.has(route)) {
        throw new Error(
          `Documentation has a duplicate route ${route}: ${pages.get(route).path} and ${path}.`,
        );
      }
      const source = readFileSync(path, 'utf8');
      const { content } = parseFrontmatter(source);
      capturedTree = undefined;
      await renderer.render(content, { fileURL: pathToFileURL(path) });
      if (!capturedTree) {
        throw new Error(`Could not parse Markdown page ${path}.`);
      }
      pages.set(route, { path, route, ...inspectTree(path, capturedTree) });
    }
  }

  for (const page of pages.values()) {
    for (const rawTarget of page.links) {
      if (EXTERNAL_URL.test(rawTarget)) continue;
      const target = targetRoute(rawTarget, page.route);

      if (target.route === '/trinity-matrix-client/') continue;
      const destination = pages.get(target.route);
      if (!destination) {
        throw new Error(`${page.path} links to missing page ${target.route}.`);
      }
      if (target.hash && !destination.headings.has(target.hash)) {
        throw new Error(
          `${page.path} links to missing heading #${target.hash} on ${target.route}.`,
        );
      }
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  await validateMarkdownLinks([
    {
      name: 'users',
      root: join(workspaceRoot, 'apps/docs-users/src/content/docs'),
      base: '/trinity-matrix-client/users',
    },
    {
      name: 'developers',
      root: join(workspaceRoot, 'apps/docs-developers/src/content/docs'),
      base: '/trinity-matrix-client/developers',
    },
  ]);
  console.log('Documentation links and heading IDs are valid.');
}
