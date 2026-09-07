import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E2E_AGGREGATE_TARGETS,
  E2E_CI_ENTRYPOINTS,
  E2E_INVENTORY,
  E2E_PACKAGE_SCRIPTS,
  E2E_QUARANTINE,
  E2E_SERIALIZATION_RESOURCES,
  E2E_SUITES,
  E2E_TIMEOUTS_MS,
} from '../e2e/registry/index.mts';
import { validateBrowserJourneyInventory } from './e2e-browser-inventory.mjs';
import { validateProtocolAssertionInventory } from './e2e-protocol-inventory.mjs';

const TARGET_PROJECT_BY_ENVIRONMENT = {
  android: 'trinity-e2e-android',
  browser: 'trinity-e2e-browser',
  components: 'trinity-e2e-components',
  electron: 'trinity-e2e-electron',
  protocol: 'trinity-e2e-protocol',
  web: 'trinity-e2e-web',
};

const PROJECT_FILES = {
  'trinity-android': 'android/project.json',
  'trinity-desktop': 'electron/project.json',
  'trinity-e2e': 'e2e/project.json',
  'trinity-e2e-android': 'e2e/android/project.json',
  'trinity-e2e-browser': 'e2e/browser/project.json',
  'trinity-e2e-components': 'e2e/components/project.json',
  'trinity-e2e-electron': 'e2e/electron/project.json',
  'trinity-e2e-protocol': 'e2e/protocol/project.json',
  'trinity-e2e-web': 'e2e/web/project.json',
};

const resolvedProjects = new Map();
const HISTORICAL_E2E_NAME =
  /(?:phase[ _-]?[67]|shipped[ _-]?ui|shipped-interface)/iu;
const RETAINED_COMPATIBILITY_ALIAS = 'e2e:ui:shipped';
const ACTIVE_LIFECYCLE_PROJECTS = new Set([
  'trinity-e2e-android',
  'trinity-e2e-browser',
  'trinity-e2e-components',
  'trinity-e2e-electron',
  'trinity-e2e-protocol',
  'trinity-e2e-web',
]);

export const registrySnapshot = () =>
  structuredClone({
    suites: E2E_SUITES,
    resources: E2E_SERIALIZATION_RESOURCES,
    packageScripts: E2E_PACKAGE_SCRIPTS,
    aggregateTargets: E2E_AGGREGATE_TARGETS,
    ciEntrypoints: E2E_CI_ENTRYPOINTS,
    quarantine: E2E_QUARANTINE,
    timeouts: E2E_TIMEOUTS_MS,
    inventory: E2E_INVENTORY,
  });

const duplicateValues = (values) => {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
};

const recordDuplicates = (errors, label, values) => {
  for (const duplicate of duplicateValues(values)) {
    errors.push(`duplicate ${label}: ${duplicate}`);
  }
};

export function validateRegistry(snapshot, now = new Date()) {
  const errors = [];
  const suiteIds = new Set(snapshot.suites.map(({ id }) => id));
  const scriptByName = new Map(
    snapshot.packageScripts.map((script) => [script.name, script]),
  );
  const resourceKeys = new Set(snapshot.resources.map(({ key }) => key));

  recordDuplicates(
    errors,
    'suite id',
    snapshot.suites.map(({ id }) => id),
  );
  recordDuplicates(
    errors,
    'current target',
    snapshot.suites.flatMap(({ currentTarget, delegatingTargets = [] }) => [
      currentTarget,
      ...delegatingTargets,
    ]),
  );
  recordDuplicates(
    errors,
    'serialization resource',
    snapshot.resources.map(({ key }) => key),
  );
  recordDuplicates(
    errors,
    'package script',
    snapshot.packageScripts.map(({ name }) => name),
  );
  recordDuplicates(
    errors,
    'aggregate target',
    snapshot.aggregateTargets.map(({ target }) => target),
  );
  recordDuplicates(
    errors,
    'CI entrypoint',
    snapshot.ciEntrypoints.map(({ command }) => command),
  );
  recordDuplicates(
    errors,
    'CI suite',
    snapshot.ciEntrypoints.flatMap(({ suiteIds }) => suiteIds),
  );

  for (const suite of snapshot.suites) {
    if (suite.capabilities.length === 0 || suite.contractTypes.length === 0) {
      errors.push(`${suite.id} is missing capability or contract annotations`);
    }
    if (suite.prerequisites.length === 0) {
      errors.push(`${suite.id} has no explicit prerequisite classification`);
    }
    if (!['required', 'optional'].includes(suite.availabilityPolicy)) {
      errors.push(`${suite.id} has no explicit availability policy`);
    }
    if (suite.cachePolicy !== 'never') {
      errors.push(`${suite.id} permits caching for an E2E runtime result`);
    }
    if (
      suite.targetProject !== TARGET_PROJECT_BY_ENVIRONMENT[suite.environment]
    ) {
      errors.push(`${suite.id} targets the wrong lifecycle project`);
    }
    if (!(suite.timeoutClass in snapshot.timeouts)) {
      errors.push(`${suite.id} uses an unknown timeout class`);
    }
    const standardArtifactRoot = `dist/.playwright/${suite.targetProject}/<run-id>`;
    if (suite.targetArtifactRoot !== standardArtifactRoot) {
      errors.push(
        `${suite.id} target artifacts must use ${standardArtifactRoot}`,
      );
    }
    if (
      suite.currentTarget.startsWith(`${suite.targetProject}:`) &&
      suite.currentArtifactRoot !== standardArtifactRoot
    ) {
      errors.push(
        `${suite.id} current artifacts must use ${standardArtifactRoot}`,
      );
    }
    if (
      ACTIVE_LIFECYCLE_PROJECTS.has(suite.targetProject) &&
      !suite.currentTarget.startsWith(`${suite.targetProject}:`)
    ) {
      errors.push(`${suite.id} bypasses its active lifecycle project`);
    }
    if (suite.sourceEntrypoints.length === 0) {
      errors.push(`${suite.id} has no source entrypoint`);
    }
    for (const key of suite.serializationKeys) {
      if (!resourceKeys.has(key)) {
        errors.push(`${suite.id} uses undefined serialization resource ${key}`);
      }
    }

    const canonicalScript = scriptByName.get(suite.canonicalScript);
    if (!canonicalScript || canonicalScript.kind !== 'canonical') {
      errors.push(`${suite.id} has no canonical package command`);
    } else if (!canonicalScript.suiteIds.includes(suite.id)) {
      errors.push(`${suite.id} is absent from ${suite.canonicalScript}`);
    }
  }

  for (const script of snapshot.packageScripts) {
    for (const suiteId of script.suiteIds) {
      if (!suiteIds.has(suiteId)) {
        errors.push(`${script.name} references unknown suite ${suiteId}`);
      }
    }
    if (script.kind === 'compatibility') {
      const criterion = script.removalAfterRelease ?? '';
      if (
        ![
          'released changelog',
          'documented replacements',
          'zero repository or CI references',
          'no reported migration failures',
        ].every((requirement) => criterion.includes(requirement))
      ) {
        errors.push(
          `${script.name} has incomplete compatibility removal criteria`,
        );
      }
    }
  }

  const aggregateTargets = new Set(
    snapshot.aggregateTargets.map(({ target }) => `trinity-e2e:${target}`),
  );
  for (const script of snapshot.packageScripts) {
    if (script.kind !== 'canonical') continue;
    const target = script.command.match(/^nx run ([^ ]+)$/)?.[1];
    if (!target || !aggregateTargets.has(target)) {
      errors.push(`${script.name} bypasses the E2E aggregate runner`);
    }
  }

  for (const entrypoint of snapshot.ciEntrypoints) {
    for (const suiteId of entrypoint.suiteIds) {
      const suite = snapshot.suites.find(({ id }) => id === suiteId);
      if (!suite) {
        errors.push(
          `${entrypoint.command} references unknown suite ${suiteId}`,
        );
      } else if (suite.ciTier !== entrypoint.tier) {
        errors.push(
          `${suiteId} runs in ${entrypoint.tier} CI but is classified ${suite.ciTier}`,
        );
      }
    }
  }

  for (const aggregate of snapshot.aggregateTargets) {
    const expectedPolicy = aggregate.selection.kind === 'all' ? 'skip' : 'fail';
    if (aggregate.unavailablePolicy !== expectedPolicy) {
      errors.push(
        `${aggregate.target} must use ${expectedPolicy} unavailable prerequisites`,
      );
    }
  }

  const today = now.toISOString().slice(0, 10);
  for (const entry of snapshot.quarantine) {
    if (!suiteIds.has(entry.suiteId)) {
      errors.push(`quarantine references unknown suite ${entry.suiteId}`);
    }
    if (!entry.issue || !entry.owner || !entry.reason) {
      errors.push(
        `quarantine for ${entry.suiteId} is missing issue, owner or reason`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn)) {
      errors.push(`quarantine for ${entry.suiteId} has an invalid expiry`);
    } else if (entry.expiresOn < today) {
      errors.push(
        `quarantine for ${entry.suiteId} expired on ${entry.expiresOn}`,
      );
    }
  }

  return errors;
}

const readJson = (workspaceRoot, path) =>
  JSON.parse(readFileSync(join(workspaceRoot, path), 'utf8'));

const resolvedProject = (workspaceRoot, project) => {
  const key = `${workspaceRoot}:${project}`;
  const cached = resolvedProjects.get(key);
  if (cached) return cached;

  const source = execFileSync(
    'pnpm',
    ['exec', 'nx', 'show', 'project', project, '--json'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, NX_DAEMON: 'false' },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const projectConfiguration = JSON.parse(source);
  resolvedProjects.set(key, projectConfiguration);
  return projectConfiguration;
};

const targetDefinition = (workspaceRoot, targetReference) => {
  const separator = targetReference.indexOf(':');
  const project = targetReference.slice(0, separator);
  const target = targetReference.slice(separator + 1);
  const projectFile = PROJECT_FILES[project];
  if (!projectFile) return undefined;
  return resolvedProject(workspaceRoot, project).targets?.[target];
};

export const yamlRunCommands = (source) => {
  const commands = [];
  const lines = source.split('\n');
  let blockIndent;

  for (const line of lines) {
    const trimmed = line.trim();
    const indentation = line.length - line.trimStart().length;
    if (blockIndent !== undefined) {
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      if (indentation > blockIndent) {
        commands.push(trimmed);
        continue;
      }
      blockIndent = undefined;
    }

    const match = line.match(/^\s*(?:-\s*)?(?:run|script):\s*(.*)$/);
    if (!match) continue;
    if (match[1] === '|' || match[1] === '>') {
      blockIndent = indentation;
    } else if (match[1]) {
      commands.push(match[1]);
    }
  }

  return commands
    .map((command) => {
      const wrapper = command.match(
        /^(.*?\s)?node scripts\/ci-run-command\.mjs --timeout-ms \d+ -- (.+)$/u,
      );
      return wrapper ? `${wrapper[1] ?? ''}${wrapper[2]}` : command;
    })
    .filter((command) => /(?:trinity-e2e|e2e:|electron:e2e)/.test(command));
};

export const yamlReportPaths = (source) =>
  [...source.matchAll(/^\s*(?:-\s*)?report-path:\s*(\S.*)$/gmu)].map((match) =>
    match[1].trim(),
  );

export const validateCiReportPaths = (errors, source, snapshot) => {
  const paths = yamlReportPaths(source);
  const suitesById = new Map(snapshot.suites.map((suite) => [suite.id, suite]));
  const coveredSuites = new Set();
  for (const path of paths) {
    if (path === 'dist/.playwright/**/**') continue;
    const match = path.match(
      /^dist\/\.playwright\/([^/]+)\/\*\/([^/]+)\/\*\*$/u,
    );
    if (!match) {
      errors.push(`CI report path has an invalid registry shape: ${path}`);
      continue;
    }
    const [project, suiteId] = match.slice(1);
    const suite = suitesById.get(suiteId);
    if (!suite) {
      errors.push(`CI report path references unknown suite: ${path}`);
      continue;
    }
    if (suite.targetProject !== project) {
      errors.push(
        `CI report path for ${suiteId} targets ${project}, expected ${suite.targetProject}`,
      );
      continue;
    }
    coveredSuites.add(suiteId);
  }
  for (const suite of snapshot.suites) {
    if (
      suite.ciTier !== 'local-only' &&
      suite.ciTier !== 'scheduled' &&
      snapshot.ciEntrypoints.some(({ suiteIds }) =>
        suiteIds.includes(suite.id),
      ) &&
      !coveredSuites.has(suite.id)
    ) {
      errors.push(`CI report path is missing suite ${suite.id}`);
    }
  }
};

const validatePackageScripts = (
  errors,
  workspaceRoot,
  packageScripts,
  snapshot,
) => {
  const contractNames = new Set(
    snapshot.packageScripts.map(({ name }) => name),
  );

  for (const contract of snapshot.packageScripts) {
    const packageCommand = packageScripts[contract.name]?.replace(
      /^node scripts\/nx\.mjs run /u,
      'nx run ',
    );
    if (packageCommand !== contract.command) {
      errors.push(`package script ${contract.name} drifted from the registry`);
    }
  }
  for (const scriptName of Object.keys(packageScripts)) {
    if (
      /^(?:e2e(?::|$)|electron:e2e(?::|$)|spike:(?:chromium|webkit)$|smoke:login$)/.test(
        scriptName,
      ) &&
      !contractNames.has(scriptName)
    ) {
      errors.push(`package script ${scriptName} is unregistered`);
    }
  }

  for (const contract of snapshot.packageScripts) {
    const match = contract.command.match(/^nx run ([^ ]+)$/);
    if (match && !targetDefinition(workspaceRoot, match[1])) {
      errors.push(`${contract.name} targets missing Nx task ${match[1]}`);
    }
  }
};

const validateSuiteFilesAndTargets = (errors, workspaceRoot, snapshot) => {
  for (const suite of snapshot.suites) {
    for (const entrypoint of suite.sourceEntrypoints) {
      if (!existsSync(join(workspaceRoot, entrypoint))) {
        errors.push(`${suite.id} entrypoint does not exist: ${entrypoint}`);
      }
    }
    for (const target of [
      suite.currentTarget,
      ...(suite.delegatingTargets ?? []),
    ]) {
      const definition = targetDefinition(workspaceRoot, target);
      if (!definition) {
        errors.push(`${suite.id} target does not exist: ${target}`);
        continue;
      }
      if (definition.cache !== false) {
        errors.push(`${target} must explicitly disable caching`);
      }
      if (
        suite.serializationKeys.length > 0 &&
        definition.parallelism !== false
      ) {
        errors.push(`${target} must explicitly disable task parallelism`);
      }
      if (
        target === suite.currentTarget &&
        target.startsWith(`${suite.targetProject}:`) &&
        !definition.outputs?.includes(
          `{workspaceRoot}/dist/.playwright/${suite.targetProject}`,
        )
      ) {
        errors.push(
          `${target} must publish the standard ${suite.targetProject} artifact root`,
        );
      }
    }
    if (suite.ciRetries !== undefined) {
      if (!Number.isInteger(suite.ciRetries) || suite.ciRetries < 0) {
        errors.push(`${suite.id} has an invalid CI retry policy`);
      }
      const configEntrypoint = suite.sourceEntrypoints.find((entrypoint) =>
        /playwright\.config\.mts$/u.test(entrypoint),
      );
      const source = configEntrypoint
        ? readFileSync(join(workspaceRoot, configEntrypoint), 'utf8')
        : '';
      if (suite.ciRetries !== 1) {
        errors.push(`${suite.id} must allow exactly one CI retry`);
      } else {
        if (!source.includes("retries: process.env['CI'] ? 1 : 0")) {
          errors.push(`${suite.id} must allow exactly one CI retry`);
        }
        if (!source.includes("failOnFlakyTests: Boolean(process.env['CI'])")) {
          errors.push(`${suite.id} must fail on flaky tests in CI`);
        }
        if (!source.includes("trace: 'retain-on-failure'")) {
          errors.push(`${suite.id} must retain failed-attempt traces`);
        }
        if (!source.includes("screenshot: 'only-on-failure'")) {
          errors.push(`${suite.id} must retain failed-attempt screenshots`);
        }
      }
    }
  }
};

const validateAggregateTargets = (errors, workspaceRoot, snapshot) => {
  const e2eProject = readJson(workspaceRoot, 'e2e/project.json');
  for (const { target } of snapshot.aggregateTargets) {
    const definition = e2eProject.targets?.[target];
    if (!definition) {
      errors.push(`aggregate target trinity-e2e:${target} does not exist`);
    } else if (definition.cache !== false || definition.parallelism !== false) {
      errors.push(
        `aggregate target trinity-e2e:${target} must be serial and uncached`,
      );
    }
  }
};

const registeredTargets = (snapshot) =>
  new Set([
    ...snapshot.suites.flatMap(({ currentTarget, delegatingTargets = [] }) => [
      currentTarget,
      ...delegatingTargets,
    ]),
    ...snapshot.aggregateTargets.map(({ target }) => `trinity-e2e:${target}`),
    ...snapshot.packageScripts.flatMap(({ command, kind }) => {
      const match = command.match(/^nx run ([^ ]+)$/);
      return kind === 'maintenance' && match ? [match[1]] : [];
    }),
  ]);

const validateTargetInventory = (errors, workspaceRoot, snapshot) => {
  const knownTargets = registeredTargets(snapshot);
  for (const targetProject of snapshot.inventory.trackedTargetProjects) {
    if (!existsSync(join(workspaceRoot, targetProject.projectFile))) {
      errors.push(
        `tracked project file is absent: ${targetProject.projectFile}`,
      );
      continue;
    }
    const project = resolvedProject(workspaceRoot, targetProject.project);
    const includedTargets = targetProject.includedTargets
      ? new Set(targetProject.includedTargets)
      : undefined;
    const ignoredTargets = new Set(targetProject.ignoredTargets ?? []);
    for (const target of Object.keys(project.targets ?? {})) {
      if (
        ignoredTargets.has(target) ||
        (includedTargets && !includedTargets.has(target))
      ) {
        continue;
      }
      const reference = `${targetProject.project}:${target}`;
      if (!knownTargets.has(reference)) {
        errors.push(`unregistered E2E target: ${reference}`);
      }
    }
  }
};

const validateEntrypointInventory = (errors, workspaceRoot, snapshot) => {
  const trackedEntrypoints =
    snapshot.inventory.trackedEntrypointPatterns.flatMap((pattern) =>
      globSync(pattern, { cwd: workspaceRoot }),
    );
  const owners = new Map();
  for (const suite of snapshot.suites) {
    for (const entrypoint of suite.sourceEntrypoints) {
      const current = owners.get(entrypoint) ?? [];
      current.push(suite.id);
      owners.set(entrypoint, current);
    }
  }
  const sharedEntrypoints = new Map(
    snapshot.inventory.sharedEntrypoints.map(({ path, serializationKey }) => [
      path,
      serializationKey,
    ]),
  );
  for (const entrypoint of trackedEntrypoints) {
    const entrypointOwners = owners.get(entrypoint) ?? [];
    if (entrypointOwners.length === 0) {
      errors.push(`unregistered E2E entrypoint: ${entrypoint}`);
    } else if (
      entrypointOwners.length > 1 &&
      !sharedEntrypoints.has(entrypoint)
    ) {
      errors.push(`E2E entrypoint has multiple owners: ${entrypoint}`);
    }
  }
  for (const [sharedEntrypoint, serializationKey] of sharedEntrypoints) {
    const sharedOwners = owners.get(sharedEntrypoint) ?? [];
    if (sharedOwners.length < 2) {
      errors.push(`shared entrypoint is no longer shared: ${sharedEntrypoint}`);
    }
    for (const suiteId of sharedOwners) {
      const suite = snapshot.suites.find(({ id }) => id === suiteId);
      if (!suite?.serializationKeys.includes(serializationKey)) {
        errors.push(
          `${suiteId} does not serialize shared entrypoint ${sharedEntrypoint} with ${serializationKey}`,
        );
      }
    }
  }
};

const validateCanonicalSpecInventory = (errors, workspaceRoot, snapshot) => {
  const canonicalSpecs = globSync('e2e/browser/journeys/**/*.spec.mts', {
    cwd: workspaceRoot,
  });
  if (canonicalSpecs.length !== snapshot.inventory.canonicalBrowserSpecCount) {
    errors.push(
      `canonical browser inventory drifted: expected ${snapshot.inventory.canonicalBrowserSpecCount}, found ${canonicalSpecs.length}`,
    );
  }
};

const validateCiEntrypoints = (errors, workspaceRoot, snapshot) => {
  const workflow = readFileSync(
    join(workspaceRoot, '.github/workflows/ci.yml'),
    'utf8',
  );
  const observedCiCommands = yamlRunCommands(workflow);
  validateCiReportPaths(errors, workflow, snapshot);
  const expectedCiCommands = snapshot.ciEntrypoints.map(
    ({ command }) => command,
  );
  for (const command of observedCiCommands) {
    if (!expectedCiCommands.includes(command)) {
      errors.push(`unregistered CI E2E entrypoint: ${command}`);
    }
  }
  for (const command of expectedCiCommands) {
    if (!observedCiCommands.includes(command)) {
      errors.push(`registered CI E2E entrypoint is absent: ${command}`);
    }
  }
  const ciSuiteIds = new Set(
    snapshot.ciEntrypoints.flatMap(({ suiteIds }) => suiteIds),
  );
  for (const suite of snapshot.suites) {
    if (suite.ciTier === 'local-only' && ciSuiteIds.has(suite.id)) {
      errors.push(`local-only suite has a CI entrypoint: ${suite.id}`);
    } else if (suite.ciTier !== 'local-only' && !ciSuiteIds.has(suite.id)) {
      errors.push(`${suite.ciTier} suite has no CI entrypoint: ${suite.id}`);
    }
  }
  if (!workflow.includes('# 110 canonical browser specs')) {
    errors.push('CI canonical browser spec count is stale');
  }
};

const validateArchitectureCommand = (errors, packageScripts) => {
  if (
    !packageScripts['architecture:check']?.includes(
      'e2e-suite-registry.mjs check',
    )
  ) {
    errors.push('architecture:check does not enforce the E2E registry');
  }
};

export const validateDurableE2ENames = (errors, workspaceRoot) => {
  const paths = [
    ...globSync('e2e/**/*', { cwd: workspaceRoot }),
    ...globSync('scripts/*e2e*', { cwd: workspaceRoot }),
  ];
  for (const path of paths) {
    if (HISTORICAL_E2E_NAME.test(path)) {
      errors.push(`historical E2E name remains in path: ${path}`);
    }
  }

  const primarySources = [
    ...globSync('e2e/**/*.{json,md,mjs,mts}', { cwd: workspaceRoot }),
    ...globSync('scripts/*e2e*.{mjs,mts}', { cwd: workspaceRoot }),
    '.github/workflows/ci.yml',
    'docs/contributing/commands.md',
    'docs/contributing/e2e-architecture.md',
    'docs/contributing/testing.md',
  ].filter(
    (path) =>
      path !== 'scripts/e2e-suite-registry-validator.mjs' &&
      existsSync(join(workspaceRoot, path)),
  );
  for (const path of primarySources) {
    const source = readFileSync(join(workspaceRoot, path), 'utf8').replaceAll(
      RETAINED_COMPATIBILITY_ALIAS,
      '',
    );
    if (HISTORICAL_E2E_NAME.test(source)) {
      errors.push(`historical E2E name remains in source: ${path}`);
    }
  }
};

export function validateWorkspace(
  workspaceRoot,
  snapshot = registrySnapshot(),
) {
  const errors = validateRegistry(snapshot);
  const packageJson = readJson(workspaceRoot, 'package.json');
  const packageScripts = packageJson.scripts ?? {};

  validatePackageScripts(errors, workspaceRoot, packageScripts, snapshot);
  validateSuiteFilesAndTargets(errors, workspaceRoot, snapshot);
  validateAggregateTargets(errors, workspaceRoot, snapshot);
  validateTargetInventory(errors, workspaceRoot, snapshot);
  validateEntrypointInventory(errors, workspaceRoot, snapshot);
  validateCanonicalSpecInventory(errors, workspaceRoot, snapshot);
  validateBrowserJourneyInventory(
    errors,
    workspaceRoot,
    snapshot.suites.find(({ id }) => id === 'browser.canonical'),
  );
  validateProtocolAssertionInventory(errors, workspaceRoot);
  validateCiEntrypoints(errors, workspaceRoot, snapshot);
  validateArchitectureCommand(errors, packageScripts);
  validateDurableE2ENames(errors, workspaceRoot);

  return errors;
}
