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

describe('Renovate update policy', () => {
  it.each([
    'dompurify',
    '@matrix-org/matrix-sdk-crypto-wasm',
    'matrix-js-sdk',
    'matrix-widget-api',
    'electron',
  ])('keeps %s patches as unmerged pull requests', (name) => {
    expect(PATCH_RULE).toBeGreaterThanOrEqual(0);
    // packageRules apply in order, and the last matching rule that sets a key wins it.
    const winner = (key) =>
      config.packageRules.findLastIndex(
        (rule) => rule.matchPackageNames?.includes(name) && key in rule,
      );
    for (const [key, value] of Object.entries({
      automerge: false,
      additionalBranchPrefix: '',
    })) {
      expect(winner(key), key).toBeGreaterThan(PATCH_RULE);
      expect(config.packageRules[winner(key)][key], key).toBe(value);
    }
    // Still a pull request straight away, not one waiting behind the dashboard.
    expect(winner('dependencyDashboardApproval')).toBe(-1);
  });

  it('holds security updates for a minimum release age', () => {
    expect(config.vulnerabilityAlerts.minimumReleaseAge).toMatch(/^\d+ days?$/);
  });

  it('describes main as protected by its ruleset', () => {
    expect(source).not.toMatch(/no protection rule|unprotected branch/);
  });
});
