import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A toast that reports a failure is a danger toast (#930 S2). Every `toast….show(` call is
 * checked on its own; the scan has no expected total, only a non-empty check.
 */
const root = join(import.meta.dirname, '..');
const sources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: root,
}).filter(
  (file) =>
    !/\.(?:spec|stories)\.ts$/u.test(file) && !file.startsWith('libs/spartan/'),
);

/** Every `toast….show(…)` call in `file`, with its full argument text. */
function toastCalls(file) {
  const text = readFileSync(join(root, file), 'utf8');
  return [...text.matchAll(/\btoast\w*\s*\.\s*show\(/giu)].map((match) => {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < text.length) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')') depth -= 1;
      end += 1;
    }
    return {
      where: `${file}:${text.slice(0, match.index).split('\n').length}`,
      args: text.slice(match.index + match[0].length, end - 1),
    };
  });
}

const calls = sources.flatMap(toastCalls);
const reportsFailure = /could not|couldn['’]t|failed|MISTYPED_MESSAGE/iu;

describe('toast variants', () => {
  it('finds toast calls to check', () => {
    expect(calls).not.toHaveLength(0);
  });

  it('shows every failure toast in the danger variant', () => {
    const failures = calls.filter((call) => reportsFailure.test(call.args));
    expect(failures).not.toHaveLength(0);
    for (const call of failures) {
      expect(call.args, call.where).toMatch(/variant:\s*[^,}]*'danger'/u);
    }
  });

  it('shows a partial cleanup as a warning', () => {
    const residue = calls.filter((call) =>
      /with (?:some )?residue/u.test(call.args),
    );
    expect(residue).not.toHaveLength(0);
    for (const call of residue) {
      expect(call.args, call.where).toMatch(/variant:\s*'warning'/u);
    }
  });
});
