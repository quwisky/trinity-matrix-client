import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessor = 'e2e/browser/journeys/conversations/message-poll.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
const loadContract = () => import('../e2e/android/message-poll-contract.mts');
const loadObserver = () => import('../e2e/android/message-poll-observer.mts');
const loadArtifacts = () => import('../e2e/android/message-poll-artifacts.mts');
const loadJourneys = () => import('../e2e/android/message-poll-journeys.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-poll-journeys.mts';
const OBSERVER = 'e2e/android/message-poll-observer.mts';
const ARTIFACTS = 'e2e/android/message-poll-artifacts.mts';
const CONTRACT = 'e2e/android/message-poll-contract.mts';

const PREDECESSOR_SHA256 =
  'e23c045d237ba9fde15eb5a39d24479dfc2019e07579142c9193a8dc05ea1674';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const OPEN_ROOM_SPAN = [14, 22];

/** The issue's identity table, verbatim. */
const STAGE = {
  id: 'create-vote-end',
  span: [27, 92],
  title: 'creates a poll, votes, and ends it',
  direct: [59, 60, 73, 74, 75, 86, 87, 91],
  inherited: [
    [19, 'openRoom', 54],
    [178, 'waitForSent', 80],
  ],
  suffixes: [
    'room-ready',
    'insert-tray',
    'no-inline-poll',
    'poll-visible',
    'poll-question',
    'zero-votes',
    'server-echo',
    'one-vote',
    'one-hundred-percent',
    'final-results',
  ],
};
const ALL_IDENTITIES = STAGE.suffixes.map(
  (suffix) => `message-poll.${STAGE.id}.${suffix}`,
);

const LINE_PINS = {
  12: 'const session = synapseSession();',
  14: 'async function openRoom(page: Page, roomName: string): Promise<void> {',
  15: "await page.getByTestId('rail-rooms').click();",
  16: "const channel = page.locator('.channel', { hasText: roomName });",
  17: "await channel.first().waitFor({ state: 'visible', timeout: 30_000 });",
  18: 'await channel.first().click();',
  19: "await expect(page.getByTestId('composer-input')).toBeVisible({",
  20: 'timeout: 15_000,',
  25: "test.skip(!session.available, 'needs a Synapse homeserver (Docker)');",
  28: "const runId = `${testResourceId('run')}p`;",
  42: 'const roomName = `Poll E2E ${runId}`;',
  54: 'await openRoom(page, roomName);',
  59: "await expect(page.getByTestId('composer-insert')).toBeVisible();",
  60: "await expect(page.getByTestId('composer-poll')).toHaveCount(0);",
  63: "await page.getByTestId('composer-insert').click();",
  64: "await page.getByTestId('insert-poll').click();",
  65: 'const question = `Best fruit ${runId}?`;',
  66: "await page.getByTestId('poll-question').fill(question);",
  67: "await page.getByTestId('poll-option-0').fill('Apple');",
  68: "await page.getByTestId('poll-option-1').fill('Pear');",
  69: "await page.getByTestId('poll-create').click();",
  72: "const poll = page.getByTestId('poll').first();",
  73: 'await expect(poll).toBeVisible({ timeout: 20_000 });',
  74: 'await expect(poll).toContainText(question);',
  75: "await expect(poll).toContainText('0 votes');",
  80: 'await waitForSent(',
  82: ".locator('.scroll .msg[data-mid]', { has: page.getByTestId('poll') })",
  85: "await poll.locator('.poll__option').first().click();",
  86: "await expect(poll).toContainText('1 vote');",
  87: "await expect(poll).toContainText('1 (100%)');",
  90: "await poll.getByTestId('poll-end').click();",
  91: "await expect(poll).toContainText('Final results');",
};

const IMPORTS = `import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  waitForSent,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';`;

/* ------------------------------------------------------------------------ */
/* Predecessor AST analysis                                                  */
/* ------------------------------------------------------------------------ */

const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

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
  source = read(module),
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
  const end = tree.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1;
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
 * Expand the definition's helper calls into inherited sites: module-local
 * function declarations and named imports from the shared support modules.
 */
function expandDefinition(source, span = STAGE.span) {
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

const siteTuple = (site) =>
  site.kind === 'direct'
    ? ['direct', site.line]
    : ['inherited', site.line, site.helper, site.call];
const ledgerTuples = () => {
  const inherited = STAGE.inherited.map(([line, helper, call]) => [
    'inherited',
    line,
    helper,
    call,
  ]);
  const key = (tuple) =>
    tuple[0] === 'direct' ? [tuple[1], 1] : [tuple[3], 0];
  return [...inherited, ...STAGE.direct.map((line) => ['direct', line])].sort(
    (a, b) => {
      const [left, right] = [key(a), key(b)];
      return left[0] - right[0] || left[1] - right[1];
    },
  );
};

const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

/** Every text-level predecessor pin, independent of the byte hash. */
function assertPredecessorShape(source) {
  expect(source.split('\n')).toHaveLength(94);
  expect(source.split('\n').slice(0, 8).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line))).toBe(text);
  expect(source.split('\n')[STAGE.span[0] - 1]).toContain(
    `test('${STAGE.title}'`,
  );
  expect(lineAt(source, STAGE.span[1])).toBe('});');
  expect(lineAt(source, OPEN_ROOM_SPAN[1])).toBe('}');
  expect(assertionLines(source, ...OPEN_ROOM_SPAN)).toEqual([19]);
  expect(assertionLines(source, 1, OPEN_ROOM_SPAN[0] - 1)).toEqual([]);
  expect(
    assertionLines(source, OPEN_ROOM_SPAN[1] + 1, STAGE.span[0] - 1),
  ).toEqual([]);
  const direct = assertionLines(source, ...STAGE.span);
  expect(direct).toEqual(STAGE.direct);
  expect(direct).toHaveLength(8);
  const expanded = expandDefinition(source);
  expect(expanded.map(siteTuple)).toEqual(ledgerTuples());
  expect(expanded.filter((site) => site.kind === 'inherited')).toHaveLength(2);
  expect(expanded).toHaveLength(10);
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-poll predecessor pins', () => {
  it('pins the unchanged predecessor and both shared helper sources by SHA-256', () => {
    expect(digest(predecessor)).toBe(PREDECESSOR_SHA256);
    for (const [path, hash] of Object.entries(SHARED_SHA256))
      expect(digest(path)).toBe(hash);
    const flipped = Buffer.from(readFileSync(resolve(root, predecessor)));
    flipped[flipped.length - 2] ^= 1;
    expect(sha256(flipped)).not.toBe(PREDECESSOR_SHA256);
    for (const path of Object.keys(SHARED_SHA256)) {
      const shared = Buffer.from(readFileSync(resolve(root, path)));
      shared[0] ^= 1;
      expect(sha256(shared)).not.toBe(SHARED_SHA256[path]);
    }
  });

  it('pins the same sources and spans in the contract', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_POLL_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_POLL_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_POLL_SOURCE_LINES).toBe(93);
    expect(contract.MESSAGE_POLL_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    expect(contract.MESSAGE_POLL_SPANS).toEqual({
      openRoom: { from: 14, to: 22 },
      definitions: { [STAGE.id]: { from: 27, to: 92 } },
    });
  });

  it('keeps the predecessor enabled in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-poll.spec.mts',
      ),
    ).toHaveLength(1);
    const android = read('e2e/android/playwright.config.mts');
    expect(android).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    for (const config of [android, read('e2e/browser/playwright.config.mts')]) {
      expect(config).not.toContain('testIgnore');
      expect(config).not.toContain('message-poll');
    }
    const source = read(predecessor);
    expect(source).not.toMatch(/test\.(?:fixme|only)\(|test\.skip\(true/u);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(1);
    expect(source.match(/^ {2}test\('/gmu)).toHaveLength(1);
  });

  it('maps the exact direct and helper assertion sites with the house AST rule', () => {
    const source = read(predecessor);
    assertPredecessorShape(source);
    expect(assertionLines(source, ...STAGE.span)).toEqual(STAGE.direct);
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = read(predecessor);
    const mutations = [
      // A poll field, test id or run suffix drifts.
      mutateLine(source, 65, (line) => line.replace('Best fruit', 'Best food')),
      mutateLine(source, 67, (line) => line.replace("'Apple'", "'apple'")),
      mutateLine(source, 68, (line) => line.replace("'Pear'", "'Plum'")),
      mutateLine(source, 28, (line) => line.replace('}p`', '}q`')),
      mutateLine(source, 42, (line) => line.replace('Poll E2E', 'Poll')),
      mutateLine(source, 64, (line) =>
        line.replace('insert-poll', 'composer-poll'),
      ),
      mutateLine(source, 60, (line) =>
        line.replace('toHaveCount(0)', 'toHaveCount(1)'),
      ),
      // A direct site is dropped, added or moved.
      mutateLine(source, 87, () => '    void poll;'),
      mutateLine(
        source,
        88,
        () => "    await expect(poll).toContainText('Apple');",
      ),
      mutateLine(source, 72, (line) => `${line}\n`),
      // The server-echo helper call or the local Room helper changes.
      source.replace(
        "    await waitForSent(\n      page\n        .locator('.scroll .msg[data-mid]', { has: page.getByTestId('poll') })\n        .first(),\n    );",
        '    void 0;',
      ),
      mutateLine(
        source,
        19,
        () => "  await page.getByTestId('composer-input').waitFor();",
      ),
      mutateLine(source, 20, (line) => line.replace('15_000', '5_000')),
      // A definition title or import drifts.
      source.replace(
        "test('creates a poll, votes, and ends it'",
        "test('creates a poll and votes'",
      ),
      source.replace(
        'import { registerUser }',
        'import { registerUser as register }',
      ),
    ];
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source);
      expect(() => assertPredecessorShape(mutated)).toThrow();
    }
  });
});

describe('Android message-poll helper expansion by binding', () => {
  it('resolves module-local and imported helper calls through the TypeChecker', () => {
    const { calls } = importedCalls(read(predecessor));
    expect(
      calls
        .filter(
          (call) =>
            call.specifier === null ||
            call.specifier.startsWith('../../../support/'),
        )
        .map((call) => [call.name, call.line]),
    ).toEqual([
      // Module level (line 12), outside the owned definition.
      ['synapseSession', 12],
      ['registerUser', 32],
      ['login', 48],
      ['openRoom', 54],
      ['waitForSent', 80],
    ]);
  });

  it('follows helper calls and proves registration and login add no sites', () => {
    const source = read(predecessor);
    expect(helperExpectLines(predecessor, 'openRoom', source)).toEqual([
      { module: predecessor, line: 19 },
    ]);
    expect(helperExpectLines('e2e/support/app.mts', 'waitForSent')).toEqual([
      { module: 'e2e/support/app.mts', line: 178 },
    ]);
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
    expect(helperExpectLines('e2e/support/app.mts', 'synapseSession')).toEqual(
      [],
    );
  });

  it('excludes a shadowing local helper and proves binding matters against a naive count', () => {
    const source = read(predecessor);
    const shadowed = source.replace(
      '    await waitForSent(',
      '    const waitForSent = async (_row: unknown) => {};\n    await waitForSent(',
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    expect(locals.map((call) => call.name)).toEqual(['waitForSent']);
    expect(calls.filter((call) => call.name === 'waitForSent')).toEqual([]);
    // Spelling alone still sees the helper call.
    expect(shadowed.match(/\bwaitForSent\(/gu)).toHaveLength(1);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
    // A nested arrow named openRoom inside the definition is not the helper.
    const nested = source.replace(
      '    await openRoom(page, roomName);',
      '    const openRoom = async (_p: unknown, _n: string) => {};\n    await openRoom(page, roomName);',
    );
    expect(
      expandDefinition(nested, [27, 93]).filter(
        (site) => site.kind === 'inherited',
      ),
    ).toHaveLength(1);
  });

  it('expands 1 Room readiness + 1 real-server echo = 2 inherited sites', () => {
    const expanded = expandDefinition(read(predecessor));
    const inherited = expanded.filter((site) => site.kind === 'inherited');
    expect(inherited.map((site) => site.helper)).toEqual([
      'openRoom',
      'waitForSent',
    ]);
    expect(expanded.filter((site) => site.kind === 'direct')).toHaveLength(8);
  });

  it('matches the contract sites, identities and helper roles exactly', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    const expanded = expandDefinition(source);
    expect(contract.MESSAGE_POLL_STAGES[0].sites.map(siteTuple)).toEqual(
      expanded.map(siteTuple),
    );
    expect(contract.MESSAGE_POLL_STAGES[0].assertions).toEqual(ALL_IDENTITIES);
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_POLL_HELPERS,
    ))
      expect(
        helperExpectLines(
          module,
          helper,
          module === predecessor ? source : undefined,
        ),
      ).toEqual(expectLines.map((line) => ({ module, line })));
    expect(contract.MESSAGE_POLL_HELPERS.openRoom.role).toBe('room-readiness');
    expect(contract.MESSAGE_POLL_HELPERS.waitForSent.role).toBe(
      'real-server-echo',
    );
    expect(contract.MESSAGE_POLL_STAGES[0].sites.map(siteTuple)).not.toEqual(
      expanded.slice(0, -1).map(siteTuple),
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Contract ledger and poll fields                                           */
/* ------------------------------------------------------------------------ */

/** The predecessor's poll fields, read from its AST rather than from text. */
function predecessorPollFields(source) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const fills = [];
  const templates = {};
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'fill' &&
      ts.isCallExpression(node.expression.expression)
    ) {
      const [testId] = node.expression.expression.arguments;
      const [value] = node.arguments;
      fills.push([
        testId.text,
        ts.isStringLiteral(value) ? value.text : value.getText(tree),
      ]);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isTemplateExpression(node.initializer)
    )
      templates[node.name.text] = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { fills, templates };
}

describe('Android message-poll contract ledger', () => {
  it('owns one stage, 8 direct + 2 inherited = 10 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_POLL_STAGES.map((entry) => entry.id)).toEqual([
      STAGE.id,
    ]);
    expect(contract.MESSAGE_POLL_STAGES[0].source).toBe(`${predecessor}:27-92`);
    expect(contract.MESSAGE_POLL_STAGES[0].title).toBe(STAGE.title);
    expect(contract.MESSAGE_POLL_ASSERTION_RECORDS).toBe(10);
    expect(contract.MESSAGE_POLL_DIRECT).toBe(8);
    expect(contract.MESSAGE_POLL_INHERITED).toBe(2);
    expect(contract.MESSAGE_POLL_HELPER_COUNTS).toEqual({
      openRoom: 1,
      waitForSent: 1,
    });
    expect(new Set(ALL_IDENTITIES).size).toBe(10);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    const valid = ALL_IDENTITIES;
    expect(() =>
      contract.assertMessagePollRecords(STAGE.id, valid),
    ).not.toThrow();
    for (const invalid of [
      [],
      valid.slice(0, -1),
      [...valid, valid.at(-1)],
      [...valid].reverse(),
      valid.map((identity, index) => (index === 1 ? valid[0] : identity)),
    ])
      expect(() =>
        contract.assertMessagePollRecords(STAGE.id, invalid),
      ).toThrow();
    expect(() =>
      contract.messagePollAssertion(STAGE.id, 'not-owned'),
    ).toThrow();
  });

  it('types exactly the predecessor question, options and Room name', async () => {
    const contract = await loadContract();
    const { fills, templates } = predecessorPollFields(read(predecessor));
    expect(fills).toEqual([
      ['poll-question', 'question'],
      ['poll-option-0', 'Apple'],
      ['poll-option-1', 'Pear'],
    ]);
    expect(
      Object.fromEntries(
        ['runId', 'roomName', 'question'].map((name) => [
          name,
          templates[name],
        ]),
      ),
    ).toEqual({
      runId: "`${testResourceId('run')}p`",
      roomName: '`Poll E2E ${runId}`',
      question: '`Best fruit ${runId}?`',
    });
    expect([...contract.MESSAGE_POLL_OPTIONS]).toEqual(['Apple', 'Pear']);
    expect(contract.MESSAGE_POLL_RUN_SUFFIX).toBe('p');
    expect(contract.messagePollQuestion('run-1p')).toBe('Best fruit run-1p?');
    expect(contract.messagePollRoomName('run-1p')).toBe('Poll E2E run-1p');
    expect(contract.FIELD_SENTINEL).toBe('(');
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertMessagePollReceiptName } = await loadContract();
    for (const name of ['tray-open', 'poll-start-event', 'poll-end-event'])
      expect(() => assertMessagePollReceiptName(name)).not.toThrow();
    for (const name of [
      'message-poll.create-vote-end.room-ready',
      'message-poll-x',
      'Poll Draft',
      'a/b',
      '',
    ])
      expect(() => assertMessagePollReceiptName(name)).toThrow();
  });

  it('pins the product poll surfaces the observer and wire checks rely on', () => {
    const poll = read('libs/feature/rooms/src/lib/poll/poll.component.html');
    for (const hook of [
      'class="poll" data-testid="poll"',
      'class="poll__question"',
      'class="poll__option"',
      '[attr.aria-pressed]="option.chosen"',
      '[disabled]="poll().ended || pending()"',
      'class="poll__option-text"',
      '>{{ option.votes }} ({{ percentages()[option.id] }}%)</span',
      'class="poll__total"',
      "poll().totalVotes === 1 ? 'vote' : 'votes'",
      '· Final results',
      '@if (canEnd() && !poll().ended) {',
      'data-testid="poll-end"',
    ])
      expect(poll).toContain(hook);
    const row = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.html',
    );
    expect(row).toContain('[canEnd]="r.isOwn"');
    expect(row).toContain('[pending]="!!r.status"');
    const dialog = read(
      'libs/feature/rooms/src/lib/poll/create-poll-dialog.component.html',
    );
    for (const hook of [
      'data-testid="poll-question"',
      '[attr.data-testid]="\'poll-option-\' + $index"',
      '[attr.data-testid]="\'poll-remove-option-\' + $index"',
      'data-testid="poll-create"',
      '[disabled]="!valid()"',
    ])
      expect(dialog).toContain(hook);
    const service = read(
      'libs/feature/rooms/src/lib/poll/create-poll.service.ts',
    );
    expect(service).toContain("ariaLabel: 'Create poll',");
    expect(service).toContain("autoFocus: '[data-testid=poll-question]',");
    const tray = read(
      'libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.html',
    );
    expect(tray).toContain('aria-haspopup="dialog"');
    expect(tray).toContain('[attr.aria-expanded]="mobileSheetOpen()"');
    expect(tray.match(/data-testid="composer-insert"/gu)).toHaveLength(2);
    const menu = read(
      'libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.ts',
    );
    expect(menu).toContain("testId: 'insert-poll',");
    expect(menu).toContain("{ header: 'Add to message', buttons },");
    expect(menu).toContain("'Add to message',");
    const wire = read('libs/util/matrix/src/lib/poll.ts');
    for (const hook of [
      "kind: 'm.poll.disclosed',",
      'max_selections: 1,',
      'id: `a${index}`,',
      "'m.poll.response': { answers: [answerId] },",
      "'m.relates_to': { rel_type: 'm.reference', event_id: pollId },",
      "'m.poll.end': {},",
    ])
      expect(wire).toContain(hook);
    const actions = read(
      'libs/data-access/timeline/src/lib/timeline-actions.service.ts',
    );
    for (const type of ["'m.poll.start'", "'m.poll.response'", "'m.poll.end'"])
      expect(actions).toContain(`${type} as never`);
  });
});

/* ------------------------------------------------------------------------ */
/* Authoritative MSC3381 events                                              */
/* ------------------------------------------------------------------------ */

const ROOM = '!Room-AbC:example.test';
const SENDER = '@poll:example.test';
const POLL_ID = '$Poll_A+b/C=d';
const RESPONSE_ID = '$Vote_E+f/G=h';
const END_ID = '$End_I+j/K=l';
const QUESTION = 'Best fruit trn-poll-create-vote-end-0a1b2cp?';

const startEvent = (content = {}) => ({
  event_id: POLL_ID,
  room_id: ROOM,
  sender: SENDER,
  type: 'm.poll.start',
  content: {
    'm.poll.start': {
      question: { 'm.text': QUESTION, body: QUESTION },
      kind: 'm.poll.disclosed',
      max_selections: 1,
      answers: [
        { id: 'a0', 'm.text': 'Apple', body: 'Apple' },
        { id: 'a1', 'm.text': 'Pear', body: 'Pear' },
      ],
    },
    'm.text': `${QUESTION}\n1. Apple\n2. Pear`,
    ...content,
  },
});
const responseEvent = (pollId = POLL_ID, answers = ['a0'], overrides = {}) => ({
  event_id: RESPONSE_ID,
  room_id: ROOM,
  sender: SENDER,
  type: 'm.poll.response',
  content: {
    'm.poll.response': { answers },
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  },
  ...overrides,
});
const endEvent = (pollId = POLL_ID, overrides = {}) => ({
  event_id: END_ID,
  room_id: ROOM,
  sender: SENDER,
  type: 'm.poll.end',
  content: {
    'm.poll.end': {},
    'm.text': 'The poll has ended.',
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  },
  ...overrides,
});
const messagesPage = (...events) => ({
  chunk: [
    ...[...events].reverse(),
    { type: 'm.room.message', event_id: '$text', content: { body: 'hi' } },
    { type: 'm.room.member', event_id: '$member', content: {} },
    { type: 'm.room.create', event_id: '$create', content: {} },
  ],
});
const expectation = {
  roomId: ROOM,
  sender: SENDER,
  pollId: POLL_ID,
  question: QUESTION,
};

describe('Android message-poll authoritative MSC3381 contract', () => {
  it('reads every poll-namespace event of the page, oldest first', async () => {
    const { authoritativePollEvents } = await loadContract();
    const events = authoritativePollEvents(
      messagesPage(startEvent(), responseEvent(), {
        ...endEvent(),
        type: 'org.matrix.msc3381.poll.end',
      }),
    );
    expect(events.map((event) => event.event_id)).toEqual([
      POLL_ID,
      RESPONSE_ID,
      END_ID,
    ]);
    for (const malformed of [null, {}, { chunk: {} }, { chunk: [null] }])
      expect(() => authoritativePollEvents(malformed)).toThrow();
    expect(read('e2e/android/account-workspace-fixtures.mts')).toContain(
      '`/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`',
    );
  });

  it('requires the exact start, then the exact Apple response, then the exact end', async () => {
    const { assertPollChain, authoritativePollEvents } = await loadContract();
    const chain = (step, ...events) =>
      assertPollChain(
        authoritativePollEvents(messagesPage(...events)),
        step,
        expectation,
      );
    expect(chain('start', startEvent())).toEqual({});
    expect(chain('response', startEvent(), responseEvent())).toEqual({
      responseId: RESPONSE_ID,
    });
    expect(chain('end', startEvent(), responseEvent(), endEvent())).toEqual({
      responseId: RESPONSE_ID,
      endId: END_ID,
    });
    const start = (patch) => {
      const event = startEvent();
      patch(event.content['m.poll.start'], event);
      return event;
    };
    const failing = [
      // Server readiness: nothing yet, the wrong id, or a vote or end already present.
      ['start'],
      ['start', { ...startEvent(), event_id: '$Other' }],
      ['start', { ...startEvent(), event_id: '~!room:txn1' }],
      ['start', startEvent(), responseEvent()],
      ['start', startEvent(), endEvent()],
      ['start', startEvent(), startEvent()],
      ['start', { ...startEvent(), sender: '@other:example.test' }],
      ['start', { ...startEvent(), room_id: '!other:example.test' }],
      ['start', { ...startEvent(), type: 'org.matrix.msc3381.poll.start' }],
      [
        'start',
        startEvent({
          'm.relates_to': { rel_type: 'm.replace', event_id: '$x' },
        }),
      ],
      // Exact question and options.
      [
        'start',
        start(
          (body) =>
            (body.question['m.text'] = QUESTION.replace('Best', 'best')),
        ),
      ],
      ['start', start((body) => (body.question = { body: QUESTION }))],
      ['start', start((body) => (body.answers[0]['m.text'] = 'apple'))],
      ['start', start((body) => (body.answers[1].id = 'a2'))],
      ['start', start((body) => body.answers.reverse())],
      [
        'start',
        start((body) => body.answers.push({ id: 'a2', 'm.text': 'Plum' })),
      ],
      ['start', start((body) => (body.kind = 'm.poll.undisclosed'))],
      ['start', start((body) => (body.max_selections = 2))],
      // Vote: missing, another poll, another answer, two answers, another sender or relation.
      ['response', startEvent()],
      ['response', startEvent(), responseEvent('$Other')],
      ['response', startEvent(), responseEvent(POLL_ID, ['a1'])],
      ['response', startEvent(), responseEvent(POLL_ID, ['a0', 'a1'])],
      ['response', startEvent(), responseEvent(POLL_ID, [])],
      [
        'response',
        startEvent(),
        responseEvent(POLL_ID, ['a0'], { sender: '@other:example.test' }),
      ],
      [
        'response',
        startEvent(),
        responseEvent(POLL_ID, ['a0'], {
          content: {
            'm.poll.response': { answers: ['a0'] },
            'm.relates_to': { rel_type: 'm.annotation', event_id: POLL_ID },
          },
        }),
      ],
      [
        'response',
        startEvent(),
        responseEvent(),
        { ...responseEvent(), event_id: '$Vote2' },
      ],
      ['response', startEvent(), responseEvent(), endEvent()],
      // End: missing, another poll, before the vote, or another relation.
      ['end', startEvent(), responseEvent()],
      ['end', startEvent(), responseEvent(), endEvent('$Other')],
      ['end', startEvent(), endEvent(), responseEvent()],
      [
        'end',
        startEvent(),
        responseEvent(),
        endEvent(POLL_ID, { content: { 'm.poll.end': {} } }),
      ],
      [
        'end',
        startEvent(),
        responseEvent(),
        endEvent(POLL_ID, { type: 'm.room.message' }),
      ],
    ];
    for (const [step, ...events] of failing)
      expect(
        () => chain(step, ...events),
        JSON.stringify([step, events.length]),
      ).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Simulated installed app: the exact journey against production-shaped DOM  */
/* ------------------------------------------------------------------------ */

const USER = {
  userId: SENDER,
  username: 'poll',
  password: 'poll-pass"word\\token',
  homeserver: 'https://localhost:8448',
};
const ROUTE = `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}?account=${encodeURIComponent(SENDER)}&view=rooms`;

/**
 * A model of the installed app, its Synapse Room and Gboard. The DOM is
 * rendered in production shape and every observer expression runs against it
 * in jsdom; native actions resolve their target exactly as the client does
 * (exactly one visible enabled match) and the server holds the real MSC3381
 * events the product would send. A settled state aborts instead of waiting.
 */
function simulatedPollApp(faults = {}) {
  const controller = new AbortController();
  const state = {
    signedIn: false,
    roomsShown: false,
    roomOpen: false,
    trayOpen: Boolean(faults.trayPreOpen),
    dialogOpen: false,
    focus: null,
    fields: { question: '', options: ['', ''] },
    poll: null,
    events: [],
    actions: [],
    reads: 0,
  };
  let lastSignature = '';
  let stale = 0;
  const question = () => state.poll?.question ?? '';
  const serverStart = () => {
    const answers = state.poll.options.map((text, index) => ({
      id: faults.swappedAnswerIds ? `a${1 - index}` : `a${index}`,
      'm.text': text,
      body: text,
    }));
    state.events.push(
      startEvent({
        'm.poll.start': {
          question: { 'm.text': question(), body: question() },
          kind: 'm.poll.disclosed',
          max_selections: 1,
          answers,
        },
      }),
    );
    if (faults.startIdMismatch) state.events.at(-1).event_id = '$Elsewhere';
    if (faults.preExistingResponse)
      state.events.push(responseEvent('$Earlier'));
  };
  const progress = () => {
    const poll = state.poll;
    if (poll && poll.rowId.startsWith('~') && !faults.echoNever) {
      poll.echoIn -= 1;
      if (poll.echoIn <= 0) {
        poll.rowId = POLL_ID;
        serverStart();
      }
    }
  };
  const tally = () => {
    const poll = state.poll;
    const responses = state.events.filter(
      (event) =>
        event.type === 'm.poll.response' &&
        event.content['m.relates_to']?.event_id === poll.rowId,
    );
    const latest = responses.at(-1)?.content['m.poll.response'].answers[0];
    return poll.options.map((_, index) =>
      faults.pearCounted && latest ? 1 : latest === `a${index}` ? 1 : 0,
    );
  };
  const escape = (value) =>
    String(value)
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/"/gu, '&quot;');
  const render = () => {
    const parts = ['<nav>'];
    if (state.signedIn)
      parts.push('<button data-testid="rail-rooms">Rooms</button>');
    parts.push('</nav>');
    if (state.roomsShown)
      parts.push(
        `<aside><div class="channel">${escape(`Poll E2E ${faults.run ?? 'run'}`)}</div></aside>`,
      );
    if (state.roomOpen) {
      parts.push(
        '<div class="scroll"><div class="msg msg--event" data-mid="$create"><span class="msg__event-text">created the room</span></div>',
      );
      const poll = state.poll;
      if (poll) {
        const votes = tally();
        const total = votes.reduce((sum, count) => sum + count, 0);
        const ended = state.events.some((event) => event.type === 'm.poll.end');
        const pending = poll.rowId.startsWith('~');
        const disabled =
          (ended && !faults.optionsStayEnabled) ||
          pending ||
          Boolean(faults.optionsDisabledAfterEcho);
        const options = poll.options.map((text, index) => {
          const count = votes[index];
          const percent = total ? Math.round((count / total) * 100) : 0;
          const chosen = !faults.notPressed && count > 0 && index === 0;
          return `<li><button type="button" class="poll__option" aria-pressed="${chosen}"${disabled ? ' disabled' : ''}><span class="poll__bar" aria-hidden="true"></span><span class="poll__option-text">${escape(text)}</span><span class="poll__option-count">${count} (${percent}%)</span></button></li>`;
        });
        const shownTotal = faults.finalLosesVote && ended ? 0 : total;
        const end =
          !ended || faults.endControlStays
            ? `<button type="button" data-testid="poll-end"${pending ? ' disabled' : ''}>End poll</button>`
            : '';
        const shownQuestion = faults.renderedQuestion ?? poll.question;
        parts.push(
          `<div class="msg" data-mid="${escape(poll.rowId)}"><div class="msg__body"><trn-poll><div class="poll" data-testid="poll"><div class="poll__question">${escape(shownQuestion)}</div><ul class="poll__options">${options.join('')}</ul><div class="poll__footer"><span class="poll__total"> ${shownTotal} ${shownTotal === 1 ? 'vote' : 'votes'} ${ended ? '· Final results' : ''} </span>${end}</div></div></trn-poll></div></div>`,
        );
      }
      parts.push('</div>');
      parts.push(
        `<textarea data-testid="composer-input" placeholder="${escape(`Message #Poll E2E ${faults.run ?? 'run'}`)}"></textarea>`,
      );
      if (!faults.insertMissing)
        parts.push(
          `<button type="button" data-testid="composer-insert"${faults.desktopTrigger ? '' : ' aria-haspopup="dialog"'} aria-expanded="${state.trayOpen}"${faults.insertDisabled ? ' disabled' : ''}>+</button>`,
        );
      if (faults.inlinePoll)
        parts.push('<button data-testid="composer-poll">Poll</button>');
      if (state.trayOpen)
        parts.push(
          '<div role="dialog" aria-label="Add to message"><button data-testid="insert-attach">Attach a file</button><button data-testid="insert-poll">Poll</button></div>',
        );
      if (state.dialogOpen) {
        const options = state.fields.options
          .map(
            (value, index) =>
              `<input data-testid="poll-option-${index}" value="${escape(value)}">`,
          )
          .join('');
        const valid =
          state.fields.question.trim() &&
          state.fields.options.filter((value) => value.trim()).length >= 2;
        parts.push(
          `<div role="dialog" aria-label="Create poll"><input id="poll-question" data-testid="poll-question" value="${escape(state.fields.question)}">${options}<button data-testid="poll-create"${valid ? '' : ' disabled'}>Create</button></div>`,
        );
      }
    }
    return parts.join('');
  };
  const dom = () => {
    const jsdom = new JSDOM(`<main>${render()}</main>`, {
      url: state.roomOpen ? ROUTE : 'https://localhost/rooms?account=x',
    });
    const { window } = jsdom;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({
      width: 120,
      height: 20,
    });
    window.matchMedia = (query) => ({
      matches: query === '(hover: none)' || query === '(pointer: coarse)',
    });
    window.Capacitor = { getPlatform: () => 'android' };
    const computed = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element) => ({
      ...computed(element),
      visibility: 'visible',
    });
    const focused = state.focus && window.document.querySelector(state.focus);
    if (focused) focused.focus();
    return window;
  };
  const settle = () => {
    state.reads += 1;
    progress();
    const signature = JSON.stringify([render(), state.events, state.focus]);
    if (signature === lastSignature && ++stale > 6)
      controller.abort(new Error('Simulated app settled'));
    if (signature !== lastSignature) stale = 0;
    lastSignature = signature;
  };
  const matches = (selector, filter = {}) =>
    [...dom().document.querySelectorAll(selector)].filter(
      (element) =>
        (filter.text === undefined ||
          (element.textContent ?? '').includes(filter.text)) &&
        (filter.exactText === undefined ||
          element.textContent?.trim() === filter.exactText),
    );
  const elementsOf = (selector, filter) =>
    matches(selector, filter).map((element) => ({
      text: element.textContent?.trim() ?? '',
      visible: true,
      focused: state.focus !== null && element.matches(state.focus),
      disabled: element.matches(':disabled'),
      value: 'value' in element ? element.value : null,
    }));
  const actionable = (selector, filter) => {
    const found = matches(selector, filter);
    if (found.length !== 1 || found[0].matches(':disabled'))
      throw new Error(`Simulated target is not actionable: ${selector}`);
    return found[0];
  };
  const gboard = (value, sentinel) => {
    // Measured on the emulator: Gboard joins a letter or digit sentinel to the
    // first word and recases that word on the next space (`1Best fruit` became
    // `1best fruit`, `xBest fruit` became `Xbest fruit`); a single word such as
    // `1Apple` stays. The focused fill then removes the first character.
    let typed = `${sentinel}${value}`;
    const [first] = typed.split(' ');
    if (/^[\p{L}\p{N}]$/u.test(sentinel) && first !== typed)
      typed =
        (/^\p{N}/u.test(first)
          ? first.toLowerCase()
          : `${first[0].toUpperCase()}${first.slice(1).toLowerCase()}`) +
        typed.slice(first.length);
    if (faults.autocorrectToken) typed = typed.replace('trn-', 'try-');
    return typed.slice(1);
  };
  const client = {
    workspaceRoot: root,
    applicationId: 'eu.qwky.trinity',
    signal: controller.signal,
    webview: {
      diagnostics: {
        send: async (_method, { expression }) => {
          settle();
          const window = dom();
          return {
            result: {
              value: JSON.parse(
                JSON.stringify(
                  runInNewContext(expression, { document: window.document }),
                ),
              ),
            },
          };
        },
      },
    },
    async reset() {
      state.actions.push('reset');
    },
    async login() {
      state.actions.push('login');
      state.signedIn = true;
    },
    async hideKeyboard() {
      state.actions.push('hide-keyboard');
    },
    async elements(selector, filter) {
      settle();
      return elementsOf(selector, filter);
    },
    async waitElements(selector, accepts, _description, filter, timeoutMs) {
      assert(Number.isFinite(timeoutMs), 'Simulated waits are bounded');
      for (;;) {
        controller.signal.throwIfAborted();
        settle();
        const values = elementsOf(selector, filter);
        if (accepts(values)) return values;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    async visible(selector, filter, timeoutMs = 15_000) {
      const [element] = await client.waitElements(
        selector,
        (values) => values.length === 1 && values[0].visible,
        selector,
        filter,
        timeoutMs,
      );
      return element;
    },
    async focused(selector) {
      await client.waitElements(
        selector,
        (values) => values.length === 1 && values[0].focused,
        selector,
        {},
        15_000,
      );
    },
    async tapCurrent(selector, filter = {}) {
      state.actions.push(
        `tap:${selector}${filter.text ? `|${filter.text}` : ''}`,
      );
      const element = actionable(selector, filter);
      const testId = element.getAttribute('data-testid');
      if (testId === 'rail-rooms') state.roomsShown = true;
      else if (element.classList.contains('channel')) state.roomOpen = true;
      else if (testId === 'composer-insert') state.trayOpen = true;
      else if (testId === 'insert-poll') {
        state.trayOpen = false;
        state.dialogOpen = true;
        state.focus = faults.noAutofocus
          ? null
          : '[data-testid="poll-question"]';
      } else if (testId === 'poll-create') {
        state.dialogOpen = false;
        state.focus = null;
        state.poll = {
          rowId: '~!Room-AbC:example.test:txn1',
          echoIn: 2,
          question: state.fields.question,
          options: [
            ...state.fields.options,
            ...(faults.thirdOption ? ['Plum'] : []),
          ],
        };
      } else if (element.classList.contains('poll__option')) {
        if (faults.noResponse) return;
        const index = [...element.parentElement.parentElement.children].indexOf(
          element.parentElement,
        );
        const answer = faults.responseAnswer ?? `a${index}`;
        const target = faults.responseTarget ?? state.poll.rowId;
        state.events.push(responseEvent(target, [answer]));
        if (faults.duplicateResponse)
          state.events.push({
            ...responseEvent(target, [answer]),
            event_id: '$Vote2',
          });
      } else if (testId === 'poll-end') {
        if (faults.noEnd) return;
        state.events.push(endEvent(faults.endTarget ?? state.poll.rowId));
      } else throw new Error(`Unmodelled simulated tap ${selector}`);
    },
    async focusCurrent(selector) {
      state.actions.push(`focus:${selector}`);
      actionable(selector, {});
      state.focus = selector;
    },
    async fillFocused(selector, value, sentinel = 'x') {
      state.actions.push(`fill:${selector}|${sentinel}`);
      assert.equal(
        state.focus,
        selector,
        `${selector} is focused before the fill`,
      );
      const typed = gboard(value, faults.sentinel ?? sentinel);
      if (selector === '[data-testid="poll-question"]')
        state.fields.question = typed;
      else {
        const index = Number(/poll-option-(\d)/u.exec(selector)[1]);
        state.fields.options[index] = typed;
      }
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture(name) {
      state.actions.push(`capture:${name}`);
    },
  };
  state.written = [];
  const fixtures = {
    async account() {
      return USER;
    },
    async createRoom(_account, { name, preset }) {
      assert.equal(preset, 'private_chat');
      return { id: ROOM, name };
    },
    async roomMessages(account, roomId) {
      assert.equal(account, USER);
      assert.equal(roomId, ROOM);
      settle();
      return messagesPage(...state.events);
    },
  };
  return { client, fixtures, state, controller };
}

async function simulatedStage(faults = {}) {
  const { MESSAGE_POLL_STAGES } = await loadContract();
  const app = simulatedPollApp(faults);
  const context = {
    entry: MESSAGE_POLL_STAGES[0],
    records: [],
    identities: new Set(),
    receipts: 0,
    client: app.client,
    fixtures: app.fixtures,
    secrets: {},
    safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
    native: false,
    ledger: { run: faults.run ?? 'run', eventIds: [] },
  };
  return { ...app, context };
}

const EXPECTED_ACTIONS = [
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  'tap:.channel|Poll E2E run',
  'tap:[data-testid="composer-insert"]',
  'tap:[data-testid="insert-poll"]',
  'fill:[data-testid="poll-question"]|(',
  'focus:[data-testid="poll-option-0"]',
  'fill:[data-testid="poll-option-0"]|(',
  'focus:[data-testid="poll-option-1"]',
  'fill:[data-testid="poll-option-1"]|(',
  'tap:[data-testid="poll-create"]',
  'tap:[data-testid="poll"] .poll__option|Apple',
  'tap:[data-testid="poll-end"]',
];

describe('Android message-poll native journey against a simulated installed app', () => {
  it('drives the exact native sequence and records all ten identities in order', async () => {
    const { runCreateVoteEnd } = await loadJourneys();
    const { context, state } = await simulatedStage();
    await runCreateVoteEnd(context);
    expect(context.records).toEqual(ALL_IDENTITIES);
    expect(state.actions).toEqual(EXPECTED_ACTIONS);
    expect(state.events.map((event) => event.type)).toEqual([
      'm.poll.start',
      'm.poll.response',
      'm.poll.end',
    ]);
    expect(context.ledger.eventIds).toEqual([POLL_ID, RESPONSE_ID, END_ID]);
    const receipts = state.written
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('receipt-'));
    expect(receipts).toEqual([
      'receipt-01-tray-open',
      'receipt-02-poll-dialog-open',
      'receipt-03-poll-draft',
      'receipt-04-poll-created',
      'receipt-05-poll-start-event',
      'receipt-06-poll-response-event',
      'receipt-07-poll-end-event',
    ]);
    // Written evidence carries digests and booleans, never an identifier or credential.
    const written = JSON.stringify(state.written);
    for (const value of [
      ROOM,
      POLL_ID,
      RESPONSE_ID,
      END_ID,
      SENDER,
      USER.password,
      QUESTION,
    ])
      expect(written).not.toContain(value);
    expect(written).toContain(sha256(POLL_ID));
    expect(written).toContain(sha256(ROOM));
    // Selectors reach the job log: none carries an identifier.
    for (const action of state.actions)
      expect(action).not.toMatch(/[$!~][A-Za-z]|data-mid/u);
  });

  for (const sentinel of ['x', '1'])
    it(`models the hazard: the ${sentinel} sentinel lets Gboard recase Best`, async () => {
      const { runCreateVoteEnd } = await loadJourneys();
      const { context, state } = await simulatedStage({ sentinel });
      await expect(runCreateVoteEnd(context)).rejects.toThrow();
      expect(state.fields.question).toBe('best fruit run?');
      expect(state.fields.options).toEqual(['Apple', 'Pear']);
      expect(state.actions).not.toContain('tap:[data-testid="poll-create"]');
      expect(context.records).toEqual(ALL_IDENTITIES.slice(0, 3));
    });

  it('uses an opening parenthesis, which Gboard keeps apart from the first word', async () => {
    const { FIELD_SENTINEL } = await loadContract();
    expect(FIELD_SENTINEL).toBe('(');
    const { state, context } = await simulatedStage();
    const { runCreateVoteEnd } = await loadJourneys();
    await runCreateVoteEnd(context);
    expect(state.fields.question).toBe('Best fruit run?');
  });

  const FAULTS = [
    // Tray and no inline Poll control.
    ['insertMissing', 'insert-tray'],
    ['desktopTrigger', 'insert-tray'],
    ['insertDisabled', 'insert-tray'],
    ['inlinePoll', 'insert-tray'],
    ['trayPreOpen', 'insert-tray'],
    // Dialog, exact question and options.
    ['noAutofocus', 'poll-visible'],
    [{ autocorrectToken: true, run: 'trn-poll-0a1bp' }, 'poll-visible'],
    ['thirdOption', 'poll-visible'],
    [{ renderedQuestion: 'Best fruit other?' }, 'poll-visible'],
    // Server readiness before the vote.
    ['echoNever', 'server-echo'],
    ['optionsDisabledAfterEcho', 'server-echo'],
    ['startIdMismatch', 'one-vote', 'no-vote'],
    ['preExistingResponse', 'one-vote', 'no-vote'],
    ['swappedAnswerIds', 'one-vote', 'no-vote'],
    // Exact vote relation, answer and tally.
    ['noResponse', 'one-vote'],
    [{ responseAnswer: 'a1' }, 'one-vote'],
    [{ responseTarget: '$Other' }, 'one-vote'],
    ['duplicateResponse', 'one-vote'],
    ['notPressed', 'one-vote'],
    ['pearCounted', 'one-vote'],
    // Exact end relation and final closure.
    ['noEnd', 'final-results'],
    [{ endTarget: '$Other' }, 'final-results'],
    ['optionsStayEnabled', 'final-results'],
    ['endControlStays', 'final-results'],
    ['finalLosesVote', 'final-results'],
  ];

  for (const [fault, firstMissing, noVote] of FAULTS) {
    const name = typeof fault === 'string' ? fault : Object.keys(fault)[0];
    it(`fails before ${firstMissing} when ${name}`, async () => {
      const { runCreateVoteEnd } = await loadJourneys();
      const faults = typeof fault === 'string' ? { [fault]: true } : fault;
      const { context, state } = await simulatedStage(faults);
      await expect(runCreateVoteEnd(context)).rejects.toThrow();
      const index = ALL_IDENTITIES.indexOf(
        `message-poll.${STAGE.id}.${firstMissing}`,
      );
      expect(context.records).toEqual(ALL_IDENTITIES.slice(0, index));
      if (
        noVote ||
        index <=
          ALL_IDENTITIES.indexOf('message-poll.create-vote-end.server-echo')
      )
        expect(state.actions).not.toContain(
          'tap:[data-testid="poll"] .poll__option|Apple',
        );
    });
  }

  it('never votes against a pending local echo', async () => {
    const { runCreateVoteEnd } = await loadJourneys();
    const { context, state } = await simulatedStage();
    const tap = context.client.tapCurrent;
    let rowAtVote;
    context.client.tapCurrent = async (selector, filter) => {
      if (selector.includes('poll__option')) rowAtVote = state.poll.rowId;
      return tap(selector, filter);
    };
    await runCreateVoteEnd(context);
    expect(rowAtVote).toBe(POLL_ID);
    expect(state.events[1].content['m.relates_to'].event_id).toBe(POLL_ID);
  });
});

/* ------------------------------------------------------------------------ */
/* Read-only renderer observation (jsdom)                                    */
/* ------------------------------------------------------------------------ */

function evaluateIn(body, expression, focus = null) {
  const dom = new JSDOM(`<main>${body}</main>`, { url: ROUTE });
  const { window } = dom;
  if (focus) window.document.querySelector(focus).focus();
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = /display:\s*none/u.test(this.getAttribute('style') ?? '');
    return { width: hidden ? 0 : 120, height: hidden ? 0 : 20 };
  };
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => ({
    ...computed(element),
    visibility:
      element.closest('[style*="visibility:hidden"]') !== null
        ? 'hidden'
        : 'visible',
  });
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

const pollRow = ({
  id = POLL_ID,
  question = QUESTION,
  total = '0 votes',
  apple = '0 (0%)',
  pear = '0 (0%)',
  pressed = 'false',
  disabled = '',
  end = '<button data-testid="poll-end">End poll</button>',
  style = '',
} = {}) =>
  `<div class="msg" data-mid="${id}"${style}><trn-poll><div class="poll" data-testid="poll"><div class="poll__question"> ${question} </div><ul class="poll__options"><li><button class="poll__option" aria-pressed="${pressed}"${disabled}><span class="poll__option-text">Apple</span><span class="poll__option-count">${apple}</span></button></li><li><button class="poll__option" aria-pressed="false"${disabled}><span class="poll__option-text">Pear</span><span class="poll__option-count">${pear}</span></button></li></ul><div class="poll__footer"><span class="poll__total">\n ${total}\n </span>${end}</div></div></trn-poll></div>`;
const scroll = (...rows) => `<div class="scroll">${rows.join('')}</div>`;

describe('Android message-poll read-only renderer observation (jsdom)', () => {
  it('observes the rendered poll and rejects hidden, doubled or foreign polls', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const observe = (body) =>
      contract.parseTimeline(evaluateIn(body, timelineExpression()));
    const production = observe(scroll(pollRow()));
    const poll = contract.assertPollVisible(production);
    expect(() => contract.assertPollQuestion(poll, QUESTION)).not.toThrow();
    expect(() => contract.assertZeroVotes(poll)).not.toThrow();
    expect(contract.assertServerEcho(production).rowId).toBe(POLL_ID);
    for (const body of [
      scroll(pollRow(), pollRow({ id: '$Two' })),
      scroll(pollRow({ style: ' style="visibility:hidden"' })),
      `${scroll()}${pollRow()}`,
    ])
      expect(() => contract.assertPollVisible(observe(body))).toThrow();
    expect(() =>
      contract.assertServerEcho(
        observe(scroll(pollRow({ id: '~!room:txn1' }))),
      ),
    ).toThrow();
    for (const question of [
      QUESTION.toLowerCase(),
      `x${QUESTION}`,
      QUESTION.slice(0, -1),
    ])
      expect(() =>
        contract.assertPollQuestion(
          contract.assertPollVisible(observe(scroll(pollRow({ question })))),
          QUESTION,
        ),
      ).toThrow();
    // Swapped, missing or extra answers are not the exact poll.
    for (const options of [
      [poll.options[1], poll.options[0]],
      [poll.options[0]],
      [...poll.options, poll.options[1]],
    ])
      expect(() =>
        contract.assertPollQuestion({ ...poll, options }, QUESTION),
      ).toThrow();
    for (const change of [
      { total: '1 vote' },
      { apple: '1 (100%)' },
      { pressed: 'true' },
    ])
      expect(() =>
        contract.assertZeroVotes(
          contract.assertPollVisible(observe(scroll(pollRow(change)))),
        ),
      ).toThrow();
  });

  it('requires the same poll row for the tally and the final closed state', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const observe = (options) =>
      contract.parseTimeline(
        evaluateIn(scroll(pollRow(options)), timelineExpression()),
      );
    const voted = { total: '1 vote', apple: '1 (100%)', pressed: 'true' };
    const poll = contract.assertOneVote(observe(voted), POLL_ID);
    expect(() => contract.assertOneHundredPercent(poll)).not.toThrow();
    expect(() =>
      contract.assertOneVote(observe({ ...voted, id: '$Other' }), POLL_ID),
    ).toThrow();
    expect(() =>
      contract.assertOneVote(observe({ ...voted, total: '2 votes' }), POLL_ID),
    ).toThrow();
    for (const change of [
      { pressed: 'false' },
      { apple: '0 (0%)', pear: '1 (100%)' },
      { pear: '1 (50%)', apple: '1 (50%)' },
    ])
      expect(() =>
        contract.assertOneHundredPercent(
          contract.assertOneVote(observe({ ...voted, ...change }), POLL_ID),
        ),
      ).toThrow();
    const final = {
      ...voted,
      total: '1 vote · Final results',
      disabled: ' disabled',
      end: '',
    };
    expect(() =>
      contract.assertFinalResults(observe(final), POLL_ID),
    ).not.toThrow();
    for (const change of [
      { disabled: '' },
      { end: '<button data-testid="poll-end">End poll</button>' },
      { total: '0 votes · Final results', apple: '0 (0%)' },
      { total: '1 vote' },
      { id: '$Other' },
    ])
      expect(() =>
        contract.assertFinalResults(observe({ ...final, ...change }), POLL_ID),
      ).toThrow();
  });

  it('observes the composer tray, the dialog and parses only complete observations', async () => {
    const contract = await loadContract();
    const { composerExpression, pollDialogExpression } = await loadObserver();
    const composer = (
      extra = '',
      insert = 'aria-haspopup="dialog" aria-expanded="false"',
    ) =>
      `<textarea data-testid="composer-input" placeholder="Message #Poll E2E run"></textarea><button data-testid="composer-insert" ${insert}>+</button>${extra}`;
    const observed = contract.parseComposer(
      evaluateIn(composer(), composerExpression()),
    );
    expect(() => contract.assertInsertTray(observed)).not.toThrow();
    expect(() => contract.assertNoInlinePoll(observed)).not.toThrow();
    expect(() =>
      contract.assertRoomReady(observed, {
        name: 'Poll E2E run',
        roomId: ROOM,
        userId: SENDER,
      }),
    ).not.toThrow();
    expect(() =>
      contract.assertRoomReady(observed, {
        name: 'Poll E2E other',
        roomId: ROOM,
        userId: SENDER,
      }),
    ).toThrow();
    for (const insert of [
      'aria-expanded="false"',
      'aria-haspopup="dialog" aria-expanded="true"',
      'aria-haspopup="dialog" disabled',
    ])
      expect(() =>
        contract.assertInsertTray(
          contract.parseComposer(
            evaluateIn(composer('', insert), composerExpression()),
          ),
        ),
      ).toThrow();
    for (const extra of [
      '<button data-testid="composer-poll"></button>',
      '<button data-testid="insert-poll"></button>',
    ])
      expect(() =>
        contract.assertNoInlinePoll(
          contract.parseComposer(
            evaluateIn(composer(extra), composerExpression()),
          ),
        ),
      ).toThrow();
    const dialog = (question, options, create = '') =>
      `<div role="dialog" aria-label="Create poll"><input data-testid="poll-question" value="${question}">${options.map((value, index) => `<input data-testid="poll-option-${index}" value="${value}"><button data-testid="poll-remove-option-${index}"></button>`).join('')}<button data-testid="poll-create"${create}>Create</button></div>`;
    const QUESTION_FIELD = '[data-testid="poll-question"]';
    const opened = (question, options, focus) =>
      contract.parsePollDialog(
        evaluateIn(dialog(question, options), pollDialogExpression(), focus),
      );
    expect(() =>
      contract.assertPollDialogOpen(opened('', ['', ''], QUESTION_FIELD)),
    ).not.toThrow();
    // Not autofocused, focused elsewhere, prefilled, or with another option count.
    for (const [question, options, focus] of [
      ['', ['', ''], null],
      ['', ['', ''], '[data-testid="poll-option-0"]'],
      ['Best', ['', ''], QUESTION_FIELD],
      ['', ['', '', ''], QUESTION_FIELD],
      ['', ['Apple', ''], QUESTION_FIELD],
    ])
      expect(() =>
        contract.assertPollDialogOpen(opened(question, options, focus)),
      ).toThrow();
    const draft = contract.parsePollDialog(
      evaluateIn(dialog(QUESTION, ['Apple', 'Pear']), pollDialogExpression()),
    );
    expect(() => contract.assertPollDraft(draft, QUESTION)).not.toThrow();
    for (const [question, options, create] of [
      [QUESTION.replace('Best', 'best'), ['Apple', 'Pear'], ''],
      [QUESTION, ['pple', 'Pear'], ''],
      [QUESTION, ['Apple', 'Pear', 'Plum'], ''],
      [QUESTION, ['Apple', 'Pear '], ''],
      [QUESTION, ['Apple', 'Pear'], ' disabled'],
    ])
      expect(() =>
        contract.assertPollDraft(
          contract.parsePollDialog(
            evaluateIn(
              dialog(question, options, create),
              pollDialogExpression(),
            ),
          ),
          QUESTION,
        ),
      ).toThrow();
    for (const malformed of [
      null,
      { ...observed, insertCount: -1 },
      { ...observed, href: undefined },
      { ...observed, insertVisible: 'yes' },
    ])
      expect(() => contract.parseComposer(malformed)).toThrow();
    for (const malformed of [
      null,
      { pollCount: 0, polls: {} },
      { pollCount: 1, polls: [{ rowId: 1 }] },
    ])
      expect(() => contract.parseTimeline(malformed)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Diagnostics safety                                                        */
/* ------------------------------------------------------------------------ */

const ARTIFACT_IDS = {
  run: 'trn-poll-create-vote-end-0a1b2cp',
  account: {
    userId: '@trn_poll_create_vote_end_0a1b2c:localhost',
    username: 'trn_poll_create_vote_end_0a1b2c',
    password: 'poll-pass"word\\token',
  },
  room: {
    id: '!Room_Ab+c/d:localhost',
    name: 'Poll E2E trn-poll-create-vote-end-0a1b2cp',
  },
  eventIds: [POLL_ID, RESPONSE_ID, END_ID],
};

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

const mixedCase = (value) =>
  value.replace(
    /%([0-9A-F]{2})/gu,
    (_match, hex, offset) => `%${offset % 2 ? hex.toLowerCase() : hex}`,
  );

/** Every record() proof must be an inline function that makes an assertion call. */
function recordProofViolations(source) {
  const tree = ts.createSourceFile(
    'journeys.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];
  let records = 0;
  const asserts = (node) => {
    let found = false;
    const visit = (child) => {
      if (found) return;
      if (ts.isCallExpression(child)) {
        const callee = child.expression;
        if (ts.isIdentifier(callee) && /^assert/u.test(callee.text))
          found = true;
        else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'assert'
        )
          found = true;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'record' &&
      node.arguments.length === 4
    ) {
      records += 1;
      const proof = node.arguments[2];
      if (
        !(ts.isArrowFunction(proof) || ts.isFunctionExpression(proof)) ||
        !asserts(proof.body)
      )
        violations.push(lineOf(tree, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { records, violations };
}

describe('Android message-poll diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read(JOURNEYS);
    const current = recordProofViolations(journey);
    expect(current.records).toBe(10);
    expect(current.violations).toEqual([]);
    for (const [from, to] of [
      ['() => assertOneHundredPercent(voted)', '() => {}'],
      ['() => assertFinalResults(ended, pollId)', '() => void ended'],
      ['() => assertInsertTray(composer)', 'undefined'],
    ]) {
      expect(journey).toContain(from);
      expect(
        recordProofViolations(journey.replace(from, to)).violations,
      ).toHaveLength(1);
    }
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_POLL_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_POLL_STAGES[0],
      records: [],
      identities: new Set(),
      receipts: 0,
      client: {
        async record(name, value) {
          written.push({ name, value });
        },
      },
    };
    await record(context, 'room-ready', () => {}, { ready: true });
    expect(written[0]).toMatchObject({
      name: 'message-poll.create-vote-end.room-ready',
      value: {
        assertion: 'message-poll.create-vote-end.room-ready',
        observation: { ready: true },
      },
    });
    await expect(
      record(
        context,
        'insert-tray',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    await expect(record(context, 'room-ready', () => {}, {})).rejects.toThrow();
    await expect(
      record(context, 'final-results', () => {}, {}),
    ).rejects.toThrow();
    await expect(record(context, 'plain-body', () => {}, {})).rejects.toThrow();
    expect(written).toHaveLength(1);
    await receipt(context, 'poll-start-event', { ok: true });
    expect(written.at(-1).name).toBe('receipt-01-poll-start-event');
    for (const name of ['message-poll.create-vote-end.room-ready', 'Start', ''])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messagePollSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messagePollSecrets(STAGE.id, ARTIFACT_IDS);
    const segment = Buffer.from(ARTIFACT_IDS.room.id).toString('base64url');
    const failure = new AssertionError({
      actual: `/rooms/${segment}?account=${encodeURIComponent(ARTIFACT_IDS.account.userId)}`,
      expected: `/rooms/${ARTIFACT_IDS.room.id}`,
      operator: 'strictEqual',
      message: 'Native navigation reached the exact Room',
    });
    const leaked = new Error(
      `Relation ${RESPONSE_ID} to ${POLL_ID} for Best fruit ${ARTIFACT_IDS.run}?`,
    );
    const error = redactStageFailure(
      STAGE.id,
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain(
      'Android message-poll create-vote-end failed',
    );
    expect(error.message).toContain('Native navigation reached the exact Room');
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ARTIFACT_IDS.room.id,
      segment,
      POLL_ID,
      RESPONSE_ID,
      ARTIFACT_IDS.run,
      ARTIFACT_IDS.account.userId,
      encodeURIComponent(ARTIFACT_IDS.account.userId),
    ])
      expect(error.message).not.toContain(value);
    const cleanup = redactCleanupFailure(
      'fixtures',
      Object.assign(new Error(`leave ${ARTIFACT_IDS.room.id}`), {
        status: 403,
      }),
    );
    expect(cleanup.message).toBe(
      'Message-poll cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardMessagePollCleanup } = await loadJourneys();
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
    const guarded = guardMessagePollCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ARTIFACT_IDS.room.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-poll cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.report.stages[0].error).toContain(ARTIFACT_IDS.room.id);
    expect(state.saves).toBe(1);
  });

  it('registers every identifier form, including each poll event id, never the bare server name', async () => {
    const { messagePollSecrets } = await loadArtifacts();
    const secrets = messagePollSecrets(STAGE.id, ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_POLL_CREATE_VOTE_END_'),
      ),
    ).toBe(true);
    const values = new Set(Object.values(secrets));
    for (const value of [
      ARTIFACT_IDS.run,
      ARTIFACT_IDS.account.userId,
      encodeURIComponent(ARTIFACT_IDS.account.userId),
      ARTIFACT_IDS.account.username,
      ARTIFACT_IDS.account.password,
      ARTIFACT_IDS.room.id,
      ARTIFACT_IDS.room.id.slice(1),
      encodeURIComponent(ARTIFACT_IDS.room.id),
      Buffer.from(ARTIFACT_IDS.room.id).toString('base64url'),
      ARTIFACT_IDS.room.name,
      POLL_ID,
      encodeURIComponent(POLL_ID),
      RESPONSE_ID,
      END_ID,
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(Object.keys(messagePollSecrets(STAGE.id, { run: 'trn-p' }))).toEqual(
      ['SECRET_POLL_CREATE_VOTE_END_RUN'],
    );
    expect(() => messagePollSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messagePollSecrets(STAGE.id, { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
    const journey = read(JOURNEYS);
    for (const step of [
      'protect(context, { room: { name } });',
      'protect(context, { account });',
      'protect(context, { room: { id: room.id } });',
      'protect(context, { eventIds: [pollId] });',
    ])
      expect(journey).toContain(step);
    expect(
      journey.indexOf('context.safety.unsafeSecrets = false;'),
    ).toBeGreaterThan(
      journey.indexOf('protect(context, { room: { id: room.id } });'),
    );
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier and credential', async () => {
    const { messagePollSecrets, scanMessagePollArtifacts } =
      await loadArtifacts();
    const secrets = messagePollSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-poll-scan-', async (output) => {
      await mkdir(join(output, STAGE.id));
      const receipt = join(output, STAGE.id, 'receipt-01-tray-open.json');
      for (const unsafe of [
        `GET /rooms/${ARTIFACT_IDS.room.id}/messages`,
        JSON.stringify({ password: ARTIFACT_IDS.account.password }),
        `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_IDS.room.id))}/event/${mixedCase(encodeURIComponent(POLL_ID))}`,
        `double=${encodeURIComponent(encodeURIComponent(ARTIFACT_IDS.room.id))}`,
        `route=/rooms/${Buffer.from(ARTIFACT_IDS.room.id).toString('base64url')}`,
        `slice=${ARTIFACT_IDS.room.id.slice(1)}`,
        `selector=.scroll .msg[data-mid="${POLL_ID}"]`,
        `relates=${RESPONSE_ID}`,
        `end=${END_ID}`,
        `question=Best fruit ${ARTIFACT_IDS.run}?`,
        `name=${ARTIFACT_IDS.room.name}`,
        `account=${encodeURIComponent(ARTIFACT_IDS.account.userId)}`,
        'Authorization: Bearer unregistered-token',
        'token=syt_dW5yZWdpc3RlcmVk_abc',
        '<map><string name="CapacitorStorage.trinity">{}</string></map>',
        'pluginId: Preferences, methodName: get, methodData: {"key":"trinity.appearance.mode"}',
      ]) {
        await writeFile(receipt, unsafe);
        await expect(
          scanMessagePollArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(receipt, '{"total":"1 vote","server":"localhost"}\n');
      await expect(
        scanMessagePollArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of ['capture.png', 'capture.PNG', 'opaque.bin'])
        await withOutput('trinity-poll-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(scanMessagePollArtifacts(other, {})).rejects.toThrow();
        });
    });
  });

  it('scrubs raw and encoded identifiers, deletes rasters and then scans clean', async () => {
    const {
      messagePollSecrets,
      scrubMessagePollArtifacts,
      scanMessagePollArtifacts,
    } = await loadArtifacts();
    const secrets = messagePollSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-poll-scrub-', async (output) => {
      const stage = join(output, STAGE.id);
      await mkdir(stage);
      const path = join(stage, 'passed-ui.json');
      await writeFile(
        path,
        [
          `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_IDS.room.id))}/messages`,
          `row=.scroll .msg[data-mid=${JSON.stringify(POLL_ID)}]`,
          `question=Best fruit ${ARTIFACT_IDS.run}?`,
          JSON.stringify({ password: ARTIFACT_IDS.account.password }),
          'unchanged=1 vote · Final results',
        ].join('\n'),
      );
      await writeFile(join(stage, 'passed.png'), 'raster');
      await scrubMessagePollArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe(
        'unchanged=1 vote · Final results',
      );
      for (const leaked of [
        ARTIFACT_IDS.room.id,
        POLL_ID,
        ARTIFACT_IDS.run,
        'poll-pass',
      ])
        expect(scrubbed).not.toContain(leaked);
      expect(scrubbed).toContain('[REDACTED]');
      expect(existsSync(join(stage, 'passed.png'))).toBe(false);
      await expect(
        scanMessagePollArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
    // The suite's own pass removes rasters even before any secret is registered.
    await withOutput('trinity-poll-scrub-raster-', async (output) => {
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        await writeFile(join(output, name), 'raster');
      await scrubMessagePollArtifacts(output, {});
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        expect(existsSync(join(output, name))).toBe(false);
      await expect(
        scanMessagePollArtifacts(output, {}),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried one-stage 10-record run', async () => {
    const artifacts = await loadArtifacts();
    const { MESSAGE_POLL_STAGES } = await loadContract();
    const { PIXEL_5_ACCOUNT_PROFILE } = await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 10,
      attempt: 1,
      retries: 0,
      stages: MESSAGE_POLL_STAGES.map((entry) => ({
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
    await withOutput('trinity-poll-gate-', async (output) => {
      const marker = join(output, 'publication-safe');
      const write = (path, value) =>
        writeFile(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
      const provenance = {
        schemaVersion: 1,
        profile: {
          requested: PIXEL_5_ACCOUNT_PROFILE,
          digest: sha256(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
        },
      };
      const arrange = async (value = report()) => {
        await write('journeys.json', value);
        await write('runtime-provenance.json', provenance);
        await mkdir(join(output, STAGE.id), { recursive: true });
        await write(join(STAGE.id, 'profile-applied.json'), {
          requested: PIXEL_5_ACCOUNT_PROFILE,
        });
        for (const name of [
          'passed.json',
          'passed-ui.json',
          'passed-surface.json',
        ])
          await write(join(STAGE.id, name), { ok: true });
      };
      const refused = async (value, options = {}) => {
        await writeFile(marker, 'stale\n');
        await expect(
          artifacts.markMessagePollDiagnosticsSafe(
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
      await artifacts.markMessagePollDiagnosticsSafe(
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
        mutate((value) => (value.status = 'failed')),
        mutate((value) => (value.attempt = 2)),
        mutate((value) => (value.retries = 1)),
        mutate((value) => value.stages.pop()),
        mutate((value) => (value.stages[0].status = 'failed')),
        mutate((value) => (value.stages[0].retries = 1)),
        mutate((value) => (value.stages[0].failureCount = 1)),
        mutate((value) => {
          value.stages[0].assertions.pop();
          value.stages[0].assertionRecords = 9;
        }),
        mutate((value) => {
          value.stages[0].assertions[9] = value.stages[0].assertions[8];
        }),
        mutate((value) => (value.expectedAssertionRecords = 9)),
      ]) {
        await arrange(invalid);
        await refused(invalid);
      }
      await arrange();
      await refused(mutate((value) => (value.stages[0].status = 'failed')));
      for (const unsafe of [
        { ...flags, unsafeSecrets: true },
        { ...flags, cleanupFailed: true },
        { ...flags, scrubFailed: true },
      ])
        await refused(report(), { flags: unsafe });
      const aborted = new AbortController();
      aborted.abort();
      await refused(report(), { signal: aborted.signal });
      for (const missing of [
        join(STAGE.id, 'profile-applied.json'),
        join(STAGE.id, 'passed-ui.json'),
        'runtime-provenance.json',
      ]) {
        await arrange();
        await rm(join(output, missing));
        await refused(report());
      }
      await arrange();
      await write(join(STAGE.id, 'profile-applied.json'), {
        requested: { ...PIXEL_5_ACCOUNT_PROFILE, width: 1280 },
      });
      await refused(report());
      await arrange();
      await write(join(STAGE.id, 'passed-surface.json'), {
        url: `https://localhost/rooms/${Buffer.from(ARTIFACT_IDS.room.id).toString('base64url')}`,
      });
      await refused(report(), {
        secrets: artifacts.messagePollSecrets(STAGE.id, ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, STAGE.id, 'passed.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const { runMessagePollStageCleanup, revokeMessagePollPublicationOnAbort } =
      await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessagePollStageCleanup(
      [
        async () => {
          ran.push('close');
          throw new Error('client close failed');
        },
        async () => {
          ran.push('clear');
        },
      ],
      failures,
    );
    expect(ran).toEqual(['close', 'clear']);
    expect(failures).toHaveLength(1);
    await withOutput('trinity-poll-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessagePollPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessagePollPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-poll publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Hosted wiring and parity ledger                                           */
/* ------------------------------------------------------------------------ */

const NX_COMMAND =
  '--suite=android.message-poll --timeout-ms=1200000 --entrypoint=e2e/android/message-poll-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "1" ]; then echo \'message-poll-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1500000 -- pnpm exec nx run trinity-e2e-android:message-poll; fi';
const GATE_PATH =
  "-path '*/android.message-poll/message-poll/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-poll-started == 'true' && steps.message-poll-artifact-gate.outputs.message-poll-safe == 'true' }}";

function wiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
    ciSpec: read('scripts/ci-workflow.spec.mjs'),
  };
}

/** Every hosted wiring rule, as a pure function of the files' text. */
function assertWiring({ project, pkg, workflow, ciSpec }) {
  const target = project.targets['message-poll'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-poll']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-poll',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(
    lines.filter((line) => line.includes('trinity-e2e-android:message-poll')),
  ).toHaveLength(1);
  expect(lines[runner - 1]).toContain("echo 'message-linkify-started=true'");
  expect(
    lines
      .filter((line) => line.startsWith('if [ "${{ matrix.shard }}" = "1" ]'))
      .at(-1),
  ).toBe(CI_LINE);
  const gate = workflow
    .split('      - name: Gate Android message-poll diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-poll-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-poll-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain('echo \'message-poll-safe=true\' >> "$GITHUB_OUTPUT"');
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-poll\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-poll/**',
  );
  expect(workflow).toContain('# shard 1 about 113 native minutes,');
  expect(workflow).toContain(
    "# 1's a provisional 6-8 minutes for message-poll.",
  );
  expect(ciSpec).toContain('expect(uploads.length).toBe(77);');
  expect(ciSpec).toContain('expect(lines).toHaveLength(70);');
  expect(ciSpec).toContain("step.with.surface === 'android-message-poll'");
  expect(ciSpec).toContain(
    'runs message-poll after message-linkify at the end of shard 1',
  );
  expect(ciSpec).toContain(
    'budgets message-poll in the shard-1 figure of the Android budget comment',
  );
}

describe('Android message-poll hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-poll',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-poll',
      canonicalScript: 'e2e:android:message-poll',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      CONTRACT,
      OBSERVER,
      ARTIFACTS,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-poll',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-poll',
        command: 'nx run trinity-e2e-android:message-poll',
        kind: 'canonical',
        suiteIds: ['android.message-poll'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-poll'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "1" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-poll',
    );
    expect(read(JOURNEYS)).toContain('timeout: 900_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-poll']);
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
            'message-poll-journeys.mts',
            'message-markdown-journeys.mts',
          )),
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:message-poll'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "1"', '= "2"')),
      withText('workflow', CI_LINE, CI_LINE.replace('1500000', '900000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-poll/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-poll-started == 'true' }}",
      ),
      withText(
        'workflow',
        'shard 1 about 113 native minutes',
        'shard 1 about 105 native minutes',
      ),
      withText(
        'ciSpec',
        'expect(uploads.length).toBe(77);',
        'expect(uploads.length).toBe(76);',
      ),
      withText(
        'ciSpec',
        'expect(lines).toHaveLength(70);',
        'expect(lines).toHaveLength(69);',
      ),
    ])
      expect(() => assertWiring(mutated)).toThrow();
    // The runner moved before message-linkify.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === CI_LINE);
    const [line] = lines.splice(index, 1);
    lines.splice(index - 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 10 identities with their source lines and the 8/2 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-poll journey')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-poll\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[4])).toEqual(ALL_IDENTITIES);
    expect(rows.map((row) => row[2].trim())).toEqual(
      ledgerTuples().map((tuple) =>
        tuple[0] === 'direct' ? String(tuple[1]) : `${tuple[1]}@${tuple[3]}`,
      ),
    );
    expect(rows.map((row) => row[1])).toEqual(
      ALL_IDENTITIES.map(() => STAGE.id),
    );
    expect(rows.map((row) => row[3])).toEqual(
      ledgerTuples().map((tuple) => tuple[0]),
    );
    expect(section).toContain('8 direct + 2');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-poll`');
    expect(section).toMatch(/remains enabled and untouched/u);
    expect(section).toContain('acceptance gate for #749');
    expect(section).not.toContain('pnpm exec nx');
  });
});

/* ------------------------------------------------------------------------ */
/* Source rules: journeys, observer and artifacts                            */
/* ------------------------------------------------------------------------ */

const FORBIDDEN_TOKENS = [
  ['.click(', /\.click\(/u],
  ['.focus(', /\.focus\(/u],
  ['focusFixture', /focusFixture/u],
  ['dispatchEvent', /dispatchEvent/u],
  ['scrollIntoView(', /scrollIntoView\(/u],
  ['.submit(', /\.submit\(|requestSubmit/u],
  ['navigate(', /\bnavigate\(/u],
  ['reload(', /\breload\(/u],
  ['installDocumentScript', /installDocumentScript/u],
  ['execCommand', /execCommand/u],
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
  ['location =', /location\s*=(?!=)|location\.href\s*=(?!=)/u],
  ['location.assign', /location\.(?:assign|replace)\(/u],
  ['Input.dispatch', /Input\.dispatch/u],
  [
    'REST poll seed',
    /sendMessage\(|sendEvent\(|\/send\/m\.poll|\/send\/org\.matrix\.msc3381|\/send\/m\.room\.message/u,
  ],
  ['seedPreference', /seedPreference/u],
  ['trinity-e2e-shared-secret', /trinity-e2e-shared-secret/u],
  ['non-zero retries', /retries:(?!\s*0\b)/u],
];

function assertNoForbiddenTokens(source, name) {
  for (const [token, pattern] of FORBIDDEN_TOKENS)
    expect(pattern.test(source), `${name} must not contain ${token}`).toBe(
      false,
    );
}

/** Every polling wait carries an explicit finite bound argument. */
function assertBoundedWaits(source, name) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText(tree).split('.').at(-1);
      if (called === 'waitForNativeShellState' || called === 'waitElements') {
        const bound = node.arguments[4];
        expect(
          bound,
          `${name}: ${node.getText(tree).slice(0, 80)} is bounded`,
        ).toBeDefined();
        expect(bound.getText(tree)).not.toMatch(/Infinity|undefined/u);
      }
      if (['readComposer', 'readTimeline', 'readPollDialog'].includes(called)) {
        const options = node.arguments[1];
        if (options)
          expect(options.getText(tree), `${name}: bounded read`).toMatch(
            /timeoutMs:\s*[A-Z_]+|timeoutMs,/u,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/** The house read-only observer rule, applied to the journeys too. */
function assertReadOnlyObserver(source) {
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

function functionSource(source, name) {
  const tree = ts.createSourceFile(
    'journeys.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let match;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      match = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(match, `${name} must be declared`).toBeDefined();
  return match.getText(tree);
}

const recordOf = (suffix) =>
  new RegExp(`\\brecord\\(\\s*\\w+,\\s*'${suffix}'`, 'u');
const callOf = (name) => new RegExp(`\\b${name}\\(`, 'u');

function assertOrder(body, steps, name) {
  let at = -1;
  for (const step of steps) {
    const pattern = new RegExp(step.source, 'gu');
    pattern.lastIndex = at + 1;
    const found = pattern.exec(body);
    expect(found, `${name}: ${step} after offset ${at}`).not.toBeNull();
    at = found.index;
  }
}

/** The native order and invariants required by the issue. */
function assertJourneyRules(journeys) {
  assertNoForbiddenTokens(journeys, JOURNEYS);
  assertReadOnlyObserver(journeys);
  assertBoundedWaits(journeys, JOURNEYS);
  expect(journeys).not.toMatch(/evaluateNative|webview\./u);
  expect(journeys).not.toMatch(
    /client\.(?:fill|replace|tap|key|keyCombination)\(/u,
  );
  const stage = functionSource(journeys, 'runCreateVoteEnd');
  assertOrder(
    stage,
    [
      callOf('arrangeStage'),
      callOf('startNative'),
      /client\.login\(account\)/u,
      /client\.hideKeyboard\(\)/u,
      callOf('openRoom'),
      recordOf('insert-tray'),
      recordOf('no-inline-poll'),
      /createPollNatively\(context, question\)/u,
      recordOf('poll-visible'),
      recordOf('poll-question'),
      recordOf('zero-votes'),
      recordOf('server-echo'),
      /serverPollChain\(context, account, room, 'start', chain\)/u,
      /client\.tapCurrent\('\[data-testid="poll"\] \.poll__option', \{ text: MESSAGE_POLL_OPTIONS\[0\] \}\)/u,
      /serverPollChain\(context, account, room, 'response', chain\)/u,
      recordOf('one-vote'),
      recordOf('one-hundred-percent'),
      /client\.tapCurrent\('\[data-testid="poll-end"\]'\)/u,
      /serverPollChain\(context, account, room, 'end', chain\)/u,
      recordOf('final-results'),
    ],
    'runCreateVoteEnd',
  );
  expect(stage.match(/client\.tapCurrent\(/gu)).toHaveLength(2);
  const create = functionSource(journeys, 'createPollNatively');
  assertOrder(
    create,
    [
      /client\.tapCurrent\('\[data-testid="composer-insert"\]'\)/u,
      /client\.waitElements\(TRAY_SHEET/u,
      /client\.tapCurrent\('\[data-testid="insert-poll"\]'\)/u,
      /assertPollDialogOpen/u,
      /client\.fillFocused\(QUESTION, question, FIELD_SENTINEL\)/u,
      /client\.focusCurrent\(field\)/u,
      /client\.fillFocused\(field, MESSAGE_POLL_OPTIONS\[index\]!, FIELD_SENTINEL\)/u,
      /assertPollDraft/u,
      /client\.tapCurrent\('\[data-testid="poll-create"\]'\)/u,
      /client\.waitElements\('\[role="dialog"\]'/u,
    ],
    'createPollNatively',
  );
  expect(create).not.toMatch(/focusCurrent\(QUESTION\)/u);
  const openRoom = functionSource(journeys, 'openRoom');
  assertOrder(
    openRoom,
    [
      /client\.tapCurrent\('\[data-testid="rail-rooms"\]'\)/u,
      /client\.tapCurrent\('\.channel', \{ text: room\.name \}\)/u,
      recordOf('room-ready'),
    ],
    'openRoom',
  );
  const chain = functionSource(journeys, 'serverPollChain');
  expect(chain).toMatch(
    /context\.fixtures\.roomMessages\(account, room\.id\)/u,
  );
  expect(chain).toMatch(/authoritativePollEvents\(/u);
  expect(chain).toMatch(/CHAIN_MS/u);
  // Native actions log their selectors to stdout, the published job log and
  // process.log, which the artifact scan does not cover: no selector may carry
  // a Room or event identifier.
  expect(journeys).not.toMatch(/data-mid(?:\^|\$|\*)?=/u);
  for (const call of journeys.matchAll(/client\.(?:\w+)\(([^;]*?)\);/gsu))
    expect(call[1], call[0]).not.toMatch(
      /\$\{[^}]*(?:Id|\.id)\b[^}]*\}|pollId|rowId/u,
    );
  const runner = functionSource(journeys, 'runMessagePollSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /createAccountFixtures\(/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /MESSAGE_POLL_STAGES/u,
      /runMessagePollStageCleanup\(/u,
      /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
    ],
    'runMessagePollSuite',
  );
  for (const required of [
    'expectedStages: 1',
    'expectedAssertionRecords: 10',
    'attempt: 1',
    'retries: 0',
    'markMessagePollDiagnosticsSafe(',
    'scrubMessagePollArtifacts(',
    'revokeMessagePollPublicationOnAbort(',
    "client.capture('passed')",
    "client.capture('failed')",
    'client.reset(PIXEL_5_ACCOUNT_PROFILE)',
    'profile: PIXEL_5_ACCOUNT_PROFILE',
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  ])
    expect(journeys).toContain(required);
}

describe('Android message-poll source rules', () => {
  it('keeps the observer and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [OBSERVER, ARTIFACTS, CONTRACT]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    assertReadOnlyObserver(read(OBSERVER));
    expect(read(ARTIFACTS)).not.toMatch(
      /message-markdown-artifacts|message-links-artifacts/u,
    );
  });

  it('fails the forbidden-token and read-only rules under each effective mutation', () => {
    const observer = read(OBSERVER);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'input.value = "Apple"',
      "document.execCommand('insertText', false, 'x')",
      'element.dispatchEvent(new MouseEvent("click"))',
      'option.classList.add("poll__option--chosen")',
      'option.setAttribute("aria-pressed", "true")',
      'poll.style.opacity = "1"',
      'window.location = "/rooms"',
      'await fixtures.sendEvent(account, room.id, "m.poll.response", {})',
      'await request.put(`/rooms/${id}/send/m.poll.end/txn`)',
      'const report = { retries: 1 }',
    ])
      expect(() =>
        assertNoForbiddenTokens(`${observer}\n${mutation}`, OBSERVER),
      ).toThrow();
    for (const mutation of [
      'element.click()',
      'input.focus()',
      'input.setSelectionRange(0, 0)',
      'input.value = "x"',
      'row.appendChild(node)',
    ])
      expect(() =>
        assertReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    for (const unbounded of [
      'await waitForNativeShellState(read, accepts, "x", signal);',
      'await client.waitElements(TRAY_SHEET, accepts, "x");',
    ])
      expect(() =>
        assertBoundedWaits(`${observer}\n${unbounded}`, OBSERVER),
      ).toThrow();
  });

  it('orders each focused-fill key after the caret the previous chord moved', () => {
    const client = read('e2e/android/account-workspace-client.mts');
    const fill = (source) => {
      const start = source.indexOf('  async fillFocused(');
      return source.slice(start, source.indexOf('\n  }\n', start));
    };
    const steps = [
      /await this\.keyCombination\('documentStart'\);/u,
      /await this\.waitForNativeCaret\(selector, 'start'\);/u,
      /await this\.key\('forwardDelete'\);/u,
      /await this\.keyCombination\('documentEnd'\);/u,
      /await this\.waitForNativeCaret\(selector, 'end'\);/u,
      /await this\.key\('space'\);/u,
    ];
    assertOrder(fill(client), steps, 'fillFocused');
    const wait = client.slice(
      client.indexOf('  private async waitForNativeCaret('),
    );
    expect(wait.slice(0, wait.indexOf('\n  }\n'))).toMatch(
      /waitForNativeShellState\([\s\S]*this\.signal,\s*5_000,\s*\)/u,
    );
    assertReadOnlyObserver(wait.slice(0, wait.indexOf('\n  }\n')));
    for (const removed of [
      "        await this.waitForNativeCaret(selector, 'start');\n",
      "        await this.waitForNativeCaret(selector, 'end');\n",
    ]) {
      expect(client).toContain(removed);
      expect(() =>
        assertOrder(fill(client.replace(removed, '')), steps, 'fillFocused'),
      ).toThrow();
    }
  });

  it('drives every product action natively in source order', () => {
    const journeys = read(JOURNEYS);
    assertJourneyRules(journeys);
    const replace = (from, to) => {
      expect(journeys).toMatch(from);
      return journeys.replace(from, to);
    };
    for (const mutated of [
      // REST seeding or DOM input.
      `${journeys}\nawait fixtures.sendEvent(account, room.id, 'm.poll.start', {});`,
      `${journeys}\nawait evaluateNative(client.webview, 'x');`,
      `${journeys}\nawait client.fill(QUESTION, question);`,
      // The vote is made before the server echo or before the start proof.
      replace(
        /(\s*)await client\.tapCurrent\('\[data-testid="poll"\] \.poll__option', \{ text: MESSAGE_POLL_OPTIONS\[0\] \}\);/u,
        '',
      ).replace(
        '  await createPollNatively(context, question);\n',
        '  await createPollNatively(context, question);\n  await client.tapCurrent(\'[data-testid="poll"] .poll__option\', { text: MESSAGE_POLL_OPTIONS[0] });\n',
      ),
      replace(
        /await serverPollChain\(context, account, room, 'start', chain\);\n/u,
        '',
      ),
      // A tally or final record is taken before its wire proof.
      replace(
        /const \{ responseId \} = await serverPollChain\(context, account, room, 'response', chain\);/u,
        'const responseId = pollId;',
      ),
      replace(
        /const \{ endId \} = await serverPollChain\(context, account, room, 'end', chain\);/u,
        'const endId = pollId;',
      ),
      // The End tap or the Create tap is dropped.
      replace(
        /await client\.tapCurrent\('\[data-testid="poll-end"\]'\);\n/u,
        '',
      ),
      replace(
        /await client\.tapCurrent\('\[data-testid="poll-create"\]'\);\n/u,
        '',
      ),
      // A proof becomes a receipt, or the vote row is targeted by its event id.
      replace(
        /record\(context, 'final-results'/u,
        "receipt(context, 'final-results'",
      ),
      replace(
        /client\.tapCurrent\('\[data-testid="poll"\] \.poll__option', \{ text: MESSAGE_POLL_OPTIONS\[0\] \}\)/u,
        'client.tapCurrent(`.scroll .msg[data-mid="${pollId}"] .poll__option`)',
      ),
      // The question field is re-focused with a Tab-and-tap instead of the product autofocus.
      replace(
        /await client\.fillFocused\(QUESTION, question, FIELD_SENTINEL\);/u,
        'await client.focusCurrent(QUESTION);\n  await client.fillFocused(QUESTION, question, FIELD_SENTINEL);',
      ),
      // The digit sentinel is dropped.
      replace(
        /client\.fillFocused\(field, MESSAGE_POLL_OPTIONS\[index\]!, FIELD_SENTINEL\)/u,
        'client.fillFocused(field, MESSAGE_POLL_OPTIONS[index]!)',
      ),
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });
});
