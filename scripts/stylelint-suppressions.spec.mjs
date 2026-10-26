import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GLOB,
  RULES,
  SUPPRESSIONS,
  committedSuppressions as committed,
  currentSuppressions,
  ratchet,
  workspaceRoot,
} from './stylelint-suppressions.mjs';

/**
 * The theme-token allow-list may only shrink (#932).
 *
 * Stylelint's native suppressions fail a file that gains a literal, but they pass silently
 * when one is fixed (the slack stays), and `--suppress` rewrites the file wholesale, so a
 * new literal could ride in on a regeneration. These checks close both gaps, and
 * `pnpm stylelint:ratchet` lowers the list after a fix without ever raising it.
 */

const git = (...args) =>
  execFileSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/** The allow-list at the merge base with origin/main; `null` before it existed. */
function baseSuppressions(run = git) {
  let sha;
  try {
    sha = run('merge-base', 'HEAD', 'origin/main').trim();
  } catch {
    throw new Error(
      'Cannot resolve origin/main: run `git fetch origin main` (CI needs fetch-depth: 0).',
    );
  }
  try {
    return JSON.parse(run('show', `${sha}:${SUPPRESSIONS}`));
  } catch {
    return null;
  }
}

const totals = (suppressions) => {
  const sums = {};
  for (const rules of Object.values(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      sums[rule] = (sums[rule] ?? 0) + count;
    }
  }
  return sums;
};

/** Every way `current` holds more than `base`, as readable lines; empty when it shrank or held. */
function growth(base, current) {
  if (!base) return [];
  const grown = [];
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const before = base[file]?.[rule]?.count;
      if (before !== undefined && count > before) {
        grown.push(`${file} ${rule}: ${before} -> ${count}`);
      }
    }
  }
  const before = totals(base);
  for (const [rule, total] of Object.entries(totals(current))) {
    if (total > (before[rule] ?? 0)) {
      grown.push(`${rule} total: ${before[rule] ?? 0} -> ${total}`);
    }
  }
  return grown;
}

const entry = (count) => ({ count });

describe('growth', () => {
  const base = { 'a.scss': { r: entry(2) }, 'b.scss': { r: entry(1) } };

  it('passes a shrink and a rename', () => {
    expect(growth(base, { 'a.scss': { r: entry(1) } })).toEqual([]);
    expect(
      growth(base, { 'a2.scss': { r: entry(2) }, 'b.scss': { r: entry(1) } }),
    ).toEqual([]);
  });

  it('fails a file that gains a literal', () => {
    expect(
      growth(base, { 'a.scss': { r: entry(3) }, 'b.scss': { r: entry(1) } }),
    ).toEqual(['a.scss r: 2 -> 3', 'r total: 3 -> 4']);
  });

  it('fails a new file that raises the total', () => {
    expect(growth(base, { ...base, 'c.scss': { r: entry(1) } })).toEqual([
      'r total: 3 -> 4',
    ]);
  });

  it('passes anything when the base has no allow-list yet', () => {
    expect(growth(null, base)).toEqual([]);
  });

  it('tells the reader to fetch main when the merge base is unknown', () => {
    const run = () => {
      throw new Error('fatal: Not a valid object name origin/main');
    };
    expect(() => baseSuppressions(run)).toThrow('git fetch origin main');
  });
});

describe('ratchet', () => {
  const committedList = {
    'a.scss': { r: entry(3), s: entry(1) },
    'b.scss': { r: entry(2) },
  };

  it('lowers a count that went down and drops one that reached zero', () => {
    const { next, lowered } = ratchet(committedList, {
      'a.scss': { r: entry(1) },
      'b.scss': { r: entry(2) },
    });
    expect(next).toEqual({
      'a.scss': { r: entry(1) },
      'b.scss': { r: entry(2) },
    });
    expect(lowered).toEqual(['a.scss r: 3 -> 1', 'a.scss s: 1 -> 0']);
  });

  it('drops a file whose violations are all gone', () => {
    const { next } = ratchet(committedList, {
      'a.scss': committedList['a.scss'],
    });
    expect(next).toEqual({ 'a.scss': committedList['a.scss'] });
  });

  it('never raises a count or adds a file', () => {
    const { next, lowered } = ratchet(committedList, {
      'a.scss': { r: entry(5), s: entry(1) },
      'b.scss': { r: entry(2) },
      'c.scss': { r: entry(1) },
    });
    expect(next).toEqual(committedList);
    expect(lowered).toEqual([]);
  });
});

describe('stylelint token allow-list', () => {
  it('sweeps the same files as `pnpm stylelint`', () => {
    const pkg = JSON.parse(
      readFileSync(join(workspaceRoot, 'package.json'), 'utf8'),
    );
    expect(pkg.scripts.stylelint).toBe(`stylelint "${GLOB}"`);
  });

  it('suppresses only the token rules', () => {
    const rules = new Set(Object.values(committed()).flatMap(Object.keys));
    expect([...rules].filter((rule) => !RULES.includes(rule))).toEqual([]);
  });

  it('records exactly the current violations, so a fix shrinks it in the same change', async () => {
    expect(
      await currentSuppressions(),
      'stylelint-suppressions.json is out of date: run `pnpm stylelint:ratchet` and commit it',
    ).toEqual(committed());
  }, 120_000);

  it('never grows against main', () => {
    expect(growth(baseSuppressions(), committed())).toEqual([]);
  });
});
