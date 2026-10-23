import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkProblems,
  land,
  prProblems,
  pushArgs,
  tagFor,
} from './land-back-merge.mjs';
import { buildBackMerge } from './back-merge.mjs';

const REQUIRED = ['Unit tests', 'Lint & format'];
const SHA = 'a'.repeat(40);
const run = (name, conclusion, id = 1, status = 'completed', more = {}) => ({
  id,
  name,
  status,
  conclusion,
  head_sha: SHA,
  app: 'github-actions',
  ...more,
});
const at = (sha, runs) => runs.map((r) => ({ ...r, head_sha: sha }));
const green = (sha = SHA) => ({
  required: REQUIRED,
  runs: at(
    sha,
    REQUIRED.map((name, i) => run(name, 'success', i)),
  ),
});
const pr = (sha, more = {}) => ({
  number: 7,
  isDraft: false,
  isCrossRepository: false,
  headRefOid: sha,
  reviewDecision: '',
  ...more,
});

/** A bare origin and a clone with main, and a pushed single-commit back-merge branch. */
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
  commit('CHANGELOG.md', 'base\n');
  git('tag', 'v0.1.0-next.1');
  git('push', '-q', 'origin', 'main', 'v0.1.0-next.1');
  git('switch', '-qc', 'release/0.1.x');
  commit('CHANGELOG.md', 'release notes\n');
  git('tag', 'v0.1.2');
  git('push', '-q', 'origin', 'release/0.1.x', 'v0.1.2');
  git('switch', '-q', 'main');
  commit('c.txt', 'main\n');
  git('push', '-q', 'origin', 'main');
  /** Branch back-merge/<tag> from main with what back-merge.mjs builds, committed but not pushed. */
  const build = (tag = 'v0.1.2') => {
    git('switch', '-q', '-C', `back-merge/${tag}`, 'origin/main');
    buildBackMerge(tag, dir);
    git('commit', '-qm', `chore: back-merge ${tag} into main`);
    return git('rev-parse', 'HEAD');
  };
  git('fetch', '-q', 'origin');
  build();
  git('push', '-q', 'origin', 'back-merge/v0.1.2');
  const head = git('rev-parse', 'HEAD');
  const remoteMain = () =>
    execFileSync('git', ['rev-parse', 'main'], {
      cwd: origin,
      encoding: 'utf8',
    }).trim();
  return { root, dir, git, commit, build, head, remoteMain };
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
        checkProblems(
          REQUIRED,
          [run('Unit tests', 'success'), run('Lint & format', 'skipped')],
          SHA,
        ),
      ).toEqual([]);
    });

    it('refuses when no required checks could be read', () => {
      expect(checkProblems([], [run('Unit tests', 'success')], SHA)).toEqual([
        'main has no required status checks to wait for',
      ]);
    });

    it('refuses pending checks', () => {
      const { required, runs } = green();
      runs[1] = run('Lint & format', null, 9, 'in_progress');
      expect(checkProblems(required, runs, SHA)).toEqual([
        'Lint & format is in_progress',
      ]);
    });

    it('refuses failed checks', () => {
      const { required, runs } = green();
      runs[0] = run('Unit tests', 'failure');
      expect(checkProblems(required, runs, SHA)).toEqual([
        'Unit tests concluded failure',
      ]);
    });

    it('refuses a required check that never reported', () => {
      expect(
        checkProblems(REQUIRED, [run('Unit tests', 'success')], SHA),
      ).toEqual(['Lint & format has not reported']);
    });

    it('counts only GitHub Actions runs on the exact commit', () => {
      expect(
        checkProblems(
          ['Unit tests'],
          [
            run('Unit tests', 'success', 5, 'completed', {
              head_sha: 'b'.repeat(40),
            }),
          ],
          SHA,
        ),
      ).toEqual(['Unit tests has not reported']);
      expect(
        checkProblems(
          ['Unit tests'],
          [
            run('Unit tests', 'failure', 1),
            run('Unit tests', 'success', 2, 'completed', { app: 'some-bot' }),
          ],
          SHA,
        ),
      ).toEqual(['Unit tests concluded failure']);
    });

    it('judges a re-run by its latest attempt', () => {
      expect(
        checkProblems(
          ['Unit tests'],
          [run('Unit tests', 'failure', 1), run('Unit tests', 'success', 2)],
          SHA,
        ),
      ).toEqual([]);
      expect(
        checkProblems(
          ['Unit tests'],
          [run('Unit tests', 'success', 1), run('Unit tests', 'failure', 2)],
          SHA,
        ),
      ).toEqual(['Unit tests concluded failure']);
    });
  });

  describe('the pull request', () => {
    it('passes for one open, ready, same-repo PR at the pushed commit', () => {
      expect(prProblems([pr(SHA)], SHA)).toEqual([]);
      expect(
        prProblems([pr(SHA, { reviewDecision: 'APPROVED' })], SHA),
      ).toEqual([]);
    });

    it('refuses without exactly one same-repo PR', () => {
      expect(prProblems([], SHA)).toEqual([
        'no open pull request from this repository into main',
      ]);
      expect(prProblems([pr(SHA, { isCrossRepository: true })], SHA)).toEqual([
        'no open pull request from this repository into main',
      ]);
      expect(prProblems([pr(SHA), pr(SHA, { number: 8 })], SHA)).toEqual([
        'more than one open pull request: #7, #8',
      ]);
    });

    it('refuses a draft, a stale head or requested changes', () => {
      expect(prProblems([pr(SHA, { isDraft: true })], SHA)).toEqual([
        '#7 is a draft',
      ]);
      expect(prProblems([pr('b'.repeat(40))], SHA)).toEqual([
        `#7 is at ${'b'.repeat(40)}, not ${SHA}`,
      ]);
      expect(
        prProblems([pr(SHA, { reviewDecision: 'CHANGES_REQUESTED' })], SHA),
      ).toEqual(['#7 has changes requested']);
    });
  });

  describe('landing a real branch', () => {
    const attempt = (over = {}) =>
      land({
        branch: 'back-merge/v0.1.2',
        cwd: r.dir,
        checks: green,
        pulls: () => [pr(r.git('rev-parse', 'origin/back-merge/v0.1.2'))],
        ...over,
      });

    it('fast-forwards main to the merge when everything is green', () => {
      r = repo();
      const seen = [];
      attempt({
        checks: (sha) => (seen.push(sha), green(sha)),
        pulls: (branch) => (seen.push(branch), [pr(r.head)]),
      });
      expect(seen).toEqual([r.head, 'back-merge/v0.1.2']);
      expect(r.remoteMain()).toBe(r.head);
    });

    it('refuses when main has moved past the merge', () => {
      r = repo();
      r.git('switch', '-q', 'main');
      r.commit('d.txt', 'later\n');
      r.git('push', '-q', 'origin', 'main');
      const moved = r.remoteMain();
      expect(() => attempt()).toThrow(
        /main has moved.*re-run the back-merge job/is,
      );
      expect(r.remoteMain()).toBe(moved);
    });

    it('rejects the push when main moves after the checks were read', () => {
      r = repo();
      let moved;
      expect(() =>
        attempt({
          checks: (sha) => {
            r.git('switch', '-q', 'main');
            r.commit('d.txt', 'racing\n');
            r.git('push', '-q', 'origin', 'main');
            moved = r.remoteMain();
            return green(sha);
          },
        }),
      ).toThrow(/rejected|non-fast-forward|fetch first/);
      expect(r.remoteMain()).toBe(moved);
    });

    it('lands a single-parent metadata commit on main', () => {
      r = repo();
      attempt();
      expect(r.remoteMain()).toBe(r.head);
    });

    it('refuses a two-parent merge', () => {
      r = repo();
      const main = r.remoteMain();
      r.git('switch', '-q', '-C', 'back-merge/v0.1.2', main);
      r.git('merge', '-q', '--no-ff', '--no-edit', 'v0.1.2');
      r.git('push', '-q', '-f', 'origin', 'back-merge/v0.1.2');
      expect(() => attempt()).toThrow(/not a single-parent commit/);
      expect(r.remoteMain()).toBe(main);
    });

    it('says how to fix a two-parent merge from an old release line', () => {
      r = repo();
      r.git('switch', '-q', '-C', 'back-merge/v0.1.2', r.remoteMain());
      r.git('merge', '-q', '--no-ff', '--no-edit', 'v0.1.2');
      r.git('push', '-q', '-f', 'origin', 'back-merge/v0.1.2');
      expect(() => attempt()).toThrow(
        /predates single-parent back-merges.*backport.*release\/0\.1\.x.*Open the back-merge PR/s,
      );
    });

    it('lands the commit back-merge.mjs builds', () => {
      r = repo();
      r.git('switch', '-q', 'main');
      r.commit('d.txt', 'later\n');
      r.git('push', '-q', 'origin', 'main');
      r.git('fetch', '-q', 'origin');
      const sha = r.build();
      r.git('push', '-q', '-f', 'origin', 'back-merge/v0.1.2');
      attempt({ pulls: () => [pr(sha)] });
      expect(r.remoteMain()).toBe(sha);
    });

    it("refuses a metadata change that is not the tag's content", () => {
      r = repo();
      const main = r.remoteMain();
      r.git('switch', '-q', '-C', 'back-merge/v0.1.2', main);
      r.commit('CHANGELOG.md', 'forged\n');
      r.git('push', '-q', '-f', 'origin', 'back-merge/v0.1.2');
      expect(() => attempt()).toThrow(/not the tag's metadata.*CHANGELOG\.md/s);
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses when the tag does not exist', () => {
      r = repo();
      const main = r.remoteMain();
      r.git('switch', '-q', '-C', 'back-merge/v9.9.9', main);
      r.commit('CHANGELOG.md', 'forged\n');
      r.git('push', '-q', 'origin', 'back-merge/v9.9.9');
      const sha = r.git('rev-parse', 'HEAD');
      expect(() =>
        attempt({ branch: 'back-merge/v9.9.9', pulls: () => [pr(sha)] }),
      ).toThrow(/v9\.9\.9/);
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses a symlink at a metadata path', () => {
      r = repo();
      const main = r.remoteMain();
      r.build();
      unlinkSync(join(r.dir, 'CHANGELOG.md'));
      symlinkSync('/etc/passwd', join(r.dir, 'CHANGELOG.md'));
      r.git('add', '-A');
      r.git('commit', '-q', '--amend', '--no-edit');
      r.git('push', '-q', '-f', 'origin', 'back-merge/v0.1.2');
      expect(() => attempt()).toThrow(/not the tag's metadata.*CHANGELOG\.md/s);
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses an empty commit', () => {
      r = repo();
      const main = r.remoteMain();
      r.git('switch', '-q', '-C', 'back-merge/v0.1.2', main);
      r.git('commit', '-q', '--allow-empty', '-m', 'empty');
      r.git('push', '-q', '-f', 'origin', 'back-merge/v0.1.2');
      expect(() => attempt()).toThrow(/nothing to back-merge/);
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses a parent that is not current main', () => {
      r = repo();
      r.git('switch', '-q', 'main');
      r.commit('d.txt', 'later\n');
      r.git('push', '-q', 'origin', 'main');
      const moved = r.remoteMain();
      expect(() => attempt()).toThrow(/main has moved/);
      expect(r.remoteMain()).toBe(moved);
    });

    it('refuses extra commits on top of the back-merge', () => {
      r = repo();
      const main = r.remoteMain();
      r.commit('CHANGELOG.md', 'more\n');
      r.git('push', '-q', 'origin', 'back-merge/v0.1.2');
      expect(() => attempt()).toThrow(/main has moved/);
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses a commit that changes a non-metadata path', () => {
      r = repo();
      const main = r.remoteMain();
      r.git('switch', '-q', '-C', 'back-merge/v0.1.2', main);
      r.commit('package.json', '{}\n');
      r.git('push', '-q', '-f', 'origin', 'back-merge/v0.1.2');
      expect(() => attempt()).toThrow(
        /outside release metadata.*package\.json/s,
      );
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses when the branch moved past the commit CI ran on', () => {
      r = repo();
      const main = r.remoteMain();
      expect(() => attempt({ expectedSha: 'b'.repeat(40) })).toThrow(
        /is at .* but CI ran on b{40}/,
      );
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses without a ready PR at the commit and leaves main alone', () => {
      r = repo();
      const main = r.remoteMain();
      for (const pulls of [
        () => [],
        () => [pr(r.head, { isDraft: true })],
        () => [pr(r.head, { reviewDecision: 'CHANGES_REQUESTED' })],
      ]) {
        expect(() => attempt({ pulls })).toThrow(/pull request is not ready/);
      }
      expect(r.remoteMain()).toBe(main);
    });

    it('refuses pending or failed checks and leaves main alone', () => {
      r = repo();
      const main = r.remoteMain();
      const pending = (sha) => ({
        required: REQUIRED,
        runs: at(sha, [
          run('Unit tests', 'success'),
          run('Lint & format', null, 2, 'queued'),
        ]),
      });
      const failed = (sha) => ({
        required: REQUIRED,
        runs: at(sha, [
          run('Unit tests', 'failure'),
          run('Lint & format', 'success', 2),
        ]),
      });
      for (const checks of [pending, failed]) {
        expect(() => attempt({ checks })).toThrow(
          /required checks are not green/,
        );
      }
      expect(r.remoteMain()).toBe(main);
    });
  });
});
