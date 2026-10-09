/** Renovate merges nothing shipped and security-sensitive on its own, and nothing brand new. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(import.meta.dirname, '../.github/renovate.json'),
  'utf8',
);
const config = JSON.parse(source);
const PATCH_RULE = config.packageRules.findIndex(
  (rule) => rule.matchUpdateTypes?.includes('patch') && rule.automerge === true,
);

const RUNTIME = [
  'dompurify',
  '@matrix-org/matrix-sdk-crypto-wasm',
  'matrix-js-sdk',
  'matrix-widget-api',
  'electron',
];

describe('Renovate update policy', () => {
  it('ends with the rule that keeps shipped runtime patches unmerged', () => {
    // No later rule may set automerge at all, or it could quietly win the key back.
    const last = config.packageRules.findLast((rule) => 'automerge' in rule);
    expect(last.matchPackageNames).toEqual(expect.arrayContaining(RUNTIME));
    expect(last.automerge).toBe(false);
    // Patches only, on a prefix of their own: off renovate/patch-*, which ci.yml treats
    // as having no pull request, and off the branch of a non-patch update in the same
    // group that waits for dashboard approval.
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
    // Still a pull request straight away, not one waiting behind the dashboard.
    expect(winner('dependencyDashboardApproval')).toBe(-1);
  });

  it('holds security updates for a minimum release age and never forces automerge', () => {
    expect(config.vulnerabilityAlerts.minimumReleaseAge).toMatch(/^\d+ days?$/);
    expect(config.vulnerabilityAlerts.automerge).not.toBe(true);
  });

  it('describes main as protected by its ruleset', () => {
    expect(source).not.toMatch(/no protection rule|unprotected branch/);
  });
});
