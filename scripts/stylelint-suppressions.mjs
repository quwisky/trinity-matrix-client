import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import stylelint from 'stylelint';

export const workspaceRoot = join(import.meta.dirname, '..');
export const SUPPRESSIONS = 'stylelint-suppressions.json';
export const RULES = [
  'color-no-hex',
  'declaration-property-value-disallowed-list',
];
export const GLOB = '{apps,libs,e2e}/**/*.{scss,css}';

/** The allow-list as committed in the working tree. */
export const committedSuppressions = () =>
  JSON.parse(readFileSync(join(workspaceRoot, SUPPRESSIONS), 'utf8'));

/** The token-rule violations the stylesheets hold now, keyed like the allow-list. */
export async function currentSuppressions() {
  const location = join(
    mkdtempSync(join(tmpdir(), 'stylelint-suppressions-')),
    SUPPRESSIONS,
  );
  await stylelint.lint({
    files: GLOB,
    cwd: workspaceRoot,
    suppressRule: RULES,
    suppressLocation: location,
  });
  // Stylelint keys files relative to the process cwd, which is the project dir under nx.
  const written = JSON.parse(readFileSync(location, 'utf8'));
  return Object.fromEntries(
    Object.entries(written).map(([file, rules]) => [
      relative(workspaceRoot, resolve(file)),
      rules,
    ]),
  );
}

/**
 * The committed allow-list lowered to the current counts: a count only goes down, and an entry
 * that reaches zero is dropped. Nothing is raised or added, so a new literal still fails.
 */
export function ratchet(committed, current) {
  const next = {};
  const lowered = [];
  for (const [file, rules] of Object.entries(committed)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const now = current[file]?.[rule]?.count ?? 0;
      if (now < count) lowered.push(`${file} ${rule}: ${count} -> ${now}`);
      if (Math.min(now, count) > 0) {
        next[file] = { ...next[file], [rule]: { count: Math.min(now, count) } };
      }
    }
  }
  return { next, lowered };
}
