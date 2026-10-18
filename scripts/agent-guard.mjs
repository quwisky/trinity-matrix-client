#!/usr/bin/env node
/**
 * Claude Code PreToolUse guard for Bash commands (registered in .claude/settings.json).
 *
 * Reads the hook payload on stdin and exits 2 with a reason on stderr to block the command;
 * exit 0 lets it run. Commands that never mention git, gh or pgrep return immediately. Also
 * registered for Edit|Write, where it guards the files release-please owns.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

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

/** Locks whose live owner builds from this checkout: a journey run or `validate-change --run`. */
export const CHECKOUT_LOCKS = [
  'dist/.playwright/homeserver.lock',
  'dist/.validate-change.lock',
];

const out = (result) => (result.stdout ?? '').trim();

const gitRoot = (dir) =>
  out(run('git', ['rev-parse', '--show-toplevel'], dir)) || dir;

/** `git [-c k=v] [-C dir] <name>` for one of the `|`-separated subcommands. */
const gitCommand = (names) =>
  new RegExp(String.raw`\bgit\b(?:\s+-[cC]\s+\S+)*\s+(${names})(?![\w-])`);

/** The command with quoted text blanked, so a PR body or grep pattern is not a command. */
const unquoted = (command) =>
  command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');

export function liveOwner(file) {
  try {
    const { pid } = JSON.parse(readFileSync(file, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM: alive, owned by another user.
    return error?.code === 'EPERM' ? 'another user' : null;
  }
}

const WORKING_TREE = gitCommand(
  String.raw`reset\s+--hard|checkout(?!\s+-[bB]\b)|switch|restore(?!\s+--staged\b)|clean|rebase|cherry-pick|merge|pull|stash(?!\s+(?:list|show)\b)`,
);

/** Working-tree changes would invalidate a run still building from this checkout. */
function checkoutBusy(command, dir) {
  const git = WORKING_TREE.exec(unquoted(command));
  if (!git) return null;
  const root = gitRoot(dir);
  for (const lock of CHECKOUT_LOCKS) {
    const owner = liveOwner(join(root, lock));
    if (owner)
      return `\`git ${git[1]}\` would change ${root} while a run holds ${lock} (PID ${owner}) and builds from it. Wait for that run to finish, or work in another worktree.`;
  }
  return null;
}

/** `gh` in command position, after any `VAR=value` prefixes. */
const GH = String.raw`(?:^|[;&|(\n]\s*)(?:\w+=\S*\s+)*gh\b[^\n;&|]*`;
const MAINTAINER_ONLY = [
  new RegExp(String.raw`${GH}\bpr\s+merge\b`),
  new RegExp(String.raw`${GH}\bpr\s+review\b[^\n;&|]*\s(?:-a|--approve)\b`),
  new RegExp(String.raw`${GH}\bapi\b[^\n;&|]*/pulls/\d+/merge\b`),
  new RegExp(
    String.raw`${GH}\bapi\b[^\n;&|]*/reviews\b[^\n;&|]*\bevent=APPROVE\b`,
  ),
  // gh api writes with a method other than GET, wherever it sits, or with a field after the path.
  new RegExp(
    String.raw`${GH}\bapi\b(?=[^\n;&|]*\brulesets\b)[^\n;&|]*\s(?:-X|--method)(?:=|\s+)(?!GET\b)\w`,
  ),
  new RegExp(
    String.raw`${GH}\bapi\b[^\n;&|]*\brulesets\b[^\n;&|]*\s(?:-f|-F|--field|--raw-field|--input)\b`,
  ),
];

/** Merging, approving and rulesets stay with the maintainer (.agents/rules/git/pull-request-handling.md). */
function maintainerOnly(command) {
  const bare = unquoted(command);
  return MAINTAINER_ONLY.some((pattern) => pattern.test(bare))
    ? 'The maintainer merges, approves and changes rulesets (.agents/rules/git/pull-request-handling.md). If they asked for this, they can run it themselves with `! <command>`.'
    : null;
}

const COMMIT = gitCommand('commit');

/** Release-please reads `Release-As` on every line; tool attribution is never added. */
function commitMessage(command) {
  if (!COMMIT.test(unquoted(command))) return null;
  if (/\bRelease-As:/i.test(command))
    return 'Do not add `Release-As` footers: both release lines read them and would cut the same version twice (.agents/rules/git/semver.md).';
  if (
    /Co-Authored-By:[^\n]*(?:Claude|anthropic\.com)|Generated with \[?Claude/i.test(
      command,
    )
  )
    return 'Do not add tool attribution or generated-by footers to commits (branches-and-commits.md).';
  return null;
}

/** Without a configured email git falls back to a hostname address that matches no account. */
function commitIdentity(command, dir) {
  if (!COMMIT.test(unquoted(command))) return null;
  if (
    /\bGIT_AUTHOR_EMAIL=\S*@|\s-c\s+user\.email=\S*@/.test(command) ||
    process.env.GIT_AUTHOR_EMAIL
  )
    return null;
  if (out(run('git', ['config', 'user.email'], dir))) return null;
  return 'No git user.email is configured, so this commit would carry a hostname address. Set one with `git config user.email <address>`, or pass GIT_AUTHOR_EMAIL and GIT_COMMITTER_EMAIL for this command.';
}

/** A ready pull request goes back to draft before new work lands on it. */
function readyPullRequestPush(command, dir) {
  const push = command.match(/\bgit\b(?:\s+-[cC]\s+\S+)*\s+push\b([^\n;&|]*)/);
  if (!push || /(?:^|\s)(?:--delete|-d)(?:\s|$)/.test(push[1])) return null;
  const current = () =>
    out(run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir));
  const refs = words(push[1])
    .filter((arg) => !arg.startsWith('-'))
    .slice(1);
  const branches = (refs.length ? refs : ['HEAD']).map((ref) => {
    const target = ref
      .replace(/^\+/, '')
      .split(':')
      .pop()
      .replace(/^refs\/heads\//, '');
    return target === 'HEAD' ? current() : target;
  });
  for (const branch of branches.filter(Boolean)) {
    const view = run(
      'gh',
      ['pr', 'view', branch, '--json', 'number,state,isDraft'],
      dir,
      30_000,
    );
    if (view.status !== 0) continue;
    let pr;
    try {
      pr = JSON.parse(view.stdout);
    } catch {
      continue;
    }
    if (pr.state === 'OPEN' && !pr.isDraft)
      return `#${pr.number} is marked ready. Return it to draft first (\`gh pr ready ${pr.number} --undo\`), then push (.agents/rules/git/draft-pull-requests.md).`;
  }
  return null;
}

/** release-please writes the changelog and bumps versions; neither is edited by hand. */
function releaseFiles(input, cwd) {
  const file = input?.file_path;
  if (typeof file !== 'string') return null;
  const abs = resolve(cwd, file);
  // git names the root by its real path, so compare real paths (macOS /var is a symlink).
  let real = abs;
  try {
    real = join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    // A new file in a new directory: no symlink to resolve.
  }
  const root = existsSync(dirname(real))
    ? out(run('git', ['rev-parse', '--show-toplevel'], dirname(real)))
    : out(run('git', ['rev-parse', '--show-toplevel'], cwd));
  if (!root) return null;
  const path = relative(root, real);
  if (path === 'CHANGELOG.md')
    return 'release-please writes CHANGELOG.md when a release PR merges; do not edit it by hand (.agents/rules/docs/changelog.md).';
  if (path !== 'package.json' && path !== 'electron/package.json') return null;
  const version = (text) => /"version":\s*"([^"]*)"/.exec(text ?? '')?.[1];
  const edits = input.edits ?? [input];
  const before =
    edits.map((edit) => edit.old_string ?? '').join('\n') ||
    (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const after = edits
    .map((edit) => edit.new_string ?? edit.content ?? '')
    .join('\n');
  return version(after) !== undefined && version(after) !== version(before)
    ? `release-please bumps the version in ${path}; keep it unchanged (.agents/rules/git/semver.md).`
    : null;
}

function pgrepLoop(command) {
  // The loop's own condition, not text that merely mentions both words.
  if (
    !/\b(?:while|until)\s+(?:!\s*)?pgrep\s+(?:-\S+\s+)*-[a-zA-Z]*f/.test(
      command,
    )
  )
    return null;
  return '`pgrep -f` inside a wait loop matches the shell running the loop, so it never ends. Wait on a PID with a timeout instead, e.g. `timeout 600 tail --pid=<pid> -f /dev/null`.';
}

function pushTypecheck(command, dir) {
  const push = command.match(/\bgit\b(?:\s+-[cC]\s+\S+)*\s+push\b([^\n;&|]*)/);
  if (!push) return null;
  const args = push[1].trim().split(/\s+/).filter(Boolean);
  const refs = args.filter((arg) => !arg.startsWith('-')).slice(1);
  if (/(?:^|\s)(?:--delete|-d)(?:\s|$)/.test(push[1])) return null;
  if (refs.length > 0 && refs.every((ref) => ref.startsWith(':'))) return null;

  const root = out(run('git', ['rev-parse', '--show-toplevel'], dir)) || dir;
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

/**
 * `gh pr create|ready` in command position (not quoted text), with any global `-R/--repo`
 * given before `pr`. Group 1: the global repo flag, 2: the subcommand, 3: its arguments,
 * which run on through a `>&` redirection such as `2>&1` so that `words` drops it whole.
 */
const GH_PR =
  /(?:^|[;&|(\n]\s*)(?:\w+=\S*\s+)*gh((?:\s+(?:-R|--repo)(?:=|\s+)\S+)*)\s+pr\s+(create|ready)\b((?:>&|[^\n;&|])*)/g;

/** Words of a simple argument list, without quotes, redirections or a trailing comment. */
const words = (text) =>
  text
    .replace(/\s#.*$/, '')
    .replace(/\s\d?>&?\s*\S+/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^(["'])(.*)\1$/, '$2'));

/** Pull requests open as drafts and are marked ready only once every check passes. */
function draftPullRequest(command, dir) {
  for (const pr of command.matchAll(GH_PR)) {
    const repo = words(pr[1]);
    if (pr[2] === 'create') {
      // Look past the first `&`, `;` or newline: a multi-line --body may come before --draft.
      if (/\s(?:-d|--draft(?:=true)?)(?=\s|$)/.test(command.slice(pr.index)))
        continue;
      return 'Open pull requests as drafts: add --draft. Mark one ready with `gh pr ready <number>` only when its checks are green and its review is done (.agents/rules/git/draft-pull-requests.md).';
    }
    const args = [...words(pr[3]), ...repo];
    if (args.includes('--undo')) continue;
    const checks = run('gh', ['pr', 'checks', ...args], dir, 30_000);
    if (checks.status === 0) continue;
    const output = `${checks.stdout ?? ''}${checks.stderr ?? ''}${checks.error?.message ?? ''}`;
    const tail = output.trim().split('\n').slice(-15).join('\n');
    const reason =
      checks.status === 1 || checks.status === 8
        ? `\`gh pr checks ${args.join(' ')}\` does not pass yet`
        : `\`gh pr checks ${args.join(' ')}\` could not run`;
    return `Keep the pull request a draft: ${reason}. Mark it ready once every check is green and its review is done.\n\n${tail}`;
  }
  return null;
}

export function check(payload) {
  const cwd = payload?.cwd ?? process.cwd();
  if (payload?.tool_name !== 'Bash')
    return releaseFiles(payload?.tool_input, cwd);
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !/\b(?:git|gh|pgrep)\b/.test(command))
    return null;
  const dir = commandDir(command, cwd);
  return (
    pgrepLoop(command) ??
    maintainerOnly(command) ??
    commitMessage(command) ??
    draftPullRequest(command, dir) ??
    privateDocs(command, dir) ??
    commitIdentity(command, dir) ??
    checkoutBusy(command, dir) ??
    readyPullRequestPush(command, dir) ??
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
