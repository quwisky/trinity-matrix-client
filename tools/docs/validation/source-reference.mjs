import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const IGNORED_DIRECTORIES = new Set([
  '.astro',
  '.git',
  '.nx',
  '.gradle',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'release',
  'tmp',
  'www',
]);

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

const sortedObject = (value = {}) =>
  Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );

const projectFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'project.json') files.push(path);
    }
  };
  visit(root);
  return files.sort();
};

const gitCommit = (root) =>
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();

export const buildSourceReference = (root, options = {}) => {
  const workspaceRoot = root instanceof URL ? fileURLToPath(root) : root;
  const manifest = json(join(workspaceRoot, 'package.json'));
  const electronManifest = json(join(workspaceRoot, 'electron/package.json'));
  const tsconfig = json(join(workspaceRoot, 'tsconfig.base.json'));
  // pnpm 12 prefixes the project lockfile with a package-manager lockfile document,
  // so the project's lockfile is the last YAML document in the file.
  const lockfile = parseAllDocuments(
    readFileSync(join(workspaceRoot, 'pnpm-lock.yaml'), 'utf8'),
  )
    .at(-1)
    ?.toJS();

  const configuredProjects = projectFiles(workspaceRoot)
    .map((path) => ({ path, project: json(path) }))
    .map(({ path, project }) => ({
      ...project,
      root:
        project.root ??
        relative(workspaceRoot, dirname(path)).split(sep).join('/'),
    }))
    .filter((project) => typeof project.name === 'string')
    .map((project) => ({
      name: project.name,
      root: project.root,
      tags: [...(project.tags ?? [])].sort(),
      targets: Object.keys(project.targets ?? {}).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const projectsByName = new Map(
    configuredProjects.map((project) => [project.name, project]),
  );
  const projectNames = options.projectNames
    ? [...options.projectNames].sort()
    : [...projectsByName.keys()].sort();
  const missingProjects = projectNames.filter(
    (name) => !projectsByName.has(name),
  );
  if (missingProjects.length > 0) {
    throw new Error(
      `Nx reported projects without readable configuration: ${missingProjects.join(', ')}.`,
    );
  }
  const projects = projectNames.map((name) => projectsByName.get(name));

  return {
    aliases: sortedObject(tsconfig.compilerOptions?.paths),
    buildCommit:
      options.commit ?? process.env.GITHUB_SHA ?? gitCommit(workspaceRoot),
    lockfileVersion: String(lockfile?.lockfileVersion),
    node: manifest.engines?.node,
    packageManager: manifest.packageManager,
    packages: sortedObject({
      ...electronManifest.dependencies,
      ...electronManifest.devDependencies,
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }),
    projects,
    scripts: sortedObject(manifest.scripts),
  };
};

export const serializeSourceReference = (reference) =>
  `${JSON.stringify(reference, null, 2)}\n`;

const requireText = (page, values) => {
  const source = readFileSync(page, 'utf8');
  const missing = values.filter((value) => !source.includes(value));
  if (missing.length > 0) {
    throw new Error(
      `${page} is missing source-derived facts: ${missing.join(', ')}.`,
    );
  }
};

export const validatePublishedSourceReference = (contentRoot, reference) => {
  const root =
    contentRoot instanceof URL ? fileURLToPath(contentRoot) : contentRoot;
  const declaredPackage = (name) => {
    if (!reference.packages[name]) {
      throw new Error(`Source reference has no package ${name}.`);
    }
    return name;
  };
  const scriptCommand = (name) => {
    if (!reference.scripts[name]) {
      throw new Error(`Source reference has no root script ${name}.`);
    }
    return `pnpm ${name}`;
  };
  const projectName = (name) => {
    if (!reference.projects.some((project) => project.name === name)) {
      throw new Error(`Source reference has no Nx project ${name}.`);
    }
    return name;
  };
  const alias = (name) => {
    if (!reference.aliases[name]) {
      throw new Error(`Source reference has no import alias ${name}.`);
    }
    return name;
  };

  // The docs build renders these references from the manifests, so the page keeps the
  // rows without copying a version that each dependency update would make stale.
  requireText(
    join(root, 'reference/technology-stack.md'),
    [
      'engines.node',
      'packageManager',
      declaredPackage('@angular/core'),
      declaredPackage('matrix-js-sdk'),
      declaredPackage('rxjs'),
      declaredPackage('nx'),
      declaredPackage('typescript'),
      declaredPackage('vitest'),
      declaredPackage('@playwright/test'),
      declaredPackage('@capacitor/core'),
      `electron/${declaredPackage('electron')}`,
      declaredPackage('astro'),
      declaredPackage('@astrojs/starlight'),
    ].map((selector) => `\`version:${selector}\``),
  );
  requireText(
    join(root, 'reference/commands.md'),
    [
      'start',
      'build',
      'test',
      'lint',
      'stylelint',
      'format:check',
      'architecture:check',
      'storybook',
      'electron:start',
      'electron:verify',
      'android:run',
      'ios:run',
      'e2e:browser',
      'e2e:components',
      'e2e:all',
    ].map(scriptCommand),
  );
  requireText(
    join(root, 'reference/project-and-library-catalog.md'),
    [
      'trinity',
      'trinity-desktop',
      'trinity-android',
      'trinity-ios',
      'application-runtime',
      'data-access-matrix-client',
      'feature-rooms',
      'components-controls',
      'runtime-host',
      'trinity-e2e-browser',
      'docs-users',
      'docs-developers',
      'docs-site',
    ].map(projectName),
  );
  requireText(
    join(root, 'reference/import-aliases.md'),
    [
      '@trinity/application/runtime',
      '@trinity/data-access/timeline',
      '@trinity/feature/rooms',
      '@trinity/components/controls',
      '@trinity/runtime/host',
      '@trinity/util/matrix',
      '@trinity/platform-native',
      '@trinity/theme-foundation',
      '@trinity/testing',
    ].map(alias),
  );
};

if (import.meta.main) {
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const projectNames = JSON.parse(
    execFileSync(
      process.execPath,
      [join(workspaceRoot, 'scripts/nx.mjs'), 'show', 'projects', '--json'],
      { cwd: workspaceRoot, encoding: 'utf8' },
    ),
  );
  const first = serializeSourceReference(
    buildSourceReference(workspaceRoot, { projectNames }),
  );
  const second = serializeSourceReference(
    buildSourceReference(workspaceRoot, { projectNames }),
  );
  if (first !== second) {
    throw new Error(
      'Source-derived documentation reference is not deterministic.',
    );
  }
  validatePublishedSourceReference(
    join(workspaceRoot, 'apps/docs-developers/src/content/docs'),
    JSON.parse(first),
  );
  console.log(
    `Source reference is deterministic (${JSON.parse(first).projects.length} projects).`,
  );
}
