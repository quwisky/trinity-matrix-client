/** Retired Playwright predecessors stay pinned at their retirement commit (#839). */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import {
  RETIRED_PREDECESSORS,
  RETIRED_PREDECESSOR_COMMIT,
  hasRetiredPredecessorCommit,
  readRetiredPredecessor,
} from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

// Android batches accepted when the user decided the retirement on 2026-09-26: every batch
// closed under #660 plus #751-#753, accepted on hosted evidence. Open batches are excluded.
// #754 (message-swipe) and #755 (message-unread) were accepted and retired separately on
// 2026-09-28 under the same policy. #756 (pinned-message-panel) followed on 2026-09-29, and #757
// (pinned-message-workflow, two of its three definitions) and #758 (quote-notification, kept
// desktop-only) on 2026-09-30.
const ACCEPTED_BATCHES = new Set([
  670, 672, 674, 676, 687, 688, 689, 690, 691, 692, 693, 694, 695, 696, 697,
  698, 699, 700, 701, 706, 707, 708, 709, 710, 711, 712, 713, 714, 715, 716,
  717, 718, 719, 720, 721, 722, 723, 724, 725, 726, 727, 728, 729, 730, 731,
  732, 733, 734, 735, 736, 737, 738, 739, 740, 741, 742, 743, 744, 745, 746,
  747, 748, 749, 750, 751, 752, 753, 754, 755, 756, 757, 758,
]);

const titleOf = (argument) =>
  ts.isStringLiteralLike(argument)
    ? argument.text
    : ts.isTemplateExpression(argument)
      ? argument.getText().slice(1, -1)
      : undefined;

/** Every `test(title, ...)` definition in a spec source, with its full text. */
function definitions(path, source) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'test' &&
      node.arguments.length >= 2
    ) {
      const title = titleOf(node.arguments[0]);
      if (title !== undefined) found.push({ title, text: node.getText(tree) });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Problems with one registry entry against the commit bytes and the working tree. */
export function retirementProblems(entry, { commitSource, workingSource }) {
  const problems = [];
  const digest = createHash('sha256').update(commitSource).digest('hex');
  if (digest !== entry.sha256)
    problems.push(`${entry.path}: SHA-256 ${digest}`);
  if (
    entry.issues.length === 0 ||
    entry.issues.some((n) => !ACCEPTED_BATCHES.has(n))
  )
    problems.push(`${entry.path}: not owned by accepted batches only`);
  if (entry.retired.length + entry.desktopOnly.length === 0)
    problems.push(`${entry.path}: retires nothing`);
  const before = definitions(entry.path, commitSource.toString('utf8'));
  for (const title of [...entry.retired, ...entry.desktopOnly])
    if (!before.some((definition) => definition.title === title))
      problems.push(
        `${entry.path}: "${title}" is not a predecessor definition`,
      );
  if (entry.deleted) {
    if (workingSource !== undefined)
      problems.push(`${entry.path}: still exists`);
    if (entry.desktopOnly.length > 0)
      problems.push(`${entry.path}: deleted with desktop-only definitions`);
    const unlisted = before.filter(
      (definition) => !entry.retired.includes(definition.title),
    );
    if (unlisted.length > 0)
      problems.push(`${entry.path}: deleted unowned "${unlisted[0].title}"`);
    return problems;
  }
  if (workingSource === undefined) {
    problems.push(`${entry.path}: missing although it keeps definitions`);
    return problems;
  }
  const after = definitions(entry.path, workingSource);
  for (const title of entry.retired)
    if (after.some((definition) => definition.title === title))
      problems.push(`${entry.path}: retired "${title}" still defined`);
  for (const title of entry.desktopOnly) {
    const kept = after.filter((definition) => definition.title === title);
    if (kept.length !== 1) {
      problems.push(
        `${entry.path}: desktop-only "${title}" defined ${kept.length} times`,
      );
      continue;
    }
    const [{ text }] = kept;
    if (!/^test\([\s\S]*?\{\s*test\.skip\(\s*isAndroidE2E,/u.test(text))
      problems.push(`${entry.path}: "${title}" does not skip Android first`);
    if (/if\s*\(\s*!?\s*isAndroidE2E\s*\)|isAndroidE2E\s*\?/u.test(text))
      problems.push(`${entry.path}: "${title}" keeps an Android branch`);
  }
  return problems;
}

const workingSourceOf = (path) =>
  existsSync(resolve(root, path)) ? read(path) : undefined;

describe('retired Playwright predecessors', () => {
  it('holds the retirement commit the parity evidence is pinned at', () => {
    expect(
      hasRetiredPredecessorCommit(),
      `run node scripts/retired-playwright-predecessors.mjs fetch to fetch ${RETIRED_PREDECESSOR_COMMIT}`,
    ).toBe(true);
  });

  it('pins each predecessor at its accepted bytes and matches the working tree', () => {
    const paths = RETIRED_PREDECESSORS.map(({ path }) => path);
    expect(new Set(paths).size).toBe(paths.length);
    const problems = RETIRED_PREDECESSORS.flatMap((entry) =>
      retirementProblems(entry, {
        commitSource: readRetiredPredecessor(entry.path),
        workingSource: workingSourceOf(entry.path),
      }),
    );
    expect(problems).toEqual([]);
  });

  it('rejects a changed pin, an unknown title, a surviving or Android-branched definition', () => {
    const partial = RETIRED_PREDECESSORS.find(
      (entry) => !entry.deleted && entry.desktopOnly.length > 0,
    );
    const deleted = RETIRED_PREDECESSORS.find((entry) => entry.deleted);
    const inputs = (entry) => ({
      commitSource: readRetiredPredecessor(entry.path),
      workingSource: workingSourceOf(entry.path),
    });
    expect(retirementProblems(partial, inputs(partial))).toEqual([]);
    expect(retirementProblems(deleted, inputs(deleted))).toEqual([]);
    const [title] = partial.desktopOnly;
    const working = inputs(partial).workingSource;
    for (const [entry, sources] of [
      [{ ...partial, sha256: '0'.repeat(64) }, inputs(partial)],
      [{ ...partial, issues: [839] }, inputs(partial)],
      [
        { ...partial, retired: [...partial.retired, 'no such test'] },
        inputs(partial),
      ],
      [{ ...deleted, deleted: false }, inputs(deleted)],
      [deleted, { ...inputs(deleted), workingSource: '' }],
      [{ ...deleted, retired: deleted.retired.slice(1) }, inputs(deleted)],
      [
        partial,
        {
          ...inputs(partial),
          workingSource: working.replace(
            /test\.skip\(\s*isAndroidE2E,/u,
            'test.skip(false,',
          ),
        },
      ],
      [
        partial,
        {
          ...inputs(partial),
          workingSource: working.replace(
            /test\.skip\(\s*isAndroidE2E,[^;]*;/u,
            (skip) => `${skip}\n    if (isAndroidE2E) return;`,
          ),
        },
      ],
      [{ ...partial, retired: [title] }, inputs(partial)],
    ])
      expect(retirementProblems(entry, sources), entry.path).not.toEqual([]);
  });

  it('keeps deleted predecessors out of the browser journey catalog', () => {
    const catalog = read('e2e/browser/journey-catalog.mts');
    for (const { path } of RETIRED_PREDECESSORS.filter(
      ({ deleted }) => deleted,
    ))
      expect(catalog).not.toContain(`'${path.replace('e2e/browser/', '')}'`);
  });

  it('records the decision and every predecessor in the migration ledger', () => {
    const section = read('e2e/android/MIGRATION.md')
      .split('\n## Predecessor retirement\n')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    expect(section).toContain('On 2026-09-26 the user decided');
    expect(section).toContain('issues/839');
    expect(section).toContain(RETIRED_PREDECESSOR_COMMIT.slice(0, 8));
    expect(section).toContain('scripts/retired-playwright-predecessors.mjs');
    for (const entry of RETIRED_PREDECESSORS) {
      const short = entry.path
        .replace('e2e/browser/journeys/', '')
        .replace('e2e/android/', 'android/');
      const row = section
        .split('\n')
        .find((line) => line.startsWith(`| \`${short}\` |`));
      expect(row, short).toBeDefined();
      expect(row).toContain(
        entry.deleted ? 'file deleted' : `${entry.retired.length} retired`,
      );
      for (const title of entry.desktopOnly) expect(row).toContain(title);
    }
  });
});
