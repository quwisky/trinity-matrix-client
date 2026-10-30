#!/usr/bin/env node
/**
 * lint-staged runs this on staged Rust files under native/ (.lintstagedrc.json). rustfmt is not
 * on PATH everywhere, notably Homebrew's keg-only rustup, so this finds it first. When there is
 * none it skips with one line and exits 0: CI's `cargo fmt --all --check` still judges the files.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** @returns {string | null} trimmed stdout, or null when the command is missing or fails */
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
};

/**
 * The rustfmt to run, or null. `rustup which` comes first because it honours the toolchain
 * pinned in rust-toolchain.toml.
 */
export function findRustfmt(exec = run) {
  const attempts = [
    () => exec('rustup', ['which', 'rustfmt']),
    () => (exec('rustfmt', ['--version']) ? 'rustfmt' : null),
    () => {
      const prefix = exec('brew', ['--prefix', 'rustup']);
      return (
        prefix && exec(join(prefix, 'bin', 'rustup'), ['which', 'rustfmt'])
      );
    },
  ];
  for (const attempt of attempts) {
    const found = attempt();
    if (found) return found;
  }
  return null;
}

/** @returns {number} the exit code: rustfmt's own, or 0 when there is no rustfmt to run */
export function main(files, { find = findRustfmt, exec = spawnSync } = {}) {
  if (files.length === 0) return 0;
  const rustfmt = find();
  if (!rustfmt) {
    console.log(
      'rustfmt-staged: rustfmt not found (run `rustup toolchain install`); skipping Rust formatting, CI still checks it.',
    );
    return 0;
  }
  return (
    exec(rustfmt, ['--edition', '2024', ...files], { stdio: 'inherit' })
      .status ?? 1
  );
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
