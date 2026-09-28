import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/message-unread.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
/**
 * Unlike the message-source/spoiler predecessors, message-unread's stays
 * enabled and unchanged in the working tree: it is retired only after hosted
 * acceptance (design "Intent and source boundary"). It is read directly.
 */
const readPredecessor = () => read(predecessor);
const loadContract = () => import('../e2e/android/message-unread-contract.mts');
const loadObserver = () => import('../e2e/android/message-unread-observer.mts');
const loadFixture = () => import('../e2e/android/message-unread-fixture.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-unread-artifacts.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');
const loadJourneys = () => import('../e2e/android/message-unread-journeys.mts');

const JOURNEYS = 'e2e/android/message-unread-journeys.mts';
const OBSERVER_PATH = 'e2e/android/message-unread-observer.mts';
const FIXTURE_PATH = 'e2e/android/message-unread-fixture.mts';
const ARTIFACTS = 'e2e/android/message-unread-artifacts.mts';

/** The predecessor working-tree file, pinned by SHA-256. */
const PREDECESSOR_SHA256 =
  'f66ad80bb41f3cc32fb45935a88ad5a94582d1a8921069517f5f0a891d40b8bd';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const API_TOKEN_SPAN = [21, 40];
const SEND_TEXT_SPAN = [42, 57];
const OPEN_ROOM_SPAN = [59, 67];

/** The design's identity table, verbatim (design doc "Parity records"). */
const STAGE = {
  id: 'divider-jump',
  span: [72, 277],
  title: 'shows a divider and a jump pill for unread messages',
  direct: [168, 171, 184, 185, 206, 217, 240, 246, 256, 267, 272, 275, 276],
  inherited: [[64, 'openRoom', 164]],
  suffixes: [
    'room-ready',
    'divider-text',
    'one-thread-connector',
    'connector-above',
    'connector-below',
    'divider-styled',
    'jump-visible',
    'jump-hidden',
    'smooth-trajectory',
    'reduced-motion-query',
    'jump-visible-at-latest',
    'reduced-jump-hidden',
    'reduced-scrolled',
    'automatic-only',
  ],
};
const ALL_IDENTITIES = STAGE.suffixes.map(
  (suffix) => `message-unread.${STAGE.id}.${suffix}`,
);
const identity = (suffix) => `message-unread.${STAGE.id}.${suffix}`;

const LINE_PINS = {
  72: "test('shows a divider and a jump pill for unread messages', async ({",
  76: "const runId = `${testResourceId('run')}u`;",
  97: 'const roomName = `Unread E2E ${runId}`;',
  116: "'seen already',",
  123: "data: { 'm.fully_read': readEventId, 'm.read': readEventId },",
  129: 'for (let i = 0; i < 14; i++) {',
  135: '`unread message ${i}`,',
  138: 'if (i === 2) threadRoot = eventId;',
  146: "body: 'Thread after the unread marker',",
  148: "rel_type: 'm.thread',",
  183: 'const geometryTolerance = 0.01;',
  184: 'expect(extension.above).toBeGreaterThanOrEqual(8 - geometryTolerance);',
  185: 'expect(extension.below).toBeGreaterThanOrEqual(8 - geometryTolerance);',
  207: "display: 'flex',",
  208: "alignItems: 'center',",
  209: "fontWeight: '600',",
  210: "ruleFlexGrow: '1',",
};

const IMPORTS = `import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';`;

/* -------------------------------------------------------------------------- */
/* Predecessor AST analysis                                                    */
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
 * Expand the definition into parity sites: direct `expect` calls and
 * binding-resolved helper calls to module-local functions or `support/`.
 * Message-unread has no `isAndroidE2E` platform branching to exclude.
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
  expect(source.split('\n')).toHaveLength(279);
  expect(source.split('\n').slice(0, 13).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  expect(assertionLines(source, 1, OPEN_ROOM_SPAN[0] - 1)).toEqual([]);
  expect(assertionLines(source, ...OPEN_ROOM_SPAN)).toEqual([64]);
  expect(
    assertionLines(source, OPEN_ROOM_SPAN[1] + 1, STAGE.span[0] - 1),
  ).toEqual([]);
  expect(assertionLines(source, STAGE.span[1] + 1, 278)).toEqual([]);
  expect(lineAt(source, STAGE.span[1])).toBe('});');
  const expanded = expandDefinition(source, STAGE.span);
  expect(expanded.map(siteTuple)).toEqual(ledgerTuples());
  expect(
    expanded.filter((site) => site.kind === 'direct').map((s) => s.line),
  ).toEqual(STAGE.direct);
  expect(expanded.filter((site) => site.kind === 'inherited')).toHaveLength(1);
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-unread predecessor pins', () => {
  it('pins the predecessor and the two shared helper sources by SHA-256', () => {
    expect(sha256(readPredecessor())).toBe(PREDECESSOR_SHA256);
    for (const [path, hash] of Object.entries(SHARED_SHA256))
      expect(digest(path)).toBe(hash);
    const flipped = Buffer.from(readPredecessor());
    flipped[flipped.length - 2] ^= 1;
    expect(sha256(flipped)).not.toBe(PREDECESSOR_SHA256);
    for (const path of Object.keys(SHARED_SHA256)) {
      const shared = Buffer.from(readFileSync(resolve(root, path)));
      shared[0] ^= 1;
      expect(sha256(shared)).not.toBe(SHARED_SHA256[path]);
    }
  });

  it('pins the same source, spans and one stage in the contract', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_UNREAD_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_UNREAD_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_UNREAD_SOURCE_LINES).toBe(278);
    expect(contract.MESSAGE_UNREAD_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    const span = ([from, to]) => ({ from, to });
    expect(contract.MESSAGE_UNREAD_SPANS).toEqual({
      apiToken: span(API_TOKEN_SPAN),
      sendText: span(SEND_TEXT_SPAN),
      openRoom: span(OPEN_ROOM_SPAN),
      definitions: { [STAGE.id]: span(STAGE.span) },
    });
    expect(existsSync(resolve(root, predecessor))).toBe(true);
  });

  it('maps the exact direct and helper sites with the house AST rule', () => {
    assertPredecessorShape(readPredecessor());
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = readPredecessor();
    const mutations = [
      // The twelve literals the design's arrangement and divider depend on.
      mutateLine(source, 116, () => "      'read already',"),
      mutateLine(source, 135, (line) =>
        line.replace('unread message', 'later message'),
      ),
      mutateLine(source, 129, () => '    for (let i = 0; i < 13; i++) {'),
      mutateLine(source, 138, () => '      if (i === 3) threadRoot = eventId;'),
      mutateLine(source, 146, (line) =>
        line.replace('Thread after', 'Reply after'),
      ),
      mutateLine(source, 148, (line) => line.replace('m.thread', 'm.reply')),
      mutateLine(
        source,
        123,
        () =>
          "        data: { 'm.fully_read': readEventId, 'm.read': threadRoot },",
      ),
      mutateLine(source, 97, (line) =>
        line.replace('Unread E2E', 'Unread Room'),
      ),
      mutateLine(source, 76, (line) => line.replace('}u`', '}un`')),
      mutateLine(source, 184, (line) =>
        line.replace('8 - geometryTolerance', '7.98'),
      ),
      mutateLine(source, 185, (line) =>
        line.replace('8 - geometryTolerance', '7.98'),
      ),
      mutateLine(source, 183, () => '    const geometryTolerance = 0.1;'),
      mutateLine(source, 207, (line) => line.replace('flex', 'block')),
      mutateLine(source, 208, (line) => line.replace('center', 'normal')),
      mutateLine(source, 209, (line) => line.replace('600', '400')),
      mutateLine(source, 210, (line) => line.replace("'1'", "'0'")),
      // A direct site is dropped, added or moved.
      mutateLine(source, 276, () => '    void reduced;'),
      mutateLine(source, 166, (line) => `${line}\n`),
      mutateLine(
        source,
        247,
        () =>
          "    await expect(jump).toHaveAttribute('data-testid', 'jump-to-unread');",
      ),
      // The Room-readiness helper call changes, or loses its own assertion.
      mutateLine(source, 164, () => "    await page.goto('/rooms');"),
      mutateLine(
        source,
        64,
        () => "  await page.getByTestId('composer-input').waitFor({",
      ),
      // The definition title or an import drifts.
      source.replace(
        "test('shows a divider and a jump pill for unread messages'",
        "test('shows the unread divider'",
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

describe('Android message-unread helper expansion by binding', () => {
  it('resolves module-local and imported helper calls through the TypeChecker', () => {
    const { calls } = importedCalls(readPredecessor());
    expect(
      calls
        .filter(
          (call) =>
            call.specifier === null ||
            call.specifier.startsWith('../../../support/'),
        )
        .map((call) => [call.name, call.line]),
    ).toEqual([
      // Module level (line 19), outside the owned definition.
      ['synapseSession', 19],
      ['registerUser', 82],
      ['registerUser', 83],
      ['apiToken', 84],
      ['apiToken', 90],
      ['sendText', 111],
      ['sendText', 130],
      ['login', 158],
      ['openRoom', 164],
    ]);
    // `testResourceId` binds to the fixtures module, outside support/.
    expect(
      calls
        .filter((call) => call.name === 'testResourceId')
        .map((call) => call.specifier),
    ).toEqual(['../../../fixtures.mts']);
  });

  it('follows helper calls and proves apiToken, sendText, login and registerUser add no sites', () => {
    const source = readPredecessor();
    expect(helperExpectLines(predecessor, 'openRoom', source)).toEqual([
      { module: predecessor, line: 64 },
    ]);
    expect(helperExpectLines(predecessor, 'apiToken', source)).toEqual([]);
    expect(helperExpectLines(predecessor, 'sendText', source)).toEqual([]);
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
    // A module-local helper that asserted would add an inherited site per call.
    const asserting = source.replace(
      '  return json.event_id as string;\n}',
      '  expect(json.event_id).toBeTruthy();\n  return json.event_id as string;\n}',
    );
    expect(asserting).not.toBe(source);
    expect(
      expandDefinition(asserting, STAGE.span).filter(
        (site) => site.helper === 'sendText',
      ),
    ).toHaveLength(2);
  });

  it('excludes a shadowing local openRoom, against a naive count', () => {
    const source = readPredecessor();
    const shadowed = source.replace(
      '    await openRoom(page, roomName);',
      '    const openRoom = async (_page: unknown, _name: string) => {};\n    await openRoom(page, roomName);',
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    // `readScrolls` is the predecessor's own local const arrow function, not a shadow.
    expect(locals.map((call) => call.name)).toEqual([
      'openRoom',
      'readScrolls',
      'readScrolls',
    ]);
    expect(
      calls.filter((call) => call.name === 'openRoom' && call.line > 72),
    ).toHaveLength(0);
    expect(
      expandDefinition(shadowed, [STAGE.span[0], STAGE.span[1] + 1]).filter(
        (site) => site.helper === 'openRoom',
      ),
    ).toHaveLength(0);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
    expect(expandDefinition(source, STAGE.span)).toHaveLength(14);
  });

  it('matches the contract sites, identities and helper roles exactly', async () => {
    const contract = await loadContract();
    const source = readPredecessor();
    const expanded = expandDefinition(source, STAGE.span);
    const [stage] = contract.MESSAGE_UNREAD_STAGES;
    expect(stage.sites.map(siteTuple)).toEqual(expanded.map(siteTuple));
    expect(stage.assertions).toEqual(ALL_IDENTITIES);
    expect(stage.sites.map(siteTuple)).not.toEqual(
      expanded.slice(0, -1).map(siteTuple),
    );
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_UNREAD_HELPERS,
    ))
      expect(
        helperExpectLines(
          module,
          helper,
          module === predecessor ? source : undefined,
        ),
      ).toEqual(expectLines.map((line) => ({ module, line })));
    expect(contract.MESSAGE_UNREAD_HELPERS.openRoom.role).toBe(
      'room-readiness',
    );
    expect(Object.keys(contract.MESSAGE_UNREAD_HELPERS)).toEqual(['openRoom']);
  });
});

/* -------------------------------------------------------------------------- */
/* Contract ledger and source fields                                          */
/* -------------------------------------------------------------------------- */

/** Every template literal bound to a name inside a span, read from the AST. */
function predecessorTemplates(source, [from, to]) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const templates = {};
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isTemplateExpression(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer)) &&
      lineOf(tree, node) >= from &&
      lineOf(tree, node) <= to
    )
      templates[node.name.text] = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return templates;
}

describe('Android message-unread contract ledger', () => {
  it('owns one stage, 13 direct + 1 inherited = 14 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_UNREAD_STAGES.map((entry) => entry.id)).toEqual([
      STAGE.id,
    ]);
    const [stage] = contract.MESSAGE_UNREAD_STAGES;
    expect(stage.source).toBe(`${predecessor}:72-277`);
    expect(stage.title).toBe(STAGE.title);
    expect(stage.expectedAssertionRecords).toBe(14);
    expect(contract.MESSAGE_UNREAD_ASSERTION_RECORDS).toBe(14);
    expect(contract.MESSAGE_UNREAD_DIRECT).toBe(13);
    expect(contract.MESSAGE_UNREAD_INHERITED).toBe(1);
    expect(contract.MESSAGE_UNREAD_HELPER_COUNTS).toEqual({ openRoom: 1 });
    expect(new Set(ALL_IDENTITIES).size).toBe(14);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    expect(() =>
      contract.assertMessageUnreadRecords(STAGE.id, ALL_IDENTITIES),
    ).not.toThrow();
    for (const invalid of [
      [],
      ALL_IDENTITIES.slice(0, -1),
      [...ALL_IDENTITIES, ALL_IDENTITIES.at(-1)],
      [...ALL_IDENTITIES].reverse(),
      ALL_IDENTITIES.map((value, index) =>
        index === 1 ? ALL_IDENTITIES[0] : value,
      ),
    ])
      expect(() =>
        contract.assertMessageUnreadRecords(STAGE.id, invalid),
      ).toThrow();
    expect(() =>
      contract.messageUnreadAssertion(STAGE.id, 'not-owned'),
    ).toThrow();
    expect(() =>
      contract.messageUnreadAssertion('not-a-stage', 'room-ready'),
    ).toThrow();
  });

  it('types exactly the predecessor run suffix and Room-name template, plus the Android arrangement constants', async () => {
    const contract = await loadContract();
    expect(predecessorTemplates(readPredecessor(), STAGE.span)).toMatchObject({
      runId: "`${testResourceId('run')}u`",
      roomName: '`Unread E2E ${runId}`',
    });
    expect(contract.MESSAGE_UNREAD_RUN_SUFFIX).toBe('u');
    expect(contract.UNREAD_ROOMS).toEqual(['motion', 'reduced']);
    expect(contract.unreadRoomName('r-1', 'motion')).toBe(
      'Unread E2E r-1-motion',
    );
    expect(contract.unreadRoomName('r-1', 'reduced')).toBe(
      'Unread E2E r-1-reduced',
    );
    expect(contract.SEEN_BODY).toBe('seen already');
    expect(contract.unreadBody(0)).toBe('unread message 0');
    expect(contract.unreadBody(13)).toBe('unread message 13');
    expect(contract.UNREAD_COUNT).toBe(14);
    expect(contract.THREAD_ROOT_INDEX).toBe(2);
    expect(contract.THREAD_BODY).toBe('Thread after the unread marker');
    expect(contract.transactionId('r-1', 'motion', 'a')).toBe('r-1-motion-a');
    expect(contract.GEOMETRY_TOLERANCE).toBe(0.01);
    expect(contract.DIVIDER_STYLE).toEqual({
      display: 'flex',
      alignItems: 'center',
      fontWeight: '600',
      ruleFlexGrow: '1',
    });
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertMessageUnreadReceiptName } = await loadContract();
    for (const name of [
      'divider-visible',
      'jump-tapped',
      'trajectory-default',
      'room-b-marker',
    ])
      expect(() => assertMessageUnreadReceiptName(name)).not.toThrow();
    for (const name of [
      'message-unread.divider-jump.divider-text',
      'message-unread-x',
      'Jump Tapped',
      'a/b',
      '',
    ])
      expect(() => assertMessageUnreadReceiptName(name)).toThrow();
  });

  it('pins the product timeline-divider, jump pills and scroller surfaces the journey relies on', () => {
    const divider = read(
      'libs/feature/rooms/src/lib/message-list/timeline-divider/timeline-divider.component.html',
    );
    for (const hook of [
      'data-testid="new-messages-divider"',
      'class="thread-connector"',
      '>New messages</span>',
    ])
      expect(divider).toContain(hook);
    const dividerStyle = read(
      'libs/feature/rooms/src/lib/message-list/timeline-divider/timeline-divider.component.scss',
    );
    for (const hook of [
      '.new-divider {',
      'display: flex;',
      'align-items: center;',
      '.thread-connector {',
    ])
      expect(dividerStyle).toContain(hook);
    const list = read(
      'libs/feature/rooms/src/lib/message-list/virtual-message-list/virtual-message-list.component.html',
    );
    for (const hook of [
      'data-testid="jump-to-unread"',
      'data-testid="jump-to-latest"',
      'class="scroll" #scroll data-message-scroller',
    ])
      expect(list).toContain(hook);
  });
});

/* -------------------------------------------------------------------------- */
/* Trajectory classifier [RF-2][RF-3]                                         */
/* -------------------------------------------------------------------------- */

describe('Android message-unread trajectory classifier', () => {
  const still = (n, top) =>
    Array.from({ length: n }, (_, i) => [i * 16, top, false]);
  const tail = (from, n, top, inView = true) =>
    Array.from({ length: n }, (_, i) => [(from + i) * 16, top, inView]);
  const path = (start, tops, inView = false) =>
    tops.map((top, i) => [(start + i) * 16, top, inView]);
  const probeSmooth = [
    ...still(40, 298.67),
    ...path(40, [298.2, 270, 187, 153, 106, 80]),
    ...path(46, [80, 138, 138.3]),
    ...tail(49, 60, 137.5),
  ];
  const probeAutomatic = [
    ...still(40, 298.67),
    ...path(40, [43, 43, 43, 43, 80, 80, 80, 138, 138.3]),
    ...tail(49, 60, 138.3),
  ];
  it('classifies the probe trajectories', async () => {
    const c = await loadContract();
    const smooth = c.classifyTrajectory(c.parseTrajectory(probeSmooth));
    // index 40 is a 0.47 px drift, so the first movement is index 41
    expect(smooth).toMatchObject({
      kind: 'smooth',
      longestRun: 5,
      baselineFrames: 41,
      movements: 6,
      settledInView: true,
    });
    expect(() => c.assertSmoothTrajectory(smooth)).not.toThrow();
    const automatic = c.classifyTrajectory(c.parseTrajectory(probeAutomatic));
    expect(automatic).toMatchObject({
      kind: 'automatic',
      longestRun: 1,
      movements: 3,
    });
    expect(() => c.assertReducedScrolled(automatic)).not.toThrow();
    expect(() => c.assertAutomaticOnly(automatic)).not.toThrow();
  });
  it('fails each negative control', async () => {
    const c = await loadContract();
    const k = (s) => c.classifyTrajectory(c.parseTrajectory(s));
    // single jump claimed smooth
    expect(() =>
      c.assertSmoothTrajectory(k([...still(40, 300), ...tail(40, 60, 100)])),
    ).toThrow();
    // smooth run claimed automatic
    expect(() => c.assertAutomaticOnly(k(probeSmooth))).toThrow();
    // a 3-frame run is ambiguous and fails both
    const three = k([
      ...still(40, 300),
      ...path(40, [250, 200, 150]),
      ...tail(43, 60, 150),
    ]);
    expect(three.kind).toBe('ambiguous');
    expect(() => c.assertSmoothTrajectory(three)).toThrow();
    expect(() => c.assertAutomaticOnly(three)).toThrow();
    // no baseline: movement began before the tap
    expect(() => c.assertSmoothTrajectory(k(probeSmooth.slice(30)))).toThrow(
      /baseline/u,
    );
    // no movement at all
    expect(() => c.assertReducedScrolled(k(still(120, 300)))).toThrow();
    // sub-pixel jitter is not movement [RF-3]
    expect(
      k([
        ...still(40, 300),
        ...path(40, [300.4, 300.8, 300.2, 300.6]),
        ...tail(44, 60, 300.6),
      ]).movements,
    ).toBe(0);
    // divider not in view after settling
    expect(() =>
      c.assertSmoothTrajectory(k(probeSmooth.map((s) => [s[0], s[1], false]))),
    ).toThrow(/divider/u);
    // malformed samples
    expect(() => c.parseTrajectory([[0, '1', true]])).toThrow();
    expect(() => c.parseTrajectory({ samples: [] })).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only renderer observation and sampler (jsdom)                         */
/* -------------------------------------------------------------------------- */

const SCROLLER_BOX = { left: 0, top: 56, right: 393, bottom: 472 };
const DIVIDER_BOX = { left: 16, top: 20, right: 377, bottom: 44 };
const CONNECTOR_BOX = { left: 24, top: 12, right: 26, bottom: 52 };
const JUMP_BOX = { left: 135, top: 225, right: 257, bottom: 269 };
const LATEST_BOX = { left: 333, top: 555, right: 377, bottom: 599 };
const rect = ({ left, top, right, bottom }) => ({
  x: left,
  y: top,
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

function unreadWindow(body, options = {}) {
  const dom = new JSDOM(`<main>${body}</main>`);
  const { window } = dom;
  // jsdom implements no layout, so `innerText` is undefined; fall back to `textContent`.
  if (!('innerText' in window.HTMLElement.prototype))
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent ?? '';
      },
      configurable: true,
    });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('.scroll[data-message-scroller]'))
      return rect(options.scrollerBox ?? SCROLLER_BOX);
    if (this.matches('[data-testid="new-messages-divider"]'))
      return rect(options.dividerBox ?? DIVIDER_BOX);
    if (this.matches('.thread-connector'))
      return rect(options.connectorBox ?? CONNECTOR_BOX);
    if (this.matches('[data-testid="jump-to-unread"]'))
      return rect(options.jumpBox ?? JUMP_BOX);
    if (this.matches('[data-testid="jump-to-latest"]'))
      return rect(options.latestBox ?? LATEST_BOX);
    return rect({ left: 0, top: 0, right: 0, bottom: 0 });
  };
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element, pseudo) => {
    const isDivider =
      typeof element.matches === 'function' &&
      element.matches('[data-testid="new-messages-divider"]');
    if (pseudo === '::before' && isDivider)
      return { flexGrow: options.styled === false ? '0' : '1' };
    if (isDivider)
      return options.styled === false
        ? {
            display: 'block',
            alignItems: 'normal',
            fontWeight: '400',
            visibility: 'visible',
          }
        : {
            display: 'flex',
            alignItems: 'center',
            fontWeight: '600',
            visibility: 'visible',
          };
    return {
      ...computed(element),
      visibility: options.hidden?.includes(element.dataset?.testid)
        ? 'hidden'
        : 'visible',
    };
  };
  window.matchMedia = (query) => ({
    matches:
      query === '(prefers-reduced-motion: reduce)' && !!options.reducedMotion,
  });
  if (options.scrollTop !== undefined) {
    const scroller = window.document.querySelector(
      '.scroll[data-message-scroller]',
    );
    if (scroller) {
      Object.defineProperties(scroller, {
        scrollTop: { get: () => options.scrollTop },
        scrollHeight: { get: () => options.scrollHeight ?? 810 },
        clientHeight: { get: () => options.clientHeight ?? 416 },
      });
    }
  }
  return window;
}

function evaluateIn(body, expression, options = {}) {
  const window = unreadWindow(body, options);
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

const dividerHtml = (connectors = 1, text = 'New messages') =>
  `<div data-testid="new-messages-divider">${'<span class="thread-connector"></span>'.repeat(connectors)}<span>${text}</span></div>`;
const sceneHtml = ({
  dividers = 1,
  connectors = 1,
  jump = true,
  latest = false,
  scroller = true,
} = {}) => {
  const dividersHtml = Array.from({ length: dividers }, () =>
    dividerHtml(connectors),
  ).join('');
  const scrollerHtml = scroller
    ? `<div class="scroll" data-message-scroller>${dividersHtml}</div>`
    : dividersHtml;
  // The mocked getBoundingClientRect ignores CSS, so "hidden" means absent, not styled away.
  const jumpHtml = jump ? '<button data-testid="jump-to-unread"></button>' : '';
  const latestHtml = latest
    ? '<button data-testid="jump-to-latest"></button>'
    : '';
  return `${scrollerHtml}${jumpHtml}${latestHtml}`;
};

describe('Android message-unread read-only renderer observation (jsdom)', () => {
  it('observes the scroller, one divider, its one connector and the jump pill', async () => {
    const contract = await loadContract();
    const { unreadViewExpression } = await loadObserver();
    const observe = (body, options) =>
      contract.parseUnreadView(
        evaluateIn(body, unreadViewExpression(), options),
      );
    const view = observe(sceneHtml());
    expect(view.scroller).not.toBeNull();
    expect(view.divider).toMatchObject({
      count: 1,
      textContent: 'New messages',
      connectorCount: 1,
    });
    expect(view.divider.innerText).toBeTypeOf('string');
    expect(view.jump).toMatchObject({ count: 1, visible: true });
    expect(view.latest).toMatchObject({ count: 0, visible: false });
    expect(() => contract.assertDividerText(view)).not.toThrow();
    expect(() => contract.assertOneConnector(view)).not.toThrow();
    expect(() => contract.assertJumpVisible(view)).not.toThrow();
    const reduced = observe(sceneHtml(), { reducedMotion: true });
    expect(reduced.reducedMotion).toBe(true);
    expect(() =>
      contract.assertReducedMotionQuery(reduced.reducedMotion),
    ).not.toThrow();
    expect(() =>
      contract.assertReducedMotionQuery(view.reducedMotion),
    ).toThrow();
  });

  it('observes two connectors, two dividers or a missing scroller as such', async () => {
    const contract = await loadContract();
    const { unreadViewExpression } = await loadObserver();
    const observe = (body) =>
      contract.parseUnreadView(evaluateIn(body, unreadViewExpression()));
    const twoConnectors = observe(sceneHtml({ connectors: 2 }));
    expect(twoConnectors.divider.connectorCount).toBe(2);
    expect(() => contract.assertOneConnector(twoConnectors)).toThrow();
    const twoDividers = observe(sceneHtml({ dividers: 2 }));
    expect(twoDividers.divider.count).toBe(2);
    expect(() => contract.assertDividerText(twoDividers)).toThrow();
    const missingScroller = observe(sceneHtml({ scroller: false }));
    expect(missingScroller.scroller).toBeNull();
    expect(() => contract.assertDividerOffAbove(missingScroller)).toThrow();
    expect(() => contract.assertAtBottom(missingScroller)).toThrow();
  });

  it('measures the connector extension and the divider style, and rejects a missing style', async () => {
    const contract = await loadContract();
    const { unreadViewExpression } = await loadObserver();
    const observe = (body, options) =>
      contract.parseUnreadView(
        evaluateIn(body, unreadViewExpression(), options),
      );
    const view = observe(sceneHtml());
    expect(view.divider.above).toBeCloseTo(
      DIVIDER_BOX.top - CONNECTOR_BOX.top,
      5,
    );
    expect(view.divider.below).toBeCloseTo(
      CONNECTOR_BOX.bottom - DIVIDER_BOX.bottom,
      5,
    );
    expect(() => contract.assertConnectorAbove(view)).not.toThrow();
    expect(() => contract.assertConnectorBelow(view)).not.toThrow();
    expect(() => contract.assertDividerStyled(view)).not.toThrow();
    const unstyled = observe(sceneHtml(), { styled: false });
    expect(() => contract.assertDividerStyled(unstyled)).toThrow();
    const short = observe(sceneHtml(), {
      connectorBox: {
        left: 24,
        top: DIVIDER_BOX.top + 4,
        right: 26,
        bottom: DIVIDER_BOX.bottom - 4,
      },
    });
    expect(() => contract.assertConnectorAbove(short)).toThrow();
    expect(() => contract.assertConnectorBelow(short)).toThrow();
  });

  it('parses only a complete unread-view observation', async () => {
    const { parseUnreadView } = await loadContract();
    const good = {
      scroller: null,
      divider: null,
      jump: { count: 0, visible: false, box: null },
      latest: { count: 0, visible: false, box: null },
      reducedMotion: false,
    };
    expect(() => parseUnreadView(good)).not.toThrow();
    for (const malformed of [
      null,
      { ...good, jump: undefined },
      { ...good, reducedMotion: 'no' },
      { ...good, jump: { count: '1', visible: true, box: null } },
      {
        ...good,
        divider: {
          count: 1,
          textContent: '',
          innerText: '',
          box: null,
          connectorCount: 0,
          above: 0,
          below: 0,
          display: '',
          alignItems: '',
          fontWeight: '',
          ruleFlexGrow: '',
        },
      },
    ])
      expect(() => parseUnreadView(malformed)).toThrow();
  });

  it('starts the sampler once per never-reused key and rejects a non-positive-integer window', async () => {
    const { samplerKey, startSamplerExpression, readSamplerExpression } =
      await loadObserver();
    const window = unreadWindow(sceneHtml());
    const run = (expression) =>
      runInNewContext(expression, {
        window,
        document: window.document,
        requestAnimationFrame: () => 0,
      });
    const key = samplerKey(1);
    expect(run(startSamplerExpression(key))).toBe(true);
    expect(run(startSamplerExpression(key))).toBe(false);
    const anotherKey = samplerKey(2);
    expect(anotherKey).not.toBe(key);
    expect(run(startSamplerExpression(anotherKey))).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    expect(descriptor).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false,
    });
    expect(Object.keys(window)).not.toContain(key);
    expect(Object.keys(window)).not.toContain(anotherKey);
    const read = run(readSamplerExpression(key));
    expect(read).toMatchObject({ done: false, samples: [] });
    for (const n of [0, -1, 1.5, Number.NaN, Infinity, '1'])
      expect(() => samplerKey(n)).toThrow();
    expect(() => startSamplerExpression('not-a-key')).toThrow();
    expect(() => readSamplerExpression('not-a-key')).toThrow();
  });

  it('keeps the sampler passive: rAF, a 45s tap window, a 120s ceiling, 60-frame stillness, and read-only scrollTop', async () => {
    const { startSamplerExpression } = await loadObserver();
    const source = startSamplerExpression('__trinityUnreadTrajectory1');
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('45000');
    expect(source).toContain('120000');
    expect(source).toContain('>= 60');
    expect(source).toContain('.scrollTop');
    for (const forbidden of [
      // `Object.prototype.hasOwnProperty.call` is a read; only a REASSIGNED
      // prototype method (the predecessor's own `Element.prototype.scrollIntoView =`)
      // is forbidden.
      /scrollTop\s*=[^=]/u,
      /\.scrollTo\(/u,
      /scrollIntoView/u,
      /\.click\(/u,
      /\.focus\(/u,
      /dispatchEvent/u,
      /\.prototype\.\w+\s*=[^=]/u,
    ])
      expect(source).not.toMatch(forbidden);
  });

  /** Drive one sampler window with a manual rAF clock and a controllable scroller. */
  async function samplerHarness() {
    const { samplerKey, startSamplerExpression, readSamplerExpression } =
      await loadObserver();
    const window = unreadWindow(sceneHtml());
    const { document } = window;
    const scroller = document.querySelector('.scroll[data-message-scroller]');
    const divider = scroller.querySelector(
      '[data-testid="new-messages-divider"]',
    );
    const view = { top: 394.3, inView: false };
    Object.defineProperty(scroller, 'scrollTop', { get: () => view.top });
    divider.getBoundingClientRect = () =>
      rect(
        view.inView
          ? { left: 16, top: 300, right: 377, bottom: 324 }
          : DIVIDER_BOX,
      );
    let pending;
    let now = 0;
    const run = (expression) =>
      runInNewContext(expression, {
        window,
        document,
        requestAnimationFrame: (callback) => {
          pending = callback;
          return 1;
        },
      });
    const key = samplerKey(1);
    expect(run(startSamplerExpression(key))).toBe(true);
    return {
      view,
      frames(ms) {
        for (const end = now + ms; now < end && pending; now += 16) {
          const callback = pending;
          pending = undefined;
          callback(now);
        }
      },
      tap: () =>
        document
          .querySelector('[data-testid="jump-to-unread"]')
          .dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
      read: () => run(readSamplerExpression(key)),
      scheduled: () => pending !== undefined,
    };
  }

  it('anchors the 45 s window at the observed tap, not at the sampler start [RF-2]', async () => {
    const c = await loadContract();
    const sampler = await samplerHarness();
    sampler.frames(46_000);
    expect(sampler.read().done).toBe(false);
    sampler.tap();
    sampler.frames(32);
    Object.assign(sampler.view, { top: 138.3, inView: true });
    sampler.frames(2_000);
    const window = sampler.read();
    expect(window).toMatchObject({
      done: true,
      tapped: true,
      ended: 'settled',
    });
    expect(sampler.scheduled()).toBe(false);
    const automatic = c.classifyTrajectory(c.parseSamplerWindow(window));
    expect(automatic).toMatchObject({
      kind: 'automatic',
      movements: 1,
      settledInView: true,
    });
    expect(() => c.assertReducedScrolled(automatic)).not.toThrow();
    expect(() => c.assertAutomaticOnly(automatic)).not.toThrow();
  });

  it('stops a never-tapped window at the 120 s ceiling and fails closed [RF-2]', async () => {
    const c = await loadContract();
    const sampler = await samplerHarness();
    sampler.frames(119_000);
    expect(sampler.read().done).toBe(false);
    sampler.frames(2_000);
    const window = sampler.read();
    expect(window).toMatchObject({
      done: true,
      tapped: false,
      ended: 'ceiling',
    });
    expect(sampler.scheduled()).toBe(false);
    expect(() => c.parseSamplerWindow(window)).toThrow(/tap/u);
    // A tapped window cut by the ceiling fails closed too.
    expect(() => c.parseSamplerWindow({ ...window, tapped: true })).toThrow(
      /ceiling/u,
    );
    expect(() =>
      c.parseSamplerWindow({ ...window, tapped: true, ended: 'tap-window' }),
    ).not.toThrow();
  });

  it('ends the tap window 45 s after the click when nothing settles [RF-2]', async () => {
    const c = await loadContract();
    const sampler = await samplerHarness();
    sampler.frames(46_000);
    expect(sampler.read().done).toBe(false);
    sampler.tap();
    // The scroller never moves, so the 60-unchanged-frame 'settled' branch
    // can never fire: only the 45 s tap window can end this loop.
    sampler.frames(44_000);
    expect(sampler.read().done).toBe(false);
    sampler.frames(2_000);
    const window = sampler.read();
    expect(window).toMatchObject({
      done: true,
      tapped: true,
      ended: 'tap-window',
    });
    expect(sampler.scheduled()).toBe(false);
    expect(() => c.parseSamplerWindow(window)).not.toThrow();
  });

  it('never ends the window on pre-tap drift or movement, only after the tap lands [RF-3]', async () => {
    const sampler = await samplerHarness();
    // Sub-pixel drift (under the classifier's own 1 CSS px MOVEMENT_PX) must
    // never register as movement, however many frames follow it.
    sampler.view.top = 298.67;
    sampler.frames(16);
    sampler.view.top = 298.4;
    sampler.frames(16);
    sampler.view.top = 298.67;
    sampler.frames(64 * 16);
    expect(sampler.read()).toMatchObject({ done: false, tapped: false });

    // A real pre-tap movement (>= 1 CSS px) is movement, but with no tap
    // observed yet the window must still not settle.
    sampler.view.top = 290;
    sampler.frames(16);
    sampler.frames(64 * 16);
    expect(sampler.read()).toMatchObject({ done: false, tapped: false });

    // Only once the tap lands and the divider settles does the window end.
    sampler.tap();
    sampler.frames(32);
    Object.assign(sampler.view, { top: 138.3, inView: true });
    sampler.frames(2_000);
    const window = sampler.read();
    expect(window).toMatchObject({
      done: true,
      tapped: true,
      ended: 'settled',
    });
    expect(sampler.scheduled()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Arrangement and authoritative events                                       */
/* -------------------------------------------------------------------------- */

const ROOM = '!Unread_Ab+c/d:localhost';
const READER_ID = '@trn_unread_reader_0a1b2c:localhost';
const MEMBER_ID = '@trn_unread_member_0a1b2c:localhost';
const SEEN_BODY = 'seen already';
const THREAD_BODY = 'Thread after the unread marker';
const unreadBodyOf = (i) => `unread message ${i}`;

/** Build the 16 arranged events oldest-first, with switches for each negative control. */
function arrangedEvents(overrides = {}) {
  let id = 0;
  const next = () => `$Unread_${id++}`;
  const events = [];
  events.push({
    type: 'm.room.message',
    event_id: next(),
    room_id: ROOM,
    sender: MEMBER_ID,
    content: { msgtype: 'm.text', body: overrides.seenBody ?? SEEN_BODY },
  });
  const unreadIds = [];
  const count = overrides.unreadCount ?? 14;
  for (let i = 0; i < count; i++) {
    const eventId = next();
    unreadIds.push(eventId);
    events.push({
      type: 'm.room.message',
      event_id: eventId,
      room_id: ROOM,
      sender: overrides.wrongSenderAt === i ? '@other:localhost' : MEMBER_ID,
      content: {
        msgtype: 'm.text',
        body: overrides.changedBodyAt === i ? 'changed body' : unreadBodyOf(i),
      },
    });
  }
  const rootIndex = overrides.threadRootIndex ?? 2;
  const relatesRoot = unreadIds[rootIndex] ?? unreadIds[0];
  const relatesTo = overrides.missingInReplyTo
    ? { rel_type: 'm.thread', event_id: relatesRoot }
    : {
        rel_type: 'm.thread',
        event_id: relatesRoot,
        'm.in_reply_to': { event_id: relatesRoot },
      };
  events.push({
    type: 'm.room.message',
    event_id: next(),
    room_id: ROOM,
    sender: overrides.threadWrongSender ? '@other:localhost' : READER_ID,
    content: {
      msgtype: 'm.text',
      body: overrides.threadBody ?? THREAD_BODY,
      'm.relates_to': relatesTo,
    },
  });
  return { events, correctRoot: unreadIds[2] };
}

const messagesPage = (events) => ({
  chunk: [
    ...events,
    {
      type: 'm.room.create',
      event_id: '$create',
      room_id: ROOM,
      sender: READER_ID,
      state_key: '',
      content: {},
    },
  ].reverse(),
  start: 's',
  end: 'e',
});

describe('Android message-unread arrangement and authoritative events', () => {
  it('reads the /messages chunk oldest-first, filtered to m.room.message', async () => {
    const { authoritativeRoomMessages } = await loadContract();
    const { events } = arrangedEvents();
    const read = authoritativeRoomMessages(messagesPage(events));
    expect(read.map((event) => event.event_id)).toEqual(
      events.map((event) => event.event_id),
    );
    for (const malformed of [null, {}, { chunk: {} }, { chunk: [null] }])
      expect(() => authoritativeRoomMessages(malformed)).toThrow();
  });

  it('accepts the exact 16-event arrangement and rejects each negative control', async () => {
    const { authoritativeRoomMessages, assertUnreadArrangement } =
      await loadContract();
    const check = (overrides, rootOverride) => {
      const { events, correctRoot } = arrangedEvents(overrides);
      const read = authoritativeRoomMessages(messagesPage(events));
      return assertUnreadArrangement(read, {
        readerId: READER_ID,
        memberId: MEMBER_ID,
        rootEventId: rootOverride ?? correctRoot,
      });
    };
    expect(() => check({})).not.toThrow();
    for (const [overrides, note] of [
      [{ unreadCount: 13 }, 'thirteen unread'],
      [{ unreadCount: 15 }, 'fifteen unread'],
      [{ wrongSenderAt: 5 }, 'wrong sender'],
      [{ threadRootIndex: 1 }, 'thread rooted at index 1'],
      [{ missingInReplyTo: true }, 'missing m.in_reply_to'],
      [{ changedBodyAt: 3 }, 'changed body'],
      [{ threadWrongSender: true }, 'thread from the wrong sender'],
      [{ seenBody: 'not seen' }, 'wrong seen body'],
    ])
      expect(() => check(overrides), note).toThrow();
  });
});

describe('Android message-unread Room names [RF-4]', () => {
  it('keeps neither the motion nor the reduced Room name a substring of the other', async () => {
    const { unreadRoomName } = await loadContract();
    for (const run of ['trn-unread-0a1b2cu', 'trn-x']) {
      const motion = unreadRoomName(run, 'motion');
      const reduced = unreadRoomName(run, 'reduced');
      expect(motion).not.toBe(reduced);
      expect(motion.includes(reduced)).toBe(false);
      expect(reduced.includes(motion)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Suite-local REST fixture                                                   */
/* -------------------------------------------------------------------------- */

const TOKEN = 'syt_dW5yZWFk_secretToken_0a1b';
const MEMBER_TOKEN = 'syt_bWVtYmVy_secretToken_1c2d';
const READER = {
  userId: READER_ID,
  username: 'trn_unread_reader_0a1b2c',
  password: 'unread-reader-pass-0a1b2c',
};
const MEMBER = {
  userId: MEMBER_ID,
  username: 'trn_unread_member_0a1b2c',
  password: 'unread-member-pass-0a1b2c',
};
const SESSIONS_BY_USERNAME = {
  [READER.username]: { userId: READER.userId, token: TOKEN },
  [MEMBER.username]: { userId: MEMBER.userId, token: MEMBER_TOKEN },
};

const fakeFetch =
  (log, opts = {}) =>
  async (url, init) => {
    const parsed = new URL(String(url));
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    log.push({
      path: parsed.pathname,
      method: init.method,
      authorization: init.headers.Authorization ?? null,
      body,
      bounded: init.signal instanceof AbortSignal,
    });
    if (parsed.pathname.endsWith('/login')) {
      const session = SESSIONS_BY_USERNAME[body.identifier.user];
      return new Response(
        JSON.stringify({
          user_id: opts.userId ?? session?.userId ?? READER_ID,
          access_token: opts.token ?? session?.token ?? TOKEN,
        }),
        { status: 200 },
      );
    }
    if (parsed.pathname.endsWith('/read_markers'))
      return opts.failMarkers
        ? new Response('{"errcode":"M_FORBIDDEN"}', { status: 403 })
        : new Response('{}', { status: 200 });
    if (parsed.pathname.includes('/send/m.room.message/'))
      return opts.failSend
        ? new Response('{"errcode":"M_FORBIDDEN"}', { status: 403 })
        : new Response(
            JSON.stringify({ event_id: opts.eventId ?? '$Unread_thread' }),
            { status: 200 },
          );
    if (parsed.pathname.endsWith('/account_data/m.fully_read'))
      return opts.notFound
        ? new Response('{"errcode":"M_NOT_FOUND"}', { status: 404 })
        : new Response(
            JSON.stringify({ event_id: opts.fullyReadId ?? '$Unread_seen' }),
            { status: 200 },
          );
    if (parsed.pathname.endsWith('/logout'))
      return new Response('{}', { status: 200 });
    return new Response('{}', { status: 404 });
  };

describe('Android message-unread REST fixture', () => {
  it('sets both read markers with exactly the fully-read event, keeping the token private', async () => {
    const { createMessageUnreadFixtures } = await loadFixture();
    const cleanups = [];
    const log = [];
    const fixtures = createMessageUnreadFixtures(
      { cleanup: (label, action) => cleanups.push({ label, action }) },
      new AbortController().signal,
      fakeFetch(log),
    );
    expect(cleanups.map((entry) => entry.label)).toEqual([
      'Message-unread REST session',
    ]);
    await fixtures.setReadMarkers(READER, ROOM, '$Unread_seen');
    expect(log.map((entry) => entry.method)).toEqual(['POST', 'POST']);
    expect(new URL(`http://x${log[1].path}`).pathname).toBe(
      `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/read_markers`,
    );
    expect(log[1].authorization).toBe(`Bearer ${TOKEN}`);
    expect(log[1].body).toEqual({
      'm.fully_read': '$Unread_seen',
      'm.read': '$Unread_seen',
    });
    expect(log.every((entry) => entry.bounded)).toBe(true);
    expect(fixtures.tokens()).toEqual([TOKEN]);
  });

  it('sends exactly the thread relation once and returns the $ event id', async () => {
    const { createMessageUnreadFixtures } = await loadFixture();
    const log = [];
    const fixtures = createMessageUnreadFixtures(
      { cleanup: () => {} },
      new AbortController().signal,
      fakeFetch(log),
    );
    const eventId = await fixtures.sendThreadReply(
      READER,
      ROOM,
      'r-1-motion-thread',
      '$Unread_root',
    );
    expect(eventId).toBe('$Unread_thread');
    const sendCall = log.at(-1);
    expect(sendCall.method).toBe('PUT');
    expect(sendCall.body).toEqual({
      msgtype: 'm.text',
      body: 'Thread after the unread marker',
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: '$Unread_root',
        'm.in_reply_to': { event_id: '$Unread_root' },
      },
    });
    expect(log.filter((entry) => entry.method === 'PUT')).toHaveLength(1);
  });

  it('reads the fully-read account data, or undefined only on a 404', async () => {
    const { createMessageUnreadFixtures } = await loadFixture();
    const log = [];
    const fixtures = createMessageUnreadFixtures(
      { cleanup: () => {} },
      new AbortController().signal,
      fakeFetch(log, { fullyReadId: '$Unread_seen' }),
    );
    const eventId = await fixtures.fullyRead(READER, ROOM);
    expect(eventId).toBe('$Unread_seen');
    const getCall = log.at(-1);
    expect(getCall.method).toBe('GET');
    expect(getCall.body).toBeUndefined();
    expect(new URL(`http://x${getCall.path}`).pathname).toBe(
      `/_matrix/client/v3/user/${encodeURIComponent(READER.userId)}/rooms/${encodeURIComponent(ROOM)}/account_data/m.fully_read`,
    );
    const missing = createMessageUnreadFixtures(
      { cleanup: () => {} },
      new AbortController().signal,
      fakeFetch([], { notFound: true }),
    );
    expect(await missing.fullyRead(READER, ROOM)).toBeUndefined();
  });

  it('collects every session token and logs each out on cleanup', async () => {
    const { createMessageUnreadFixtures } = await loadFixture();
    const cleanups = [];
    const log = [];
    const fixtures = createMessageUnreadFixtures(
      { cleanup: (label, action) => cleanups.push({ label, action }) },
      new AbortController().signal,
      fakeFetch(log),
    );
    await fixtures.setReadMarkers(READER, ROOM, '$Unread_seen');
    await fixtures.sendThreadReply(
      MEMBER,
      ROOM,
      'r-1-motion-b0',
      '$Unread_root',
    );
    expect(fixtures.tokens().sort()).toEqual([MEMBER_TOKEN, TOKEN].sort());
    log.length = 0;
    await cleanups[0].action();
    expect(
      log.every(
        (entry) => entry.method === 'POST' && entry.path.endsWith('/logout'),
      ),
    ).toBe(true);
    expect(log.map((entry) => entry.authorization).sort()).toEqual(
      [`Bearer ${TOKEN}`, `Bearer ${MEMBER_TOKEN}`].sort(),
    );
  });

  it('fails without the token, Room or password in its error', async () => {
    const { createMessageUnreadFixtures } = await loadFixture();
    const fixtures = createMessageUnreadFixtures(
      { cleanup: () => {} },
      new AbortController().signal,
      fakeFetch([], { failMarkers: true }),
    );
    const error = await fixtures
      .setReadMarkers(READER, ROOM, '$Unread_seen')
      .then(
        () => undefined,
        (failure) => failure,
      );
    expect(error.message).toBe(
      'Message-unread fixture POST read markers failed with HTTP 403',
    );
    for (const value of [
      TOKEN,
      ROOM,
      encodeURIComponent(ROOM),
      READER.password,
    ])
      expect(error.message).not.toContain(value);
  });
});

/* -------------------------------------------------------------------------- */
/* Diagnostics safety                                                         */
/* -------------------------------------------------------------------------- */

const ROOM_A = {
  id: '!Unread_Ab+c/d:localhost',
  name: 'Unread E2E trn-unread-0a1b2cu-motion',
};
const ROOM_B = {
  id: '!Unread_Ef+g/h:localhost',
  name: 'Unread E2E trn-unread-0a1b2cu-reduced',
};
const ARTIFACT_IDS = {
  accounts: [READER, MEMBER],
  rooms: [ROOM_A, ROOM_B],
  texts: [SEEN_BODY, unreadBodyOf(0), THREAD_BODY],
  eventIds: ['$Unread_seen', '$Unread_root', '$Unread_thread'],
  transactions: ['r-1-motion-a', 'r-1-motion-thread'],
  tokens: [TOKEN],
};

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

describe('Android message-unread diagnostics safety', () => {
  it('registers every identifier form across both Accounts and both Rooms, never the bare server name', async () => {
    const { messageUnreadSecrets } = await loadArtifacts();
    const secrets = messageUnreadSecrets(STAGE.id, ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_UNREAD_DIVIDER_JUMP_'),
      ),
    ).toBe(true);
    const values = new Set(Object.values(secrets));
    for (const value of [
      READER.userId,
      encodeURIComponent(READER.userId),
      READER.username,
      READER.password,
      MEMBER.userId,
      MEMBER.username,
      MEMBER.password,
      ROOM_A.id,
      ROOM_A.id.slice(1),
      encodeURIComponent(ROOM_A.id),
      Buffer.from(ROOM_A.id).toString('base64url'),
      ROOM_A.name,
      ROOM_B.id,
      ROOM_B.id.slice(1),
      encodeURIComponent(ROOM_B.id),
      Buffer.from(ROOM_B.id).toString('base64url'),
      ROOM_B.name,
      SEEN_BODY,
      THREAD_BODY,
      '$Unread_seen',
      '$Unread_root',
      '$Unread_thread',
      'r-1-motion-a',
      'r-1-motion-thread',
      TOKEN,
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(
        messageUnreadSecrets(STAGE.id, {
          accounts: [],
          rooms: [],
          texts: [],
          eventIds: [],
          transactions: [],
          tokens: [],
        }),
      ),
    ).toEqual([]);
    expect(() => messageUnreadSecrets('not-a-stage', ARTIFACT_IDS)).toThrow();
    expect(() =>
      messageUnreadSecrets(STAGE.id, { ...ARTIFACT_IDS, texts: [''] }),
    ).toThrow();
  });

  it('rethrows stage failures to the job log without identifiers or assertion values [I2]', async () => {
    const { messageUnreadSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageUnreadSecrets(STAGE.id, ARTIFACT_IDS);
    const segment = Buffer.from(ROOM_A.id).toString('base64url');
    const OTHER_ID = '$Unread_other';
    const failure = new AssertionError({
      actual: '$Unread_root',
      expected: OTHER_ID,
      operator: 'strictEqual',
      message: 'The thread root is the arranged unread event',
    });
    const leaked = new Error(
      `GET /rooms/${encodeURIComponent(ROOM_A.id)}/messages for ${READER.userId} at /rooms/${segment} on $Unread_root body ${SEEN_BODY}`,
    );
    const error = redactStageFailure(
      STAGE.id,
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain(
      'Android message-unread divider-jump failed',
    );
    expect(error.message).toContain(
      'The thread root is the arranged unread event',
    );
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ROOM_A.id,
      encodeURIComponent(ROOM_A.id),
      segment,
      '$Unread_root',
      READER.userId,
      SEEN_BODY,
      'trn-unread-0a1b2cu',
    ])
      expect(error.message).not.toContain(value);
    // Node appends an assertion's actual/expected values to a custom message,
    // contiguous or as an interleaved character diff depending on the
    // terminal. The rethrow keeps exactly the first line, so no fragment of
    // that block reaches the job log, nor does any unregistered event-id shape.
    const [firstLine, ...appended] = failure.message.split('\n');
    expect(firstLine).toBe('The thread root is the arranged unread event');
    expect(appended.join('\n').trim()).not.toBe('');
    expect(error.message.split('\n')).toContain(`AssertionError: ${firstLine}`);
    for (const fragment of appended.map((line) => line.trim()))
      if (fragment.length >= 3) expect(error.message).not.toContain(fragment);
    expect(error.message).not.toContain(OTHER_ID);
    expect(error.message).not.toContain('actual');
    const unregistered = '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4';
    const shaped = redactStageFailure(
      STAGE.id,
      [
        new Error(`Event ${unregistered} already in timeline`),
        (() => {
          try {
            assert.equal(unregistered, OTHER_ID);
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
      'Android message-unread divider-jump failed\nError: Event [REDACTED] already in timeline\nAssertionError: strictEqual assertion failed\nAssertionError: Fields',
    );
    const cleanup = redactCleanupFailure(
      'fixtures',
      Object.assign(new Error(`leave ${ROOM_A.id}`), { status: 403 }),
    );
    expect(cleanup.message).toBe(
      'Message-unread cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
    expect(journey).not.toMatch(/throw failures\[0\]/u);
    const guardStart = journey.indexOf(
      'export function guardMessageUnreadCleanup',
    );
    expect(guardStart).toBeGreaterThan(-1);
    const guardBody = journey.slice(
      guardStart,
      journey.indexOf('\n}', guardStart),
    );
    expect(guardBody).toContain('throw redactCleanupFailure(label, error);');
    expect(guardBody).not.toMatch(/throw error;/u);
    // Removing the redaction leaks the identifiers again.
    expect(redactStageFailure(STAGE.id, [leaked], {}).message).toContain(
      '$Unread_root',
    );
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error [I2]', async () => {
    const { guardMessageUnreadCleanup } = await loadJourneys();
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
    const guarded = guardMessageUnreadCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ROOM_A.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-unread cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.report.stages[0].error).toContain(ROOM_A.id);
    expect(state.saves).toBe(1);
    const early = { ...state, report: { status: 'running', stages: [] } };
    const later = [];
    guardMessageUnreadCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier, credential and token', async () => {
    const { messageUnreadSecrets, scanMessageUnreadArtifacts } =
      await loadArtifacts();
    const secrets = messageUnreadSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-unread-scan-', async (output) => {
      await mkdir(join(output, STAGE.id));
      const capture = join(output, STAGE.id, 'passed.json');
      for (const unsafe of [
        JSON.stringify({ password: READER.password }),
        `GET /rooms/${ROOM_A.id}/messages`,
        `GET /rooms/${encodeURIComponent(ROOM_B.id)}/event/${encodeURIComponent('$Unread_root')}`,
        `double=${encodeURIComponent(encodeURIComponent(ROOM_A.id))}`,
        `route=/rooms/${Buffer.from(ROOM_A.id).toString('base64url')}`,
        `slice=${ROOM_B.id.slice(1)}`,
        `user=${READER.userId}`,
        `user=${encodeURIComponent(MEMBER.userId)}`,
        `body=${THREAD_BODY}`,
        `name=${ROOM_A.name}`,
        `name=${ROOM_B.name}`,
        `txn=r-1-motion-a`,
        `token=${TOKEN}`,
        // An event JSON whose ids were never registered still blocks publication.
        JSON.stringify({ text: '"event_id": "$Unregistered_X"' }),
        '{"room_id": "!unregistered:localhost"}',
        '{\\"sender\\": \\"@unregistered:localhost\\"}',
        'Msg: Event $SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 already in timeline',
        '/event/%24SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4?x=1',
        '/_matrix/client/v3/sync?access_token=unregisteredTokenValue',
        '{"access_token":"unregistered_token_value"}',
        'Authorization: Bearer unregistered-token',
        'token=syt_dW5yZWdpc3RlcmVk_abc',
        '<map><string name="CapacitorStorage.trinity">{}</string></map>',
        'pluginId: Preferences, methodName: get, methodData: {"key":"trinity.appearance.mode"}',
      ]) {
        await writeFile(capture, unsafe);
        await expect(
          scanMessageUnreadArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        capture,
        '{"eventDigest":"ab","event_id":"[REDACTED]","server":"localhost","access_token":false,"alpha":1}\n',
      );
      await expect(
        scanMessageUnreadArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of [
        'passed-webview.png',
        'failed-device.PNG',
        'opaque.bin',
      ])
        await withOutput('trinity-unread-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(scanMessageUnreadArtifacts(other, {})).rejects.toThrow();
        });
    });
  });

  it('scrubs captured diagnostics of every registered form, deletes raster, and then scans clean', async () => {
    const {
      messageUnreadSecrets,
      scrubMessageUnreadArtifacts,
      scanMessageUnreadArtifacts,
    } = await loadArtifacts();
    const secrets = messageUnreadSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-unread-scrub-', async (output) => {
      const stage = join(output, STAGE.id);
      await mkdir(stage);
      const path = join(stage, 'passed-surface.json');
      await writeFile(
        path,
        [
          `GET /rooms/${encodeURIComponent(ROOM_A.id)}/messages`,
          `sender=${READER.userId}`,
          JSON.stringify({ password: MEMBER.password }),
          `token=${TOKEN}`,
          'Msg: Event $SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 already in timeline',
          'class $OnBluetoothActivityEnergyInfoProxy digest 0a1b2c',
          'unchanged=1 divider',
        ].join('\n'),
      );
      for (const name of [
        'passed-webview.png',
        'passed-device.png',
        'failed-webview.png',
        'failed-device.png',
      ])
        await writeFile(join(stage, name), 'raster of the divider');
      await scrubMessageUnreadArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe('unchanged=1 divider');
      for (const leaked of [
        ROOM_A.id,
        READER.userId,
        MEMBER.password,
        TOKEN,
        '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4',
      ])
        expect(scrubbed).not.toContain(leaked);
      expect(scrubbed).toContain('$OnBluetoothActivityEnergyInfoProxy');
      for (const name of [
        'passed-webview.png',
        'passed-device.png',
        'failed-webview.png',
        'failed-device.png',
      ])
        expect(existsSync(join(stage, name))).toBe(false);
      await expect(
        scanMessageUnreadArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  it('requires the reduced-motion feasibility gate, then publishes only a complete, clean, unretried 1-stage 14-record Pixel 5 run', async () => {
    const artifacts = await loadArtifacts();
    const { DESKTOP_ACCOUNT_PROFILE, PIXEL_5_ACCOUNT_PROFILE } =
      await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 14,
      attempt: 1,
      retries: 0,
      stages: [
        {
          id: STAGE.id,
          status: 'passed',
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: 14,
          assertionRecords: 14,
          assertions: [...ALL_IDENTITIES],
          failureCount: 0,
        },
      ],
    });
    const flags = {
      unsafeSecrets: false,
      cleanupFailed: false,
      scrubFailed: false,
    };
    await withOutput('trinity-unread-gate-', async (output) => {
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
      const arrange = async (value = report(), feasible = true) => {
        await write('journeys.json', value);
        await write('runtime-provenance.json', provenance());
        await mkdir(join(output, STAGE.id, 'reduced-motion'), {
          recursive: true,
        });
        await write(join(STAGE.id, 'profile-applied.json'), {
          requested: PIXEL_5_ACCOUNT_PROFILE,
        });
        await write(join(STAGE.id, 'reduced-motion', 'feasibility.json'), {
          feasible,
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
          artifacts.markMessageUnreadDiagnosticsSafe(
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
      await artifacts.markMessageUnreadDiagnosticsSafe(
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
          value.stages[0].assertionRecords = 13;
        }),
        mutate((value) => (value.expectedAssertionRecords = 13)),
      ]) {
        await arrange(invalid);
        await refused(invalid);
      }
      // The reduced-motion gate must have been feasible.
      await arrange(report(), false);
      await refused(report());
      await arrange(report());
      await rm(join(output, STAGE.id, 'reduced-motion', 'feasibility.json'));
      await refused(report());
      for (const unsafe of [
        { ...flags, unsafeSecrets: true },
        { ...flags, cleanupFailed: true },
        { ...flags, scrubFailed: true },
      ]) {
        await arrange();
        await refused(report(), { flags: unsafe });
      }
      await arrange();
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
        requested: DESKTOP_ACCOUNT_PROFILE,
      });
      await refused(report());
      await arrange();
      await write(
        'runtime-provenance.json',
        provenance(DESKTOP_ACCOUNT_PROFILE),
      );
      await refused(report());
      await arrange();
      await writeFile(
        join(output, STAGE.id, 'passed-surface.json'),
        `token=${TOKEN}`,
      );
      await refused(report(), {
        secrets: artifacts.messageUnreadSecrets(STAGE.id, ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, STAGE.id, 'passed-webview.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const {
      runMessageUnreadStageCleanup,
      revokeMessageUnreadPublicationOnAbort,
    } = await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessageUnreadStageCleanup(
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
    await withOutput('trinity-unread-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageUnreadPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageUnreadPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-unread publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });

  it('redacts registered secrets and shared Matrix identifier shapes from diagnostic text', async () => {
    const { messageUnreadSecrets, redactDiagnosticText } =
      await loadArtifacts();
    const secrets = messageUnreadSecrets(STAGE.id, ARTIFACT_IDS);
    const text = `user=${READER.userId} room=${ROOM_A.id} unregistered=$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 token=${TOKEN}`;
    const redacted = redactDiagnosticText(text, secrets);
    expect(redacted).not.toContain(READER.userId);
    expect(redacted).not.toContain(ROOM_A.id);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(
      '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4',
    );
    // Removing the artifacts module's own redaction call would leak identifiers again.
    expect(read(ARTIFACTS)).toContain(
      'redactMatrixIdentifiers(redactSecretText(text, secrets))',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Native journey against a simulated installed app [RF-1][RF-4][RF-5]        */
/* -------------------------------------------------------------------------- */

const UNREAD_READER = {
  userId: '@unread-journey-reader:localhost',
  username: 'unread-journey-reader',
  password: 'unread-journey-reader-secret-pw',
};
const UNREAD_MEMBER = {
  userId: '@unread-journey-member:localhost',
  username: 'unread-journey-member',
  password: 'unread-journey-member-secret-pw',
};
const UNREAD_ROOM_A_ID = '!Unread_Journey_A:localhost';
const UNREAD_ROOM_B_ID = '!Unread_Journey_B:localhost';

const SUFFIXES = [
  'room-ready',
  'divider-text',
  'one-thread-connector',
  'connector-above',
  'connector-below',
  'divider-styled',
  'jump-visible',
  'jump-hidden',
  'smooth-trajectory',
  'reduced-motion-query',
  'jump-visible-at-latest',
  'reduced-jump-hidden',
  'reduced-scrolled',
  'automatic-only',
];

const stillFrames = (n, top) =>
  Array.from({ length: n }, (_, i) => [i * 16, top, false]);
const pathFrames = (start, tops, inView = false) =>
  tops.map((top, i) => [(start + i) * 16, top, inView]);
const tailFrames = (from, n, top, inView = true) =>
  Array.from({ length: n }, (_, i) => [(from + i) * 16, top, inView]);
const SMOOTH_TRAJECTORY = [
  ...stillFrames(40, 298.67),
  ...pathFrames(40, [298.2, 270, 187, 153, 106, 80]),
  ...pathFrames(46, [80, 138, 138.3]),
  ...tailFrames(49, 60, 137.5),
];
const AUTOMATIC_TRAJECTORY = [
  ...stillFrames(40, 298.67),
  ...pathFrames(40, [43, 43, 43, 43, 80, 80, 80, 138, 138.3]),
  ...tailFrames(49, 60, 138.3),
];

const UNREAD_BOX = (top, height = 24) => ({
  left: 16,
  top,
  right: 377,
  bottom: top + height,
  width: 361,
  height,
});
const UNREAD_SCROLLER_BOX = {
  left: 0,
  top: 56,
  right: 393,
  bottom: 456,
  width: 393,
  height: 400,
};

/** The unread view the simulated app reports, given only its own phase state. */
function unreadViewFor(state) {
  if (state.room === null) {
    return {
      scroller: null,
      divider: null,
      jump: { count: 0, visible: false, box: null },
      latest: { count: 0, visible: false, box: null },
      reducedMotion: state.reducedMotionApplied,
    };
  }
  const divider = (aboveScreen) => ({
    count: 1,
    textContent: 'New messages',
    innerText: 'NEW MESSAGES',
    box: aboveScreen ? UNREAD_BOX(-40) : UNREAD_BOX(200),
    connectorCount: 1,
    above: 10,
    below: 10,
    display: 'flex',
    alignItems: 'center',
    fontWeight: '600',
    ruleFlexGrow: '1',
  });
  const pill = (visible, top = 225) => ({
    count: visible ? 1 : 0,
    visible,
    box: visible ? UNREAD_BOX(top, 44) : null,
  });
  const scroller = (atBottom) =>
    atBottom
      ? { top: 400, height: 800, clientHeight: 400, box: UNREAD_SCROLLER_BOX }
      : { top: 100, height: 800, clientHeight: 400, box: UNREAD_SCROLLER_BOX };

  if (state.room === 'motion') {
    const tapped = state.jumpTapped.motion;
    return {
      scroller: scroller(false),
      divider: divider(!tapped),
      jump: pill(!tapped),
      latest: pill(false),
      reducedMotion: false,
    };
  }
  // state.room === 'reduced'
  if (!state.jumpTapped.reduced1)
    return {
      scroller: scroller(false),
      divider: divider(true),
      jump: pill(true),
      latest: pill(false),
      reducedMotion: state.reducedMotionApplied,
    };
  if (!state.latestTapped)
    return {
      scroller: scroller(false),
      divider: divider(false),
      jump: pill(false),
      latest: pill(true, 599),
      reducedMotion: state.reducedMotionApplied,
    };
  if (!state.jumpTapped.reduced2)
    return {
      scroller: scroller(true),
      divider: divider(false),
      jump: pill(true),
      latest: pill(false),
      reducedMotion: state.reducedMotionApplied,
    };
  return {
    scroller: scroller(false),
    divider: divider(false),
    jump: pill(false),
    latest: pill(false),
    reducedMotion: state.reducedMotionApplied,
  };
}

function appliedUnreadProfileFor(state, faults) {
  const width =
    (state.launch === 'relaunch' && faults.relaunchWidth412) ||
    (state.launch === 'reset' && faults.resetWidth412)
      ? 412
      : 393;
  return {
    innerWidth: width,
    innerHeight: 727,
    devicePixelRatio: 2.75,
    coarsePointer: true,
    hoverNone: !faults.hoverCapable,
    platform: faults.notAndroid ? 'ios' : 'android',
  };
}

/** A minimal simulated installed app: only the phases the journey drives through. */
async function simulatedUnreadApp(faults = {}, directory) {
  const { unreadViewExpression, appliedProfileExpression } =
    await loadObserver();
  const UNREAD_VIEW_EXPR = unreadViewExpression();
  const APPLIED_PROFILE_EXPR = appliedProfileExpression();
  const controller = new AbortController();
  const state = {
    actions: [],
    written: [],
    navigationMode: faults.navigationMode ?? '2',
    animator: 'null',
    launch: null,
    reducedMotionApplied: false,
    room: null,
    jumpTapped: { motion: false, reduced1: false, reduced2: false },
    latestTapped: false,
    rooms: {
      motion: { id: UNREAD_ROOM_A_ID, events: [], fullyRead: undefined },
      reduced: { id: UNREAD_ROOM_B_ID, events: [], fullyRead: undefined },
    },
  };
  let eventCounter = 0;
  let roomBFullyReadCalls = 0;
  let samplerCalls = 0;
  const roomById = (id) =>
    id === UNREAD_ROOM_A_ID ? state.rooms.motion : state.rooms.reduced;

  const client = {
    device: {
      adb: async (...args) => {
        state.actions.push(`adb:${args.slice(1).join(' ')}`);
        const [, , op, scope, key] = args;
        if (op === 'get' && scope === 'secure' && key === 'navigation_mode')
          return state.navigationMode;
        if (
          op === 'get' &&
          scope === 'global' &&
          key === 'animator_duration_scale'
        )
          return state.animator;
        if (
          op === 'put' &&
          scope === 'global' &&
          key === 'animator_duration_scale'
        ) {
          state.animator = args[5];
          if (args[5] === '0')
            state.reducedMotionApplied = !faults.neverReduced;
          return '';
        }
        if (
          op === 'delete' &&
          scope === 'global' &&
          key === 'animator_duration_scale'
        ) {
          state.animator = 'null';
          state.reducedMotionApplied = false;
          return '';
        }
        throw new Error(`Unmodelled simulated adb ${args.join(' ')}`);
      },
      clearApplicationData: async () => {},
    },
    signal: controller.signal,
    webview: {
      diagnostics: {
        send: async (_method, { expression }) => {
          if (expression === UNREAD_VIEW_EXPR)
            return { result: { value: unreadViewFor(state) } };
          if (expression === APPLIED_PROFILE_EXPR)
            return {
              result: { value: appliedUnreadProfileFor(state, faults) },
            };
          if (
            expression ===
            "matchMedia('(prefers-reduced-motion: reduce)').matches"
          )
            return { result: { value: state.reducedMotionApplied } };
          if (expression.includes('Object.defineProperty(window, key')) {
            samplerCalls++;
            return { result: { value: true } };
          }
          if (expression.includes('s.samples.slice()')) {
            const samples =
              samplerCalls <= 1
                ? SMOOTH_TRAJECTORY
                : samplerCalls === 2
                  ? SMOOTH_TRAJECTORY
                  : AUTOMATIC_TRAJECTORY;
            return {
              result: {
                value: { done: true, tapped: true, ended: 'settled', samples },
              },
            };
          }
          throw new Error(`Unmodelled simulated evaluate: ${expression}`);
        },
      },
    },
    async reset(profile) {
      state.actions.push(`reset:${profile.width}`);
      state.launch = 'reset';
    },
    async relaunch(profile) {
      state.actions.push(`relaunch:${profile.width}`);
      state.launch = 'relaunch';
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
      state.actions.push(
        `tap:${selector}${filter.text ? `|${filter.text}` : ''}`,
      );
      if (selector === '[data-testid="rail-rooms"]') return;
      if (selector === '.channel') {
        state.room = filter.text;
        return;
      }
      if (selector === '[data-testid="jump-to-unread"]') {
        if (state.room === 'motion') state.jumpTapped.motion = true;
        else if (!state.jumpTapped.reduced1) state.jumpTapped.reduced1 = true;
        else state.jumpTapped.reduced2 = true;
        return;
      }
      if (selector === '[data-testid="jump-to-latest"]') {
        state.latestTapped = true;
        return;
      }
      throw new Error(`Unmodelled simulated tap ${selector}`);
    },
    async record(name, value) {
      state.written.push({ name, value });
      if (directory) {
        const path = join(directory, `${name}.json`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
      }
    },
    async capture() {},
  };

  const fixtures = {
    async account(role) {
      return role.includes('member')
        ? { ...UNREAD_MEMBER }
        : { ...UNREAD_READER };
    },
    async createRoom(_account, content) {
      const key = content.name.endsWith('-motion') ? 'motion' : 'reduced';
      return { id: state.rooms[key].id, name: key };
    },
    async join() {},
    async sendMessage(account, roomId, body) {
      const room = roomById(roomId);
      const eventId = `$unread-evt-${++eventCounter}`;
      room.events.push({
        type: 'm.room.message',
        event_id: eventId,
        room_id: roomId,
        sender: account.userId,
        content: { msgtype: 'm.text', body },
      });
      return eventId;
    },
    async roomMessages(_account, roomId) {
      const room = roomById(roomId);
      return {
        chunk: [
          ...room.events,
          {
            type: 'm.room.create',
            event_id: '$create',
            room_id: roomId,
            sender: UNREAD_READER.userId,
            state_key: '',
            content: {},
          },
        ].reverse(),
        start: 's',
        end: 'e',
      };
    },
  };

  const unreadFixtures = {
    async setReadMarkers(_account, roomId, eventId) {
      roomById(roomId).fullyRead = eventId;
    },
    async sendThreadReply(account, roomId, _transactionId, rootId) {
      const room = roomById(roomId);
      const eventId = `$unread-evt-${++eventCounter}`;
      room.events.push({
        type: 'm.room.message',
        event_id: eventId,
        room_id: roomId,
        sender: account.userId,
        content: {
          msgtype: 'm.text',
          body: 'Thread after the unread marker',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: rootId,
            'm.in_reply_to': { event_id: rootId },
          },
        },
      });
      return eventId;
    },
    async fullyRead(_account, roomId) {
      if (roomId === UNREAD_ROOM_B_ID) {
        roomBFullyReadCalls++;
        if (faults.roomBFullyReadWrongFirst && roomBFullyReadCalls === 2)
          return '$unread-wrong-marker';
        if (faults.roomBFullyReadWrongSecond && roomBFullyReadCalls === 3)
          return '$unread-wrong-marker';
      }
      return roomById(roomId).fullyRead;
    },
    tokens: () => ['unread-fake-token'],
  };

  return { client, fixtures, unreadFixtures, state, controller };
}

/** Builds one simulated stage context and cleans up its real temp directory. */
async function withSimulatedUnreadStage(faults, run) {
  const { MESSAGE_UNREAD_STAGES } = await loadContract();
  const directory = await mkdtemp(join(tmpdir(), 'trinity-unread-journey-'));
  try {
    const app = await simulatedUnreadApp(faults, directory);
    const context = {
      entry: MESSAGE_UNREAD_STAGES[0],
      records: [],
      identities: new Set(),
      receipts: 0,
      client: app.client,
      fixtures: app.fixtures,
      unreadFixtures: app.unreadFixtures,
      secrets: {},
      safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
      native: false,
      animatorApplied: false,
      animatorPrior: 'null',
      samplers: 0,
      directory,
      signal: app.controller.signal,
      ledger: {
        run: 'trn-unread-journey-0a1b2cu',
        accounts: [],
        rooms: [],
        texts: [],
        eventIds: [],
        transactions: [],
        tokens: [],
      },
    };
    return await run({ context, state: app.state });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Android message-unread native journey against a simulated installed app', () => {
  it('drives the exact native sequence and records all fourteen identities in order', async () => {
    const { runDividerJump, restoreAnimatorDurationScale } =
      await loadJourneys();
    await withSimulatedUnreadStage({}, async ({ context, state }) => {
      await runDividerJump(context);
      await restoreAnimatorDurationScale(context.client, context.animatorPrior);
      expect(context.records).toEqual(
        SUFFIXES.map((s) => `message-unread.divider-jump.${s}`),
      );
      expect(state.actions).toEqual([
        'adb:settings get secure navigation_mode',
        'reset:393',
        'login',
        'hideKeyboard',
        'tap:[data-testid="rail-rooms"]',
        'tap:.channel|motion',
        'tap:[data-testid="jump-to-unread"]',
        'adb:settings get global animator_duration_scale',
        'adb:settings put global animator_duration_scale 0',
        'relaunch:393',
        'hideKeyboard',
        'tap:[data-testid="rail-rooms"]',
        'tap:.channel|reduced',
        'tap:[data-testid="jump-to-unread"]',
        'tap:[data-testid="jump-to-latest"]',
        'tap:[data-testid="jump-to-unread"]',
        'adb:settings delete global animator_duration_scale',
        'adb:settings get global animator_duration_scale',
      ]);
    });
  });

  it('fails closed when the emulator is not in gesture navigation mode', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { navigationMode: '0' },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /navigation mode/u,
        );
      },
    );
  });

  it('writes feasibility.json with feasible: false and rejects when the query never becomes true', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { neverReduced: true },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow();
        const feasibility = JSON.parse(
          await readFile(
            join(context.directory, 'reduced-motion', 'feasibility.json'),
            'utf8',
          ),
        );
        expect(feasibility.feasible).toBe(false);
      },
    );
  }, 25_000);

  it('marks animatorApplied once the write lands, even when the stage then fails the feasibility gate [RF-1]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { neverReduced: true },
      async ({ context, state }) => {
        await expect(runDividerJump(context)).rejects.toThrow();
        expect(state.actions).toContain(
          'adb:settings put global animator_duration_scale 0',
        );
        expect(context.animatorApplied).toBe(true);
      },
    );
  }, 25_000);

  it('marks animatorApplied once the write lands, even when the post-relaunch profile check then fails [RF-1]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { relaunchWidth412: true },
      async ({ context, state }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /applied profile is Pixel 5/u,
        );
        expect(state.actions).toContain(
          'adb:settings put global animator_duration_scale 0',
        );
        expect(context.animatorApplied).toBe(true);
      },
    );
  });

  it('never marks animatorApplied when the stage fails before the write [RF-1]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { navigationMode: '0' },
      async ({ context, state }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /navigation mode/u,
        );
        expect(state.actions).not.toContain(
          'adb:settings put global animator_duration_scale 0',
        );
        expect(context.animatorApplied).toBe(false);
      },
    );
  });

  it('restoreAnimatorIfApplied restores exactly when animatorApplied is true, and is a no-op otherwise [RF-1]', async () => {
    const { restoreAnimatorIfApplied } = await loadJourneys();
    const actionsFor = async (animatorApplied) => {
      const actions = [];
      const client = {
        device: {
          adb: async (...args) => {
            actions.push(`adb:${args.slice(1).join(' ')}`);
            return args[2] === 'get' ? 'null' : '';
          },
        },
        record: async () => {},
      };
      await restoreAnimatorIfApplied(
        { animatorApplied, animatorPrior: 'null' },
        client,
      );
      return actions;
    };
    expect(await actionsFor(true)).toEqual([
      'adb:settings delete global animator_duration_scale',
      'adb:settings get global animator_duration_scale',
    ]);
    expect(await actionsFor(false)).toEqual([]);
  });

  it('fails closed when Room B was read before the reduced-motion relaunch [RF-4]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { roomBFullyReadWrongFirst: true },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /Room B was read before the reduced-motion relaunch/u,
        );
      },
    );
  });

  it('fails closed when Room B was read again right before it opens [RF-4]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { roomBFullyReadWrongSecond: true },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /Room B was read before the reduced-motion relaunch/u,
        );
      },
    );
  });

  it('fails closed when the relaunched profile is not Pixel 5 [RF-5]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { relaunchWidth412: true },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /applied profile is Pixel 5/u,
        );
      },
    );
  });

  it('fails closed when the initial reset profile is not Pixel 5 [RF-5]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { resetWidth412: true },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /applied profile is Pixel 5/u,
        );
      },
    );
  });

  it('fails closed when the applied profile reports a hover-capable pointer [RF-5][M8]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { hoverCapable: true },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /applied profile is Pixel 5/u,
        );
      },
    );
  });

  it('fails closed when the applied profile is not android [RF-5][M8]', async () => {
    const { runDividerJump } = await loadJourneys();
    await withSimulatedUnreadStage(
      { notAndroid: true },
      async ({ context }) => {
        await expect(runDividerJump(context)).rejects.toThrow(
          /applied profile is Pixel 5/u,
        );
      },
    );
  });

  it('restores animator_duration_scale before a throwing close, in teardown order [RF-1]', async () => {
    const { restoreAnimatorDurationScale } = await loadJourneys();
    const { runMessageUnreadStageCleanup } = await loadArtifacts();
    const actions = [];
    const client = {
      device: {
        adb: async (...args) => {
          actions.push(`adb:${args.slice(1).join(' ')}`);
          return args[2] === 'get' ? 'null' : '';
        },
      },
      record: async () => {},
      close: async () => {
        actions.push('close');
        throw new Error('client close failed');
      },
    };
    const failures = [];
    await runMessageUnreadStageCleanup(
      [
        async () => {
          await restoreAnimatorDurationScale(client, 'null');
        },
        () => client.close(),
        () => Promise.resolve(),
      ],
      failures,
    );
    expect(failures).toHaveLength(1);
    expect(actions).toEqual([
      'adb:settings delete global animator_duration_scale',
      'adb:settings get global animator_duration_scale',
      'close',
    ]);
  });

  it('fails when the restored value does not read back exactly [RF-1]', async () => {
    const { restoreAnimatorDurationScale } = await loadJourneys();
    const client = {
      device: { adb: async (...args) => (args[2] === 'get' ? '0.5' : '') },
      record: async () => {},
    };
    await expect(restoreAnimatorDurationScale(client, 'null')).rejects.toThrow(
      /animator_duration_scale restored/u,
    );
  });

  it('restores a non-null prior value with put, not delete [RF-1]', async () => {
    const { restoreAnimatorDurationScale } = await loadJourneys();
    const actions = [];
    const client = {
      device: {
        adb: async (...args) => {
          actions.push(args.join(' '));
          return args[2] === 'get' ? '1.0' : '';
        },
      },
      record: async () => {},
    };
    await restoreAnimatorDurationScale(client, '1.0');
    expect(
      actions.some((a) => a.includes('put global animator_duration_scale 1.0')),
    ).toBe(true);
    expect(actions.some((a) => a.includes('delete'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Source rules: journeys, observer, fixture and artifacts                    */
/* -------------------------------------------------------------------------- */

const UNREAD_FORBIDDEN_TOKENS = [
  ['.click(', /\.click\(/u],
  ['.focus(', /\.focus\(/u],
  ['dispatchEvent', /dispatchEvent/u],
  ['scrollIntoView', /scrollIntoView/u],
  ['scrollTo(', /\.scrollTo\(/u],
  ['scrollTop =', /scrollTop\s*=[^=]/u],
  ['setViewportSize', /setViewportSize/u],
  ['emulateMedia', /emulateMedia/u],
  ['setEmulatedMedia', /setEmulatedMedia/u],
  ['input_method', /input_method/u],
  ['dumpsys', /dumpsys/u],
  ['new SharedStageAccount(', /new SharedStageAccount\(/u],
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
  // Unlike message-source, message-unread's REST arrangement legitimately
  // seeds every message and the thread reply (D2), so REST text seeding is
  // not itself forbidden here.
  [
    'CSS class or screenshot paint',
    /classList\.contains\(['"](?:border|shadow|bg-)|shadow-overlay|\.screenshot\(|toHaveScreenshot|captureScreenshot/u,
  ],
  ['seedPreference', /seedPreference/u],
  ['trinity-e2e-shared-secret', /trinity-e2e-shared-secret/u],
  ['non-zero retries', /retries:(?!\s*0\b)/u],
  // The sampler's one allowed definition is stripped before this pattern runs.
  ['Object.defineProperty', /Object\.defineProperty\(/u],
  ['.prototype. write', /\.prototype\.\w+\s*=[^=]/u],
];

const ALLOWED_SAMPLER_DEFINITION = 'Object.defineProperty(window, key';

function assertNoUnreadForbiddenTokens(source, name) {
  const stripped = source.split(ALLOWED_SAMPLER_DEFINITION).join('');
  for (const [token, pattern] of UNREAD_FORBIDDEN_TOKENS)
    expect(pattern.test(stripped), `${name} must not contain ${token}`).toBe(
      false,
    );
}

/** Every polling wait carries an explicit finite bound argument. */
function assertUnreadBoundedWaits(source, name) {
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
      if (called === 'readUnreadView' || called === 'readAppliedProfile') {
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
function assertUnreadReadOnlyObserver(source) {
  const stripped = source.split(ALLOWED_SAMPLER_DEFINITION).join('');
  expect(stripped).not.toMatch(
    /\.(?:click|focus|blur|dispatchEvent|scrollIntoView|scrollTo|scrollBy|submit|requestSubmit|select|setSelectionRange)\s*\(/u,
  );
  expect(stripped).not.toMatch(
    /(?:\.scrollTop|\.scrollLeft|\.value|\.selectionStart|\.selectionEnd|\.innerHTML|\.textContent|\.style\.[\w]+)\s*=(?!=)/u,
  );
  expect(stripped).not.toMatch(
    /Input\.dispatch|\.goto\s*\(|window\.location\s*=|location\.assign\s*\(|\.style\.(?:setProperty|removeProperty)\s*\(|appendChild|insertBefore|replaceChildren/u,
  );
}

describe('Android message-unread source rules', () => {
  it('keeps the journeys, observer, fixture and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [JOURNEYS, OBSERVER_PATH, FIXTURE_PATH, ARTIFACTS]) {
      const source = read(path);
      assertNoUnreadForbiddenTokens(source, path);
    }
    for (const path of [JOURNEYS, OBSERVER_PATH]) {
      assertUnreadBoundedWaits(read(path), path);
      assertUnreadReadOnlyObserver(read(path));
    }
    const observer = read(OBSERVER_PATH);
    expect(observer).toContain('Object.defineProperty(window, key');
  });

  it('fails the forbidden-token and read-only rules under each effective mutation', () => {
    const observer = read(OBSERVER_PATH);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'input.value = "x"',
      'element.dispatchEvent(new MouseEvent("click"))',
      'element.scrollIntoView()',
      'element.scrollTo(0, 0)',
      'scroller.scrollTop = 0',
      'page.setViewportSize({ width: 1, height: 1 })',
      'page.emulateMedia({ reducedMotion: "reduce" })',
      'client.setEmulatedMedia(...)',
      'device.adb("shell", "dumpsys", "input_method")',
      'new SharedStageAccount(role)',
      'surface.classList.add("bg-popover")',
      'surface.setAttribute("style", "background: white")',
      'window.location = "/rooms"',
      'const report = { retries: 1 }',
      'Object.defineProperty(navigator, "x", {})',
      'Element.prototype.scrollIntoView = () => {}',
    ])
      expect(() =>
        assertNoUnreadForbiddenTokens(
          `${observer}\n${mutation}`,
          OBSERVER_PATH,
        ),
      ).toThrow();
    for (const mutation of [
      'element.click()',
      'input.focus()',
      'row.scrollTo(0, 0)',
      'input.value = "x"',
      'row.appendChild(node)',
    ])
      expect(() =>
        assertUnreadReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    for (const unbounded of [
      'await waitForNativeShellState(read, accepts, "x", signal);',
      'await client.waitElements(SHEET, accepts, "x");',
    ])
      expect(() =>
        assertUnreadBoundedWaits(`${observer}\n${unbounded}`, OBSERVER_PATH),
      ).toThrow();
  });

  it('never defines a property except the sampler window key', () => {
    const observer = read(OBSERVER_PATH);
    expect(() =>
      assertNoUnreadForbiddenTokens(observer, OBSERVER_PATH),
    ).not.toThrow();
    const extra = observer.replace(
      'Object.defineProperty(window, key, { value: state, writable: false, configurable: false, enumerable: false });',
      "Object.defineProperty(window, key, { value: state, writable: false, configurable: false, enumerable: false });\n    Object.defineProperty(window, 'other', {});",
    );
    expect(extra).not.toBe(observer);
    expect(() => assertNoUnreadForbiddenTokens(extra, OBSERVER_PATH)).toThrow();
  });

  it('restores animator_duration_scale before close and clearApplicationData, in source order [RF-1]', () => {
    const journeys = read(JOURNEYS);
    const runnerStart = journeys.indexOf(
      'export async function runMessageUnreadSuite',
    );
    expect(runnerStart).toBeGreaterThan(-1);
    const runner = journeys.slice(runnerStart);
    const restoreIdx = runner.indexOf(
      '() => restoreAnimatorIfApplied(context, client)',
    );
    const closeIdx = runner.indexOf('() => client.close()');
    const clearIdx = runner.indexOf(
      '() => device.clearApplicationData(APPLICATION_ID)',
    );
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(restoreIdx);
    expect(clearIdx).toBeGreaterThan(closeIdx);
  });
});

/* -------------------------------------------------------------------------- */
/* Hosted wiring and parity ledger                                           */
/* -------------------------------------------------------------------------- */

const UNREAD_NX_COMMAND =
  '--suite=android.message-unread --timeout-ms=900000 --entrypoint=e2e/android/message-unread-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const UNREAD_CI_LINE =
  'if [ "${{ matrix.shard }}" = "4" ]; then echo \'message-unread-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:message-unread; fi';
const UNREAD_GATE_PATH =
  "-path '*/android.message-unread/message-unread/publication-safe'";
const UNREAD_UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-unread-started == 'true' && steps.message-unread-artifact-gate.outputs.message-unread-safe == 'true' }}";

function unreadWiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
  };
}

/** Every hosted wiring rule for message-unread, as a pure function of the files' text. */
function assertUnreadWiring({ project, pkg, workflow }) {
  const target = project.targets['message-unread'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(UNREAD_NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-unread']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-unread',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(UNREAD_CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(runner).toBeLessThan(
    lines.findIndex((line) => line.includes('pnpm e2e:android --')),
  );
  expect(
    lines.filter((line) => line.includes('trinity-e2e-android:message-unread')),
  ).toHaveLength(1);
  const gate = workflow
    .split('      - name: Gate Android message-unread diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-unread-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-unread-started == 'true' }}",
  );
  expect(gate).toContain(UNREAD_GATE_PATH);
  expect(gate).toContain(
    'echo \'message-unread-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-unread\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UNREAD_UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-unread/**',
  );
}

describe('Android message-unread hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertUnreadWiring(unreadWiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-unread',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-unread',
      canonicalScript: 'e2e:android:message-unread',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      'e2e/android/message-unread-contract.mts',
      OBSERVER_PATH,
      FIXTURE_PATH,
      ARTIFACTS,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-unread',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-unread',
        command: 'nx run trinity-e2e-android:message-unread',
        kind: 'canonical',
        suiteIds: ['android.message-unread'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-unread'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "4" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-unread',
    );
    expect(read(JOURNEYS)).toContain('timeout: 900_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = unreadWiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-unread']);
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
            'message-unread-journeys.mts',
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
        delete inputs.pkg.scripts['e2e:android:message-unread'];
        return inputs;
      })(),
      withText(
        'workflow',
        UNREAD_CI_LINE,
        UNREAD_CI_LINE.replace('= "4"', '= "3"'),
      ),
      withText(
        'workflow',
        UNREAD_CI_LINE,
        UNREAD_CI_LINE.replace('1200000', '600000'),
      ),
      withText('workflow', `${UNREAD_CI_LINE}\n`, ''),
      withText(
        'workflow',
        UNREAD_GATE_PATH,
        "-path '*/android.message-unread/publication-safe'",
      ),
      withText(
        'workflow',
        UNREAD_UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-unread-started == 'true' }}",
      ),
    ])
      expect(() => assertUnreadWiring(mutated)).toThrow();
    // The runner moved after the retained Playwright command.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === UNREAD_CI_LINE);
    const [line] = lines.splice(index, 1);
    const retained = lines.findIndex((entry) =>
      entry.includes('pnpm e2e:android --'),
    );
    lines.splice(retained + 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertUnreadWiring(inputs)).toThrow();
  });

  it('documents exactly the 14 identities with their source lines and the 13/1 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-unread journey')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-unread\.[^`]+)` \|$/gmu,
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
    expect(section).toContain('13 direct + 1');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-unread`');
    expect(section).toContain('Predecessor status: enabled');
    expect(section).toContain('reduced-motion/feasibility.json');
    expect(section).not.toContain('pnpm exec nx');
  });
});
