/** Renovate merges nothing on its own, and proposes nothing brand new. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { read, workflow, workflows } from './workspace-sources.mjs';

const source = readFileSync(
  resolve(import.meta.dirname, '../.github/renovate.json'),
  'utf8',
);
const config = JSON.parse(source);
const PATCH_RULE = config.packageRules.findIndex(
  (rule) =>
    rule.matchUpdateTypes?.includes('patch') &&
    !rule.matchPackageNames &&
    !rule.matchManagers,
);

const RUNTIME = [
  'dompurify',
  'katex',
  '@matrix-org/matrix-sdk-crypto-wasm',
  'matrix-js-sdk',
  'matrix-widget-api',
  'electron',
];

describe('Renovate update policy', () => {
  it('automerges nothing, because Renovate is not a bypass actor on main', () => {
    // 'Protect main' requires an approval, so a Renovate merge could never complete.
    expect(config.automerge).toBe(false);
    for (const rule of [
      config,
      config.vulnerabilityAlerts,
      config.lockFileMaintenance,
      ...config.packageRules,
    ]) {
      expect(rule.automerge).not.toBe(true);
      expect(rule).not.toHaveProperty('automergeType');
      expect(rule).not.toHaveProperty('platformAutomerge');
    }
  });

  it('ends with the rule that keeps shipped runtime patches unmerged', () => {
    // No later rule may set automerge at all, or it could quietly win the key back.
    const last = config.packageRules.findLast((rule) => 'automerge' in rule);
    expect(last.matchPackageNames).toEqual(expect.arrayContaining(RUNTIME));
    expect(last.automerge).toBe(false);
    // Patches only, on a prefix of their own: off renovate/patch-* and off the branch of
    // a non-patch update in the same group that waits for dashboard approval.
    expect(last.matchUpdateTypes).toEqual(['patch']);
    expect(last.additionalBranchPrefix).toMatch(/^[a-z]+-$/);
    expect(last.additionalBranchPrefix).not.toBe(
      config.packageRules[PATCH_RULE].additionalBranchPrefix,
    );
  });

  it.each(RUNTIME)('keeps %s patches as unmerged pull requests', (name) => {
    expect(PATCH_RULE).toBeGreaterThanOrEqual(0);
    // packageRules apply in order, and the last matching rule that sets a key wins it.
    const winner = (key) =>
      config.packageRules.findLastIndex(
        (rule) => rule.matchPackageNames?.includes(name) && key in rule,
      );
    for (const [key, value] of Object.entries({
      automerge: false,
      additionalBranchPrefix: 'runtime-',
    })) {
      expect(winner(key), key).toBeGreaterThan(PATCH_RULE);
      expect(config.packageRules[winner(key)][key], key).toBe(value);
    }
    expect(config.packageRules[PATCH_RULE].additionalBranchPrefix).toBe(
      'patch-',
    );
    // Still a pull request straight away, not one waiting behind the dashboard.
    expect(winner('dependencyDashboardApproval')).toBe(-1);
  });

  it('holds security updates for a minimum release age and never forces automerge', () => {
    expect(config.vulnerabilityAlerts.minimumReleaseAge).toMatch(/^\d+ days?$/);
    expect(config.vulnerabilityAlerts.automerge).not.toBe(true);
  });

  it('rebases update branches on the next run after main moves', () => {
    expect(config.rebaseWhen).toBe('behind-base-branch');
  });

  it('describes main as protected by its ruleset', () => {
    expect(source).not.toMatch(/no protection rule|unprotected branch/);
  });
});

describe('Renovate post-upgrade commands', () => {
  const renovateSteps = Object.entries(workflow('renovate.yml').jobs).flatMap(
    ([id, job]) => job.steps.map((step) => ({ id, step })),
  );
  const allowed = renovateSteps.flatMap(({ step }) =>
    step.env?.RENOVATE_ALLOWED_COMMANDS
      ? JSON.parse(step.env.RENOVATE_ALLOWED_COMMANDS)
      : [],
  );
  const commands = config.packageRules.flatMap(
    (rule) => rule.postUpgradeTasks?.commands ?? [],
  );

  it('allows exactly the native-path sync, anchored, on the Renovate step only', () => {
    expect(allowed).toEqual(['^node scripts/sync-native-plugin-paths\\.mjs$']);
    const owners = renovateSteps.filter(
      ({ step }) => step.env?.RENOVATE_ALLOWED_COMMANDS,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0].step.uses).toMatch(/^renovatebot\/github-action@/);
    // A shell executor would let a command allowed by regex chain arbitrary others.
    expect(JSON.stringify(workflow('renovate.yml'))).not.toMatch(
      /ALLOW_SHELL_EXECUTOR|allowShellExecutor/,
    );
  });

  it('runs only commands the workflow allows', () => {
    expect(commands).toEqual(['node scripts/sync-native-plugin-paths.mjs']);
    for (const command of commands) {
      expect(allowed.some((pattern) => new RegExp(pattern).test(command))).toBe(
        true,
      );
    }
  });

  it('commits only the native files, once per Capacitor branch', () => {
    const rule = config.packageRules.find((r) => r.postUpgradeTasks);
    expect(rule.matchPackageNames).toEqual(
      config.packageRules.find((r) => r.groupName === 'capacitor')
        .matchPackageNames,
    );
    expect(rule.postUpgradeTasks).toEqual({
      commands: ['node scripts/sync-native-plugin-paths.mjs'],
      fileFilters: [
        'ios/App/CapApp-SPM/Package.swift',
        'android/capacitor.settings.gradle',
      ],
      executionMode: 'branch',
    });
    // Every package with a virtual-store path in those files must trigger the sync.
    const referenced = rule.postUpgradeTasks.fileFilters.flatMap((file) =>
      [
        ...read(file).matchAll(
          /node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/'"]+)/g,
        ),
      ].map((match) => match[1]),
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(
        rule.matchPackageNames.some((pattern) =>
          pattern.endsWith('/**')
            ? name.startsWith(pattern.slice(0, -2))
            : pattern === name,
        ),
        name,
      ).toBe(true);
    }
  });
});

describe('Renovate App key', () => {
  it('is read only by the Renovate job, inside the renovate environment', () => {
    const readers = [];
    for (const name of workflows()) {
      const { jobs } = workflow(name);
      for (const [id, job] of Object.entries(jobs)) {
        if (JSON.stringify(job).includes('secrets.RENOVATE_APP_PRIVATE_KEY'))
          readers.push(`${name} ${id}`);
      }
    }
    expect(readers).toEqual(['renovate.yml renovate']);
    const { jobs } = workflow('renovate.yml');
    expect(jobs.renovate.environment).toBe('renovate');
  });
});
