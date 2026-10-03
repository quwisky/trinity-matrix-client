/** Release PRs on both lines are titled, and so committed, as `release: cut the vX.Y.Z release`. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const config = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const commitlint = (message) =>
  spawnSync(resolve(root, 'node_modules/.bin/commitlint'), [], {
    cwd: root,
    input: message,
    encoding: 'utf8',
  });

describe('release PR title', () => {
  it.each(['release-please-config.json', 'release-please-config.next.json'])(
    '%s cuts the release under the release type',
    (name) => {
      expect(config(name)['pull-request-title-pattern']).toBe(
        'release: cut the v${version} release',
      );
    },
  );

  it.each([
    'release: cut the v22.3.0-next.0 release',
    'release: cut the v22.3.0 release',
  ])('passes commitlint: %s', (title) => {
    const result = commitlint(title);
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
