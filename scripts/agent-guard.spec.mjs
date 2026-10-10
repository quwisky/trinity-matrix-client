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

const hook = (command, cwd = repo, env = process.env) =>
  spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env,
  });

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
