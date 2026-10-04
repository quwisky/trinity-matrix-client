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
// These files are automation and rules, not prose about developers: any bare "develop" is the old branch.
const DEVELOP = /\bdevelop\b/;

describe('branch names', () => {
  it('names main, not develop, as the integration branch', () => {
    const offenders = files.filter((path) =>
      DEVELOP.test(readFileSync(resolve(root, path), 'utf8')),
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
