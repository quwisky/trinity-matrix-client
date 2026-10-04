import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backportBranch,
  backportTargets,
  cherryPickArgs,
  cherryPickOnto,
  parentCount,
  pickNotice,
  pickPlan,
  planBackport,
  selectTargets,
} from './backport.mjs';

describe('backport', () => {
  it('reads release branches from labels', () => {
    expect(
      backportTargets([
        'bug',
        'backport release/0.1.x',
        'backport release/0.2.x',
        'backport release/0.1.x',
      ]),
    ).toEqual(['release/0.1.x', 'release/0.2.x']);
    expect(
      backportTargets([
        'backport release/0.1',
        'backport main',
        'backport release/01.1.x',
      ]),
    ).toEqual([]);
  });

  it('names the backport branch', () => {
    expect(backportBranch(42, 'release/0.1.x')).toBe(
      'backport/42-release-0.1.x',
    );
  });

  it('cherry-picks merge commits against their first parent', () => {
    expect(cherryPickArgs('abc', 1)).toEqual(['cherry-pick', '-x', 'abc']);
    expect(cherryPickArgs('abc', 2)).toEqual([
      'cherry-pick',
      '-x',
      '-m',
      '1',
      'abc',
    ]);
  });

  it('never opens a second backport', () => {
    expect(
      planBackport({
        targetExists: false,
        branchExists: false,
        existingPr: null,
      }),
    ).toBe('missing-target');
    expect(
      planBackport({ targetExists: true, branchExists: true, existingPr: 7 }),
    ).toBe('skip');
    expect(
      planBackport({
        targetExists: true,
        branchExists: true,
        existingPr: null,
      }),
    ).toBe('skip');
    expect(
      planBackport({
        targetExists: true,
        branchExists: false,
        existingPr: null,
      }),
    ).toBe('create');
  });
});

describe('pickPlan', () => {
  const base = { sha: 'abc', parents: 1 };
  it('picks the whole range of a rebase-merged PR', () => {
    expect(
      pickPlan({ ...base, prHeadlines: ['a', 'b'], mainSubjects: ['a', 'b'] }),
    ).toEqual({ kind: 'range', args: ['cherry-pick', '-x', 'abc~2..abc'] });
  });
  it('matches full subjects longer than GitHub truncates headlines', () => {
    const long = `fix(release): ${'keep the whole subject line '.repeat(3)}intact`;
    expect(long.length).toBeGreaterThan(72);
    expect(
      pickPlan({ ...base, prHeadlines: [long, 'b'], mainSubjects: [long, 'b'] })
        .kind,
    ).toBe('range');
  });
  it('picks a squash commit alone', () => {
    expect(
      pickPlan({ ...base, prHeadlines: ['a', 'b'], mainSubjects: ['x', 'b'] }),
    ).toEqual({ kind: 'single', args: ['cherry-pick', '-x', 'abc'] });
  });
  it('picks a one-commit PR alone', () => {
    expect(
      pickPlan({ ...base, prHeadlines: ['a'], mainSubjects: [] }).kind,
    ).toBe('single');
  });
  it('picks a merge commit against its first parent', () => {
    expect(
      pickPlan({
        sha: 'abc',
        parents: 2,
        prHeadlines: ['a', 'b'],
        mainSubjects: ['a', 'b'],
      }),
    ).toEqual({
      kind: 'single',
      args: ['cherry-pick', '-x', '-m', '1', 'abc'],
    });
  });
});

describe('pickNotice', () => {
  const single = { kind: 'single', args: [] };
  it('notes a multi-commit PR picked as one non-merge commit', () => {
    expect(
      pickNotice({ plan: single, parents: 1, prHeadlines: ['a', 'b'] }),
    ).toMatch(/^::notice::/);
  });
  it('stays quiet for ranges, merge commits and one-commit PRs', () => {
    expect(
      pickNotice({
        plan: { kind: 'range', args: [] },
        parents: 1,
        prHeadlines: ['a', 'b'],
      }),
    ).toBeNull();
    expect(
      pickNotice({ plan: single, parents: 2, prHeadlines: ['a', 'b'] }),
    ).toBeNull();
    expect(
      pickNotice({ plan: single, parents: 1, prHeadlines: ['a'] }),
    ).toBeNull();
  });
});

describe('selectTargets', () => {
  const labels = ['backport release/0.1.x', 'backport release/0.2.x', 'bug'];
  it('takes every backport label when the PR closes', () => {
    expect(selectTargets(labels)).toEqual(['release/0.1.x', 'release/0.2.x']);
  });
  it('takes only the label just added', () => {
    expect(selectTargets(labels, 'backport release/0.2.x')).toEqual([
      'release/0.2.x',
    ]);
    expect(selectTargets(labels, 'bug')).toEqual([]);
  });
});

describe('cherryPickOnto', () => {
  let dir;
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const commit = (file, text, message) => {
    writeFileSync(join(dir, file), text);
    git('add', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  /** main and release/0.1.x share a base; origin is a local bare repository. */
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'backport-'));
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    dir = work;
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.com');
    git('remote', 'add', 'origin', origin);
    commit('a.txt', 'base\n', 'base');
    git('branch', 'release/0.1.x');
    git('push', '-q', 'origin', 'main', 'release/0.1.x');
  };
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('picks cleanly onto a new branch with a provenance trailer', () => {
    setup();
    const sha = commit('b.txt', 'fix\n', 'fix: b');
    const branch = 'backport/1-release-0.1.x';
    expect(
      cherryPickOnto({ sha, target: 'release/0.1.x', branch, cwd: dir }),
    ).toBe('picked');
    expect(git('log', '-1', '--format=%B', branch)).toContain(
      `(cherry picked from commit ${sha})`,
    );
    expect(git('show', `${branch}:b.txt`)).toBe('fix');
  });

  it('reports a conflict and leaves no backport branch', () => {
    setup();
    git('switch', '-q', 'release/0.1.x');
    commit('a.txt', 'release\n', 'release change');
    git('push', '-q', 'origin', 'release/0.1.x');
    git('switch', '-q', 'main');
    const sha = commit('a.txt', 'main\n', 'main change');
    const branch = 'backport/2-release-0.1.x';
    expect(
      cherryPickOnto({ sha, target: 'release/0.1.x', branch, cwd: dir }),
    ).toBe('conflict');
    expect(git('branch', '--list', 'backport/*')).toBe('');
    expect(git('branch', '--show-current')).toBe('main');
  });

  it('picks every commit of a rebase-merged PR', () => {
    setup();
    commit('b.txt', 'one\n', 'feat: one');
    commit('c.txt', 'two\n', 'feat: two');
    const sha = git('rev-parse', 'HEAD');
    const branch = 'backport/3-release-0.1.x';
    expect(
      cherryPickOnto({
        sha,
        target: 'release/0.1.x',
        branch,
        prHeadlines: ['feat: one', 'feat: two'],
        cwd: dir,
      }),
    ).toBe('picked');
    expect(git('show', `${branch}:b.txt`)).toBe('one');
    expect(git('show', `${branch}:c.txt`)).toBe('two');
    expect(parentCount(branch, dir)).toBe(1);
  });

  it('reports an empty pick when the fix is already on the branch', () => {
    setup();
    const sha = commit('b.txt', 'fix\n', 'fix: b');
    git('push', '-q', 'origin', 'main:release/0.1.x');
    expect(
      cherryPickOnto({
        sha,
        target: 'release/0.1.x',
        branch: 'backport/4-x',
        cwd: dir,
      }),
    ).toBe('empty');
    expect(git('branch', '--list', 'backport/*')).toBe('');
  });
});
