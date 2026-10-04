/** After the develop → main rename, automation and agent rules must never name develop. */
import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  ...globSync('.github/**/*.{yml,yaml,json,md}', { cwd: root }),
  ...globSync('.agents/rules/**/*.md', { cwd: root }),
  'AGENTS.md',
  'nx.json',
  'package.json',
];
// Branch-like uses: origin/develop, 'develop', "develop", `develop`, [develop, branches: develop, --base develop, ref=develop.
const BRANCH_USE =
  /origin\/develop|['"`]develop['"`]|\[develop\b|branches:\s*develop|--base[= ]develop|ref[=:]\s*develop|\bdevelop\.\.\.|\.\.\.develop\b|\bdevelop\b branch|on `develop`|from `develop`|to `develop`/;

describe('branch names', () => {
  it('names main, not develop, as the integration branch', () => {
    const offenders = files.filter((path) =>
      BRANCH_USE.test(readFileSync(resolve(root, path), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('has no promote-stable workflow left', () => {
    expect(
      globSync('.github/workflows/promote-stable*', { cwd: root }),
    ).toEqual([]);
    expect(globSync('scripts/promote-stable*', { cwd: root })).toEqual([]);
  });
});
