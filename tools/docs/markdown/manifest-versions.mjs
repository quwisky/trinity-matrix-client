import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Inline code `version:<selector>` renders the version a manifest declares:
//   engines.node      root package.json engines.node
//   packageManager    the version in root package.json packageManager (pnpm@X)
//   electron/<name>   electron/package.json dependencies or devDependencies
//   <name>            root package.json dependencies or devDependencies
// Unscoped npm names cannot contain `/`, so `electron/<name>` never shadows a package.
const REFERENCE = /^version:(.*)$/;
const ELECTRON_PREFIX = 'electron/';
const PACKAGE_MANAGER_VERSION = /^[^@]+@([^+]+)/;

const declared = (manifest) => ({
  ...manifest.devDependencies,
  ...manifest.dependencies,
});

/**
 * Reads the facts a page may reference into plain data. The docs config passes this
 * data as plugin options, so Astro's config digest, and with it the content cache,
 * changes whenever a referenced manifest does.
 */
export const readManifestVersions = (workspaceRoot) => {
  const read = (path) =>
    JSON.parse(readFileSync(join(workspaceRoot, path), 'utf8'));
  const root = read('package.json');
  return {
    node: root.engines?.node,
    packageManager: root.packageManager,
    packages: declared(root),
    electronPackages: declared(read('electron/package.json')),
  };
};

const lookup = (manifests, selector) => {
  if (selector === 'engines.node') return manifests.node;
  if (selector === 'packageManager') {
    return manifests.packageManager?.match(PACKAGE_MANAGER_VERSION)?.[1];
  }
  if (selector.startsWith(ELECTRON_PREFIX)) {
    const name = selector.slice(ELECTRON_PREFIX.length);
    return Object.hasOwn(manifests.electronPackages, name)
      ? manifests.electronPackages[name]
      : undefined;
  }
  return Object.hasOwn(manifests.packages, selector)
    ? manifests.packages[selector]
    : undefined;
};

export const resolveManifestVersion = (manifests, selector) => {
  const version = lookup(manifests, selector);
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
      `\`version:${selector}\` names no version that package.json or electron/package.json declares.`,
    );
  }
  return version;
};

const visit = (node, replace) => {
  if (node.type === 'inlineCode') replace(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) visit(child, replace);
};

export default function manifestVersions(manifests) {
  if (!manifests?.packages || !manifests.electronPackages) {
    throw new Error('manifestVersions needs the manifest versions as options.');
  }
  return (tree, file) =>
    visit(tree, (node) => {
      const selector = node.value.match(REFERENCE)?.[1];
      if (selector === undefined) return;
      try {
        node.value = resolveManifestVersion(manifests, selector);
      } catch (error) {
        throw new Error(`${file?.path ?? 'Markdown'}: ${error.message}`, {
          cause: error,
        });
      }
    });
}
