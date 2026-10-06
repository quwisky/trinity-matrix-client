import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProblems, land, pushArgs, tagFor } from './land-back-merge.mjs';

const REQUIRED = ['Unit tests', 'Lint & format'];
const run = (name, conclusion, id = 1, status = 'completed') => ({
  id,
  name,
  status,
  conclusion,
});
const green = () => ({
  required: REQUIRED,
  runs: REQUIRED.map((name, i) => run(name, 'success', i)),
});

/** A bare origin and a clone with main, a tagged release line and a pushed back-merge branch. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'land-back-merge-'));
  const origin = join(root, 'origin.git');
  const dir = join(root, 'work');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' });
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  const commit = (file, text) => {
    writeFileSync(join(dir, file), text);
    git('add', '-A');
    git('commit', '-qm', `${file}: ${text}`);
    return git('rev-parse', 'HEAD');
  };
  commit('a.txt', 'base\n');
  git('push', '-q', 'origin', 'main');
  git('switch', '-qc', 'release/0.1.x');
  commit('b.txt', 'release\n');
  git('tag', 'v0.1.2');
  git('push', '-q', 'origin', 'release/0.1.x', 'v0.1.2');
  git('switch', '-q', 'main');
  commit('c.txt', 'main\n');
  git('push', '-q', 'origin', 'main');
  git('switch', '-qc', 'back-merge/v0.1.2');
  git('merge', '-q', '--no-ff', '--no-edit', 'v0.1.2');
  git('push', '-q', 'origin', 'back-merge/v0.1.2');
  const head = git('rev-parse', 'HEAD');
  const remoteMain = () =>
    execFileSync('git', ['rev-parse', 'main'], {
      cwd: origin,
      encoding: 'utf8',
    }).trim();
  return { root, dir, git, commit, head, remoteMain };
}

describe('land-back-merge', () => {
  let r;
  afterEach(() => r && rmSync(r.root, { recursive: true, force: true }));

  it('reads the stable tag from the branch name', () => {
    expect(tagFor('back-merge/v0.1.2')).toBe('v0.1.2');
    expect(() => tagFor('back-merge/v0.2.0-next.1')).toThrow(/stable/);
    expect(() => tagFor('feature/v0.1.2')).toThrow(/back-merge\/vX\.Y\.Z/);
  });

  it('pushes exactly sha:refs/heads/main, without force', () => {
    expect(pushArgs('abc123')).toEqual([
      'push',
      'origin',
      'abc123:refs/heads/main',
    ]);
  });

  describe('required checks', () => {
    it('passes when every required check succeeded or was skipped', () => {
      expect(
        checkProblems(REQUIRED, [
          run('Unit tests', 'success'),
          run('Lint & format', 'skipped'),
        ]),
      ).toEqual([]);
    });

    it('refuses when no required checks could be read', () => {
      expect(checkProblems([], [run('Unit tests', 'success')])).toEqual([
        'main has no required status checks to wait for',
      ]);
    });

    it('refuses pending checks', () => {
      const { required, runs } = green();
      runs[1] = run('Lint & format', null, 9, 'in_progress');
      expect(checkProblems(required, runs)).toEqual([
        'Lint & format is in_progress',
      ]);
    });

    it('refuses failed checks', () => {
      const { required, runs } = green();
      runs[0] = run('Unit tests', 'failure');
      expect(checkProblems(required, runs)).toEqual([
        'Unit tests concluded failure',
      ]);
    });

    it('refuses a required check that never reported', () => {
      expect(checkProblems(REQUIRED, [run('Unit tests', 'success')])).toEqual([
        'Lint & format has not reported',
      ]);
    });

    it('judges a re-run by its latest attempt', () => {
      expect(
        checkProblems(
          ['Unit tests'],
          [run('Unit tests', 'failure', 1), run('Unit tests', 'success', 2)],
        ),
      ).toEqual([]);
      expect(
        checkProblems(
          ['Unit tests'],
          [run('Unit tests', 'success', 1), run('Unit tests', 'failure', 2)],
        ),
      ).toEqual(['Unit tests concluded failure']);
    });
  });

  describe('landing a real branch', () => {
    it('fast-forwards main to the merge when everything is green', () => {
      r = repo();
      const seen = [];
      land({
        branch: 'back-merge/v0.1.2',
        cwd: r.dir,
        checks: (sha) => (seen.push(sha), green()),
      });
      expect(seen).toEqual([r.head]);
      expect(r.remoteMain()).toBe(r.head);
    });

    it('refuses when main has moved past the merge', () => {
      r = repo();
      r.git('switch', '-q', 'main');
      r.commit('d.txt', 'later\n');
      r.git('push', '-q', 'origin', 'main');
      const moved = r.remoteMain();
      expect(() =>
        land({ branch: 'back-merge/v0.1.2', cwd: r.dir, checks: green }),
      ).toThrow(/main has moved.*re-run the back-merge job/is);
      expect(r.remoteMain()).toBe(moved);
    });

    it('refuses a head that is not a merge', () => {
      r = repo();
      r.commit('e.txt', 'on top\n');
      r.git('push', '-q', 'origin', 'back-merge/v0.1.2');
      expect(() =>
        land({ branch: 'back-merge/v0.1.2', cwd: r.dir, checks: green }),
      ).toThrow(/not a merge/);
    });

    it('refuses a merge that does not contain the tag', () => {
      r = repo();
      const main = r.remoteMain();
      r.git('switch', '-q', 'release/0.1.x');
      r.commit('g.txt', 'next release\n');
      r.git('tag', 'v0.1.3');
      r.git('push', '-q', 'origin', 'v0.1.3');
      r.git('switch', '-qc', 'side', main);
      r.commit('f.txt', 'side\n');
      r.git('switch', '-qc', 'back-merge/v0.1.3', main);
      r.git('merge', '-q', '--no-ff', '--no-edit', 'side');
      r.git('push', '-q', 'origin', 'back-merge/v0.1.3');
      expect(() =>
        land({ branch: 'back-merge/v0.1.3', cwd: r.dir, checks: green }),
      ).toThrow(/does not contain v0\.1\.3/);
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses pending or failed checks and leaves main alone', () => {
      r = repo();
      const main = r.remoteMain();
      const pending = () => ({
        required: REQUIRED,
        runs: [
          run('Unit tests', 'success'),
          run('Lint & format', null, 2, 'queued'),
        ],
      });
      const failed = () => ({
        required: REQUIRED,
        runs: [
          run('Unit tests', 'failure'),
          run('Lint & format', 'success', 2),
        ],
      });
      for (const checks of [pending, failed]) {
        expect(() =>
          land({ branch: 'back-merge/v0.1.2', cwd: r.dir, checks }),
        ).toThrow(/required checks are not green/);
      }
      expect(r.remoteMain()).toBe(main);
    });
  });
});
