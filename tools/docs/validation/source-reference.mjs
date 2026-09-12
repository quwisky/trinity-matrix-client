import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

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
  const lockfile = parse(
    readFileSync(join(workspaceRoot, 'pnpm-lock.yaml'), 'utf8'),
  );

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
    lockfileVersion: String(lockfile.lockfileVersion),
    node: manifest.engines?.node,
    packageManager: manifest.packageManager,
    packages: sortedObject({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...electronManifest.dependencies,
      ...electronManifest.devDependencies,
    }),
    projects,
    scripts: sortedObject(manifest.scripts),
  };
};

export const serializeSourceReference = (reference) =>
  `${JSON.stringify(reference, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
  console.log(
    `Source reference is deterministic (${JSON.parse(first).projects.length} projects).`,
  );
}
