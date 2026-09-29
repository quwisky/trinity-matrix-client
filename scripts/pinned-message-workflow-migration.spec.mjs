import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
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
        line: 207,
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
