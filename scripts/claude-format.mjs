#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook (Edit|Write|MultiEdit): format the edited file with the
 * repository's Prettier. Unsupported extensions and .prettierignore paths are skipped; it
 * never blocks, so every failure exits 0.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

try {
  const root = join(import.meta.dirname, '..');
  const file = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.file_path;
  const inside =
    typeof file === 'string' && !relative(root, file).startsWith('..');
  if (inside) {
    spawnSync(
      join(root, 'node_modules/.bin/prettier'),
      ['--write', '--ignore-unknown', '--log-level', 'silent', file],
      { cwd: root, stdio: 'ignore', timeout: 30_000 },
    );
  }
} catch {
  // Formatting is a convenience; never block the edit.
}
