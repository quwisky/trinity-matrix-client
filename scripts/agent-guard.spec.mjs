import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const guard = join(import.meta.dirname, 'agent-guard.mjs');
const repo = mkdtempSync(join(tmpdir(), 'agent-guard-'));
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git('init', '-q');
git('config', 'user.email', 'guard@example.org');

const hook = (command, cwd = repo, env = process.env) =>
  spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env,
  });

const edit = (tool_input, tool_name = 'Edit') =>
  spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ cwd: repo, tool_name, tool_input }),
    encoding: 'utf8',
  });

/** A stand-in `gh` whose `pr view` describes one pull request. */
function fakePr(pr) {
  const bin = join(repo, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho '${JSON.stringify(pr)}'\n`, {
    mode: 0o755,
  });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

/** A stand-in `gh` that records its arguments and exits with `status`. */
function fakeGh(status) {
  const bin = join(repo, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$@" > "${join(repo, 'gh-args')}"\necho "build pending"\nexit ${status}\n`,
    { mode: 0o755 },
  );
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('agent-guard PreToolUse hook', () => {
  it('allows unrelated and clean git commands', () => {
    expect(hook('ls -la').status).toBe(0);
    expect(hook('git commit -m "chore(agents): add guard"').status).toBe(0);
    expect(hook('git push origin --delete old-branch').status).toBe(0);
    expect(hook('git push origin :old-branch').status).toBe(0);
  });

  it('blocks staging superpowers notes explicitly or through add -A', () => {
    expect(hook('git add docs/superpowers/plan.md').status).toBe(2);
    expect(hook(`git -C ${repo} add .superpowers/x`).status).toBe(2);
    mkdirSync(join(repo, '.superpowers'), { recursive: true });
    writeFileSync(join(repo, '.superpowers/notes.md'), 'x\n');
    expect(hook('git add -A').status).toBe(2);
    expect(hook('git add scripts/x.mjs').status).toBe(0);
    rmSync(join(repo, '.superpowers'), { recursive: true });
  });

  it('blocks self-matching pgrep -f wait loops', () => {
    const result = hook('while pgrep -f playwright; do sleep 5; done');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/PID with a timeout/);
    expect(hook('until ! pgrep -af "nx run"; do sleep 1; done').status).toBe(2);
    expect(hook('pgrep -f node').status).toBe(0);
    expect(
      hook(
        "cat <<'EOF'\nBlocks `pgrep -f` wait loops while a run holds it\nEOF",
      ).status,
    ).toBe(0);
  });

  it('blocks a pull request opened without --draft', () => {
    const result = hook('gh pr create --base main --title "fix(x): y"');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--draft/);
    expect(hook('gh pr create --draft --base main').status).toBe(0);
    expect(hook('gh pr create -d -R owner/repo').status).toBe(0);
    expect(hook('gh pr create --draft=true').status).toBe(0);
    expect(hook('cd x && gh -R owner/repo pr create --fill').status).toBe(2);
    expect(
      hook(
        'gh pr create --body "$(cat <<\'EOF\'\nQ & A\nEOF\n)" --draft --base main',
      ).status,
    ).toBe(0);
  });

  it('ignores gh pr commands that only appear as text', () => {
    expect(hook('grep -rn "gh pr create" .agents').status).toBe(0);
    expect(hook("rg 'gh pr ready' docs", repo, fakeGh(1)).status).toBe(0);
  });

  it('marks a pull request ready only when its checks pass', () => {
    const pending = hook('gh pr ready 12 -R owner/repo', repo, fakeGh(8));
    expect(pending.status).toBe(2);
    expect(pending.stderr).toMatch(/build pending/);
    expect(readFileSync(join(repo, 'gh-args'), 'utf8').trim()).toBe(
      'pr checks 12 -R owner/repo',
    );
    expect(hook('gh pr ready 12', repo, fakeGh(0)).status).toBe(0);
    expect(hook('gh pr ready 12 --undo', repo, fakeGh(1)).status).toBe(0);
  });

  it('checks the repository named before pr and every pull request in the command', () => {
    expect(hook('gh -R owner/repo pr ready "12"', repo, fakeGh(0)).status).toBe(
      0,
    );
    expect(readFileSync(join(repo, 'gh-args'), 'utf8').trim()).toBe(
      'pr checks 12 -R owner/repo',
    );
    expect(
      hook('gh pr ready 1 2>&1 && gh pr ready 2', repo, fakeGh(1)).status,
    ).toBe(2);
  });

  it.each([
    'gh pr ready 1115 2>&1 | tail -1',
    'gh pr ready 1115 &> /dev/null; echo done',
    'gh pr ready 1115 >&2',
  ])('passes only the pull request to gh pr checks from %s', (command) => {
    expect(hook(command, repo, fakeGh(0)).status).toBe(0);
    expect(readFileSync(join(repo, 'gh-args'), 'utf8').trim()).toBe(
      'pr checks 1115',
    );
  });

  it('keeps a pull request a draft when gh cannot run', () => {
    const missing = hook('gh pr ready 12', repo, {
      ...process.env,
      PATH: join(repo, 'no-such-bin'),
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/could not run/);
  });

  it('leaves merging, approving and rulesets to the maintainer', () => {
    expect(hook('gh pr merge 12 --squash').status).toBe(2);
    expect(hook('gh -R owner/repo pr merge 12 --admin').status).toBe(2);
    expect(hook('gh pr review 12 --approve').status).toBe(2);
    expect(hook('gh pr review 12 -a').status).toBe(2);
    expect(
      hook('gh api -X PUT repos/owner/repo/rulesets/1 --input r.json').status,
    ).toBe(2);
    expect(hook('gh pr review 12 --comment -b "looks off"').status).toBe(0);
    expect(hook('gh api repos/owner/repo/rulesets').status).toBe(0);
    expect(hook('grep -rn "gh pr merge" .agents').status).toBe(0);
    expect(
      hook('gh pr comment 12 --body "the maintainer runs gh pr merge"').status,
    ).toBe(0);
    expect(hook('gh pr review 12 --comment -b "drop the -a flag"').status).toBe(
      0,
    );
    expect(hook('GH_REPO=owner/repo gh pr merge 12').status).toBe(2);
    expect(
      hook('gh api repos/o/r/pulls/1/reviews -f event=APPROVE').status,
    ).toBe(2);
    expect(hook('gh api -X PUT repos/o/r/pulls/1/merge').status).toBe(2);
    expect(hook('gh api repos/o/r/rulesets -f name=x').status).toBe(2);
    expect(hook('gh api -X DELETE repos/o/r/rulesets/1').status).toBe(2);
    expect(hook('gh api -X GET repos/o/r/rulesets').status).toBe(0);
  });

  it('blocks Release-As footers and tool attribution in commit messages', () => {
    expect(hook('git commit -m "fix: x" -m "Release-As: 1.0.0"').status).toBe(
      2,
    );
    expect(
      hook(
        'git commit -m "fix: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
      ).status,
    ).toBe(2);
    expect(
      hook('git commit -m "fix: x" -m "Co-Authored-By: Ada <ada@example.org>"')
        .status,
    ).toBe(0);
  });

  it('blocks a commit without a configured email', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agent-guard-bare-'));
    execFileSync('git', ['init', '-q'], { cwd: bare });
    const { GIT_AUTHOR_EMAIL: _, ...rest } = process.env;
    const env = {
      ...rest,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    try {
      const result = hook('git commit -m "fix: x"', bare, env);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/user\.email/);
      expect(
        hook(
          'GIT_AUTHOR_EMAIL=a@example.org GIT_COMMITTER_EMAIL=a@example.org git commit -m "fix: x"',
          bare,
          env,
        ).status,
      ).toBe(0);
      expect(
        hook('git -c user.email=a@example.org commit -m "fix: x"', bare, env)
          .status,
      ).toBe(0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('holds back working-tree changes while a run builds from the checkout', () => {
    const lock = join(repo, 'dist/.validate-change.lock');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    try {
      const result = hook('git checkout main');
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/validate-change\.lock/);
      expect(hook('git reset --hard origin/main').status).toBe(2);
      expect(hook('git stash push -q').status).toBe(2);
      expect(hook('git stash list').status).toBe(0);
      expect(hook('git merge-tree --write-tree a b').status).toBe(0);
      expect(hook('git checkout -b feature').status).toBe(0);
      expect(hook('git restore --staged x.ts').status).toBe(0);
      expect(hook('git -c core.pager=cat checkout main').status).toBe(2);
      expect(hook('git reset --soft HEAD~1').status).toBe(0);
      writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7 }));
      expect(hook('git checkout main').status).toBe(0);
    } finally {
      rmSync(join(repo, 'dist'), { recursive: true, force: true });
    }
  });

  it('blocks a push to a pull request marked ready', () => {
    const ready = fakePr({ number: 7, state: 'OPEN', isDraft: false });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts/nx.mjs'), 'process.exit(0);\n');
    try {
      const result = hook('git push origin feature', repo, ready);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/gh pr ready 7 --undo/);
      for (const command of [
        'git push --force-with-lease=feature:abc origin feature',
        'git push -u origin HEAD',
        'git push origin HEAD:refs/heads/feature',
        'git push',
        'git -c push.default=current push',
      ])
        expect(hook(command, repo, ready).status).toBe(2);
      expect(
        hook(
          'git push origin feature',
          repo,
          fakePr({ number: 7, state: 'OPEN', isDraft: true }),
        ).status,
      ).toBe(0);
    } finally {
      rmSync(join(repo, 'bin'), { recursive: true, force: true });
    }
  });

  it('blocks hand edits to the changelog and release versions', () => {
    expect(
      edit({
        file_path: join(repo, 'CHANGELOG.md'),
        old_string: 'a',
        new_string: 'b',
      }).status,
    ).toBe(2);
    expect(
      edit({
        file_path: join(repo, 'package.json'),
        old_string: '"version": "0.5.0-next.3",',
        new_string: '"version": "0.5.0",',
      }).status,
    ).toBe(2);
    expect(
      edit({
        file_path: join(repo, 'package.json'),
        old_string: '"lint": "nx lint"',
        new_string: '"lint": "nx run-many -t lint"',
      }).status,
    ).toBe(0);
    writeFileSync(join(repo, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    expect(
      edit(
        {
          file_path: join(repo, 'package.json'),
          content: '{\n  "version": "1.1.0"\n}\n',
        },
        'Write',
      ).status,
    ).toBe(2);
    expect(
      edit(
        {
          file_path: join(repo, 'package.json'),
          content: '{\n  "version": "1.0.0",\n  "private": true\n}\n',
        },
        'Write',
      ).status,
    ).toBe(0);
    rmSync(join(repo, 'package.json'));
    expect(
      edit({
        file_path: join(repo, 'docs/CHANGELOG.md'),
        old_string: 'a',
        new_string: 'b',
      }).status,
    ).toBe(0);
    expect(
      edit(
        {
          file_path: join(repo, 'package.json'),
          edits: [
            {
              old_string: '"version": "1.0.0"',
              new_string: '"version": "2.0.0"',
            },
          ],
        },
        'MultiEdit',
      ).status,
    ).toBe(2);
    const outside = mkdtempSync(join(tmpdir(), 'agent-guard-loose-'));
    try {
      expect(
        edit({
          file_path: join(outside, 'CHANGELOG.md'),
          old_string: 'a',
          new_string: 'b',
        }).status,
      ).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    const fresh = edit(
      { file_path: join(repo, 'no/such/dir/x.ts'), content: 'x\n' },
      'Write',
    );
    expect(fresh.status).toBe(0);
    expect(fresh.stderr).toBe('');
  });

  it('blocks a push when the affected typecheck fails', () => {
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts/nx.mjs'),
      "console.log('error TS2322: nope'); process.exit(1);\n",
    );
    const result = hook(`cd ${repo} && git push -u origin HEAD`, tmpdir());
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/TS2322/);
    writeFileSync(join(repo, 'scripts/nx.mjs'), 'process.exit(0);\n');
    expect(hook('git push').status).toBe(0);
  });
});
