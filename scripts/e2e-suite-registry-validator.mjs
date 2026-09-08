import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
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
import { CODE_JOB_IDS } from './ci-classify.mjs';

const TARGET_PROJECT_BY_ENVIRONMENT = {
  android: 'trinity-e2e-android',
  browser: 'trinity-e2e-browser',
  components: 'trinity-e2e-components',
  electron: 'trinity-e2e-electron',
  protocol: 'trinity-e2e-protocol',
  web: 'trinity-e2e-web',
};

const PROJECT_FILES = {
  'trinity-web-container': 'container/project.json',
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

const SHA_PIN = /@[0-9a-f]{40}$/iu;
const fiveReusableSuites = new Set([
  'components.storybook',
  'components.styling',
  'browser.canonical',
  'protocol.verify-qr',
  'web.production-renderer',
]);

const walkSteps = (document) => [
  ...Object.values(document?.jobs ?? {}).flatMap((job) => job?.steps ?? []),
  ...(document?.runs?.steps ?? []),
];

const scheduledInvocations = (document) =>
  walkSteps(document).reduce(
    (count, step) =>
      count +
      [...String(step?.run ?? '').matchAll(/\bpnpm e2e:scheduled\b/gu)].length,
    0,
  );

const workflowUses = (document) =>
  [
    ...Object.values(document?.jobs ?? {}).map((job) => job?.uses),
    ...walkSteps(document).map((step) => step?.uses),
  ].filter((uses) => typeof uses === 'string');

const hasSecretsInherit = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (value.secrets === 'inherit') return true;
  return Object.values(value).some(hasSecretsInherit);
};

const permissionKeysAre = (permissions, expected) =>
  permissions &&
  Object.keys(permissions).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, value]) => permissions[key] === value);

const localActionPaths = (workspaceRoot, document) => [
  ...new Set(
    [...walkSteps(document), ...Object.values(document?.jobs ?? {})]
      .map((item) => item?.uses)
      .filter((uses) => typeof uses === 'string' && uses.startsWith('./'))
      .map((uses) => uses.replace(/^\.\//u, ''))
      .filter((path) => existsSync(join(workspaceRoot, path))),
  ),
];

/** Validate the concrete caller/callee graph, including mutations that regex-only guards miss. */
export const validateWorkflowContracts = (
  workspaceRoot,
  { ci, e2e, renderer, restore, diagnostics, setupPlaywright, nightly } = {},
  expectedSuiteIds = fiveReusableSuites,
) => {
  const errors = [];
  const ciJobs = ci?.jobs ?? {};
  const e2eJobs = e2e?.jobs ?? {};
  if (scheduledInvocations(ci) !== 1)
    errors.push(
      'CI transition workflow must have exactly one scheduled aggregate invocation',
    );
  const reusableCalls = Object.entries(ciJobs).filter(
    ([, job]) => job?.uses === './.github/workflows/_e2e-suite.yml',
  );
  const expectedCallSuites = new Set();
  for (const [id, job] of reusableCalls) {
    const suiteId = job.with?.['suite-id'];
    if (!fiveReusableSuites.has(suiteId) || !expectedSuiteIds.has(suiteId)) {
      errors.push(
        `${id} calls an unknown or forbidden reusable suite: ${suiteId ?? 'missing'}`,
      );
    } else expectedCallSuites.add(suiteId);
    if (hasSecretsInherit(job)) errors.push(`${id} inherits secrets`);
    if (job.with?.environment !== undefined)
      errors.push(`${id} exposes a protected environment input`);
    if (
      !permissionKeysAre(job.permissions, { contents: 'read', actions: 'read' })
    ) {
      errors.push(
        `${id} must grant only the reusable workflow read permissions`,
      );
    }
    const sha = job.with?.sha;
    if (
      typeof sha !== 'string' ||
      !/^\$\{\{ (?:github\.sha|needs\.renderer\.outputs\.sha) \}\}$/u.test(sha)
    ) {
      errors.push(`${id} must pass an exact immutable checkout SHA`);
    }
    if (typeof job.with?.['diagnostics-artifact-name'] !== 'string') {
      errors.push(`${id} is missing a diagnostics artifact identity`);
    } else {
      const name = job.with['diagnostics-artifact-name'];
      for (const token of [
        'github.run_id',
        'github.run_attempt',
        'github.sha',
      ]) {
        if (!name.includes(token))
          errors.push(`${id} diagnostics identity omits ${token}`);
      }
      if (suiteId && !name.includes(suiteId.replaceAll('.', '-')))
        errors.push(`${id} diagnostics identity omits suite identity`);
    }
  }
  for (const suiteId of fiveReusableSuites) {
    if (!expectedCallSuites.has(suiteId))
      errors.push(`reusable suite caller is missing ${suiteId}`);
  }
  const rendererCaller = ciJobs.renderer;
  if (rendererCaller?.uses === './.github/workflows/_renderer.yml') {
    if (!permissionKeysAre(rendererCaller.permissions, { contents: 'read' })) {
      errors.push('renderer caller permissions must be contents read-only');
    }
    if (rendererCaller.with?.sha !== '${{ github.sha }}') {
      errors.push('renderer caller must pass github.sha exactly');
    }
  } else {
    errors.push('renderer caller is missing the local renderer workflow');
  }
  for (const [id, job] of Object.entries(e2eJobs)) {
    if (job?.uses)
      errors.push(`reusable E2E job ${id} nests another reusable workflow`);
  }
  if (
    !permissionKeysAre(e2eJobs.suite?.permissions, {
      contents: 'read',
      actions: 'read',
    })
  ) {
    errors.push(
      'reusable E2E callee permissions must be contents/actions read-only',
    );
  }
  if (
    !permissionKeysAre(renderer?.jobs?.renderer?.permissions, {
      contents: 'read',
    })
  ) {
    errors.push('renderer callee permissions must be contents read-only');
  }
  const exactCheckout = (document, expectedRef, label) => {
    const checkout = walkSteps(document).find(
      (step) =>
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/checkout@'),
    );
    if (!checkout || checkout.with?.ref !== expectedRef) {
      errors.push(`${label} checkout must use ${expectedRef}`);
    }
  };
  exactCheckout(e2e, '${{ inputs.sha }}', 'reusable E2E');
  exactCheckout(renderer, '${{ inputs.sha }}', 'renderer');
  const allDocuments = [
    ci,
    nightly,
    e2e,
    renderer,
    restore,
    diagnostics,
    setupPlaywright,
  ].filter(Boolean);
  for (const document of [ci, e2e, renderer].filter(Boolean)) {
    for (const path of localActionPaths(workspaceRoot, document)) {
      const sourcePath =
        path.endsWith('.yml') || path.endsWith('.yaml')
          ? path
          : `${path}/action.yml`;
      try {
        allDocuments.push(
          parseYaml(readFileSync(join(workspaceRoot, sourcePath), 'utf8')),
        );
      } catch {
        errors.push(`local action cannot be parsed: ${sourcePath}`);
      }
    }
  }
  for (const document of allDocuments) {
    for (const uses of workflowUses(document)) {
      if (uses.startsWith('./')) continue;
      if (!SHA_PIN.test(uses))
        errors.push(`mutable or unpinned action reference: ${uses}`);
    }
    if (hasSecretsInherit(document))
      errors.push('secrets inherit is forbidden');
  }
  for (const [id, job] of Object.entries(ciJobs)) {
    if (!job || typeof job !== 'object') continue;
    if (job.strategy?.matrix && Object.keys(job.outputs ?? {}).length > 0)
      errors.push(`${id} exports a matrix scalar output`);
    if (job.strategy?.matrix && job.strategy['fail-fast'] !== false) {
      errors.push(`${id} matrix must disable fail-fast`);
    }
  }
  const requiredNeeds = new Set([
    ...(ciJobs.required?.needs ?? []),
    'classify',
    'docs-gate',
  ]);
  const requiredJob = ciJobs.required;
  const expectedRequiredNeeds = new Set([
    'classify',
    'docs-gate',
    ...CODE_JOB_IDS,
  ]);
  if (requiredJob?.name !== 'CI / Required')
    errors.push(
      'Required aggregate must emit the exact CI / Required check name',
    );
  if (
    !Array.isArray(requiredJob?.needs) ||
    requiredJob.needs.length !== expectedRequiredNeeds.size ||
    new Set(requiredJob.needs).size !== expectedRequiredNeeds.size ||
    requiredJob.needs.some((id) => !expectedRequiredNeeds.has(id))
  )
    errors.push('Required aggregate needs must be complete and explicit');
  if (
    !permissionKeysAre(requiredJob?.permissions, {
      contents: 'read',
      'pull-requests': 'read',
      actions: 'read',
    })
  )
    errors.push(
      'Required aggregate permissions must be contents and pull requests read-only',
    );
  const sourceStep = requiredJob?.steps?.find(
    (step) => step?.id === 'master-source',
  );
  const evaluatorStep = requiredJob?.steps?.find(
    (step) => step?.name === 'Evaluate required results',
  );
  if (sourceStep?.run !== 'node scripts/ci-master-source.mjs')
    errors.push('Required aggregate must run the master source guard');
  if (sourceStep?.['continue-on-error'] !== true)
    errors.push(
      'Required aggregate source guard must preserve evaluator diagnostics',
    );
  if (
    !evaluatorStep ||
    !String(evaluatorStep.env?.CI_SOURCE_RESULT ?? '').includes(
      'steps.master-source.outcome',
    )
  )
    errors.push('Required evaluator must consume the source guard outcome');
  for (const id of CODE_JOB_IDS) {
    if (!requiredNeeds.has(id)) errors.push(`Required aggregate omits ${id}`);
  }
  if (!expectedCallSuites.has('web.production-renderer')) {
    errors.push(
      'production-renderer-e2e is missing the reusable production suite caller',
    );
  }
  const productionConsumers = [
    'web-container',
    'desktop-e2e',
    'android-e2e',
    'ios-native-build',
  ];
  for (const id of productionConsumers) {
    const job = ciJobs[id];
    if (!job) {
      errors.push(`production consumer is missing ${id}`);
      continue;
    }
    if (!job.needs || ![job.needs].flat().includes('renderer'))
      errors.push(`${id} does not depend on renderer`);
    const steps = job.steps ?? [];
    if (
      !steps.some(
        (step) => step.uses === './.github/actions/restore-verified-renderer',
      )
    )
      errors.push(`${id} does not restore the verified renderer`);
    const upload = steps.find(
      (step) => step.uses === './.github/actions/upload-playwright-diagnostics',
    );
    if (
      id !== 'ios-native-build' &&
      (!upload || !String(upload.if).includes('outputs.started'))
    )
      errors.push(`${id} does not gate diagnostics on started execution`);
    if (id === 'ios-native-build') {
      if (
        !steps.some((step) =>
          String(step.run).includes('trinity-ios:build-prebuilt'),
        )
      )
        errors.push(
          'ios-native-build bypasses the managed Nx build-prebuilt target',
        );
      if (
        !steps.some((step) =>
          String(step.if).includes('steps.ios.outputs.started'),
        )
      )
        errors.push(
          'ios-native-build diagnostics are not gated on started execution',
        );
    }
  }
  const reusableSteps = walkSteps(e2e);
  const restoreStep = reusableSteps.find(
    (step) => step.uses === './.github/actions/restore-verified-renderer',
  );
  if (!restoreStep)
    errors.push('reusable E2E workflow has no verified renderer restore step');
  if (
    restoreStep?.if !== "${{ steps.plan.outputs.requires-renderer == 'true' }}"
  )
    errors.push('reusable E2E restore is not controlled by the registry plan');
  const reportUpload = reusableSteps.find(
    (step) => step.uses === './.github/actions/upload-playwright-diagnostics',
  );
  if (
    reportUpload?.with?.['report-path'] !==
    '${{ steps.plan.outputs.report-path }}'
  )
    errors.push('reusable E2E report path is not registry-owned');
  if (
    !reportUpload ||
    !String(reportUpload.if).includes('steps.suite.outputs.started')
  )
    errors.push('reusable E2E diagnostics are not gated on started execution');
  if (nightly) {
    const triggers = nightly.on ?? {};
    if (
      nightly.concurrency?.group !==
        '${{ github.workflow }}-${{ github.ref }}' ||
      nightly.concurrency?.['cancel-in-progress'] !== true
    )
      errors.push(
        'nightly workflow must cancel superseded runs on the same ref',
      );
    const schedules = triggers.schedule ?? [];
    if (schedules.length !== 1 || schedules[0]?.cron !== '23 3 * * 1-6')
      errors.push(
        'nightly workflow must schedule Monday through Saturday at 03:23 UTC',
      );
    if (!triggers.workflow_dispatch)
      errors.push('nightly workflow must support workflow_dispatch');
    const nightlyJobs = Object.entries(nightly.jobs ?? {});
    if (
      nightlyJobs.length !== 1 ||
      nightly.jobs?.['scheduled-e2e'] === undefined
    )
      errors.push('nightly workflow must have one canonical scheduled job');
    const nightlyJob = nightly.jobs?.['scheduled-e2e'];
    if (nightlyJob?.['timeout-minutes'] !== 120)
      errors.push('nightly scheduled job must retain a 120 minute ceiling');
    if (
      !permissionKeysAre(nightly.permissions, {
        contents: 'read',
        actions: 'read',
      })
    )
      errors.push(
        'nightly workflow permissions must be contents/actions read-only',
      );
    if (nightlyJob?.uses)
      errors.push('nightly scheduled job must not nest a reusable workflow');
    const checkout = (nightlyJob?.steps ?? []).find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    if (checkout?.with?.ref !== '${{ github.sha }}')
      errors.push('nightly checkout must use github.sha exactly');
    const identity = (nightlyJob?.steps ?? []).find((step) =>
      String(step.run).includes('Nightly execution identity'),
    );
    if (
      !identity ||
      !identity.env?.EVENT_NAME ||
      !identity.env?.EVENT_REF ||
      !identity.env?.EVENT_SHA ||
      String(identity.run).includes('${{')
    )
      errors.push(
        'nightly identity must pass event values through the environment',
      );
    const defaultRefGuard = (nightlyJob?.steps ?? []).find((step) =>
      String(step.run).includes('refs/heads/develop'),
    );
    if (
      !defaultRefGuard ||
      !String(defaultRefGuard.if).includes("event_name == 'schedule'")
    )
      errors.push('nightly scheduled runs must guard the develop default ref');
    const aggregate = (nightlyJob?.steps ?? []).find((step) =>
      String(step.run).includes('pnpm e2e:scheduled'),
    );
    if (scheduledInvocations(nightly) !== 1)
      errors.push(
        'nightly workflow must have exactly one scheduled aggregate invocation',
      );
    if (!aggregate || !String(aggregate.run).includes('--timeout-ms 6600000'))
      errors.push(
        'nightly workflow must invoke the canonical scheduled aggregate with its managed ceiling',
      );
    const upload = (nightlyJob?.steps ?? []).find(
      (step) => step.uses === './.github/actions/upload-playwright-diagnostics',
    );
    if (
      !upload ||
      !String(upload.if).includes('steps.scheduled.outputs.started') ||
      !String(upload.with?.path ?? upload.with?.['report-path']).includes(
        'dist/.playwright',
      )
    )
      errors.push('nightly diagnostics must retain started suite reports');
    const timing = (nightlyJob?.steps ?? []).find((step) =>
      String(step.run).includes('ci-timing-summary.mjs'),
    );
    if (
      !timing ||
      timing['continue-on-error'] !== true ||
      timing.env?.GH_TOKEN !== '${{ github.token }}'
    )
      errors.push(
        'nightly timing reporting must be best effort with a narrowly scoped token',
      );
    if (
      timing &&
      upload &&
      nightlyJob.steps.indexOf(timing) > nightlyJob.steps.indexOf(upload)
    )
      errors.push(
        'nightly timing reporting must run before diagnostics upload',
      );
  }
  return errors;
};

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
    const expectedCiPreparation = {
      'components.storybook': {
        buildTarget: 'components-storybook-host:build-storybook',
      },
      'components.styling': { buildTarget: 'trinity:build:development' },
      'browser.canonical': { buildTarget: 'trinity:build:development' },
      'protocol.verify-qr': { buildTarget: 'trinity:build:development' },
      'web.production-renderer': { renderer: 'verified-production' },
    }[suite.id];
    if (
      expectedCiPreparation &&
      JSON.stringify(suite.ciPreparation) !==
        JSON.stringify(expectedCiPreparation)
    ) {
      errors.push(`${suite.id} has incorrect CI preparation metadata`);
    }
    if (suite.id === 'web.container' && suite.ciPreparation !== undefined) {
      errors.push('web.container must not declare CI preparation metadata');
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
  const expectedPreparationIds = [
    'components.storybook',
    'components.styling',
    'browser.canonical',
    'protocol.verify-qr',
    'web.production-renderer',
  ];
  const actualPreparationIds = snapshot.suites
    .filter(({ ciPreparation }) => ciPreparation !== undefined)
    .map(({ id }) => id)
    .sort();
  if (
    JSON.stringify(actualPreparationIds) !==
    JSON.stringify([...expectedPreparationIds].sort())
  ) {
    errors.push(
      'CI preparation metadata must exist for exactly the five reusable suites',
    );
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
    .filter((command) =>
      /(?:trinity-e2e|trinity-web-container|e2e:|electron:e2e)/.test(command),
    );
};

export const yamlReportPaths = (source) =>
  [...source.matchAll(/^\s*(?:-\s*)?report-path:\s*(\S.*)$/gmu)].map((match) =>
    match[1].trim(),
  );

export const validateCiReportPaths = (errors, source, snapshot) => {
  const paths = yamlReportPaths(source);
  const suitesById = new Map(snapshot.suites.map((suite) => [suite.id, suite]));
  const coveredSuites = new Set(
    [...source.matchAll(/^\s*suite-id:\s*["']?([a-z0-9.-]+)["']?\s*$/gimu)].map(
      ([, suiteId]) => suiteId,
    ),
  );
  if (source.includes('trinity-web-container:smoke'))
    coveredSuites.add('web.container');
  for (const path of paths) {
    if (path.includes('${{') || path.includes('steps.plan.outputs')) continue;
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
  const workflowSources = globSync('.github/workflows/*.{yml,yaml}', {
    cwd: workspaceRoot,
  }).map((path) => readFileSync(join(workspaceRoot, path), 'utf8'));
  const workflow = workflowSources.join('\n');
  const observedCiCommands = workflowSources.flatMap(yamlRunCommands);
  const observedSuiteIds = new Set(
    [
      ...workflow.matchAll(/^\s*suite-id:\s*["']?([a-z0-9.-]+)["']?\s*$/gimu),
    ].map(([, suiteId]) => suiteId),
  );
  if (workflow.includes('trinity-web-container:smoke'))
    observedSuiteIds.add('web.container');
  const infrastructureCommands = new Set([
    'pnpm nx run trinity-web-container:verify',
    'pnpm nx run trinity-web-container:build-prebuilt',
  ]);
  validateCiReportPaths(errors, workflow, snapshot);
  const expectedCiCommands = snapshot.ciEntrypoints.map(
    ({ command }) => command,
  );
  const registeredSuiteIds = new Set(
    snapshot.ciEntrypoints.flatMap(({ suiteIds }) => suiteIds),
  );
  for (const suiteId of observedSuiteIds) {
    if (!registeredSuiteIds.has(suiteId)) {
      errors.push(`unregistered CI E2E entrypoint suite: ${suiteId}`);
    }
  }
  for (const command of observedCiCommands) {
    if (infrastructureCommands.has(command)) continue;
    if (!expectedCiCommands.includes(command)) {
      errors.push(`unregistered CI E2E entrypoint: ${command}`);
    }
  }
  for (const [command, entrypoint] of snapshot.ciEntrypoints.map((entry) => [
    entry.command,
    entry,
  ])) {
    const coveredBySuiteInput = entrypoint.suiteIds.every((suiteId) =>
      observedSuiteIds.has(suiteId),
    );
    if (!observedCiCommands.includes(command) && !coveredBySuiteInput) {
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
  if (
    !workflow.includes('# 110 canonical browser specs') &&
    !workflow.includes('canonicalBrowserSpecCount') &&
    !observedSuiteIds.has('browser.canonical')
  ) {
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
  const nightlyWorkflowPath = join(
    workspaceRoot,
    '.github/workflows/e2e-nightly.yml',
  );
  if (!existsSync(nightlyWorkflowPath))
    errors.push('nightly workflow is missing');
  const readYaml = (path) =>
    parseYaml(readFileSync(join(workspaceRoot, path), 'utf8'));
  errors.push(
    ...validateWorkflowContracts(
      workspaceRoot,
      {
        ci: readYaml('.github/workflows/ci.yml'),
        e2e: readYaml('.github/workflows/_e2e-suite.yml'),
        renderer: readYaml('.github/workflows/_renderer.yml'),
        restore: readYaml(
          '.github/actions/restore-verified-renderer/action.yml',
        ),
        diagnostics: readYaml(
          '.github/actions/upload-playwright-diagnostics/action.yml',
        ),
        setupPlaywright: readYaml(
          '.github/actions/setup-playwright/action.yml',
        ),
        nightly: existsSync(nightlyWorkflowPath)
          ? readYaml('.github/workflows/e2e-nightly.yml')
          : undefined,
      },
      new Set(snapshot.ciEntrypoints.flatMap(({ suiteIds }) => suiteIds)),
    ),
  );
  validateArchitectureCommand(errors, packageScripts);
  validateDurableE2ENames(errors, workspaceRoot);

  return errors;
}
