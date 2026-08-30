import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';

const workspaceRoot = join(import.meta.dirname, '..');
const contractPath = join(workspaceRoot, 'architecture/contract.json');
const qualityBaselinesPath = join(
  workspaceRoot,
  'architecture/quality-baselines.json',
);
const dependencyMapPath = join(
  workspaceRoot,
  'docs/architecture/generated/dependency-map.md',
);

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

function tagValues(tags, prefix) {
  return tags
    .filter((tag) => tag.startsWith(`${prefix}:`))
    .map((tag) => tag.slice(prefix.length + 1));
}

function dependencyKey(source, target) {
  return `${source} -> ${target}`;
}

function validateLedger(contract, errors) {
  const removalLedgers = [
    ['classification exception', contract.classificationExceptions],
    ['secondary entrypoint', contract.secondaryEntrypoints],
    ['multi-capability project', contract.multiCapabilityProjects],
    ['dependency exception', contract.dependencyExceptions],
  ];
  for (const [kind, entries] of removalLedgers) {
    for (const entry of entries) {
      if (!entry.reason || !entry.removeBy) {
        errors.push(`${kind} must declare a reason and removal issue`);
      }
    }
  }
  validateRoleDirection(contract.roles, errors);
}

export function validateRoleDirection(roles, errors) {
  const dependencies = Object.fromEntries(
    Object.entries(roles).map(([source, targets]) => [
      source,
      targets
        .filter((target) => target !== source)
        .map((target) => ({ target })),
    ]),
  );
  for (const cycle of findCycles(dependencies)) {
    errors.push(
      `Role dependency direction is cyclic: ${cycle.map((role) => `role:${role}`).join(' -> ')}`,
    );
  }
}

export function validateQualityBaselines(baselines, errors) {
  const requiredPerformanceMetrics = [
    'account-restore',
    'active-account-switch',
    'background-account-cpu',
    'conversation-attach',
    'message-projection',
    'retained-resources',
    'workspace-transition',
  ];
  const requiredSecurityBaselines = [
    'electron-ipc-boundary',
    'normalized-matrix-input',
    'sdk-import-containment',
    'secret-safe-diagnostics',
    'sensitive-preference-policy',
  ];
  const actualPerformanceMetrics = baselines.performance
    .map(({ metric }) => metric)
    .sort();
  if (
    JSON.stringify(actualPerformanceMetrics) !==
    JSON.stringify(requiredPerformanceMetrics)
  ) {
    errors.push(
      `Performance baseline registry must cover exactly ${requiredPerformanceMetrics.join(', ')}`,
    );
  }
  for (const baseline of baselines.performance) {
    for (const field of [
      'metric',
      'scope',
      'unit',
      'current',
      'owner',
      'issue',
    ]) {
      if (!baseline[field]) {
        errors.push(
          `Performance baseline ${baseline.metric ?? '<unnamed>'} lacks ${field}`,
        );
      }
    }
  }
  const actualSecurityBaselines = baselines.security.map(({ id }) => id).sort();
  if (
    JSON.stringify(actualSecurityBaselines) !==
    JSON.stringify(requiredSecurityBaselines)
  ) {
    errors.push(
      `Security baseline registry must cover exactly ${requiredSecurityBaselines.join(', ')}`,
    );
  }
  for (const baseline of baselines.security) {
    for (const field of ['id', 'invariant', 'enforcement', 'issue']) {
      if (!baseline[field]) {
        errors.push(`Security baseline lacks ${field}`);
      }
    }
  }
}

export function findCycles(dependencies) {
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function visit(project, path) {
    if (visiting.has(project)) {
      const start = path.indexOf(project);
      cycles.push([...path.slice(start), project]);
      return;
    }
    if (visited.has(project)) {
      return;
    }
    visiting.add(project);
    for (const edge of dependencies[project] ?? []) {
      visit(edge.target, [...path, project]);
    }
    visiting.delete(project);
    visited.add(project);
  }

  for (const project of Object.keys(dependencies).sort()) {
    visit(project, []);
  }
  return cycles;
}

function lineCount(relativePath) {
  const contents = readFileSync(join(workspaceRoot, relativePath), 'utf8');
  return contents.endsWith('\n')
    ? contents.split('\n').length - 1
    : contents.split('\n').length;
}

function initializerCount(relativePath) {
  const contents = readFileSync(join(workspaceRoot, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '');
  return (contents.match(/\bprovideAppInitializer\(/gu) ?? []).length;
}

export function classify(graph, contract, errors) {
  const roles = new Map();
  const capabilities = new Map();
  const unmanaged = new Set(
    contract.unmanagedProjects.map(({ project }) => project),
  );
  const classificationExceptions = new Set(
    contract.classificationExceptions.map(({ project }) => project),
  );
  const expectedProjects = new Set(Object.keys(graph.nodes));

  for (const project of [...unmanaged, ...classificationExceptions]) {
    if (!expectedProjects.has(project)) {
      errors.push(
        `Architecture exemption names missing Nx project: ${project}`,
      );
    }
  }

  for (const [project, node] of Object.entries(graph.nodes)) {
    if (unmanaged.has(project) || classificationExceptions.has(project)) {
      continue;
    }
    const tags = node.data.tags ?? [];
    const projectRoles = tagValues(tags, 'role');
    const projectCapabilities = tagValues(tags, 'capability');
    if (projectRoles.length !== 1) {
      errors.push(
        `${project} must carry exactly one role:* tag; found ${projectRoles.length}`,
      );
      continue;
    }
    if (!Object.hasOwn(contract.roles, projectRoles[0])) {
      errors.push(`${project} carries unknown role:${projectRoles[0]}`);
    }
    if (projectCapabilities.length === 0) {
      errors.push(`${project} must carry at least one capability:* tag`);
    }
    for (const capability of projectCapabilities) {
      if (!contract.capabilities.includes(capability)) {
        errors.push(`${project} carries unknown capability:${capability}`);
      }
    }
    roles.set(project, projectRoles[0]);
    capabilities.set(project, projectCapabilities);
  }

  const actualMultiCapability = [...capabilities]
    .filter(([, values]) => values.length > 1)
    .map(([project, values]) => ({
      project,
      capabilities: [...values].sort(),
    }))
    .sort((left, right) => left.project.localeCompare(right.project));
  const expectedMultiCapability = contract.multiCapabilityProjects
    .map(({ project, capabilities: values }) => ({
      project,
      capabilities: [...(values ?? [])].sort(),
    }))
    .sort((left, right) => left.project.localeCompare(right.project));
  if (
    JSON.stringify(actualMultiCapability) !==
    JSON.stringify(expectedMultiCapability)
  ) {
    errors.push(
      `Multi-capability allowlist drifted. Expected ${JSON.stringify(expectedMultiCapability)}; found ${JSON.stringify(actualMultiCapability)}`,
    );
  }

  return { roles, capabilities, unmanaged, classificationExceptions };
}

export function validateDependencies(graph, contract, classification, errors) {
  const { roles, capabilities } = classification;
  const violations = [];

  for (const [source, edges] of Object.entries(graph.dependencies)) {
    const sourceRole = roles.get(source);
    if (!sourceRole) {
      continue;
    }
    for (const { target } of edges) {
      const targetRole = roles.get(target);
      if (!targetRole) {
        continue;
      }
      if (!contract.roles[sourceRole].includes(targetRole)) {
        violations.push(dependencyKey(source, target));
        continue;
      }
      if (sourceRole === 'capability' && targetRole === 'capability') {
        const sourceCapabilities = capabilities.get(source);
        const targetCapabilities = capabilities.get(target);
        const sharesCapability = sourceCapabilities.some((capability) =>
          targetCapabilities.includes(capability),
        );
        if (!sharesCapability) {
          violations.push(dependencyKey(source, target));
        }
      }
    }
  }

  const actual = [...new Set(violations)].sort();
  const expected = contract.dependencyExceptions
    .map(({ source, target }) => dependencyKey(source, target))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `Dependency exception allowlist drifted. Expected ${expected.join(', ') || 'none'}; found ${actual.join(', ') || 'none'}`,
    );
  }
}

export function validateEntrypoints(graph, contract, paths, errors) {
  const secondary = new Map(
    contract.secondaryEntrypoints.map(({ alias, target }) => [alias, target]),
  );
  const seenSecondary = new Set();
  const primaryEntrypoints = [];

  for (const [alias, targets] of Object.entries(paths)) {
    if (!alias.startsWith('@trinity/')) {
      continue;
    }
    if (alias.includes('*')) {
      errors.push(
        `Public entrypoint must be explicit, not wildcarded: ${alias}`,
      );
    }
    if (targets.length !== 1) {
      errors.push(`${alias} must resolve to exactly one source entrypoint`);
      continue;
    }
    const target = targets[0];
    if (target.endsWith('/src/index.ts')) {
      primaryEntrypoints.push({ alias, target });
      continue;
    }
    if (secondary.get(alias) !== target) {
      errors.push(`Unclassified secondary entrypoint: ${alias} -> ${target}`);
      continue;
    }
    seenSecondary.add(alias);
  }

  for (const alias of secondary.keys()) {
    if (!seenSecondary.has(alias)) {
      errors.push(`Secondary entrypoint allowlist is stale: ${alias}`);
    }
  }

  const entrypointExempt = new Set(
    contract.entrypointExemptProjects.map(({ project }) => project),
  );
  const expectedPrimaryTargets = new Map();
  for (const [project, node] of Object.entries(graph.nodes)) {
    if (entrypointExempt.has(project) || !node.data.root.startsWith('libs/')) {
      continue;
    }
    const expected = `./${node.data.root}/src/index.ts`;
    expectedPrimaryTargets.set(expected, project);
  }

  const primaryByTarget = new Map();
  for (const entrypoint of primaryEntrypoints) {
    const entries = primaryByTarget.get(entrypoint.target) ?? [];
    entries.push(entrypoint);
    primaryByTarget.set(entrypoint.target, entries);
    if (!expectedPrimaryTargets.has(entrypoint.target)) {
      errors.push(
        `Primary entrypoint is not owned by a classified library: ${entrypoint.alias} -> ${entrypoint.target}`,
      );
    }
  }
  for (const [target, project] of expectedPrimaryTargets) {
    const entries = primaryByTarget.get(target) ?? [];
    if (entries.length !== 1) {
      errors.push(
        `${project} must have exactly one explicit public entrypoint at ${target}; found ${entries.length}`,
      );
    }
  }

  return {
    primary: primaryEntrypoints
      .map((entrypoint) => ({
        ...entrypoint,
        project: expectedPrimaryTargets.get(entrypoint.target) ?? 'unowned',
      }))
      .sort((left, right) => left.alias.localeCompare(right.alias)),
    secondary: contract.secondaryEntrypoints
      .map((entrypoint) => ({ ...entrypoint }))
      .sort((left, right) => left.alias.localeCompare(right.alias)),
  };
}

export function validateFrozenMeasurements(measurements, contract, errors) {
  for (const [name, value] of Object.entries(measurements)) {
    const frozen = contract.sourceBaselines[name].value;
    if (value === 0 && frozen !== 0) {
      errors.push(`${name} source sweep found no matches`);
    }
    if (value !== frozen) {
      errors.push(
        `${name} changed from its frozen value ${frozen} to ${value}`,
      );
    }
  }
}

function validateSourceBaselines(contract, errors) {
  const measurements = {
    appInitializers: initializerCount(
      contract.sourceBaselines.appInitializers.path,
    ),
    messageViewLines: lineCount(contract.sourceBaselines.messageViewLines.path),
    roomLibraryServiceLines: lineCount(
      contract.sourceBaselines.roomLibraryServiceLines.path,
    ),
  };
  validateFrozenMeasurements(measurements, contract, errors);
  return measurements;
}

function projectSummary(graph, classification) {
  return Object.keys(graph.nodes)
    .sort()
    .map((project) => {
      const node = graph.nodes[project];
      const role = classification.roles.get(project);
      const capabilities = classification.capabilities.get(project);
      let classificationText = 'unmanaged tooling/test';
      if (classification.classificationExceptions.has(project)) {
        classificationText = 'migration exception';
      } else if (role) {
        classificationText = `role:${role}; ${capabilities
          .map((capability) => `capability:${capability}`)
          .join(', ')}`;
      }
      return `| \`${project}\` | \`${node.data.root}\` | ${classificationText} | ${(graph.dependencies[project] ?? []).length} |`;
    })
    .join('\n');
}

function renderDependencyMap(
  graph,
  contract,
  classification,
  measurements,
  entrypoints,
) {
  const projectCount = Object.keys(graph.nodes).length;
  const dependencyCount = Object.values(graph.dependencies).reduce(
    (total, edges) => total + edges.length,
    0,
  );
  const cycles = findCycles(graph.dependencies);
  const roleCounts = {};
  for (const role of classification.roles.values()) {
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
  }
  const roleRows = Object.keys(contract.roles)
    .map(
      (role) =>
        `| \`role:${role}\` | ${roleCounts[role] ?? 0} | ${contract.roles[role].map((target) => `\`role:${target}\``).join(', ')} |`,
    )
    .join('\n');
  const exceptionRows = contract.dependencyExceptions
    .map(
      ({ source, target, removeBy, reason }) =>
        `| \`${source}\` | \`${target}\` | ${removeBy} | ${reason} |`,
    )
    .join('\n');
  const multiCapabilityRows = contract.multiCapabilityProjects
    .map(
      ({ project, capabilities, removeBy, reason }) =>
        `| \`${project}\` | ${capabilities.map((capability) => `\`capability:${capability}\``).join(', ')} | ${removeBy} | ${reason} |`,
    )
    .join('\n');
  const primaryEntrypointRows = entrypoints.primary
    .map(
      ({ project, alias, target }) =>
        `| \`${project}\` | \`${alias}\` | \`${target}\` |`,
    )
    .join('\n');
  const secondaryEntrypointRows = entrypoints.secondary
    .map(
      ({ alias, target, removeBy, reason }) =>
        `| \`${alias}\` | \`${target}\` | ${removeBy} | ${reason} |`,
    )
    .join('\n');

  return `# Generated architecture dependency map

<!-- Generated by \`pnpm architecture:map\`; do not edit by hand. -->

This snapshot contains **${projectCount} Nx projects** and **${dependencyCount} dependencies**. ${cycles.length === 0 ? 'No project cycles detected.' : `${cycles.length} project cycles detected.`}

## Target dependency direction

\`\`\`mermaid
flowchart LR
  app[role:app] --> application[role:application]
  app --> capability[role:capability]
  app --> kernel[role:kernel]
  app --> adapter[role:adapter]
  app --> design[role:design-system]
  application --> capability
  application --> kernel
  application --> adapter
  application --> design
  capability --> kernel
  capability --> adapter
  capability --> design
  adapter --> kernel
  design --> kernel
  design --> adapter
\`\`\`

Capability-to-capability dependencies are valid only inside the same named capability. Cross-capability workflows belong in \`role:application\` projects.

## Role rules

| Source role | Projects | May depend on |
| --- | ---: | --- |
${roleRows}

## Frozen dependency exceptions

The validator compares this table to the live Nx graph exactly. A new edge or a stale exception fails the check.

| Source | Target | Removal issue | Reason |
| --- | --- | --- | --- |
${exceptionRows}

## Multi-capability migration projects

The validator compares each project's complete capability set to this ledger.

| Project | Frozen capabilities | Removal issue | Reason |
| --- | --- | --- | --- |
${multiCapabilityRows}

## Public entrypoints

Every classified library has exactly one explicit primary entrypoint. Additional entrypoints are temporary, exact exceptions with removal issues.

| Project | Primary alias | Target |
| --- | --- | --- |
${primaryEntrypointRows}

| Secondary alias | Target | Removal issue | Reason |
| --- | --- | --- | --- |
${secondaryEntrypointRows}

## Source baselines

These are ratcheted snapshots. Any change fails until the measured value and ledger are reviewed and updated together; migration tickets are expected to reduce them toward zero.

| Baseline | Current | Frozen value | Removal issue |
| --- | ---: | ---: | --- |
| Application initializers | ${measurements.appInitializers} | ${contract.sourceBaselines.appInitializers.value} | ${contract.sourceBaselines.appInitializers.removeBy} |
| Message projection lines | ${measurements.messageViewLines} | ${contract.sourceBaselines.messageViewLines.value} | ${contract.sourceBaselines.messageViewLines.removeBy} |
| Room Library service lines | ${measurements.roomLibraryServiceLines} | ${contract.sourceBaselines.roomLibraryServiceLines.value} | ${contract.sourceBaselines.roomLibraryServiceLines.removeBy} |

## Project classifications

| Nx project | Root | Architecture metadata | Direct dependencies |
| --- | --- | --- | ---: |
${projectSummary(graph, classification)}
`;
}

async function validateWorkspace({ checkMap }) {
  const graph = nxGraph();
  const contract = readJson(contractPath);
  const qualityBaselines = readJson(qualityBaselinesPath);
  const errors = [];
  validateLedger(contract, errors);
  validateQualityBaselines(qualityBaselines, errors);
  const classification = classify(graph, contract, errors);
  validateDependencies(graph, contract, classification, errors);
  const paths = readJson(join(workspaceRoot, 'tsconfig.base.json'))
    .compilerOptions.paths;
  const entrypoints = validateEntrypoints(graph, contract, paths, errors);
  const measurements = validateSourceBaselines(contract, errors);
  const cycles = findCycles(graph.dependencies);
  if (cycles.length > 0) {
    errors.push(
      `Nx project cycles detected: ${cycles.map((cycle) => cycle.join(' -> ')).join('; ')}`,
    );
  }
  const dependencyMap = await format(
    renderDependencyMap(
      graph,
      contract,
      classification,
      measurements,
      entrypoints,
    ),
    {
      filepath: dependencyMapPath,
    },
  );
  if (checkMap) {
    let committedMap = '';
    try {
      committedMap = readFileSync(dependencyMapPath, 'utf8');
    } catch {
      errors.push(
        'Generated dependency map is missing; run pnpm architecture:map',
      );
    }
    validateMapFreshness(dependencyMap, committedMap, errors);
  }
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  }
  return { graph, contract, dependencyMap };
}

export function validateMapFreshness(expected, committed, errors) {
  if (committed && committed !== expected) {
    errors.push('Generated dependency map is stale; run pnpm architecture:map');
  }
}

async function runCli(command) {
  if (command === 'check') {
    const { graph, contract } = await validateWorkspace({ checkMap: true });
    const dependencyCount = Object.values(graph.dependencies).reduce(
      (total, edges) => total + edges.length,
      0,
    );
    process.stdout.write(
      `Architecture contract is valid (${Object.keys(graph.nodes).length} projects, ${dependencyCount} dependencies, ${contract.dependencyExceptions.length} frozen dependency exceptions).\n`,
    );
  } else if (command === 'write-map') {
    const { dependencyMap } = await validateWorkspace({ checkMap: false });
    writeFileSync(dependencyMapPath, dependencyMap);
    process.stdout.write(`Wrote ${dependencyMapPath}\n`);
  } else {
    process.stderr.write(
      'Usage: node scripts/architecture-contract.mjs <check|write-map>\n',
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli(process.argv[2]);
}
