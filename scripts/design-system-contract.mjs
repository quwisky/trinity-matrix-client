import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceRoot = join(import.meta.dirname, '..');
const catalogPath = join(workspaceRoot, 'architecture/design-system.json');
const pathsPath = join(workspaceRoot, 'tsconfig.base.json');
const requiredCategories = [
  'controls',
  'foundations',
  'generic-content',
  'navigation-layout',
  'overlays',
];
const forbiddenUiImports = [
  '@angular/cdk',
  '@ctrl/ngx-emoji-mart',
  '@ng-icons',
  '@spartan-ng/brain',
  '@trinity/helm/',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function nxGraph() {
  const environment = { ...process.env, NO_COLOR: '1' };
  delete environment.FORCE_COLOR;
  const output = execFileSync('pnpm', ['exec', 'nx', 'graph', '--print'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: environment,
  });
  return JSON.parse(output).graph;
}

function importSpecifiers(source) {
  const specifiers = [];
  const importPattern =
    /(?:from\s+|import\s*\()\s*['"](?<specifier>[^'"]+)['"]/gu;
  for (const match of source.matchAll(importPattern)) {
    specifiers.push(match.groups.specifier);
  }
  return specifiers;
}

function codeWithoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
}

function markupWithoutComments(source) {
  return source.replace(/<!--[\s\S]*?-->/gu, '');
}

function catalogEntries(catalog) {
  return [
    ...Object.entries(catalog.categories).flatMap(([category, entries]) =>
      entries.map((entry) => ({ ...entry, category })),
    ),
    ...catalog.migrationExceptions.map((entry) => ({
      ...entry,
      category: 'migration-exception',
    })),
    ...catalog.nonConsumable.map((entry) => ({
      ...entry,
      category: 'non-consumable',
    })),
  ];
}

function sameValues(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function validateDesignSystemCatalog(
  graph,
  catalog,
  paths,
  readSource,
  errors,
) {
  const categories = Object.keys(catalog.categories).sort();
  if (!sameValues(categories, requiredCategories)) {
    errors.push(
      `Design-system categories must be exactly ${requiredCategories.join(', ')}`,
    );
  }
  for (const category of requiredCategories) {
    if ((catalog.categories[category] ?? []).length === 0) {
      errors.push(`Design-system category must own an entrypoint: ${category}`);
    }
  }

  const entries = catalogEntries(catalog);
  const projects = entries.map(({ project }) => project);
  const duplicateProjects = projects.filter(
    (project, index) => projects.indexOf(project) !== index,
  );
  if (duplicateProjects.length > 0) {
    errors.push(
      `Design-system projects have duplicate ownership: ${[...new Set(duplicateProjects)].sort().join(', ')}`,
    );
  }

  const publicProjects = Object.entries(graph.nodes)
    .filter(([, node]) => (node.data.tags ?? []).includes('ui:public'))
    .map(([project]) => project);
  if (!sameValues(projects, publicProjects)) {
    errors.push(
      `Design-system ownership must classify every ui:public project exactly once; expected ${publicProjects.sort().join(', ')}, found ${projects.sort().join(', ')}`,
    );
  }

  for (const entry of entries) {
    const node = graph.nodes[entry.project];
    if (!node) {
      errors.push(
        `Design-system ownership names missing project: ${entry.project}`,
      );
      continue;
    }
    if (entry.category === 'non-consumable') {
      if (!entry.reason) {
        errors.push(`${entry.project} must explain why it is non-consumable`);
      }
      continue;
    }
    const expectedTarget = `./${node.data.root}/src/index.ts`;
    const actualTargets = paths[entry.entrypoint] ?? [];
    if (!sameValues(actualTargets, [expectedTarget])) {
      errors.push(
        `${entry.project} entrypoint ${entry.entrypoint} must resolve to ${expectedTarget}`,
      );
    }
    if (entry.category === 'migration-exception') {
      for (const field of ['targetOwner', 'removeBy', 'reason']) {
        if (!entry[field]) {
          errors.push(`${entry.project} migration ownership lacks ${field}`);
        }
      }
    }
  }

  const publicEntrypoints = new Set(
    entries.flatMap(({ entrypoint }) => (entrypoint ? [entrypoint] : [])),
  );
  if (catalog.proofScreens.length === 0) {
    errors.push('Design-system contract must name a production proof screen');
  }
  for (const screen of catalog.proofScreens) {
    if (!graph.nodes[screen.project]) {
      errors.push(
        `Design-system proof screen names missing project: ${screen.project}`,
      );
    }
    if (screen.publicEntrypoints.length === 0) {
      errors.push(
        `${screen.project} proof screen must name public UI entrypoints`,
      );
    }
    if (screen.requiredSelectors.length === 0) {
      errors.push(
        `${screen.project} proof screen must name required selectors`,
      );
    }
    const source = codeWithoutComments(readSource(screen.source));
    const imports = importSpecifiers(source);
    const forbidden = imports.filter((specifier) =>
      forbiddenUiImports.some((prefix) => specifier.startsWith(prefix)),
    );
    if (forbidden.length > 0) {
      errors.push(
        `${screen.project} proof screen imports vendor UI directly: ${forbidden.sort().join(', ')}`,
      );
    }
    const actualPublicImports = imports.filter((specifier) =>
      specifier.startsWith('@trinity/components/'),
    );
    if (!sameValues(actualPublicImports, screen.publicEntrypoints)) {
      errors.push(
        `${screen.project} proof screen public UI imports drifted; expected ${screen.publicEntrypoints.join(', ')}, found ${actualPublicImports.sort().join(', ')}`,
      );
    }
    for (const entrypoint of actualPublicImports) {
      if (!publicEntrypoints.has(entrypoint)) {
        errors.push(
          `${screen.project} proof screen uses unowned UI entrypoint: ${entrypoint}`,
        );
      }
    }
    const template = markupWithoutComments(readSource(screen.template));
    for (const selector of screen.requiredSelectors) {
      if (!template.includes(selector)) {
        errors.push(
          `${screen.project} proof screen is missing public selector: ${selector}`,
        );
      }
    }
  }
}

export function validateWorkspace() {
  const graph = nxGraph();
  const catalog = readJson(catalogPath);
  const paths = readJson(pathsPath).compilerOptions.paths;
  const errors = [];
  validateDesignSystemCatalog(
    graph,
    catalog,
    paths,
    (path) => readFileSync(join(workspaceRoot, path), 'utf8'),
    errors,
  );
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  }
  return { catalog, graph };
}

function runCli() {
  const { catalog } = validateWorkspace();
  const classified = catalogEntries(catalog).length;
  process.stdout.write(
    `Design-system contract is valid (${classified} public projects, ${catalog.proofScreens.length} production proof screen).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
