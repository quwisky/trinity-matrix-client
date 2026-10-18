#!/usr/bin/env node
/**
 * Claude Code SessionStart hook: print the facts that change how a session should start.
 * Its stdout becomes session context. It never blocks, so every failure exits 0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKOUT_LOCKS, liveOwner } from './agent-guard.mjs';

const root = join(import.meta.dirname, '..');
const [HOMESERVER_LOCK] = CHECKOUT_LOCKS;
const git = (args, timeout = 5_000) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout });

/** Lines describing what needs attention, given readers for git and the journey lock. */
export function status({ read, behind, staleLock }) {
  const notes = [];
  if (behind > 0)
    notes.push(
      `Local main is ${behind} commit(s) behind origin/main: run \`git pull --ff-only origin main\` before branching.`,
    );
  if (!read(['config', 'user.email']))
    notes.push(
      'No git user.email is configured: commits are blocked until one is set (`git config user.email <address>`), or pass GIT_AUTHOR_EMAIL and GIT_COMMITTER_EMAIL per command.',
    );
  if (staleLock)
    notes.push(
      `${HOMESERVER_LOCK} belongs to a journey run that has ended; journeys fail with EEXIST until it is deleted.`,
    );
  return notes;
}

if (import.meta.main) {
  try {
    // A remote that asks for credentials must not stall the session start.
    process.env.GIT_TERMINAL_PROMPT = '0';
    process.env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes';
    git(['fetch', '-q', 'origin', 'main'], 15_000);
    const count = Number(
      git(['rev-list', '--count', 'main..origin/main']).stdout?.trim(),
    );
    const lock = join(root, HOMESERVER_LOCK);
    const notes = status({
      read: (args) => git(args).stdout?.trim() ?? '',
      behind: Number.isFinite(count) ? count : 0,
      staleLock: existsSync(lock) && !liveOwner(lock),
    });
    if (notes.length)
      process.stdout.write(
        `Repository status:\n${notes.map((note) => `- ${note}`).join('\n')}\n`,
      );
  } catch {
    // Status is a convenience; never block the session.
  }
}
