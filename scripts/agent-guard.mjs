#!/usr/bin/env node
/**
 * Claude Code PreToolUse guard for Bash commands (registered in .claude/settings.json).
 *
 * Reads the hook payload on stdin and exits 2 with a reason on stderr to block the command;
 * exit 0 lets it run. Commands that never mention git or pgrep return immediately.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PRIVATE_PATH =
  /(?:^|[\s'"=/])(?:docs\/superpowers|\.superpowers)(?:[/\s'"]|$)/;
const PRIVATE_STATUS = /^(?:docs\/superpowers|\.superpowers)(?:\/|$)/;

const run = (cmd, args, cwd, timeout = 10_000) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });

const lines = (text) => (text ?? '').split('\n').filter(Boolean);

/** Directory the command runs git in: `git -C <dir>`, else a leading `cd <dir> &&`. */
function commandDir(command, cwd) {
  const dir =
    command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)?.[1] ??
    command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/)?.[1];
  return dir ? resolve(cwd, dir.replace(/^["']|["']$/g, '')) : cwd;
}

function privateDocs(command, dir) {
  const add = command.match(/\bgit\b(?:\s+-C\s+\S+)?\s+add\b([^\n;&|]*)/);
  const commit = command.match(/\bgit\b(?:\s+-C\s+\S+)?\s+commit\b([^\n;&|]*)/);
  if (!add && !commit) return null;
  const reason =
    'docs/superpowers and .superpowers are local working notes and must never be committed. Unstage them (git restore --staged <path>) and stage only task-owned files.';
  if (add && PRIVATE_PATH.test(add[1])) return reason;

  const status = lines(
    run('git', ['status', '--porcelain', '--untracked-files=all'], dir).stdout,
  );
  const changed = status.map((line) => line.slice(3).replace(/^"|"$/g, ''));
  const staged = lines(
    run('git', ['diff', '--cached', '--name-only'], dir).stdout,
  );
  const addsAll =
    add && /(?:^|\s)(?:-A|--all|-u|--update|\.)(?:\s|$)/.test(add[1]);
  const commitsAll =
    commit && /(?:^|\s)(?:-[a-zA-Z]*a[a-zA-Z]*|--all)(?:\s|$)/.test(commit[1]);
  const pending = [...staged, ...(addsAll || commitsAll ? changed : [])];
  if ((add || commit) && pending.some((path) => PRIVATE_STATUS.test(path)))
    return reason;
  return null;
}

function pgrepLoop(command) {
  if (!/\b(?:while|until)\b/.test(command)) return null;
  if (!/\bpgrep\s+(?:-\S+\s+)*-[a-zA-Z]*f/.test(command)) return null;
  return '`pgrep -f` inside a wait loop matches the shell running the loop, so it never ends. Wait on a PID with a timeout instead, e.g. `timeout 600 tail --pid=<pid> -f /dev/null`.';
}

function pushTypecheck(command, dir) {
  const push = command.match(/\bgit\b(?:\s+-C\s+\S+)?\s+push\b([^\n;&|]*)/);
  if (!push) return null;
  const args = push[1].trim().split(/\s+/).filter(Boolean);
  const refs = args.filter((arg) => !arg.startsWith('-')).slice(1);
  if (/(?:^|\s)(?:--delete|-d)(?:\s|$)/.test(push[1])) return null;
  if (refs.length > 0 && refs.every((ref) => ref.startsWith(':'))) return null;

  const root =
    run('git', ['rev-parse', '--show-toplevel'], dir).stdout.trim() || dir;
  const result = run(
    process.execPath,
    ['scripts/nx.mjs', 'affected', '-t', 'typecheck', '--base=origin/main'],
    root,
    840_000,
  );
  if (result.status === 0) return null;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
  const tail = output.trim().split('\n').slice(-40).join('\n');
  return `Push blocked: \`node scripts/nx.mjs affected -t typecheck --base=origin/main\` failed in ${root}. Fix the type errors, then push again.\n\n${tail}`;
}

export function check(payload) {
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !/\b(?:git|pgrep)\b/.test(command))
    return null;
  const dir = commandDir(command, payload.cwd ?? process.cwd());
  return (
    pgrepLoop(command) ??
    privateDocs(command, dir) ??
    pushTypecheck(command, dir)
  );
}

if (import.meta.main) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const reason = check(payload);
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
}
