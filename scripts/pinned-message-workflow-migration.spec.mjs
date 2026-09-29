import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  readRetiredPredecessor,
  RETIRED_PREDECESSOR_COMMIT,
} from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const PREDECESSOR =
  'e2e/browser/journeys/conversations/pinned-message-workflow.spec.mts';
/** Alias for the ported binding-resolver helpers below, whose defaults reference this name. */
const predecessor = PREDECESSOR;
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
/** The canonical bytes are the issue's pin, a Git object at the retirement commit (spec OQ1). */
const readPredecessor = () =>
  readRetiredPredecessor(PREDECESSOR).toString('utf8');
const loadContract = () =>
  import('../e2e/android/pinned-message-workflow-contract.mts');
const loadObserver = () =>
  import('../e2e/android/pinned-message-workflow-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/pinned-message-workflow-artifacts.mts');

/** The issue's predecessor bytes, at RETIRED_PREDECESSOR_COMMIT (dd0cb53c). */
const PREDECESSOR_SHA256 =
  'ee52c7e30ba06c519d277e0009416e63f1c5239a98e56fe1a6187cb8d18620f2';
/** The working tree: identical except line 27, a comment #839 edited. */
const WORKING_TREE_SHA256 =
  'f0a1f4be395c30c05bc71820aadf5fe719d0062654e9b83d115c35e2a2ed5ff7';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const SEED_SPANS = [
  [91, 124],
  [137, 188],
];
const EXCLUDED_SPAN = [402, 445];

/** The design's identity table, verbatim (design doc "Parity records"). */
const STAGES = [
  {
    id: 'pin-jump-unpin',
    span: [193, 290],
    direct: [212, 237, 241, 246, 247, 263, 267, 271, 275, 284, 289],
    inherited: [{ helper: 'openMessageActionSheet', line: 220, call: 226 }],
    suffixes: [
      'timeline-visible',
      'sheet-ready',
      'badge-one',
      'panel-heading-visible',
      'pin-row-visible',
      'pin-row-body',
      'jump-flash',
      'panel-closed-by-jump',
      'target-in-viewport',
      'panel-reopened',
      'empty-copy-visible',
      'badge-cleared',
    ],
  },
  {
    id: 'repeat-jump',
    span: [300, 400],
    direct: [
      321, 354, 355, 365, 366, 369, 376, 377, 384, 391, 392, 395, 398, 399,
    ],
    inherited: [],
    suffixes: [
      'timeline-visible',
      'last-filler-in-viewport',
      'target-offscreen',
      'first-heading-visible',
      'first-pin-row-visible',
      'first-flash',
      'first-panel-closed',
      'first-target-in-viewport',
      'target-offscreen-at-latest',
      'second-heading-visible',
      'second-pin-row-visible',
      'second-flash',
      'second-panel-closed',
      'second-target-in-viewport',
    ],
  },
];
const ALL_IDENTITIES = STAGES.flatMap((stage) =>
  stage.suffixes.map(
    (suffix) => `pinned-message-workflow.${stage.id}.${suffix}`,
  ),
);

const LINE_PINS = {
  40: "const OTHER_BODY = 'just chatting';",
  41: "const PIN_BODY = 'pin me please';",
  42: "const REPEAT_PIN_BODY = 'pin me twice please';",
  56: 'const FILLER_COUNT = 32;',
  96: 'const readerUser = `pin-reader-${runId}`;',
  98: 'const roomName = `Pin E2E ${runId}`;',
  106: "data: { name: roomName, preset: 'private_chat' },",
  147: 'const readerUser = `pin-repeat-reader-${runId}`;',
  149: 'const roomName = `Pin Repeat E2E ${runId}`;',
  179: '{ headers: reader.headers, data: { pinned: [targetEventId] } },',
  198: "const runId = `${testResourceId('run')}p`;",
  225: 'if (isAndroidE2E) {',
  227: "await sheet.getByTestId('sheet-pin').click();",
  237: "await expect(badge).toHaveText('1', { timeout: 30_000 });",
  264: 'timeout: 1_500,',
  285: "page.getByText('No pinned messages in this channel yet.'),",
  289: 'await expect(badge).toHaveCount(0, { timeout: 30_000 });',
  305: "const runId = `${testResourceId('run')}pr`;",
  334: 'const lastFillerBody = `pin-repeat filler ${runId} ${FILLER_COUNT - 1}`;',
  342: 'body: `pin-repeat filler ${runId} ${i}`,',
  354: 'await expect(lastFillerRow.first()).toBeInViewport({ timeout: 30_000 });',
  370: 'timeout: 1_500,',
  383: '.evaluate((el) => el.scrollTo(0, el.scrollHeight));',
  396: 'timeout: 1_500,',
  402: "test('the panel takes its own width, and only offers a divider where one means something', async ({",
};

const TRANSACTION_TEMPLATES = [
  'pin-other-${runId}',
  'pin-target-${runId}',
  'pin-repeat-lead-${runId}',
  'pin-repeat-target-${runId}',
  'pin-repeat-filler-${runId}-${i}',
];

/* -------------------------------------------------------------------------- */
/* Predecessor AST analysis, ported unchanged from #756's guard               */
/* -------------------------------------------------------------------------- */

const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
const endLineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

function assertionLines(source, start, end, name = predecessor) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect'
    ) {
      const line = lineOf(tree, node);
      if (line >= start && line <= end) lines.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return lines;
}

/** Map a relative import specifier of `from` to a repository path. */
const repositoryPath = (from, specifier) =>
  posix.normalize(posix.join(posix.dirname(from), specifier));

/**
 * Resolve every call through the TypeChecker. A call binds to a helper only
 * when its symbol is a named import or a module-level function declaration, so
 * a shadowing local of the same name never expands.
 */
function importedCalls(source, fileName = predecessor) {
  const virtual = `/virtual/${basename(fileName)}`;
  const file = ts.createSourceFile(
    virtual,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = {
    getSourceFile: (name) => (name === virtual ? file : undefined),
    getDefaultLibFileName: () => '/virtual/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/virtual',
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === virtual,
    readFile: (name) => (name === virtual ? source : undefined),
  };
  const program = ts.createProgram({
    rootNames: [virtual],
    options: {
      noResolve: true,
      noLib: true,
      types: [],
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    },
    host,
  });
  const checker = program.getTypeChecker();
  const tree = program.getSourceFile(virtual);
  const calls = [];
  const shadowed = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = checker.getSymbolAtLocation(node.expression)
        ?.declarations?.[0];
      if (declaration && ts.isImportSpecifier(declaration)) {
        calls.push({
          name: (declaration.propertyName ?? declaration.name).text,
          specifier: declaration.parent.parent.parent.moduleSpecifier.text,
          line: lineOf(tree, node),
        });
      } else if (
        declaration &&
        ts.isFunctionDeclaration(declaration) &&
        ts.isSourceFile(declaration.parent)
      ) {
        calls.push({
          name: node.expression.text,
          specifier: null,
          line: lineOf(tree, node),
        });
      } else if (declaration) {
        shadowed.push({ name: node.expression.text, line: lineOf(tree, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { calls, shadowed };
}

/** Every `expect` line a helper reaches, following module-local and relative imports. */
function helperExpectLines(
  module,
  name,
  source = module === predecessor ? readPredecessor() : read(module),
  seen = new Set(),
) {
  const key = `${module}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const tree = ts.createSourceFile(
    module,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = tree.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) return [];
  const start = lineOf(tree, declaration);
  const end = endLineOf(tree, declaration);
  const own = assertionLines(source, start, end, module).map((line) => ({
    module,
    line,
  }));
  const { calls } = importedCalls(source, module);
  const nested = calls
    .filter((call) => call.line >= start && call.line <= end)
    .flatMap((call) =>
      call.specifier === null
        ? helperExpectLines(module, call.name, source, seen)
        : call.specifier.startsWith('.')
          ? helperExpectLines(
              repositoryPath(module, call.specifier),
              call.name,
              undefined,
              seen,
            )
          : [],
    );
  return [...own, ...nested];
}

/**
 * Expand a definition into parity sites by naively following every
 * module-local or `support/` call in its span. Unlike message-quote's guard,
 * this has no `isAndroidE2E` branch awareness: it is used here only to show
 * why the contract's site list is pinned by hand rather than derived from it
 * (the "expands only the Android branch" test, below).
 */
function expandDefinition(source, span) {
  const [from, to] = span;
  const { calls } = importedCalls(source);
  const inherited = calls
    .filter(
      (call) =>
        call.line >= from &&
        call.line <= to &&
        (call.specifier === null ||
          call.specifier.startsWith('../../../support/')),
    )
    .flatMap((call) => {
      const module =
        call.specifier === null
          ? predecessor
          : repositoryPath(predecessor, call.specifier);
      const lines = helperExpectLines(
        module,
        call.name,
        call.specifier === null ? source : undefined,
      );
      return lines.map(({ line }) => ({
        kind: 'inherited',
        line,
        helper: call.name,
        call: call.line,
      }));
    });
  const direct = assertionLines(source, from, to).map((line) => ({
    kind: 'direct',
    line,
  }));
  const key = (site) =>
    site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
  return [...inherited, ...direct].sort((a, b) => {
    const [left, right] = [key(a), key(b)];
    return left[0] - right[0] || left[1] - right[1];
  });
}

const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

/** Corrupt the last alphanumeric character of a pinned line's exact text. */
function corrupt(text) {
  const chars = [...text];
  for (let index = chars.length - 1; index >= 0; index--) {
    if (/[A-Za-z0-9]/u.test(chars[index])) {
      const ch = chars[index];
      chars[index] =
        ch === '9'
          ? '8'
          : ch === 'z'
            ? 'y'
            : ch === 'Z'
              ? 'Y'
              : String.fromCharCode(ch.charCodeAt(0) + 1);
      return chars.join('');
    }
  }
  throw new Error(
    `No alphanumeric character to corrupt in ${JSON.stringify(text)}`,
  );
}

/** Every text-level predecessor pin and the direct-site map, independent of the byte hash. */
function assertPredecessorShape(source) {
  expect(source.split('\n')).toHaveLength(447);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  for (const stage of STAGES)
    expect(assertionLines(source, ...stage.span)).toEqual(stage.direct);
  expect(assertionLines(source, ...EXCLUDED_SPAN)).toHaveLength(11);
}

/* -------------------------------------------------------------------------- */
/* Predecessor pins                                                            */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-workflow predecessor pins', () => {
  it('pins the canonical predecessor bytes, the working tree and both shared helpers by SHA-256', () => {
    expect(RETIRED_PREDECESSOR_COMMIT.startsWith('dd0cb53c')).toBe(true);
    expect(sha256(readPredecessor())).toBe(PREDECESSOR_SHA256);
    expect(sha256(read(PREDECESSOR))).toBe(WORKING_TREE_SHA256);
    for (const [path, hash] of Object.entries(SHARED_SHA256))
      expect(digest(path)).toBe(hash);
    const flippedCommit = Buffer.from(readPredecessor());
    flippedCommit[0] ^= 1;
    expect(sha256(flippedCommit)).not.toBe(PREDECESSOR_SHA256);
    const flippedTree = Buffer.from(read(PREDECESSOR));
    flippedTree[0] ^= 1;
    expect(sha256(flippedTree)).not.toBe(WORKING_TREE_SHA256);
    for (const path of Object.keys(SHARED_SHA256)) {
      const shared = Buffer.from(readFileSync(resolve(root, path)));
      shared[0] ^= 1;
      expect(sha256(shared)).not.toBe(SHARED_SHA256[path]);
    }
  });

  it('differs from the working tree only in the line-27 comment', () => {
    const commit = readPredecessor().split('\n');
    const tree = read(PREDECESSOR).split('\n');
    expect(commit).toHaveLength(447);
    expect(tree).toHaveLength(commit.length);
    const diffs = commit
      .map((_, index) => index)
      .filter((index) => commit[index] !== tree[index]);
    expect(diffs).toEqual([26]);
    expect(commit[26].trim().startsWith('//')).toBe(true);
    expect(tree[26].trim().startsWith('//')).toBe(true);
  });

  it('pins the same source, spans and both stages in the contract', async () => {
    const contract = await loadContract();
    expect(contract.PINNED_WORKFLOW_SOURCE).toBe(PREDECESSOR);
    expect(contract.PINNED_WORKFLOW_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.PINNED_WORKFLOW_WORKING_TREE_SHA256).toBe(
      WORKING_TREE_SHA256,
    );
    expect(contract.PINNED_WORKFLOW_SOURCE_LINES).toBe(446);
    expect(contract.PINNED_WORKFLOW_SHARED_SOURCE_SHA256).toEqual(
      SHARED_SHA256,
    );
    const span = ([from, to]) => ({ from, to });
    expect(contract.PINNED_WORKFLOW_SPANS).toEqual({
      seedPinRoom: span(SEED_SPANS[0]),
      seedRepeatJumpPinRoom: span(SEED_SPANS[1]),
      excluded: span(EXCLUDED_SPAN),
      definitions: {
        'pin-jump-unpin': span(STAGES[0].span),
        'repeat-jump': span(STAGES[1].span),
      },
    });
    expect(existsSync(resolve(root, PREDECESSOR))).toBe(true);
  });

  it('maps exactly 11 + 14 direct sites and excludes 402-445', () => {
    assertPredecessorShape(readPredecessor());
    const spans = [...STAGES.map((stage) => stage.span), EXCLUDED_SPAN];
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++)
        expect(
          spans[i][1] < spans[j][0] || spans[j][1] < spans[i][0],
          `spans ${i} and ${j} do not overlap`,
        ).toBe(true);
  });

  it('fails every text pin under an effective in-memory mutation', () => {
    const source = readPredecessor();
    for (const template of TRANSACTION_TEMPLATES)
      expect(source).toContain(template);
    const mutations = Object.entries(LINE_PINS).map(([line, text]) =>
      mutateLine(source, Number(line), (raw) =>
        raw.replace(text, corrupt(text)),
      ),
    );
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source);
      expect(() => assertPredecessorShape(mutated)).toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Helper expansion by binding                                                */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-workflow helper expansion by binding', () => {
  it('expands only the Android branch', async () => {
    const source = readPredecessor();
    const { calls } = importedCalls(source);
    const sheetCall = calls.find(
      (call) => call.name === 'openMessageActionSheet',
    );
    const menuCall = calls.find((call) => call.name === 'clickRowMenuItem');
    expect(sheetCall).toMatchObject({
      line: 226,
      specifier: '../../../support/app.mts',
    });
    expect(menuCall).toMatchObject({
      line: 229,
      specifier: '../../../support/app.mts',
    });
    const lines = source.split('\n');
    expect(lines[224].trim()).toBe('if (isAndroidE2E) {');
    expect(lines[227].trim()).toBe('} else {');

    const contract = await loadContract();
    expect(contract.PINNED_WORKFLOW_EXCLUDED).toEqual([
      {
        helper: 'clickRowMenuItem',
        module: 'e2e/support/app.mts',
        line: 206,
        call: 229,
        reason: 'desktop else branch',
      },
    ]);
    expect(assertionLines(read('e2e/support/app.mts'), 214, 222)).toEqual([
      220,
    ]);

    // A naive expansion that does not know about the `isAndroidE2E` branch
    // follows BOTH `openMessageActionSheet` and `clickRowMenuItem` and counts
    // 27, one more than the contract's hand-pinned, Android-only 26.
    const naive =
      expandDefinition(source, STAGES[0].span).length +
      expandDefinition(source, STAGES[1].span).length;
    expect(naive).toBe(27);
    expect(naive).not.toBe(contract.PINNED_WORKFLOW_ASSERTION_RECORDS);
  });

  it('derives the excluded clickRowMenuItem line from the AST of the pinned app.mts, not by hand', async () => {
    const contract = await loadContract();
    const lines = helperExpectLines(
      'e2e/support/app.mts',
      'clickRowMenuItem',
    ).map((entry) => entry.line);
    expect(lines).toEqual([206]);
    expect(contract.PINNED_WORKFLOW_EXCLUDED[0].line).toBe(lines[0]);
  });

  it('matches the contract sites, identities and helper table exactly', async () => {
    const contract = await loadContract();
    expect(contract.PINNED_WORKFLOW_STAGES.map((entry) => entry.id)).toEqual(
      STAGES.map((stage) => stage.id),
    );
    expect(
      contract.PINNED_WORKFLOW_STAGES.flatMap((entry) => entry.assertions),
    ).toEqual(ALL_IDENTITIES);
    expect(Object.keys(contract.PINNED_WORKFLOW_HELPERS)).toEqual([
      'openMessageActionSheet',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Contract ledger and source fields                                          */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-workflow contract ledger', () => {
  it('owns two stages, 25 direct + 1 inherited = 26 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.PINNED_WORKFLOW_STAGES.map((entry) => entry.id)).toEqual([
      ...contract.PINNED_WORKFLOW_STAGE_IDS,
    ]);
    expect(contract.PINNED_WORKFLOW_ASSERTION_RECORDS).toBe(26);
    expect(contract.PINNED_WORKFLOW_DIRECT).toBe(25);
    expect(contract.PINNED_WORKFLOW_INHERITED).toBe(1);
    expect(contract.PINNED_WORKFLOW_INHERITED_COUNTS).toEqual([1, 0]);
    expect(
      contract.PINNED_WORKFLOW_STAGES.map(
        (entry) => entry.expectedAssertionRecords,
      ),
    ).toEqual([12, 14]);
    expect(new Set(ALL_IDENTITIES).size).toBe(26);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    for (const stage of STAGES) {
      const identities = stage.suffixes.map(
        (suffix) => `pinned-message-workflow.${stage.id}.${suffix}`,
      );
      expect(() =>
        contract.assertPinnedWorkflowRecords(stage.id, identities),
      ).not.toThrow();
      for (const invalid of [
        [],
        identities.slice(0, -1),
        [...identities, identities.at(-1)],
        [...identities].reverse(),
      ])
        expect(() =>
          contract.assertPinnedWorkflowRecords(stage.id, invalid),
        ).toThrow();
    }
    expect(() =>
      contract.pinnedWorkflowAssertion('pin-jump-unpin', 'not-owned'),
    ).toThrow();
    expect(() =>
      contract.pinnedWorkflowAssertion('not-a-stage', 'timeline-visible'),
    ).toThrow();
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertPinnedWorkflowReceiptName } = await loadContract();
    for (const name of [
      'room-open',
      'toolbar-pin-hidden',
      'unpin-target',
      'server-pinned',
      'fillers-sent',
      'pre-flood',
      'at-latest',
    ])
      expect(() => assertPinnedWorkflowReceiptName(name)).not.toThrow();
    for (const name of [
      'timeline-visible',
      'sheet-ready',
      'Server-Pins',
      'a/b',
      '',
      '1abc',
    ])
      expect(() => assertPinnedWorkflowReceiptName(name)).toThrow();
  });

  it('types exactly the predecessor texts and server shapes', async () => {
    const c = await loadContract();
    expect([c.OTHER_BODY, c.PIN_BODY, c.REPEAT_PIN_BODY]).toEqual([
      'just chatting',
      'pin me please',
      'pin me twice please',
    ]);
    expect(c.FILLER_COUNT).toBe(32);
    expect(c.EMPTY_COPY).toBe('No pinned messages in this channel yet.');
    expect([c.PANEL_HEADING, c.CLOSE_LABEL]).toEqual([
      'Pinned messages',
      'Close pinned messages',
    ]);
    expect([c.pinRoomName('r'), c.repeatRoomName('r')]).toEqual([
      'Pin E2E r',
      'Pin Repeat E2E r',
    ]);
    expect([c.fillerBody('r', 31), c.fillerTxn('r', 0)]).toEqual([
      'pin-repeat filler r 31',
      'pin-repeat-filler-r-0',
    ]);
    expect([
      c.pinOtherTxn('r'),
      c.pinTargetTxn('r'),
      c.repeatLeadTxn('r'),
      c.repeatTargetTxn('r'),
    ]).toEqual([
      'pin-other-r',
      'pin-target-r',
      'pin-repeat-lead-r',
      'pin-repeat-target-r',
    ]);
    expect(c.FLASH_LATENCY_MS).toBe(1_500);
    for (const body of [c.PIN_BODY, c.OTHER_BODY])
      expect(
        c.REPEAT_PIN_BODY.includes(body) && body !== c.REPEAT_PIN_BODY,
      ).toBe(false);
    expect(c.fillerBody('r', 3).includes('pin me')).toBe(false);
  });

  it('accepts only the exact arrangements, fillers and converged pins', async () => {
    const c = await loadContract();
    const reader = '@r:localhost';
    const other = '@o:localhost';
    const create = () => ({
      type: 'm.room.create',
      sender: reader,
      event_id: '$create',
      content: {},
    });
    const message = (sender, body, id) => ({
      type: 'm.room.message',
      sender,
      event_id: id,
      content: { msgtype: 'm.text', body },
    });

    const otherEvent = message(reader, c.OTHER_BODY, '$other');
    const targetEvent = message(reader, c.PIN_BODY, '$target');
    const exp1 = { readerId: reader, otherId: '$other', targetId: '$target' };
    expect(() =>
      c.assertPinArrangement(
        [create(), otherEvent, targetEvent],
        undefined,
        exp1,
      ),
    ).not.toThrow();
    expect(() =>
      c.assertPinArrangement(
        [create(), otherEvent, targetEvent],
        { pinned: [] },
        exp1,
      ),
    ).not.toThrow();
    expect(() =>
      c.assertPinArrangement(
        [create(), otherEvent, targetEvent],
        { pinned: ['$target'] },
        exp1,
      ),
    ).toThrow();
    expect(() =>
      c.assertPinArrangement([otherEvent, targetEvent], undefined, exp1),
    ).toThrow();
    expect(() =>
      c.assertPinArrangement(
        [create(), otherEvent, targetEvent, message(reader, 'x', '$x')],
        undefined,
        exp1,
      ),
    ).toThrow();
    expect(() =>
      c.assertPinArrangement(
        [create(), targetEvent, otherEvent],
        undefined,
        exp1,
      ),
    ).toThrow();
    expect(() =>
      c.assertPinArrangement(
        [create(), message(other, c.OTHER_BODY, '$other'), targetEvent],
        undefined,
        exp1,
      ),
    ).toThrow();

    const leadEvent = message(reader, c.OTHER_BODY, '$lead');
    const repeatTargetEvent = message(reader, c.REPEAT_PIN_BODY, '$rtarget');
    const exp2 = { readerId: reader, leadId: '$lead', targetId: '$rtarget' };
    expect(() =>
      c.assertRepeatArrangement(
        [create(), leadEvent, repeatTargetEvent],
        { pinned: ['$rtarget'] },
        exp2,
      ),
    ).not.toThrow();
    expect(() =>
      c.assertRepeatArrangement(
        [create(), leadEvent, repeatTargetEvent],
        { pinned: [] },
        exp2,
      ),
    ).toThrow();
    expect(() =>
      c.assertRepeatArrangement(
        [create(), leadEvent, repeatTargetEvent],
        { pinned: ['$lead'] },
        exp2,
      ),
    ).toThrow();

    const run = 'r';
    const fillerIds = Array.from({ length: 32 }, (_, i) => `$f${i}`);
    const fillers = fillerIds.map((id, i) =>
      message(reader, c.fillerBody(run, i), id),
    );
    const expF = {
      readerId: reader,
      run,
      leadId: '$lead',
      targetId: '$rtarget',
      fillerIds,
    };
    expect(() =>
      c.assertFillers(
        [create(), leadEvent, repeatTargetEvent, ...fillers],
        expF,
      ),
    ).not.toThrow();
    expect(() =>
      c.assertFillers(
        [create(), leadEvent, repeatTargetEvent, ...fillers.slice(0, -1)],
        {
          ...expF,
          fillerIds: fillerIds.slice(0, -1),
        },
      ),
    ).toThrow();
    const extraFillerIds = [...fillerIds, '$f32'];
    const extraFillers = [
      ...fillers,
      message(reader, c.fillerBody(run, 32), '$f32'),
    ];
    expect(() =>
      c.assertFillers(
        [create(), leadEvent, repeatTargetEvent, ...extraFillers],
        {
          ...expF,
          fillerIds: extraFillerIds,
        },
      ),
    ).toThrow();
    const swapped = [...fillers];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(() =>
      c.assertFillers(
        [create(), leadEvent, repeatTargetEvent, ...swapped],
        expF,
      ),
    ).toThrow();
    const otherSender = [...fillers];
    otherSender[0] = message(other, c.fillerBody(run, 0), fillerIds[0]);
    expect(() =>
      c.assertFillers(
        [create(), leadEvent, repeatTargetEvent, ...otherSender],
        expF,
      ),
    ).toThrow();
    expect(() =>
      c.assertFillers([leadEvent, repeatTargetEvent, ...fillers], expF),
    ).toThrow();

    expect(() => c.assertServerPins({ pinned: ['$t'] }, ['$t'])).not.toThrow();
    expect(() => c.assertServerPins({ pinned: [] }, [])).not.toThrow();
    expect(() => c.assertServerPins(undefined, [])).toThrow();
    expect(() => c.assertServerPins({ pinned: ['$t'] }, [])).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only renderer observation (jsdom) [RF-1][RF-4]                        */
/* -------------------------------------------------------------------------- */

const box = (x, y, width, height) => ({ x, y, width, height });
const rect = (b) => ({
  x: b.x,
  y: b.y,
  width: b.width,
  height: b.height,
  left: b.x,
  top: b.y,
  right: b.x + b.width,
  bottom: b.y + b.height,
});
const ZERO_BOX = box(0, 0, 0, 0);
const SCROLL_BOX = box(0, 100, 393, 500);
const OTHER_ROW_BOX = box(8, 110, 377, 20);
const FILLER_ROW_BOX = box(8, 900, 377, 20);
const OVERFLOW_BADGE_BOX = box(300, 10, 16, 16);
const HEADING_BOX = box(0, 0, 200, 24);
const PIN_ROW_BOX = box(8, 64, 377, 65);
const PINNED_UNPIN_BOX = box(337, 74, 44, 44);
const CLOSE_BOX = box(340, 0, 40, 40);
const JUMP_LATEST_BOX = box(100, 650, 150, 40);

const WORKFLOW_TEXTS = {
  roomName: 'Pin E2E r',
  targetBody: 'pin me please',
  lastFillerBody: 'pin-repeat filler r 31',
};

function workflowHtml({ includeTarget = true } = {}) {
  const targetRow = includeTarget
    ? '<div class="msg" data-mid="$target" data-box="target">pin me please</div>'
    : '';
  return `
    <div class="scroll">
      <div class="msg" data-mid="$other" data-box="other">just chatting</div>
      ${targetRow}
      <div class="msg" data-mid="$filler" data-box="filler">pin-repeat filler r 31</div>
    </div>
    <button data-testid="room-actions-overflow"><span class="header-pin__badge">1</span></button>
    <button data-testid="open-pinned" hidden><span class="header-pin__badge">1</span></button>
    <div data-testid="pinned-panel">
      <h2>Pinned messages</h2>
      <div class="pin-item">
        <div data-testid="pinned-item">Pinner - 10:00 - <span class="pin-item__body">pin me please</span></div>
        <button data-testid="pinned-unpin"></button>
      </div>
    </div>
    <button data-testid="pinned-close" aria-label="Close pinned messages"></button>
    <button data-testid="jump-to-latest"></button>`;
}

function workflowWindow(html, { targetBox = box(8, 300, 377, 20) } = {}) {
  const dom = new JSDOM(`<main>${html}</main>`);
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', {
    value: 393,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: 727,
    configurable: true,
  });
  window.matchMedia = (query) => ({ matches: false, media: query });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('.scroll')) return rect(SCROLL_BOX);
    if (this.matches('.msg[data-box="other"]')) return rect(OTHER_ROW_BOX);
    if (this.matches('.msg[data-box="target"]')) return rect(targetBox);
    if (this.matches('.msg[data-box="filler"]')) return rect(FILLER_ROW_BOX);
    if (
      this.matches('[data-testid="room-actions-overflow"] .header-pin__badge')
    )
      return rect(OVERFLOW_BADGE_BOX);
    if (this.matches('[data-testid="open-pinned"] .header-pin__badge'))
      return rect(ZERO_BOX);
    if (this.matches('[data-testid="open-pinned"]')) return rect(ZERO_BOX);
    if (this.matches('h2')) return rect(HEADING_BOX);
    if (this.matches('.pin-item')) return rect(PIN_ROW_BOX);
    if (this.matches('[data-testid="pinned-unpin"]'))
      return rect(PINNED_UNPIN_BOX);
    if (this.matches('[data-testid="pinned-close"]')) return rect(CLOSE_BOX);
    if (this.matches('[data-testid="jump-to-latest"]'))
      return rect(JUMP_LATEST_BOX);
    return rect(ZERO_BOX);
  };
  // jsdom implements no layout: an explicit empty list marks the desktop-only
  // hidden control unrendered, exactly like `max-md:hidden` at Pixel 5.
  window.HTMLElement.prototype.getClientRects = function () {
    return this.matches('[data-testid="open-pinned"]') ||
      this.matches('[data-testid="open-pinned"] .header-pin__badge')
      ? []
      : [this.getBoundingClientRect()];
  };
  window.document.elementFromPoint = (x, y) => {
    const hitTestable = [
      ...window.document.querySelectorAll(
        '[data-testid="pinned-unpin"], [data-testid="jump-to-latest"]',
      ),
    ];
    return (
      hitTestable.find((element) => {
        const elementBox = element.getBoundingClientRect();
        return (
          x >= elementBox.x &&
          x <= elementBox.x + elementBox.width &&
          y >= elementBox.y &&
          y <= elementBox.y + elementBox.height
        );
      }) ?? null
    );
  };
  return window;
}

function evaluateIn(html, expression, options = {}) {
  const window = workflowWindow(html, options);
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

describe('Android pinned-message-workflow read-only renderer observation (jsdom)', () => {
  it('observes the target, badges, panel and jump-to-latest, leaking no text', async () => {
    const contract = await loadContract();
    const { workflowViewExpression } = await loadObserver();
    const view = contract.parseWorkflowView(
      evaluateIn(workflowHtml(), workflowViewExpression(WORKFLOW_TEXTS)),
    );
    expect(view.target).toEqual({ count: 1, inViewport: true });
    expect(view.lastFiller).toEqual({ count: 1, inViewport: false });
    expect(view.badges).toHaveLength(2);
    const overflow = view.badges.find(
      (badge) => badge.host === 'room-actions-overflow',
    );
    expect(overflow).toMatchObject({ text: '1', visible: true });
    expect(view.heading.count).toBe(1);
    expect(view.pinRow).toMatchObject({
      count: 1,
      visible: true,
      bodyIncludes: true,
    });
    expect(view.close.label).toBe('Close pinned messages');
    expect(view.jumpLatest.visible).toBe(true);
    const serialized = JSON.stringify(view);
    for (const leaked of [
      WORKFLOW_TEXTS.targetBody,
      WORKFLOW_TEXTS.lastFillerBody,
      WORKFLOW_TEXTS.roomName,
    ])
      expect(serialized).not.toContain(leaked);

    const removed = contract.parseWorkflowView(
      evaluateIn(
        workflowHtml({ includeTarget: false }),
        workflowViewExpression(WORKFLOW_TEXTS),
      ),
    );
    expect(removed.target).toEqual({ count: 0, inViewport: false });

    const above = contract.parseWorkflowView(
      evaluateIn(workflowHtml(), workflowViewExpression(WORKFLOW_TEXTS), {
        targetBox: box(8, 40, 377, 20),
      }),
    );
    expect(above.target.inViewport).toBe(false);

    const partial = contract.parseWorkflowView(
      evaluateIn(workflowHtml(), workflowViewExpression(WORKFLOW_TEXTS), {
        targetBox: box(8, 95, 377, 20),
      }),
    );
    expect(partial.target.inViewport).toBe(true);
  });

  it('records a trusted click plus a same-tick add/add/remove flash sequence, and enforces a single arm [D5]', async () => {
    const {
      flashRecorderKey,
      armFlashRecorderExpression,
      readFlashRecorderExpression,
    } = await loadObserver();
    const contract = await loadContract();
    const window = workflowWindow(workflowHtml());
    const { document } = window;
    const run = (expression) =>
      JSON.parse(JSON.stringify(runInNewContext(expression, { document })));

    const key = flashRecorderKey(1);
    expect(run(armFlashRecorderExpression(key, 'pin me please'))).toEqual({
      armed: true,
      targetRendered: 1,
      targetFlashing: false,
    });
    expect(() => run(armFlashRecorderExpression(key, 'pin me please'))).toThrow(
      /already armed/u,
    );

    const item = document.querySelector('[data-testid="pinned-item"]');
    item.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // untrusted in jsdom
    const row = [...document.querySelectorAll('.scroll .msg')].find((e) =>
      e.textContent.includes('pin me please'),
    );
    row.classList.remove('msg--flash');
    row.classList.add('msg--flash'); // exactly what flash() does
    await Promise.resolve(); // MutationObserver microtask
    row.classList.remove('msg--flash');
    await Promise.resolve();

    const window1 = contract.parseFlashWindow(
      run(readFlashRecorderExpression(key)),
    );
    expect(window1.events.map((e) => e.kind)).toEqual([
      'click',
      'add',
      'add',
      'remove',
    ]);
    expect(window1.events[0]).toMatchObject({
      itemLabel: 'target',
      trusted: false,
    });
  });

  it('names each flash key uniquely and keeps the recorder passive', async () => {
    const { flashRecorderKey, armFlashRecorderExpression } =
      await loadObserver();
    expect(() => flashRecorderKey(0)).toThrow();
    expect(flashRecorderKey(2)).toBe('__trinityPinnedFlash2');
    const source = armFlashRecorderExpression(
      flashRecorderKey(1),
      'pin me please',
    );
    expect(source).not.toContain('preventDefault');
    expect(source).not.toContain('stopPropagation');
    expect(source).toContain('{ capture: true, passive: true }');
  });
});

/* -------------------------------------------------------------------------- */
/* Asserters and classifier [RF-1][RF-2][RF-4]                                */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-workflow asserters', () => {
  // The probe's measured Pixel 5 view (spec Feasibility probe, items 3-9).
  const probeView = () => ({
    reducedMotion: false,
    namesRoom: true,
    scroll: { count: 1, visible: true },
    target: { count: 1, inViewport: true },
    lastFiller: { count: 1, inViewport: true },
    badges: [
      { host: 'room-actions-overflow', text: '1', visible: true },
      { host: 'open-pinned', text: '1', visible: false },
    ],
    heading: { count: 1 },
    pinRow: {
      count: 1,
      visible: true,
      bodyIncludes: true,
      unpinCount: 1,
      unpinInside: true,
      unpinUnobstructed: true,
    },
    empty: { count: 1, visible: true, exact: true },
    close: { count: 1, label: 'Close pinned messages' },
    openPinned: { count: 1, rendered: false },
    jumpLatest: { count: 1, visible: true, unobstructed: true },
  });
  const probeSheet = () => ({
    dialogs: 1,
    dialogVisible: true,
    pin: { count: 1, visible: true, unobstructed: true },
  });

  it('passes the probe view on every record predicate', async () => {
    const c = await loadContract();
    const v = c.parseWorkflowView(probeView());
    for (const f of [
      c.assertMotionFull,
      c.assertTimelineVisible,
      c.assertTargetRendered,
      c.assertBadgeOne,
      c.assertOpenPinnedHidden,
      c.assertHeadingVisible,
      c.assertPinRowVisible,
      c.assertPinRowBody,
      c.assertTargetInViewport,
      c.assertLastFillerInViewport,
      c.assertUnpinTarget,
      c.assertEmptyCopy,
      c.assertCloseControl,
      c.assertJumpLatestReady,
    ])
      expect(() => f(v)).not.toThrow();
    const sheet = c.parseSheetView(probeSheet());
    expect(() => c.assertSheetReady(sheet)).not.toThrow();
    expect(() => c.assertSheetPinReachable(sheet)).not.toThrow();
    const closedHeading = c.parseWorkflowView({
      ...probeView(),
      heading: { count: 0 },
    });
    expect(() => c.assertHeadingHidden(closedHeading)).not.toThrow();
    const clearedBadges = c.parseWorkflowView({ ...probeView(), badges: [] });
    expect(() => c.assertBadgeCleared(clearedBadges)).not.toThrow();
    const offscreen = c.parseWorkflowView({
      ...probeView(),
      target: { count: 1, inViewport: false },
    });
    expect(() => c.assertTargetOffscreen(offscreen)).not.toThrow();
  });

  it('fails each record boundary', async () => {
    const c = await loadContract();
    const v = (patch) => c.parseWorkflowView({ ...probeView(), ...patch });
    const pinRow = probeView().pinRow;

    expect(() =>
      c.assertBadgeOne(
        v({
          badges: [{ host: 'room-actions-overflow', text: '2', visible: true }],
        }),
      ),
    ).toThrow();
    expect(() =>
      c.assertBadgeOne(
        v({ badges: [{ host: 'open-pinned', text: '1', visible: false }] }),
      ),
    ).toThrow();
    expect(() =>
      c.assertBadgeOne(
        v({
          badges: [
            { host: 'room-actions-overflow', text: '1', visible: false },
          ],
        }),
      ),
    ).toThrow();
    expect(() => c.assertBadgeCleared(v({}))).toThrow();
    expect(() =>
      c.assertOpenPinnedHidden(v({ openPinned: { count: 1, rendered: true } })),
    ).toThrow();
    expect(() =>
      c.assertHeadingVisible(v({ heading: { count: 0 } })),
    ).toThrow();
    expect(() => c.assertHeadingHidden(v({ heading: { count: 1 } }))).toThrow();
    expect(() =>
      c.assertPinRowBody(v({ pinRow: { ...pinRow, bodyIncludes: false } })),
    ).toThrow();
    expect(() =>
      c.assertEmptyCopy(
        v({ empty: { count: 1, visible: true, exact: false } }),
      ),
    ).toThrow();
    expect(() =>
      c.assertEmptyCopy(
        v({ empty: { count: 1, visible: false, exact: true } }),
      ),
    ).toThrow();
    expect(() =>
      c.assertCloseControl(
        v({ close: { count: 1, label: 'Close pinned message' } }),
      ),
    ).toThrow();
    expect(() =>
      c.assertTargetInViewport(v({ target: { count: 1, inViewport: false } })),
    ).toThrow();
    // [RF-4] "not in viewport" also requires the row to be rendered.
    expect(() =>
      c.assertTargetOffscreen(v({ target: { count: 1, inViewport: true } })),
    ).toThrow();
    expect(() =>
      c.assertTargetOffscreen(v({ target: { count: 0, inViewport: false } })),
    ).toThrow();
    expect(() =>
      c.assertLastFillerInViewport(
        v({ lastFiller: { count: 0, inViewport: true } }),
      ),
    ).toThrow();
    expect(() =>
      c.assertUnpinTarget(v({ pinRow: { ...pinRow, unpinCount: 2 } })),
    ).toThrow();
    expect(() =>
      c.assertUnpinTarget(v({ pinRow: { ...pinRow, unpinInside: false } })),
    ).toThrow();
    expect(() =>
      c.assertUnpinTarget(
        v({ pinRow: { ...pinRow, unpinUnobstructed: false } }),
      ),
    ).toThrow();
    expect(() =>
      c.assertJumpLatestReady(
        v({ jumpLatest: { count: 1, visible: false, unobstructed: true } }),
      ),
    ).toThrow();
    expect(() => c.assertMotionFull(v({ reducedMotion: true }))).toThrow(
      /reduced motion is on; revisit animator_duration_scale \(#755 M5\)/u,
    );

    const twoDialogs = c.parseSheetView({ ...probeSheet(), dialogs: 2 });
    expect(() => c.assertSheetReady(twoDialogs)).toThrow();
    const noPin = c.parseSheetView({
      ...probeSheet(),
      pin: { count: 0, visible: false, unobstructed: false },
    });
    expect(() => c.assertSheetReady(noPin)).toThrow();
    const obstructed = c.parseSheetView({
      ...probeSheet(),
      pin: { ...probeSheet().pin, unobstructed: false },
    });
    expect(() => c.assertSheetPinReachable(obstructed)).toThrow();
  });

  it('classifies a complete jump-flash window and rejects the pre-fix regression [RF-2]', async () => {
    const c = await loadContract();
    const ok = {
      events: [
        {
          kind: 'click',
          at: 1000,
          itemLabel: 'target',
          trusted: true,
          targetInViewport: false,
        },
        { kind: 'add', at: 1023, label: 'target', inViewport: false },
        { kind: 'add', at: 1025, label: 'target', inViewport: false },
        { kind: 'remove', at: 2625, label: 'target', inViewport: true },
      ],
    };
    expect(c.assertJumpFlash(ok, { requireOffscreenAtClick: true })).toEqual({
      latencyMs: 23,
      durationMs: 1602,
      offscreenAtClick: true,
    });
    expect(c.flashWindowComplete(ok)).toBe(true);

    const without = (kind) => ({
      events: ok.events.filter((e) => e.kind !== kind),
    });
    // [RF-2] The pre-fix regression: a trusted click with no `add` at all.
    expect(() =>
      c.assertJumpFlash(without('add'), { requireOffscreenAtClick: false }),
    ).toThrow();
    expect(c.flashWindowComplete(without('add'))).toBe(false);

    const onlyAddBeforeClick = {
      events: [
        { kind: 'add', at: 900, label: 'target', inViewport: false },
        ok.events[0],
        ok.events[3],
      ],
    };
    expect(() =>
      c.assertJumpFlash(onlyAddBeforeClick, { requireOffscreenAtClick: false }),
    ).toThrow();

    const addOnOther = {
      events: [
        ok.events[0],
        { ...ok.events[1], label: 'other' },
        ok.events[2],
        ok.events[3],
      ],
    };
    expect(() =>
      c.assertJumpFlash(addOnOther, { requireOffscreenAtClick: false }),
    ).toThrow();

    const late = {
      events: [
        ok.events[0],
        { ...ok.events[1], at: 1000 + 1_501 },
        ok.events[3],
      ],
    };
    expect(() =>
      c.assertJumpFlash(late, { requireOffscreenAtClick: false }),
    ).toThrow();
    const onBoundary = {
      events: [
        ok.events[0],
        { ...ok.events[1], at: 1000 + 1_500 },
        { ...ok.events[3], at: 1000 + 1_500 + 1 },
      ],
    };
    expect(() =>
      c.assertJumpFlash(onBoundary, { requireOffscreenAtClick: false }),
    ).not.toThrow();

    expect(() =>
      c.assertJumpFlash(without('remove'), { requireOffscreenAtClick: false }),
    ).toThrow();
    expect(c.flashWindowComplete(without('remove'))).toBe(false);

    const untrusted = {
      events: [{ ...ok.events[0], trusted: false }, ok.events[1], ok.events[3]],
    };
    expect(() =>
      c.assertJumpFlash(untrusted, { requireOffscreenAtClick: false }),
    ).toThrow();

    const twoClicks = {
      events: [
        ok.events[0],
        { ...ok.events[0], at: 1001 },
        ok.events[1],
        ok.events[3],
      ],
    };
    expect(() =>
      c.assertJumpFlash(twoClicks, { requireOffscreenAtClick: false }),
    ).toThrow();

    const otherItem = {
      events: [
        { ...ok.events[0], itemLabel: 'other' },
        ok.events[1],
        ok.events[3],
      ],
    };
    expect(() =>
      c.assertJumpFlash(otherItem, { requireOffscreenAtClick: false }),
    ).toThrow();

    const inViewAtClick = {
      events: [
        { ...ok.events[0], targetInViewport: true },
        ok.events[1],
        ok.events[3],
      ],
    };
    expect(() =>
      c.assertJumpFlash(inViewAtClick, { requireOffscreenAtClick: true }),
    ).toThrow();
    expect(() =>
      c.assertJumpFlash(inViewAtClick, { requireOffscreenAtClick: false }),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Diagnostics safety [RF-5]                                                  */
/* -------------------------------------------------------------------------- */

const READER_1 = {
  userId: '@trn_pinreader_0a1b2c:localhost',
  username: 'trn_pinreader_0a1b2c',
  password: 'pin-reader-pass-0a1b2c',
};
const ROOM_1 = { id: '!Pin_Ab+c/d:localhost', name: 'Pin E2E trn-pin-0a1b2cp' };
const OTHER_ID_1 = '$Pin_other';
const TARGET_ID_1 = '$Pin_target';
const RUN_1 = 'trn-pin-0a1b2cp';

const READER_2 = {
  userId: '@trn_pinrepeatreader_1a2b3c:localhost',
  username: 'trn_pinrepeatreader_1a2b3c',
  password: 'pin-repeat-reader-pass-1a2b3c',
};
const ROOM_2 = {
  id: '!PinRepeat_Ef+g/h:localhost',
  name: 'Pin Repeat E2E trn-pinrepeat-1a2b3cpr',
};
const LEAD_ID_2 = '$PinRepeat_lead';
const TARGET_ID_2 = '$PinRepeat_target';
const RUN_2 = 'trn-pinrepeat-1a2b3cpr';
const FILLER_IDS_2 = Array.from(
  { length: 32 },
  (_, i) => `$PinRepeat_filler_${i}`,
);

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

function stageIds(c) {
  const fillerBodies = Array.from({ length: 32 }, (_, i) =>
    c.fillerBody(RUN_2, i),
  );
  const fillerTxns = Array.from({ length: 32 }, (_, i) =>
    c.fillerTxn(RUN_2, i),
  );
  return {
    fillerBodies,
    fillerTxns,
    ids1: {
      accounts: [READER_1],
      rooms: [ROOM_1],
      texts: [ROOM_1.name],
      eventIds: [OTHER_ID_1, TARGET_ID_1],
      transactions: [c.pinOtherTxn(RUN_1), c.pinTargetTxn(RUN_1)],
    },
    ids2: {
      accounts: [READER_2],
      rooms: [ROOM_2],
      texts: [ROOM_2.name, ...fillerBodies],
      eventIds: [LEAD_ID_2, TARGET_ID_2, ...FILLER_IDS_2],
      transactions: [
        c.repeatLeadTxn(RUN_2),
        c.repeatTargetTxn(RUN_2),
        ...fillerTxns,
      ],
    },
  };
}

describe('Android pinned-message-workflow diagnostics safety', () => {
  it('registers every identifier for the two Accounts and two Rooms, excludes the fixed bodies, never the bare server name', async () => {
    const c = await loadContract();
    const { pinnedWorkflowSecrets } = await loadArtifacts();
    const { fillerBodies, fillerTxns, ids1, ids2 } = stageIds(c);
    const secrets1 = pinnedWorkflowSecrets('pin-jump-unpin', ids1);
    const secrets2 = pinnedWorkflowSecrets('repeat-jump', ids2);
    expect(
      Object.keys(secrets1).every((key) =>
        key.startsWith('SECRET_WORKFLOW_PIN_JUMP_UNPIN_'),
      ),
    ).toBe(true);
    expect(
      Object.keys(secrets2).every((key) =>
        key.startsWith('SECRET_WORKFLOW_REPEAT_JUMP_'),
      ),
    ).toBe(true);
    const values = new Set([
      ...Object.values(secrets1),
      ...Object.values(secrets2),
    ]);
    for (const value of [
      READER_1.userId,
      encodeURIComponent(READER_1.userId),
      READER_1.username,
      READER_1.password,
      ROOM_1.id,
      ROOM_1.id.slice(1),
      encodeURIComponent(ROOM_1.id),
      Buffer.from(ROOM_1.id).toString('base64url'),
      ROOM_1.name,
      OTHER_ID_1,
      TARGET_ID_1,
      c.pinOtherTxn(RUN_1),
      c.pinTargetTxn(RUN_1),
      READER_2.userId,
      READER_2.username,
      READER_2.password,
      ROOM_2.id,
      ROOM_2.name,
      LEAD_ID_2,
      TARGET_ID_2,
      c.repeatLeadTxn(RUN_2),
      c.repeatTargetTxn(RUN_2),
      ...fillerBodies,
      ...FILLER_IDS_2,
      ...fillerTxns,
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    for (const fixed of [c.OTHER_BODY, c.PIN_BODY, c.REPEAT_PIN_BODY])
      expect(values.has(fixed)).toBe(false);
    expect(() => pinnedWorkflowSecrets('not-a-stage', ids1)).toThrow();
  });

  it('rejects a leaked filler body, filler transaction id and Room name', async () => {
    const c = await loadContract();
    const { pinnedWorkflowSecrets } = await loadArtifacts();
    const { scanPinnedPanelArtifacts } =
      await import('../e2e/android/pinned-message-panel-artifacts.mts');
    const { fillerBodies, fillerTxns, ids2 } = stageIds(c);
    const secrets = pinnedWorkflowSecrets('repeat-jump', ids2);
    await withOutput('trinity-workflow-scan-', async (output) => {
      await mkdir(join(output, 'repeat-jump'));
      const capture = join(output, 'repeat-jump', 'passed.json');
      for (const unsafe of [
        `body=${fillerBodies[5]}`,
        `txn=${fillerTxns[5]}`,
        `room=${ROOM_2.name}`,
      ]) {
        await writeFile(capture, unsafe);
        await expect(
          scanPinnedPanelArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(capture, '{"ok":true}\n');
      await expect(
        scanPinnedPanelArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried two-stage 26-record Pixel 5 run', async () => {
    const c = await loadContract();
    const artifacts = await loadArtifacts();
    const { PIXEL_5_ACCOUNT_PROFILE, DESKTOP_ACCOUNT_PROFILE } =
      await import('../e2e/android/account-workspace-client.mts');
    const report = () => ({
      status: 'passed',
      expectedStages: 2,
      expectedAssertionRecords: 26,
      attempt: 1,
      retries: 0,
      stages: c.PINNED_WORKFLOW_STAGES.map((entry) => ({
        id: entry.id,
        status: 'passed',
        attempt: 1,
        retries: 0,
        expectedAssertionRecords: entry.expectedAssertionRecords,
        assertionRecords: entry.assertions.length,
        assertions: [...entry.assertions],
        failureCount: 0,
      })),
    });
    const flags = {
      unsafeSecrets: false,
      cleanupFailed: false,
      scrubFailed: false,
    };
    await withOutput('trinity-workflow-gate-', async (output) => {
      const marker = join(output, 'publication-safe');
      const write = (path, value) =>
        writeFile(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
      const provenance = (profile = PIXEL_5_ACCOUNT_PROFILE) => ({
        schemaVersion: 1,
        profile: {
          requested: profile,
          digest: sha256(JSON.stringify(profile)),
        },
      });
      const arrange = async (value = report()) => {
        await write('journeys.json', value);
        await write('runtime-provenance.json', provenance());
        for (const entry of c.PINNED_WORKFLOW_STAGES) {
          await mkdir(join(output, entry.id), { recursive: true });
          await write(join(entry.id, 'profile-applied.json'), {
            requested: PIXEL_5_ACCOUNT_PROFILE,
          });
          for (const name of [
            'passed.json',
            'passed-ui.json',
            'passed-surface.json',
          ])
            await write(join(entry.id, name), { ok: true });
        }
      };
      const refused = async (value, options = {}) => {
        await writeFile(marker, 'stale\n');
        await expect(
          artifacts.markPinnedWorkflowDiagnosticsSafe(
            output,
            options.secrets ?? {},
            options.flags ?? flags,
            options.signal,
            value,
          ),
        ).rejects.toThrow();
        expect(existsSync(marker)).toBe(false);
      };

      await arrange();
      await artifacts.markPinnedWorkflowDiagnosticsSafe(
        output,
        {},
        flags,
        undefined,
        report(),
      );
      expect(await readFile(marker, 'utf8')).toBe('scanned\n');

      const mutate = (change) => {
        const value = report();
        change(value);
        return value;
      };
      for (const invalid of [
        mutate((value) => value.stages.pop()), // one stage
        mutate((value) => {
          value.stages[0].assertions.pop();
          value.stages[0].assertionRecords = 11;
        }), // 25 records
        mutate((value) => {
          const [first, second] = value.stages;
          value.stages[0] = second;
          value.stages[1] = first;
        }), // the two stages swapped
        mutate((value) => (value.retries = 1)), // retries: 1
      ]) {
        await arrange(invalid);
        await refused(invalid);
      }

      await arrange();
      await write(join('pin-jump-unpin', 'profile-applied.json'), {
        requested: DESKTOP_ACCOUNT_PROFILE,
      });
      await refused(report()); // wrong profile in pin-jump-unpin/profile-applied.json

      await arrange();
      await refused(report(), { flags: { ...flags, cleanupFailed: true } });

      await arrange();
      const secrets = artifacts.pinnedWorkflowSecrets('repeat-jump', {
        accounts: [],
        rooms: [],
        texts: [],
        eventIds: [TARGET_ID_2],
        transactions: [],
      });
      await writeFile(
        join(output, 'repeat-jump', 'passed-surface.json'),
        `token=${TARGET_ID_2}`,
      );
      await refused(report(), { secrets }); // an unscrubbed identifier
    });
  });

  it('revokes publication on abort with the exact message', async () => {
    const { revokePinnedWorkflowPublicationOnAbort } = await loadArtifacts();
    await withOutput('trinity-workflow-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokePinnedWorkflowPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokePinnedWorkflowPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before pinned-workflow publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Native journey against a simulated installed app [RF-1][RF-2][RF-3][RF-4] */
/* -------------------------------------------------------------------------- */

const JOURNEYS = 'e2e/android/pinned-message-workflow-journeys.mts';
const OBSERVER_PATH = 'e2e/android/pinned-message-workflow-observer.mts';
const ARTIFACTS_PATH = 'e2e/android/pinned-message-workflow-artifacts.mts';
const CONTRACT_PATH = 'e2e/android/pinned-message-workflow-contract.mts';
const loadJourneys = () =>
  import('../e2e/android/pinned-message-workflow-journeys.mts');

const OVERFLOW_TAP = 'tap:[data-testid="room-actions-overflow"]';
const OPEN_PINNED_TAP = 'tap:[data-testid="overflow-open-pinned"]';
const SHEET_PIN_TAP = 'tap:[data-testid="sheet-pin"]';
const JUMP_TAP = 'tap:[data-testid="pinned-item"]|target';
const UNPIN_TAP = 'tap:[data-testid="pinned-unpin"]|within .pin-item target';
const CLOSE_TAP = 'tap:[data-testid="pinned-close"]';
const JUMP_LATEST_TAP = 'tap:[data-testid="jump-to-latest"]';

const PIN_JUMP_UNPIN_ACTIONS = [
  'reset:393',
  'login',
  'hideKeyboard',
  'tap:[data-testid="rail-rooms"]',
  'tap:.channel|room',
  'longPress:.scroll .msg[data-mid^="$"]|target',
  SHEET_PIN_TAP,
  OVERFLOW_TAP,
  OPEN_PINNED_TAP,
  JUMP_TAP,
  OVERFLOW_TAP,
  OPEN_PINNED_TAP,
  UNPIN_TAP,
  CLOSE_TAP,
];
const REPEAT_JUMP_ACTIONS = [
  'reset:393',
  'login',
  'hideKeyboard',
  'tap:[data-testid="rail-rooms"]',
  'tap:.channel|room',
  OVERFLOW_TAP,
  OPEN_PINNED_TAP,
  JUMP_TAP,
  JUMP_LATEST_TAP,
  OVERFLOW_TAP,
  OPEN_PINNED_TAP,
  JUMP_TAP,
];

/**
 * One minimal simulated installed app: a fake `AccountWorkspaceClient` and
 * `AccountFixtures` pair that drives the real, imported `runPinJumpUnpin` or
 * `runRepeatJump` end to end. `faults` injects exactly one negative control
 * (or, for the anchor-probe row, two combined lag values) at a time.
 *
 * Every derived view/flash/server value is a pure function of `Date.now()`
 * and `state.returns` (plus the fixed action-order array, itself only ever
 * appended to), per the brief's binding rules. Only the SPECIFIC transitions
 * the RF-3 table calls out consult a lag fault; every other rendered value is
 * immediate, so one fault never contaminates an unrelated, later assertion in
 * the same stage run (disclosed in the report: the brief's five "uiLagMs"/
 * "serverLagMs" table rows are implemented as distinctly named fault fields
 * per transition, not one shared field, because a single shared field would
 * also delay later, untested transitions and break their own tighter windows).
 */
async function simulatedWorkflowApp(stageId, faults = {}) {
  const contract = await loadContract();
  const observer = await loadObserver();
  const panelObserver =
    await import('../e2e/android/pinned-message-panel-observer.mts');
  const stage1 = stageId === 'pin-jump-unpin';

  const RUN = stage1 ? RUN_1 : RUN_2;
  const READER = stage1 ? READER_1 : READER_2;
  const ROOM = stage1 ? ROOM_1 : ROOM_2;
  const texts = stage1
    ? {
        roomName: contract.pinRoomName(RUN),
        targetBody: contract.PIN_BODY,
        lastFillerBody: null,
      }
    : {
        roomName: contract.repeatRoomName(RUN),
        targetBody: contract.REPEAT_PIN_BODY,
        lastFillerBody: contract.fillerBody(RUN, contract.FILLER_COUNT - 1),
      };

  const VIEW_EXPR = observer.workflowViewExpression(texts);
  const SHEET_EXPR = observer.sheetViewExpression();
  const PROFILE_EXPR = panelObserver.appliedProfileExpression();
  const ARM_EXPR = new Map();
  const READ_EXPR = new Map();
  for (let n = 1; n <= 4; n++) {
    const key = observer.flashRecorderKey(n);
    ARM_EXPR.set(observer.armFlashRecorderExpression(key, texts.targetBody), n);
    READ_EXPR.set(observer.readFlashRecorderExpression(key), n);
  }

  const controller = new AbortController();
  const state = { actions: [], returns: {}, written: [], fillerSentAt: null };
  const armedKeys = new Set();
  if (faults.preArmedFlashKey)
    armedKeys.add(observer.flashRecorderKey(faults.preArmedFlashKey));
  const flashWindowsByKey = new Map();
  let pendingArmKey = null;
  let pendingArmClickInViewport = null;
  let fillersSeen = 0;

  const label = (text) =>
    text === texts.roomName
      ? 'room'
      : text === texts.targetBody
        ? 'target'
        : text;

  function switched(tapLabel, lagMs) {
    const at = state.returns[tapLabel];
    if (at === undefined) return false;
    return Date.now() - at >= (lagMs ?? 0);
  }

  function currentJumpNumber() {
    return state.actions.filter((a) => a === JUMP_TAP).length;
  }

  function jumpGated(n) {
    return faults.jumpUiLagMsJump === undefined || faults.jumpUiLagMsJump === n;
  }

  function jumpDone() {
    const n = currentJumpNumber();
    if (n === 0) return false;
    return switched(JUMP_TAP, jumpGated(n) ? faults.jumpUiLagMs : undefined);
  }

  function panelOpenNow() {
    const openIdx = state.actions.lastIndexOf(OPEN_PINNED_TAP);
    if (openIdx === -1) return false;
    const jumpIdx = state.actions.lastIndexOf(JUMP_TAP);
    if (jumpIdx === -1 || jumpIdx < openIdx) return true;
    return !jumpDone();
  }

  function floodSettled() {
    if (state.fillerSentAt === null) return false;
    return Date.now() - state.fillerSentAt >= (faults.fillerLagMs ?? 0);
  }

  function fillerServerSettled() {
    if (state.fillerSentAt === null || faults.fillerServerNever) return false;
    return Date.now() - state.fillerSentAt >= (faults.fillerServerLagMs ?? 0);
  }

  function targetInViewportNow() {
    const jumpIdx = state.actions.lastIndexOf(JUMP_TAP);
    const latestIdx = state.actions.lastIndexOf(JUMP_LATEST_TAP);
    if (jumpIdx !== -1 && jumpIdx > latestIdx) {
      if (faults.secondJumpRegression && currentJumpNumber() === 2)
        return false;
      return jumpDone();
    }
    if (latestIdx !== -1)
      return (
        !switched(JUMP_LATEST_TAP, faults.jumpLatestUiLagMs) ||
        !!faults.targetInViewAtLatest
      );
    if (stage1) return true;
    return !floodSettled() || !!faults.targetInViewAfterFlood;
  }

  function targetRenderedNow() {
    if (faults.targetRemovedAfterFlood && floodSettled()) return false;
    return true;
  }

  function badgesNow() {
    if (!stage1)
      return [
        {
          host: 'room-actions-overflow',
          text: faults.badgeTwo ? '2' : '1',
          visible: true,
        },
      ];
    const pinnedUi = switched(SHEET_PIN_TAP, faults.badgeUiLagMs);
    if (!pinnedUi) return [];
    const clearedUi =
      !faults.badgeLeftAfterClose && switched(CLOSE_TAP, faults.closeUiLagMs);
    if (clearedUi) return [];
    return [
      {
        host: 'room-actions-overflow',
        text: faults.badgeTwo ? '2' : '1',
        visible: true,
      },
    ];
  }

  function pinRowNow() {
    const gone = {
      count: 0,
      visible: false,
      bodyIncludes: false,
      unpinCount: 0,
      unpinInside: false,
      unpinUnobstructed: false,
    };
    if (!panelOpenNow()) return gone;
    if (stage1 && switched(UNPIN_TAP, faults.unpinUiLagMs)) return gone;
    return {
      count: 1,
      visible: true,
      bodyIncludes: !faults.pinRowNoBody,
      unpinCount: 1,
      unpinInside: !faults.unpinOutsideRow,
      unpinUnobstructed: !faults.unpinObstructed,
    };
  }

  function emptyNow() {
    if (!stage1 || !switched(UNPIN_TAP, faults.unpinUiLagMs))
      return { count: 0, visible: false, exact: false };
    return { count: 1, visible: true, exact: !faults.emptyCopyWrong };
  }

  function closeNow() {
    if (!stage1 || !switched(UNPIN_TAP, faults.unpinUiLagMs))
      return { count: 0, label: null };
    return { count: 1, label: contract.CLOSE_LABEL };
  }

  function lastFillerNow() {
    const settled = floodSettled();
    return {
      count: settled ? 1 : 0,
      inViewport: settled && !faults.lastFillerNeverInView,
    };
  }

  function jumpLatestNow() {
    if (stage1 || !floodSettled() || faults.jumpLatestNeverAppears)
      return { count: 0, visible: false, unobstructed: false };
    return { count: 1, visible: true, unobstructed: true };
  }

  function currentView() {
    return {
      reducedMotion: !!faults.reducedMotion,
      namesRoom: true,
      scroll: { count: 1, visible: true },
      target: {
        count: targetRenderedNow() ? 1 : 0,
        inViewport: targetInViewportNow(),
      },
      lastFiller: lastFillerNow(),
      badges: badgesNow(),
      heading: { count: panelOpenNow() ? 1 : 0 },
      pinRow: pinRowNow(),
      empty: emptyNow(),
      close: closeNow(),
      openPinned: { count: 1, rendered: !!faults.openPinnedRendered },
      jumpLatest: jumpLatestNow(),
    };
  }

  function currentSheet() {
    if (faults.sheetMissingPin)
      return {
        dialogs: 1,
        dialogVisible: true,
        pin: { count: 0, visible: false, unobstructed: false },
      };
    if (faults.sheetPinObstructed)
      return {
        dialogs: 1,
        dialogVisible: true,
        pin: { count: 1, visible: true, unobstructed: false },
      };
    return {
      dialogs: 1,
      dialogVisible: true,
      pin: { count: 1, visible: true, unobstructed: true },
    };
  }

  function currentServerPins() {
    if (faults.alreadyPinned) return [TARGET_ID_1];
    const pinnedOk =
      switched(SHEET_PIN_TAP, faults.pinServerLagMs) && !faults.pinServerNever;
    if (!pinnedOk) return [];
    const unpinnedOk =
      switched(UNPIN_TAP, faults.unpinServerLagMs) && !faults.unpinServerNever;
    if (unpinnedOk) return [];
    return [TARGET_ID_1];
  }

  const STAGE1_BODIES = new Map([
    [contract.OTHER_BODY, OTHER_ID_1],
    [contract.PIN_BODY, TARGET_ID_1],
  ]);
  const STAGE2_BODIES = new Map([
    [contract.OTHER_BODY, LEAD_ID_2],
    [contract.REPEAT_PIN_BODY, TARGET_ID_2],
  ]);
  for (let i = 0; i < contract.FILLER_COUNT; i++)
    STAGE2_BODIES.set(contract.fillerBody(RUN_2, i), FILLER_IDS_2[i]);

  function advance() {
    vi.setSystemTime(Date.now() + 1_000);
  }

  const client = {
    signal: controller.signal,
    webview: {
      diagnostics: {
        send: async (_method, { expression }) => {
          vi.setSystemTime(Date.now() + (faults.readMs ?? 1_000));
          if (expression === VIEW_EXPR)
            return { result: { value: currentView() } };
          if (expression === SHEET_EXPR)
            return { result: { value: currentSheet() } };
          if (expression === PROFILE_EXPR)
            return {
              result: {
                value: {
                  innerWidth: 393,
                  innerHeight: 727,
                  devicePixelRatio: 2.75,
                  coarsePointer: true,
                  hoverNone: true,
                  platform: 'android',
                },
              },
            };
          if (ARM_EXPR.has(expression)) {
            const n = ARM_EXPR.get(expression);
            const key = observer.flashRecorderKey(n);
            if (armedKeys.has(key))
              throw new Error(`Flash recorder already armed: ${key}`);
            armedKeys.add(key);
            pendingArmKey = key;
            pendingArmClickInViewport = targetInViewportNow();
            return {
              result: {
                value: {
                  armed: true,
                  targetRendered: targetRenderedNow() ? 1 : 0,
                  targetFlashing: false,
                },
              },
            };
          }
          if (READ_EXPR.has(expression)) {
            const n = READ_EXPR.get(expression);
            const key = observer.flashRecorderKey(n);
            const win = flashWindowsByKey.get(key);
            if (!win) return { result: { value: { events: [] } } };
            const suppressAdd =
              (stage1 && faults.flashNoAdd && n === 1) ||
              (!stage1 && faults.secondJumpRegression && n === 2);
            const clickInViewport =
              !stage1 && faults.secondJumpClickInView && n === 2
                ? true
                : win.clickInViewport;
            const events = [
              {
                kind: 'click',
                at: win.tapAt,
                itemLabel: 'target',
                trusted: true,
                targetInViewport: clickInViewport,
              },
            ];
            if (!suppressAdd) {
              events.push({
                kind: 'add',
                at: win.tapAt + 23,
                label: 'target',
                inViewport: clickInViewport,
              });
              if (
                switched(JUMP_TAP, faults.flashRemoveLagMs) ||
                win.tapAt !== state.returns[JUMP_TAP]
              )
                events.push({
                  kind: 'remove',
                  at: Date.now(),
                  label: 'target',
                  inViewport: true,
                });
            }
            return { result: { value: { events } } };
          }
          throw new Error(`Unmodelled simulated evaluate: ${expression}`);
        },
      },
    },
    async reset(profile) {
      state.actions.push(`reset:${profile.width}`);
    },
    async login() {
      state.actions.push('login');
    },
    async hideKeyboard() {
      state.actions.push('hideKeyboard');
    },
    async visible(_selector, filter = {}) {
      return {
        text: filter.text ?? '',
        visible: true,
        rect: { x: 0, y: 0, width: 10, height: 10, bottom: 10, right: 10 },
      };
    },
    async tapCurrent(selector, filter = {}) {
      const key = filter.within
        ? `tap:${selector}|within ${filter.within.selector} ${label(filter.within.text)}`
        : `tap:${selector}${filter.text !== undefined ? `|${label(filter.text)}` : ''}`;
      state.actions.push(key);
      vi.setSystemTime(Date.now() + (faults.tapMs ?? 1_000));
      state.returns[key] = Date.now();
      if (key === JUMP_TAP && pendingArmKey) {
        flashWindowsByKey.set(pendingArmKey, {
          tapAt: state.returns[key],
          clickInViewport: pendingArmClickInViewport,
        });
        pendingArmKey = null;
      }
    },
    async longPressCurrent(selector, filter = {}) {
      const key = `longPress:${selector}${filter.text !== undefined ? `|${label(filter.text)}` : ''}`;
      state.actions.push(key);
      vi.setSystemTime(Date.now() + (faults.tapMs ?? 1_000));
      state.returns[key] = Date.now();
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture() {},
  };

  const fixtures = {
    async account() {
      return { ...READER };
    },
    async createRoom(_account, content) {
      return { id: ROOM.id, name: content.name };
    },
    async sendMessage(_account, _roomId, body) {
      const bodies = stage1 ? STAGE1_BODIES : STAGE2_BODIES;
      const id = bodies.get(body);
      if (id === undefined)
        throw new Error(`Unmodelled simulated sendMessage body ${body}`);
      if (!stage1 && body.startsWith('pin-repeat filler')) {
        fillersSeen++;
        if (fillersSeen === contract.FILLER_COUNT && !faults.fillerNeverSettles)
          state.fillerSentAt = Date.now();
      }
      return id;
    },
    async setRoomState() {},
    async roomState() {
      advance();
      if (stage1) return { pinned: currentServerPins() };
      return { pinned: [TARGET_ID_2] };
    },
    async roomMessages() {
      advance();
      const create = {
        type: 'm.room.create',
        event_id: '$create',
        room_id: ROOM.id,
        sender: READER.userId,
        state_key: '',
        content: {},
      };
      if (stage1) {
        return {
          chunk: [
            create,
            {
              type: 'm.room.message',
              event_id: TARGET_ID_1,
              room_id: ROOM.id,
              sender: READER.userId,
              content: { msgtype: 'm.text', body: contract.PIN_BODY },
            },
            {
              type: 'm.room.message',
              event_id: OTHER_ID_1,
              room_id: ROOM.id,
              sender: READER.userId,
              content: { msgtype: 'm.text', body: contract.OTHER_BODY },
            },
          ],
          start: 's',
          end: 'e',
        };
      }
      const fillerCount = faults.fillerDropOne
        ? contract.FILLER_COUNT - 1
        : contract.FILLER_COUNT;
      const fillerEvents = fillerServerSettled()
        ? Array.from({ length: fillerCount }, (_, i) => ({
            type: 'm.room.message',
            event_id: FILLER_IDS_2[i],
            room_id: ROOM.id,
            sender: READER.userId,
            content: { msgtype: 'm.text', body: contract.fillerBody(RUN_2, i) },
          })).reverse()
        : [];
      return {
        chunk: [
          create,
          ...fillerEvents,
          {
            type: 'm.room.message',
            event_id: TARGET_ID_2,
            room_id: ROOM.id,
            sender: READER.userId,
            content: { msgtype: 'm.text', body: contract.REPEAT_PIN_BODY },
          },
          {
            type: 'm.room.message',
            event_id: LEAD_ID_2,
            room_id: ROOM.id,
            sender: READER.userId,
            content: { msgtype: 'm.text', body: contract.OTHER_BODY },
          },
        ],
        start: 's',
        end: 'e',
      };
    },
  };

  return { client, fixtures, state, controller, texts };
}

/** Builds one simulated stage context and cleans up its real temp directory. */
async function withSimulatedWorkflowStage(stageId, faults, run) {
  const { PINNED_WORKFLOW_STAGES } = await loadContract();
  const directory = await mkdtemp(join(tmpdir(), 'trinity-workflow-journey-'));
  try {
    const app = await simulatedWorkflowApp(stageId, faults);
    const entry = PINNED_WORKFLOW_STAGES.find((e) => e.id === stageId);
    const context = {
      entry,
      records: [],
      identities: new Set(),
      receipts: 0,
      client: app.client,
      fixtures: app.fixtures,
      secrets: {},
      safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
      native: false,
      directory,
      signal: app.controller.signal,
      flashWindows: 0,
      ledger: {
        run: RUN_1,
        accounts: [],
        rooms: [],
        texts: [],
        eventIds: [],
        transactions: [],
      },
    };
    if (stageId === 'repeat-jump') context.ledger.run = RUN_2;
    return await run({ context, state: app.state });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Android pinned-message-workflow native journey against a simulated installed app', () => {
  it('drives the exact native sequence and records all twelve identities in order [pin-jump-unpin]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      {},
      async ({ context, state }) => {
        await runPinJumpUnpin(context);
        expect(state.actions).toEqual(PIN_JUMP_UNPIN_ACTIONS);
        expect(context.records).toEqual(
          [
            'timeline-visible',
            'sheet-ready',
            'badge-one',
            'panel-heading-visible',
            'pin-row-visible',
            'pin-row-body',
            'jump-flash',
            'panel-closed-by-jump',
            'target-in-viewport',
            'panel-reopened',
            'empty-copy-visible',
            'badge-cleared',
          ].map((s) => `pinned-message-workflow.pin-jump-unpin.${s}`),
        );
      },
    );
  }, 20_000);

  it('drives the exact native sequence and records all fourteen identities in order [repeat-jump]', async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      {},
      async ({ context, state }) => {
        await runRepeatJump(context);
        expect(state.actions).toEqual(REPEAT_JUMP_ACTIONS);
        expect(context.records).toEqual(
          [
            'timeline-visible',
            'last-filler-in-viewport',
            'target-offscreen',
            'first-heading-visible',
            'first-pin-row-visible',
            'first-flash',
            'first-panel-closed',
            'first-target-in-viewport',
            'target-offscreen-at-latest',
            'second-heading-visible',
            'second-pin-row-visible',
            'second-flash',
            'second-panel-closed',
            'second-target-in-viewport',
          ].map((s) => `pinned-message-workflow.repeat-jump.${s}`),
        );
      },
    );
  }, 20_000);

  it('rejects before any native action when the arranged pins are already published [pin-jump-unpin]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { alreadyPinned: true },
      async ({ context, state }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /No pin exists before the native pin/u,
        );
        expect(state.actions).toEqual([]);
      },
    );
  });

  it('fails closed if reduced motion is on, after reset only [Q7]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { reducedMotion: true },
      async ({ context, state }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /reduced motion is on/u,
        );
        expect(state.actions).toEqual(['reset:393']);
      },
    );
  });

  it('fails closed when open-pinned is rendered at Pixel 5 [revisit D3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { openPinnedRendered: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(/revisit D3/u);
      },
    );
  });

  it('fails closed when the sheet never grows a sheet-pin control', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { sheetMissingPin: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(/sheet-pin/u);
      },
    );
  }, 20_000);

  it('fails closed when the badge reads 2 instead of 1', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { badgeTwo: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(/badge/u);
      },
    );
  }, 20_000);

  it('rejects when the server never pins', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { pinServerNever: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /server pinned state/u,
        );
      },
    );
  }, 20_000);

  it('rejects when the server never unpins', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { unpinServerNever: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /server pinned state/u,
        );
      },
    );
  }, 20_000);

  it('fails closed when the pin row never shows the target body', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { pinRowNoBody: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /pin row.s body/u,
        );
      },
    );
  }, 20_000);

  it('fails closed when the empty copy is not exact [trailing period]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { emptyCopyWrong: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /empty-copy text is visible and exact/u,
        );
      },
    );
  }, 20_000);

  it('fails closed when a pin badge is left after the close tap', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { badgeLeftAfterClose: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /No pin badge remains/u,
        );
      },
    );
  }, 20_000);

  it('fails closed when the jump flash window has no add [flashed the target]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'pin-jump-unpin',
      { flashNoAdd: true },
      async ({ context }) => {
        await expect(runPinJumpUnpin(context)).rejects.toThrow(
          /flashed the target/u,
        );
      },
    );
  }, 20_000);

  it('rejects when the /messages page never grows the 32nd filler [Exactly 32]', async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { fillerDropOne: true },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(/Exactly 32/u);
      },
    );
  }, 20_000);

  it('fails closed when the target row is removed from the DOM after the flood [RF-4]', async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { targetRemovedAfterFlood: true },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(
          /target row is rendered/u,
        );
      },
    );
  }, 20_000);

  it('fails closed when the target is still in view after the flood [offscreen]', async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { targetInViewAfterFlood: true },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(
          /out of the viewport/u,
        );
      },
    );
  }, 20_000);

  it('fails closed when the target is still in view after jump-to-latest [offscreen]', async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { targetInViewAtLatest: true },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(
          /out of the viewport/u,
        );
      },
    );
  }, 20_000);

  it('rejects a server that converges 31 s after the tap when every read burns 10 s [RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, readMs: 10_000, pinServerLagMs: 31_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(
            /server pinned state/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('fails closed when jump-to-latest never appears [revisit D3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { jumpLatestNeverAppears: true },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(
          /jump-to-latest control exists/u,
        );
      },
    );
  }, 20_000);

  // [RF-2] The repeat-jump regression: jump 2's evidence is independent of jump 1's.
  it('fails closed when the second jump has no add and the view keeps the target offscreen [RF-2 regression fake]', async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { secondJumpRegression: true },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(
          /flashed the target/u,
        );
      },
    );
  }, 20_000);

  it("fails closed when the second jump's trusted click is observed in view [RF-2]", async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { secondJumpClickInView: true },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(
          /offscreen at the trusted click/u,
        );
      },
    );
  }, 20_000);

  it("throws already armed if the second jump were to reuse the first jump's flash key [RF-2 window reuse]", async () => {
    const { runRepeatJump } = await loadJourneys();
    await withSimulatedWorkflowStage(
      'repeat-jump',
      { preArmedFlashKey: 2 },
      async ({ context }) => {
        await expect(runRepeatJump(context)).rejects.toThrow(/already armed/u);
      },
    );
  }, 20_000);

  /* RF-3 window pairs: each with tapMs 45_000, one passing and one failing case. */

  it('anchors the badge window at the sheet-pin tap: passes at 25 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, badgeUiLagMs: 25_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects the badge window past 31 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, badgeUiLagMs: 31_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(/badge/u);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('the server-pinned window converges at 15 s, well inside 30 s from the tap [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, pinServerLagMs: 15_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects when the server never pins, within the 30 s window [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, pinServerNever: true },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(
            /server pinned state/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects a server convergence that misses the window measured from the tap, even though it beats a fresh 30 s from the poll [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, badgeUiLagMs: 25_000, pinServerLagMs: 34_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(
            /server pinned state/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('anchors the stage-1 jump window at the jump tap: passes at 15 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, jumpUiLagMs: 15_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects the stage-1 jump window past 21 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, jumpUiLagMs: 21_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(
            /heading is hidden|viewport/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('the flash-remove window clears within 15 s of the jump [RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, flashRemoveLagMs: 15_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects when the flash never clears itself [RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, flashRemoveLagMs: Number.POSITIVE_INFINITY },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(
            /cleared itself/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('anchors the empty-copy window at the unpin tap: passes at 25 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, unpinUiLagMs: 25_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects the empty-copy window past 31 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, unpinUiLagMs: 31_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(
            /empty-copy element exists|visible and exact/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('the server-unpinned window converges at 15 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, unpinServerLagMs: 15_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects when the server never unpins, within the window [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, unpinServerNever: true },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(
            /server pinned state/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('anchors the badge-cleared window at the close tap: passes at 25 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, closeUiLagMs: 25_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('rejects the badge-cleared window past 31 s [RF-1][RF-3]', async () => {
    const { runPinJumpUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'pin-jump-unpin',
        { tapMs: 45_000, closeUiLagMs: 31_000 },
        async ({ context }) => {
          await expect(runPinJumpUnpin(context)).rejects.toThrow(/badge/u);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 25_000);

  it('the last-filler-in-viewport window resolves at 25 s [RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, fillerLagMs: 25_000 },
        async ({ context }) => {
          await expect(runRepeatJump(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('rejects the last-filler-in-viewport window past 31 s [RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, fillerLagMs: 31_000 },
        async ({ context }) => {
          await expect(runRepeatJump(context)).rejects.toThrow(/last filler/u);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('the /messages 32-filler window converges at 15 s [RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, fillerServerLagMs: 15_000 },
        async ({ context }) => {
          await expect(runRepeatJump(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('rejects when /messages never shows all 32 fillers [RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, fillerServerNever: true },
        async ({ context }) => {
          await expect(runRepeatJump(context)).rejects.toThrow(/Exactly 32/u);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('anchors the jump-to-latest offscreen window at its own tap: passes at 15 s [RF-1][RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, jumpLatestUiLagMs: 15_000 },
        async ({ context }) => {
          await expect(runRepeatJump(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('rejects the jump-to-latest offscreen window past 21 s [RF-1][RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, jumpLatestUiLagMs: 21_000 },
        async ({ context }) => {
          await expect(runRepeatJump(context)).rejects.toThrow(
            /out of the viewport/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('anchors the second-jump window at its own tap, independent of the first jump: passes at 15 s [RF-1][RF-2][RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, jumpUiLagMs: 15_000, jumpUiLagMsJump: 2 },
        async ({ context }) => {
          await expect(runRepeatJump(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('rejects the second-jump window past 21 s, while the first jump is unaffected [RF-1][RF-2][RF-3]', async () => {
    const { runRepeatJump } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedWorkflowStage(
        'repeat-jump',
        { tapMs: 45_000, jumpUiLagMs: 21_000, jumpUiLagMsJump: 2 },
        async ({ context }) => {
          await expect(runRepeatJump(context)).rejects.toThrow(
            /heading is hidden|viewport/u,
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

/* -------------------------------------------------------------------------- */
/* Teardown and redaction guards [RF-5]                                       */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-workflow teardown and redaction guards [RF-5]', () => {
  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { pinnedWorkflowSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = pinnedWorkflowSecrets('pin-jump-unpin', {
      accounts: [READER_1],
      rooms: [ROOM_1],
      texts: [ROOM_1.name],
      eventIds: [OTHER_ID_1, TARGET_ID_1],
      transactions: [
        (await loadContract()).pinOtherTxn(RUN_1),
        (await loadContract()).pinTargetTxn(RUN_1),
      ],
    });
    const segment = Buffer.from(ROOM_1.id).toString('base64url');
    const OTHER_EXPECTED = '$Pin_expected';
    const failure = new AssertionError({
      actual: TARGET_ID_1,
      expected: OTHER_EXPECTED,
      operator: 'strictEqual',
      message: 'The target message has the arranged event id',
    });
    const leaked = new Error(
      `GET /rooms/${encodeURIComponent(ROOM_1.id)}/messages for ${READER_1.userId} at /rooms/${segment} on ${TARGET_ID_1}`,
    );
    const error = redactStageFailure(
      'pin-jump-unpin',
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain(
      'Android pinned-message-workflow pin-jump-unpin failed',
    );
    expect(error.message).toContain(
      'The target message has the arranged event id',
    );
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ROOM_1.id,
      encodeURIComponent(ROOM_1.id),
      segment,
      TARGET_ID_1,
      READER_1.userId,
      ROOM_1.name,
    ])
      expect(error.message).not.toContain(value);
    const [firstLine, ...appended] = failure.message.split('\n');
    expect(firstLine).toBe('The target message has the arranged event id');
    expect(appended.join('\n').trim()).not.toBe('');
    expect(error.message.split('\n')).toContain(`AssertionError: ${firstLine}`);
    for (const fragment of appended.map((line) => line.trim()))
      if (fragment.length >= 3) expect(error.message).not.toContain(fragment);
    expect(error.message).not.toContain(OTHER_EXPECTED);
    expect(error.message).not.toContain('actual');
    const unregistered = '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4';
    const shaped = redactStageFailure(
      'pin-jump-unpin',
      [
        new Error(`Event ${unregistered} already in timeline`),
        (() => {
          try {
            assert.equal(unregistered, OTHER_EXPECTED);
          } catch (generated) {
            return generated;
          }
        })(),
        (() => {
          try {
            assert.deepEqual({ event_id: '$x' }, { event_id: '$y' }, 'Fields');
          } catch (diffed) {
            return diffed;
          }
        })(),
      ],
      {},
    );
    expect(shaped.message).toBe(
      'Android pinned-message-workflow pin-jump-unpin failed\nError: Event [REDACTED] already in timeline\nAssertionError: strictEqual assertion failed\nAssertionError: Fields',
    );
    const cleanup = redactCleanupFailure(
      'fixtures',
      Object.assign(new Error(`leave ${ROOM_1.id}`), { status: 403 }),
    );
    expect(cleanup.message).toBe(
      'Pinned-message-workflow cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(
      journey.split('throw redactStageFailure(entry.id, failures, secrets);'),
    ).toHaveLength(2);
    expect(journey).not.toMatch(/throw failures/u);
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
    expect(journey).not.toMatch(/throw failures\[0\]/u);
    const guardStart = journey.indexOf(
      'export function guardPinnedWorkflowCleanup',
    );
    expect(guardStart).toBeGreaterThan(-1);
    const guardBody = journey.slice(
      guardStart,
      journey.indexOf('\n}', guardStart),
    );
    expect(guardBody).toContain('throw redactCleanupFailure(label, error);');
    expect(guardBody).not.toMatch(/throw error;/u);
    expect(
      redactStageFailure('pin-jump-unpin', [leaked], {}).message,
    ).toContain(TARGET_ID_1);
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardPinnedWorkflowCleanup } = await loadJourneys();
    const registered = [];
    const state = {
      safety: {
        unsafeSecrets: false,
        cleanupFailed: false,
        scrubFailed: false,
      },
      report: {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      },
      saves: 0,
      async save() {
        this.saves++;
      },
    };
    const guarded = guardPinnedWorkflowCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ROOM_1.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Pinned-message-workflow cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.report.stages[0].error).toContain(ROOM_1.id);
    expect(state.saves).toBe(1);
    const early = { ...state, report: { status: 'running', stages: [] } };
    const later = [];
    guardPinnedWorkflowCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it("runs close then clear through the runner's own finishPinnedWorkflowStage call, even when close throws [RF-5][I1]", async () => {
    const { finishPinnedWorkflowStage } = await loadJourneys();
    const order = [];
    const client = {
      close: async () => {
        order.push('close');
        throw new Error('close');
      },
    };
    const device = {
      clearApplicationData: async (id) => {
        order.push(`clear:${id}`);
      },
    };
    const failures = [];
    const cleanupFailed = await finishPinnedWorkflowStage(
      client,
      device,
      failures,
    );
    expect(order).toEqual(['close', 'clear:eu.qwky.trinity']);
    expect(failures).toHaveLength(1);
    expect(cleanupFailed).toBe(true);
  });

  it('reports no cleanup failure when both teardown steps succeed [I1]', async () => {
    const { finishPinnedWorkflowStage } = await loadJourneys();
    const client = { close: async () => {} };
    const device = { clearApplicationData: async () => {} };
    const failures = [];
    const cleanupFailed = await finishPinnedWorkflowStage(
      client,
      device,
      failures,
    );
    expect(failures).toHaveLength(0);
    expect(cleanupFailed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Source rules: journeys, observer and artifacts                            */
/* -------------------------------------------------------------------------- */

const WORKFLOW_FORBIDDEN_TOKENS = [
  ['.click(', /\.click\(/u],
  ['.focus(', /\.focus\(/u],
  ['dispatchEvent', /dispatchEvent/u],
  ['scrollIntoView', /scrollIntoView/u],
  ['scrollTo(', /\.scrollTo\(/u],
  ['setViewportSize', /setViewportSize/u],
  ['value write', /\.value\s*=(?!=)|setRangeText|insertText/u],
  [
    'classList mutation',
    /classList\.(?:add|remove|toggle|replace)\(|className\s*=(?!=)/u,
  ],
  ['setAttribute', /setAttribute|removeAttribute|toggleAttribute/u],
  [
    '.style. write',
    /\.style\.[\w-]+\s*=(?!=)|\.style\.(?:setProperty|removeProperty)\(|\.style\s*=(?!=)/u,
  ],
  ['location =', /(?:window|self|document)\.location\s*=(?!=)/u],
  ['location.assign', /location\.(?:assign|replace)\(/u],
  ['location.', /\blocation\./u],
  ['scrollTop =', /scrollTop\s*=(?!=)/u],
  ['history.', /\bhistory\./u],
  ['Input.dispatch', /Input\.dispatch/u],
  ['input_method', /input_method/u],
  ['dumpsys', /dumpsys/u],
  ['non-zero retries', /retries:(?!\s*0\b)/u],
  [
    'CSS class or screenshot paint',
    /classList\.contains\(['"](?:border|shadow|bg-)|shadow-overlay|\.screenshot\(|toHaveScreenshot|captureScreenshot/u,
  ],
  ['jumpTo(', /\bjumpTo\(/u],
  ['unpin(', /\bunpin\(/u],
  ['togglePin', /togglePin/u],
  ['scrollToLatest(', /scrollToLatest\(/u],
  ['openPinnedPanel(', /openPinnedPanel\(/u],
  ['preventDefault', /preventDefault/u],
  ['stopPropagation', /stopPropagation/u],
  ['SharedStageAccount', /new SharedStageAccount\(/u],
];

function assertNoWorkflowForbiddenTokens(source, name) {
  for (const [token, pattern] of WORKFLOW_FORBIDDEN_TOKENS)
    expect(pattern.test(source), `${name} must not contain ${token}`).toBe(
      false,
    );
  const stripped = source.split("'pinned-unpin'").join('');
  expect(
    /\bunpin\(/u.test(stripped),
    `${name} must not call unpin( outside 'pinned-unpin'`,
  ).toBe(false);
}

function assertWorkflowReadOnlyObserver(source) {
  expect(source).not.toMatch(
    /\.(?:click|focus|blur|dispatchEvent|scrollIntoView|scrollTo|scrollBy|submit|requestSubmit|select|setSelectionRange)\s*\(/u,
  );
  expect(source).not.toMatch(
    /(?:\.scrollTop|\.scrollLeft|\.value|\.selectionStart|\.selectionEnd|\.innerHTML|\.textContent|\.style\.[\w]+)\s*=(?!=)/u,
  );
  expect(source).not.toMatch(
    /Input\.dispatch|\.goto\s*\(|window\.location\s*=|location\.assign\s*\(|\.style\.(?:setProperty|removeProperty)\s*\(|appendChild|insertBefore|replaceChildren/u,
  );
}

/** Every `waitForNativeShellState` call carries an explicit finite bound argument. */
function assertWorkflowBoundedWaits(source, name) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText(tree).split('.').at(-1);
      if (called === 'waitForNativeShellState') {
        const bound = node.arguments[4];
        expect(
          bound,
          `${name}: ${node.getText(tree).slice(0, 80)} is bounded`,
        ).toBeDefined();
        expect(bound.getText(tree)).not.toMatch(/Infinity|undefined/u);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/**
 * RF-3's static counterpart: every native tap or long-press in the journeys is
 * immediately followed (within the next three statements) by a `Date.now()`
 * capture, or by a helper call whose own body takes one (matched textually,
 * as the brief directs, rather than by full call-graph resolution).
 */
function assertTapsAnchorDateNow(source) {
  const lines = source.split('\n');
  const isStatementLine = (line) => {
    const t = line.trim();
    return (
      t.length > 0 &&
      !t.startsWith('//') &&
      !t.startsWith('*') &&
      !t.startsWith('/*')
    );
  };
  for (let i = 0; i < lines.length; i++) {
    if (!/\.(tapCurrent|longPressCurrent)\(/u.test(lines[i])) continue;
    let seen = 0;
    let found = false;
    for (let j = i; j < lines.length && seen <= 3; j++) {
      if (!isStatementLine(lines[j])) continue;
      if (j > i) seen++;
      if (/Date\.now\(\)/u.test(lines[j])) {
        found = true;
        break;
      }
      if (seen > 3) break;
    }
    expect(
      found,
      `line ${i + 1} (${lines[i].trim()}) must be followed within 3 statements by a Date.now() capture`,
    ).toBe(true);
  }
}

/** Every elapsed-time bound goes through the clamped `left()` helper, never `BOUND - (Date.now() - t)`. */
function assertElapsedBoundsClamped(source) {
  const unclamped = source
    .split('\n')
    .filter((line) => /-\s*\(Date\.now\(\)\s*-/u.test(line))
    .filter((line) => !line.includes('Math.max('));
  expect(unclamped, 'unclamped elapsed-time bound').toEqual([]);
}

describe('Android pinned-message-workflow source rules', () => {
  it('keeps the journeys, observer and artifacts read-only, bounded, forbidden-token free and tap-anchored', () => {
    for (const path of [
      JOURNEYS,
      CONTRACT_PATH,
      OBSERVER_PATH,
      ARTIFACTS_PATH,
    ]) {
      const source = read(path);
      assertNoWorkflowForbiddenTokens(source, path);
    }
    for (const path of [JOURNEYS, OBSERVER_PATH]) {
      assertWorkflowBoundedWaits(read(path), path);
      assertWorkflowReadOnlyObserver(read(path));
    }
    assertTapsAnchorDateNow(read(JOURNEYS));
    assertElapsedBoundsClamped(read(JOURNEYS));
  });

  it('fails the forbidden-token, read-only, bounded-wait and tap-anchoring rules under each effective mutation', () => {
    const observer = read(OBSERVER_PATH);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'input.value = "x"',
      'element.dispatchEvent(new MouseEvent("click"))',
      'element.scrollIntoView()',
      'element.scrollTo(0, 0)',
      'page.setViewportSize({ width: 1, height: 1 })',
      'device.adb("shell", "dumpsys", "input_method")',
      'surface.classList.add("bg-popover")',
      'surface.setAttribute("style", "background: white")',
      'window.location = "/rooms"',
      'history.pushState({}, "", "/rooms")',
      'const report = { retries: 1 }',
      'client.unpin(eventId)',
      'client.jumpTo(eventId)',
      'panel.togglePin()',
      'view.scrollToLatest()',
      'client.openPinnedPanel()',
      'window.location.href',
      'list.scrollTop = 0',
      'history.back()',
      'event.preventDefault()',
      'event.stopPropagation()',
      'new SharedStageAccount()',
    ])
      expect(() =>
        assertNoWorkflowForbiddenTokens(
          `${observer}\n${mutation}`,
          OBSERVER_PATH,
        ),
      ).toThrow();
    expect(() =>
      assertNoWorkflowForbiddenTokens(observer, OBSERVER_PATH),
    ).not.toThrow();
    for (const mutation of [
      'element.click()',
      'input.focus()',
      'row.scrollTo(0, 0)',
      'input.value = "x"',
      'row.appendChild(node)',
    ])
      expect(() =>
        assertWorkflowReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    expect(() =>
      assertWorkflowBoundedWaits(
        `${observer}\nawait waitForNativeShellState(read, accepts, "x", signal);`,
        OBSERVER_PATH,
      ),
    ).toThrow();
    const journeys = read(JOURNEYS);
    const mutated = journeys.replace(
      'async function tap(context: PinnedWorkflowStageContext, selector: string,\n  filter: AccountElementFilter = {}): Promise<number> {\n  await context.client.tapCurrent(selector, filter);\n  return Date.now();\n}',
      'async function tap(context: PinnedWorkflowStageContext, selector: string,\n  filter: AccountElementFilter = {}): Promise<number> {\n  await context.client.tapCurrent(selector, filter);\n  await Promise.resolve();\n  await Promise.resolve();\n  await Promise.resolve();\n  await Promise.resolve();\n  return Date.now();\n}',
    );
    expect(() =>
      assertElapsedBoundsClamped(
        journeys.replace(
          'left(UI_MS, tapped)',
          'UI_MS - (Date.now() - tapped)',
        ),
      ),
    ).toThrow();
    expect(mutated).not.toBe(journeys);
    expect(() => assertTapsAnchorDateNow(mutated)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Hosted wiring and parity ledger                                           */
/* -------------------------------------------------------------------------- */

const WORKFLOW_NX_COMMAND =
  '--suite=android.pinned-message-workflow --timeout-ms=900000 --entrypoint=e2e/android/pinned-message-workflow-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const WORKFLOW_CI_LINE =
  'if [ "${{ matrix.shard }}" = "4" ]; then echo \'pinned-message-workflow-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:pinned-message-workflow; fi';
const WORKFLOW_GATE_PATH =
  "-path '*/android.pinned-message-workflow/pinned-message-workflow/publication-safe'";
const WORKFLOW_UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.pinned-message-workflow-started == 'true' && steps.pinned-message-workflow-artifact-gate.outputs.pinned-message-workflow-safe == 'true' }}";

function workflowWiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
  };
}

/** Every hosted wiring rule for pinned-message-workflow, as a pure function of the files' text. */
function assertWorkflowWiring({ project, pkg, workflow }) {
  const target = project.targets['pinned-message-workflow'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(WORKFLOW_NX_COMMAND);
  expect(pkg.scripts['e2e:android:pinned-message-workflow']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:pinned-message-workflow',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(WORKFLOW_CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(runner).toBeLessThan(
    lines.findIndex((line) => line.includes('pnpm e2e:android --')),
  );
  // Shard 4: after message-unread's own runner line.
  const unread = lines.findIndex((line) =>
    line.includes('message-unread-started=true'),
  );
  expect(unread).toBeGreaterThan(-1);
  expect(runner).toBeGreaterThan(unread);
  expect(
    lines.filter((line) =>
      line.includes('trinity-e2e-android:pinned-message-workflow'),
    ),
  ).toHaveLength(1);
  const gate = workflow
    .split(
      '      - name: Gate Android pinned-message-workflow diagnostics\n',
    )[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: pinned-message-workflow-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.pinned-message-workflow-started == 'true' }}",
  );
  expect(gate).toContain(WORKFLOW_GATE_PATH);
  expect(gate).toContain(
    'echo \'pinned-message-workflow-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) =>
      step.includes('surface: android-pinned-message-workflow\n'),
    );
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${WORKFLOW_UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.pinned-message-workflow/**',
  );
}

describe('Android pinned-message-workflow hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands on shard 4 after message-unread', async () => {
    assertWorkflowWiring(workflowWiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.pinned-message-workflow',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:pinned-message-workflow',
      canonicalScript: 'e2e:android:pinned-message-workflow',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      'e2e/android/pinned-message-workflow-contract.mts',
      OBSERVER_PATH,
      ARTIFACTS_PATH,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:pinned-message-workflow',
      ),
    ).toEqual([
      {
        name: 'e2e:android:pinned-message-workflow',
        command: 'nx run trinity-e2e-android:pinned-message-workflow',
        kind: 'canonical',
        suiteIds: ['android.pinned-message-workflow'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.pinned-message-workflow'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "4" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:pinned-message-workflow',
    );
    expect(read(JOURNEYS)).toContain('timeout: 900_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = workflowWiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['pinned-message-workflow']);
      return inputs;
    };
    const withText = (key, from, to) => {
      const inputs = clone();
      expect(inputs[key]).toContain(from);
      inputs[key] = inputs[key].replace(from, to);
      return inputs;
    };
    for (const mutated of [
      withTarget((target) => (target.cache = true)),
      withTarget((target) => (target.parallelism = true)),
      withTarget((target) => (target.dependsOn = [])),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            ' --resource=synapse',
            '',
          )),
      ),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            'pinned-message-workflow-journeys.mts',
            'message-source-journeys.mts',
          )),
      ),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            '--timeout-ms=900000',
            '--timeout-ms=90000',
          )),
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:pinned-message-workflow'];
        return inputs;
      })(),
      withText(
        'workflow',
        WORKFLOW_CI_LINE,
        WORKFLOW_CI_LINE.replace('= "4"', '= "3"'),
      ),
      withText(
        'workflow',
        WORKFLOW_CI_LINE,
        WORKFLOW_CI_LINE.replace('1200000', '600000'),
      ),
      withText('workflow', `${WORKFLOW_CI_LINE}\n`, ''),
      withText(
        'workflow',
        WORKFLOW_GATE_PATH,
        "-path '*/android.pinned-message-workflow/publication-safe'",
      ),
      withText(
        'workflow',
        WORKFLOW_UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.pinned-message-workflow-started == 'true' }}",
      ),
    ])
      expect(() => assertWorkflowWiring(mutated)).toThrow();
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === WORKFLOW_CI_LINE);
    const [line] = lines.splice(index, 1);
    const retained = lines.findIndex((entry) =>
      entry.includes('pnpm e2e:android --'),
    );
    lines.splice(retained + 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWorkflowWiring(inputs)).toThrow();
    // Moved before message-unread's own runner line: still textually present but wrongly ordered.
    const before = clone();
    const beforeLines = before.workflow.split('\n');
    const workflowIdx = beforeLines.findIndex(
      (l) => l.trim() === WORKFLOW_CI_LINE,
    );
    const [moved] = beforeLines.splice(workflowIdx, 1);
    const unreadIdx = beforeLines.findIndex((l) =>
      l.includes('message-unread-started=true'),
    );
    beforeLines.splice(unreadIdx, 0, moved);
    before.workflow = beforeLines.join('\n');
    expect(() => assertWorkflowWiring(before)).toThrow();
  });

  it('documents exactly the 26 identities with their source lines, both hashes, the redaction sentence and the retirement scope', async () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Pinned-message workflow journeys')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(pinned-message-workflow\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[4])).toEqual(ALL_IDENTITIES);
    expect(rows.map((row) => row[3])).toEqual(
      ALL_IDENTITIES.map((identity) =>
        identity === 'pinned-message-workflow.pin-jump-unpin.sheet-ready'
          ? 'inherited'
          : 'direct',
      ),
    );
    expect(rows.map((row) => row[2].trim())).toEqual([
      '212',
      '220 (openMessageActionSheet@226)',
      '237',
      '241',
      '246',
      '247',
      '263',
      '267',
      '271',
      '275',
      '284',
      '289',
      '321',
      '354',
      '355',
      '365',
      '366',
      '369',
      '376',
      '377',
      '384',
      '391',
      '392',
      '395',
      '398',
      '399',
    ]);
    const flat = section.replace(/\s+/gu, ' ');
    expect(flat).toContain('25 direct + 1 inherited');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(flat).toContain('Suite `android.pinned-message-workflow`');
    expect(flat).toContain('Predecessor status: enabled');
    expect(flat).toContain('Documented reinterpretations of the predecessor:');
    expect(flat).toContain(
      'a failed teardown step is rethrown through `redactStageFailure`, and a failed guarded cleanup is rethrown through `redactCleanupFailure`, never as the raw error.',
    );
    expect(flat).toContain('402–445');
    expect(flat).toContain(
      'Shard 4 runs it last, after message-unread; its budget comment adds the 6-minute local run time (about 85 native minutes of the 240-minute job).',
    );
    expect(section).not.toContain('pnpm exec nx');
  });
});
