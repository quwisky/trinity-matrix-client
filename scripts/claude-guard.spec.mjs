import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const guard = join(import.meta.dirname, 'claude-guard.mjs');
const repo = mkdtempSync(join(tmpdir(), 'claude-guard-'));
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git('init', '-q');

const hook = (command, cwd = repo) =>
  spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('claude-guard PreToolUse hook', () => {
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
