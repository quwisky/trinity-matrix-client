/** Dependency updates are `deps` commits, listed under Dependencies in both release lines' notes. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const json = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const renovate = json('.github/renovate.json');

describe('dependency updates in the release notes', () => {
  it.each(['release-please-config.json', 'release-please-config.next.json'])(
    '%s lists the deps type under a visible Dependencies section',
    (name) => {
      const sections = json(name)['changelog-sections'];
      const deps = sections.find((s) => s.type === 'deps');
      expect(deps).toEqual({ type: 'deps', section: 'Dependencies' });
      expect(sections.at(-1).hidden).toBe(true);
      expect(sections.findIndex((s) => s.type === 'deps')).toBe(
        sections.findIndex((s) => s.type === 'revert') + 1,
      );
    },
  );

  it('commitlint accepts the deps type', () => {
    const result = spawnSync(
      resolve(root, 'node_modules/.bin/commitlint'),
      [],
      {
        cwd: root,
        input: 'deps: update foo to v1.2.3',
        encoding: 'utf8',
      },
    );
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('has Renovate commit every update as deps, after the presets that set the type', () => {
    expect(renovate.semanticCommitType).toBe('deps');
    expect(renovate.semanticCommitScope).toBeNull();
    // Rules of config:recommended come first; the first own rule matching everything beats them.
    const all = renovate.packageRules.find(
      (rule) => rule.semanticCommitType === 'deps',
    );
    expect(all).toMatchObject({ matchPackageNames: ['*'] });
  });

  it('keeps security updates as fix(deps), which still cuts a release', () => {
    expect(renovate.vulnerabilityAlerts).toMatchObject({
      semanticCommitType: 'fix',
      semanticCommitScope: 'deps',
    });
  });
});
