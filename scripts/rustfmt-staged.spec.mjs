import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { findRustfmt, main } from './rustfmt-staged.mjs';

/** A fake `exec` that answers `command args` from `answers` and null for anything else. */
const answering = (answers) => (command, args) =>
  answers[[command, ...args].join(' ')] ?? null;

describe('findRustfmt', () => {
  it('prefers the toolchain rustup resolves, without asking brew', () => {
    const exec = vi.fn(
      answering({
        'rustup which rustfmt': '/tc/bin/rustfmt',
        'rustfmt --version': 'rustfmt 1',
      }),
    );
    expect(findRustfmt(exec)).toBe('/tc/bin/rustfmt');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('falls back to a rustfmt on PATH when rustup is missing', () => {
    expect(findRustfmt(answering({ 'rustfmt --version': 'rustfmt 1' }))).toBe(
      'rustfmt',
    );
  });

  it('prefers a rustfmt on PATH to the one Homebrew has, without asking brew', () => {
    const exec = vi.fn(
      answering({
        'rustfmt --version': 'rustfmt 1',
        'brew --prefix rustup': '/opt/homebrew/opt/rustup',
        '/opt/homebrew/opt/rustup/bin/rustup which rustfmt': '/brew/rustfmt',
      }),
    );
    expect(findRustfmt(exec)).toBe('rustfmt');
    expect(exec).not.toHaveBeenCalledWith('brew', expect.anything());
  });

  it("falls back to Homebrew's keg-only rustup, which is not on PATH", () => {
    const exec = answering({
      'brew --prefix rustup': '/opt/homebrew/opt/rustup',
      '/opt/homebrew/opt/rustup/bin/rustup which rustfmt': '/brew/rustfmt',
    });
    expect(findRustfmt(exec)).toBe('/brew/rustfmt');
  });

  it('returns null when none of them has rustfmt', () => {
    expect(
      findRustfmt(
        answering({ 'brew --prefix rustup': '/opt/homebrew/opt/rustup' }),
      ),
    ).toBeNull();
    expect(findRustfmt(answering({}))).toBeNull();
  });
});

describe('main', () => {
  it('formats the files with the 2024 edition and passes rustfmt exit code on', () => {
    const exec = vi.fn(() => ({ status: 1 }));
    expect(main(['a.rs', 'b.rs'], { find: () => '/tc/rustfmt', exec })).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      '/tc/rustfmt',
      ['--edition', '2024', 'a.rs', 'b.rs'],
      {
        stdio: 'inherit',
      },
    );
  });

  it('fails open with one line when rustfmt is missing, and does nothing without files', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn();
    expect(main(['a.rs'], { find: () => null, exec })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(
      /rustfmt not found.*CI still checks it/,
    );
    expect(main([], { find: () => '/tc/rustfmt', exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('exits 0 with its message when run with no rustfmt anywhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rustfmt-staged-'));
    const file = join(dir, 'a.rs');
    writeFileSync(file, 'fn  main(){}\n');
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'rustfmt-staged.mjs'), file],
      {
        encoding: 'utf8',
        env: { PATH: dir },
      },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^rustfmt-staged: rustfmt not found.*\n$/);
  });
});
