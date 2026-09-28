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

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/pinned-message-panel.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
/**
 * The pinned-message-panel predecessor stays enabled and unchanged in the
 * working tree: it is retired only after hosted acceptance (design "Intent
 * and source boundary"). It is read directly.
 */
const readPredecessor = () => read(predecessor);
const loadContract = () =>
  import('../e2e/android/pinned-message-panel-contract.mts');
const loadObserver = () =>
  import('../e2e/android/pinned-message-panel-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/pinned-message-panel-artifacts.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');
const loadJourneys = () =>
  import('../e2e/android/pinned-message-panel-journeys.mts');

const FIXTURES = 'e2e/android/account-workspace-fixtures.mts';
const JOURNEYS = 'e2e/android/pinned-message-panel-journeys.mts';
const OBSERVER_PATH = 'e2e/android/pinned-message-panel-observer.mts';
const ARTIFACTS_PATH = 'e2e/android/pinned-message-panel-artifacts.mts';

/** The predecessor working-tree file, pinned by SHA-256. */
const PREDECESSOR_SHA256 =
  'd30470d1c2129818a096aefdf50768d31c4eae995ce17b5300e69afc696d56c0';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const SEED_SPAN = [34, 91];

/** The design's identity table, verbatim (design doc "Parity records"). */
const STAGE = {
  id: 'list-unpin',
  span: [96, 160],
  title: 'lists pinned messages and unpins one in place',
  direct: [119, 120, 135, 136, 137, 139, 140, 145, 154, 157, 158, 159],
  inherited: [],
  suffixes: [
    'panel-visible',
    'two-pinned-items',
    'room-header-measured',
    'panel-header-measured',
    'panel-title-measured',
    'header-heights-equal',
    'title-inset',
    'title-centred',
    'one-pinned-item',
    'panel-stays-open',
    'keep-remains',
    'unpin-removed',
  ],
};
const ALL_IDENTITIES = STAGE.suffixes.map(
  (suffix) => `pinned-message-panel.${STAGE.id}.${suffix}`,
);

const LINE_PINS = {
  44: 'const user = `pinner-${runId}`;',
  45: 'const pass = `pinner-pass-${runId}`;',
  46: 'const roomName = `Pinned Room ${runId}`;',
  47: 'const unpinBody = `unpin-me-${runId}`;',
  48: 'const keepBody = `keep-me-${runId}`;',
  65: "data: { name: roomName, preset: 'private_chat' },",
  71: '`${hs}/_matrix/client/v3/rooms/${room_id}/send/m.room.message/${body}`,',
  82: '{ headers: auth, data: { pinned: [unpinId, keepId] } },',
  101: "const runId = `${testResourceId('run')}p`;",
  113: "await room.first().waitFor({ state: 'visible', timeout: 30_000 });",
  119: 'await expect(panel).toBeVisible({ timeout: 30_000 });',
  140: 'expect(panelTitle!.x - panelBar!.x).toBeCloseTo(12, 0);',
  145: 'expect(Math.abs(above - below)).toBeLessThan(2);',
  152: "await unpinRow.getByTestId('pinned-unpin').click({ timeout: 10_000 });",
  155: 'timeout: 30_000,',
};

const IMPORTS = `import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
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
 * Pinned-message-panel has no platform branching to exclude.
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
  expect(source.split('\n')).toHaveLength(162);
  expect(source.split('\n').slice(0, 12).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  expect(assertionLines(source, 1, SEED_SPAN[0] - 1)).toEqual([]);
  expect(assertionLines(source, ...SEED_SPAN)).toEqual([]);
  expect(assertionLines(source, SEED_SPAN[1] + 1, STAGE.span[0] - 1)).toEqual(
    [],
  );
  expect(assertionLines(source, STAGE.span[1] + 1, 161)).toEqual([]);
  expect(lineAt(source, STAGE.span[1])).toBe('});');
  const expanded = expandDefinition(source, STAGE.span);
  expect(expanded.map(siteTuple)).toEqual(ledgerTuples());
  expect(
    expanded.filter((site) => site.kind === 'direct').map((s) => s.line),
  ).toEqual(STAGE.direct);
  expect(expanded.filter((site) => site.kind === 'inherited')).toHaveLength(0);
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android pinned-message-panel predecessor pins', () => {
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
    expect(contract.PINNED_PANEL_SOURCE).toBe(predecessor);
    expect(contract.PINNED_PANEL_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.PINNED_PANEL_SOURCE_LINES).toBe(161);
    expect(contract.PINNED_PANEL_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    const span = ([from, to]) => ({ from, to });
    expect(contract.PINNED_PANEL_SPANS).toEqual({
      seedPinnedRoom: span(SEED_SPAN),
      definitions: { [STAGE.id]: span(STAGE.span) },
    });
    expect(existsSync(resolve(root, predecessor))).toBe(true);
  });

  it('maps the exact 12 direct sites with the house AST rule, and zero inherited', () => {
    assertPredecessorShape(readPredecessor());
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = readPredecessor();
    const mutations = [
      mutateLine(source, 44, () => '  const user = `pinuser-${runId}`;'),
      mutateLine(source, 45, () => '  const pass = `pinner-secret-${runId}`;'),
      mutateLine(source, 46, () => '  const roomName = `Pin Room ${runId}`;'),
      mutateLine(source, 47, () => '  const unpinBody = `remove-me-${runId}`;'),
      mutateLine(source, 48, () => '  const keepBody = `retain-me-${runId}`;'),
      mutateLine(source, 65, (line) =>
        line.replace("'private_chat'", "'public_chat'"),
      ),
      mutateLine(source, 71, (line) =>
        line.replace('m.room.message', 'm.room.custom'),
      ),
      mutateLine(source, 82, (line) =>
        line.replace('[unpinId, keepId]', '[keepId, unpinId]'),
      ),
      mutateLine(source, 101, (line) => line.replace('}p`', '}pp`')),
      mutateLine(source, 140, (line) =>
        line.replace('toBeCloseTo(12, 0)', 'toBeCloseTo(10, 0)'),
      ),
      mutateLine(source, 145, (line) =>
        line.replace('toBeLessThan(2)', 'toBeLessThan(3)'),
      ),
      mutateLine(source, 113, (line) => line.replace('30_000', '5_000')),
      mutateLine(source, 119, (line) => line.replace('30_000', '5_000')),
      mutateLine(source, 155, (line) => line.replace('30_000', '5_000')),
      mutateLine(source, 152, (line) => line.replace('10_000', '2_000')),
    ];
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source);
      expect(() => assertPredecessorShape(mutated)).toThrow();
    }
  });
});

describe('Android pinned-message-panel helper expansion by binding', () => {
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
      ['synapseSession', 27],
      ['registerUser', 50],
      ['seedPinnedRoom', 103],
      ['login', 109],
    ]);
    // `testResourceId` binds to the fixtures module, outside support/.
    expect(
      calls
        .filter((call) => call.name === 'testResourceId')
        .map((call) => call.specifier),
    ).toEqual(['../../../fixtures.mts']);
  });

  it('follows helper calls and proves seedPinnedRoom, registerUser, login and synapseSession add no sites', () => {
    const source = readPredecessor();
    expect(helperExpectLines(predecessor, 'seedPinnedRoom', source)).toEqual(
      [],
    );
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(helperExpectLines('e2e/support/app.mts', 'synapseSession')).toEqual(
      [],
    );
    // A module-local helper that asserted would add an inherited site per call.
    const asserting = source.replace(
      '  return {\n    reader: { available: true, hs, user, pass },',
      '  expect(unpinId).toBeTruthy();\n  return {\n    reader: { available: true, hs, user, pass },',
    );
    expect(asserting).not.toBe(source);
    expect(
      expandDefinition(asserting, STAGE.span).filter(
        (site) => site.helper === 'seedPinnedRoom',
      ),
    ).toHaveLength(1);
  });

  it('excludes a shadowing local login, against a naive count', () => {
    const source = readPredecessor();
    const shadowed = source.replace(
      '    await login(page, reader);',
      '    const login = async (_page: unknown, _reader: unknown) => {};\n    await login(page, reader);',
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    expect(locals.some((call) => call.name === 'login')).toBe(true);
    expect(calls.filter((call) => call.name === 'login')).toHaveLength(0);
    expect(
      expandDefinition(shadowed, [STAGE.span[0], STAGE.span[1] + 1]).filter(
        (site) => site.helper === 'login',
      ),
    ).toHaveLength(0);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
    expect(expandDefinition(source, STAGE.span)).toHaveLength(12);
  });

  it('matches the contract sites, identities and helper table exactly', async () => {
    const contract = await loadContract();
    const source = readPredecessor();
    const expanded = expandDefinition(source, STAGE.span);
    const [stage] = contract.PINNED_PANEL_STAGES;
    expect(stage.sites.map(siteTuple)).toEqual(expanded.map(siteTuple));
    expect(stage.assertions).toEqual(ALL_IDENTITIES);
    expect(stage.sites.map(siteTuple)).not.toEqual(
      expanded.slice(0, -1).map(siteTuple),
    );
    expect(Object.keys(contract.PINNED_PANEL_HELPERS)).toEqual([]);
    expect(Object.keys(contract.PINNED_PANEL_HELPER_COUNTS)).toEqual([]);
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

describe('Android pinned-message-panel contract ledger', () => {
  it('owns one stage, 12 direct + 0 inherited = 12 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.PINNED_PANEL_STAGES.map((entry) => entry.id)).toEqual([
      STAGE.id,
    ]);
    const [stage] = contract.PINNED_PANEL_STAGES;
    expect(stage.source).toBe(`${predecessor}:96-160`);
    expect(stage.title).toBe(STAGE.title);
    expect(stage.expectedAssertionRecords).toBe(12);
    expect(contract.PINNED_PANEL_ASSERTION_RECORDS).toBe(12);
    expect(contract.PINNED_PANEL_DIRECT).toBe(12);
    expect(contract.PINNED_PANEL_INHERITED).toBe(0);
    expect(contract.PINNED_PANEL_HELPER_COUNTS).toEqual({});
    expect(new Set(ALL_IDENTITIES).size).toBe(12);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    expect(() =>
      contract.assertPinnedPanelRecords(STAGE.id, ALL_IDENTITIES),
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
        contract.assertPinnedPanelRecords(STAGE.id, invalid),
      ).toThrow();
    expect(() =>
      contract.pinnedPanelAssertion(STAGE.id, 'not-owned'),
    ).toThrow();
    expect(() =>
      contract.pinnedPanelAssertion('not-a-stage', 'panel-visible'),
    ).toThrow();
  });

  it('types exactly the predecessor run suffix, Room-name and body templates, plus the geometry and timing constants', async () => {
    const contract = await loadContract();
    expect(predecessorTemplates(readPredecessor(), STAGE.span)).toMatchObject({
      runId: "`${testResourceId('run')}p`",
    });
    expect(predecessorTemplates(readPredecessor(), SEED_SPAN)).toMatchObject({
      roomName: '`Pinned Room ${runId}`',
      unpinBody: '`unpin-me-${runId}`',
      keepBody: '`keep-me-${runId}`',
    });
    expect(contract.PINNED_PANEL_RUN_SUFFIX).toBe('p');
    expect(contract.pinnedRoomName('r-1')).toBe('Pinned Room r-1');
    expect(contract.unpinBody('r-1')).toBe('unpin-me-r-1');
    expect(contract.keepBody('r-1')).toBe('keep-me-r-1');
    expect(contract.TITLE_INSET_PX).toBe(12);
    expect(contract.CENTRE_IMBALANCE_PX).toBe(2);
    expect(contract.SETTLE_GAP_MS).toBe(500);
    expect(contract.HOLD_MS).toBe(2_000);
    expect(contract.HOLD_READS).toBe(4);
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertPinnedPanelReceiptName } = await loadContract();
    for (const name of [
      'room-open',
      'toolbar-pin-hidden',
      'unpin-target',
      'server-pins',
    ])
      expect(() => assertPinnedPanelReceiptName(name)).not.toThrow();
    for (const name of [
      'pinned-message-panel.list-unpin.panel-visible',
      'pinned-message-panel-x',
      'Server Pins',
      'a/b',
      '',
    ])
      expect(() => assertPinnedPanelReceiptName(name)).toThrow();
  });

  it('pins the product pinned-panel and toolbar-overflow template surfaces the journey relies on', () => {
    const roomsPage = read('libs/feature/rooms/src/lib/rooms/rooms.page.html');
    expect(roomsPage).toContain('data-testid="room-actions-overflow"');
    const openPinnedTestId = 'data-testid="open-pinned"';
    const openPinnedButton = roomsPage.slice(
      roomsPage.lastIndexOf('<button', roomsPage.indexOf(openPinnedTestId)),
      roomsPage.indexOf(openPinnedTestId) + openPinnedTestId.length,
    );
    expect(openPinnedButton).toContain('class="header-pin max-md:hidden"');
    expect(openPinnedButton).toContain(
      '(click)="messageActions.openPinnedPanel()"',
    );
    const overflowTestId = 'data-testid="overflow-open-pinned"';
    const overflowStart = roomsPage.indexOf(overflowTestId);
    const overflowItem = roomsPage.slice(
      roomsPage.lastIndexOf('<button', overflowStart),
      overflowStart + overflowTestId.length,
    );
    expect(overflowItem).toContain('class="md:hidden"');
    expect(overflowItem).toContain('trnDropdownMenuItem');
    expect(overflowItem).toContain(
      '(triggered)="messageActions.openPinnedPanel()"',
    );
    const panel = read(
      'libs/feature/rooms/src/lib/pinned/pinned-messages-panel.component.html',
    );
    for (const hook of [
      'class="pin-item"',
      'data-testid="pinned-unpin"',
      'class="panel-header',
    ])
      expect(panel).toContain(hook);
  });
});

/* -------------------------------------------------------------------------- */
/* Shared fixture union                                                        */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-panel shared fixture union', () => {
  it('adds the pinned-events member right after the Room-name member', () => {
    const fixtures = read(FIXTURES);
    expect(fixtures).toContain(
      "  | 'm.room.name'\n  | 'm.room.pinned_events'\n  | 'm.room.power_levels'",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Asserters, settle and hold predicates [RF-2][RF-3][RF-4]                   */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-panel asserters', () => {
  const box = (x, y, width, height) => ({ x, y, width, height });
  // The probe's measured Pixel 5 view (spec §Feasibility probe, items 3–5).
  const probe = () => ({
    roomHeader: {
      count: 1,
      first: box(0, 160.76, 393.14, 56),
      namesRoom: true,
    },
    panel: {
      count: 1,
      visible: true,
      box: box(0, 0, 393.14, 727.24),
      containsKeep: true,
      containsUnpin: true,
      animating: false,
    },
    panelHeader: { count: 1, box: box(0, 0, 393.14, 56) },
    panelTitle: { count: 1, box: box(12, 15.62, 317.14, 24) },
    items: { count: 2, order: ['unpin', 'keep'] },
    rows: [
      {
        label: 'unpin',
        box: box(8, 64, 377, 65.5),
        unpinCount: 1,
        unpin: box(337.14, 74.75, 44, 44),
        unobstructed: true,
      },
      {
        label: 'keep',
        box: box(8, 129.5, 377, 65.5),
        unpinCount: 1,
        unpin: box(337.14, 140.25, 44, 44),
        unobstructed: true,
      },
    ],
    openPinned: { count: 1, box: box(0, 0, 0, 0) },
  });
  const after = () => ({
    ...probe(),
    panel: { ...probe().panel, containsUnpin: false },
    items: { count: 1, order: ['keep'] },
    rows: [{ ...probe().rows[1], box: box(8, 64, 377, 65.5) }],
  });

  it('passes the probe view on every record predicate', async () => {
    const c = await loadContract();
    const v = c.parsePinnedView(probe());
    for (const f of [
      c.assertPanelVisible,
      c.assertPinOrder,
      c.assertOpenPinnedHidden,
      c.assertHeaderNamesRoom,
      c.assertHeaderHeightsEqual,
      c.assertTitleInset,
      c.assertTitleCentred,
      c.assertUnpinTarget,
    ])
      expect(() => f(v)).not.toThrow();
    expect(() => c.assertItemCount(v, 2)).not.toThrow();
    expect(() =>
      c.assertHeldAfterUnpin(c.parsePinnedView(after())),
    ).not.toThrow();
  });
  it('fails each geometry boundary', async () => {
    const c = await loadContract();
    const withBar = (h) =>
      c.parsePinnedView({
        ...probe(),
        panelHeader: { count: 1, box: box(0, 0, 393.14, h) },
      });
    expect(() => c.assertHeaderHeightsEqual(withBar(45))).toThrow();
    expect(() => c.assertHeaderHeightsEqual(withBar(56.01))).toThrow();
    const withTitleX = (x) =>
      c.parsePinnedView({
        ...probe(),
        panelTitle: { count: 1, box: box(x, 15.62, 317.14, 24) },
      });
    expect(() => c.assertTitleInset(withTitleX(12.49))).not.toThrow();
    expect(() => c.assertTitleInset(withTitleX(12.5))).toThrow();
    expect(() => c.assertTitleInset(withTitleX(11.5))).toThrow();
    // above − below = 2y + 24 − 56, so y = 17 gives 2.0 and y = 16.995 gives 1.99
    const withTitleY = (y) =>
      c.parsePinnedView({
        ...probe(),
        panelTitle: { count: 1, box: box(12, y, 317.14, 24) },
      });
    expect(() => c.assertTitleCentred(withTitleY(16.995))).not.toThrow();
    expect(() => c.assertTitleCentred(withTitleY(17))).toThrow();
    expect(() => c.assertMeasured(null, 'Room header')).toThrow(/Room header/u);
    expect(() =>
      c.assertHeaderNamesRoom(
        c.parsePinnedView({
          ...probe(),
          roomHeader: { ...probe().roomHeader, namesRoom: false },
        }),
      ),
    ).toThrow();
  });
  it('settles only on two identical, non-animating reads at least 500 ms apart [RF-2]', async () => {
    const c = await loadContract();
    const v = c.parsePinnedView(probe());
    expect(c.geometrySettled({ at: 0, view: v }, { at: 500, view: v })).toBe(
      true,
    );
    expect(c.geometrySettled({ at: 0, view: v }, { at: 499, view: v })).toBe(
      false,
    );
    const moved = c.parsePinnedView({
      ...probe(),
      panelTitle: { count: 1, box: box(40, 15.62, 317.14, 24) },
    });
    expect(
      c.geometrySettled({ at: 0, view: moved }, { at: 600, view: v }),
    ).toBe(false);
    const animating = c.parsePinnedView({
      ...probe(),
      panel: { ...probe().panel, animating: true },
    });
    expect(
      c.geometrySettled(
        { at: 0, view: animating },
        { at: 600, view: animating },
      ),
    ).toBe(false);
    // Isolates the previous-side check: only `pick()`'s box fields must match
    // between the animating and settled views, so a settle predicate that
    // forgot to check `previous.view.panel.animating` would wrongly settle here.
    expect(
      c.geometrySettled({ at: 0, view: animating }, { at: 600, view: v }),
    ).toBe(false);
  });
  it('fails count, order, visibility, target and held-state controls [RF-3]', async () => {
    const c = await loadContract();
    const v = (patch) => c.parsePinnedView({ ...probe(), ...patch });
    expect(() =>
      c.assertItemCount(
        v({ items: { count: 3, order: ['unpin', 'keep', 'other'] } }),
        2,
      ),
    ).toThrow();
    expect(() =>
      c.assertPinOrder(v({ items: { count: 2, order: ['keep', 'unpin'] } })),
    ).toThrow();
    expect(() =>
      c.assertPanelVisible(v({ panel: { ...probe().panel, visible: false } })),
    ).toThrow();
    expect(() =>
      c.assertOpenPinnedHidden(
        v({ openPinned: { count: 1, box: box(300, 172, 32, 32) } }),
      ),
    ).toThrow(/revisit D3/u);
    const [unpinRow, keepRow] = probe().rows;
    expect(() =>
      c.assertUnpinTarget(
        v({ rows: [{ ...unpinRow, unpin: keepRow.unpin }, keepRow] }),
      ),
    ).toThrow();
    expect(() =>
      c.assertUnpinTarget(
        v({ rows: [{ ...unpinRow, unpinCount: 2 }, keepRow] }),
      ),
    ).toThrow();
    expect(() =>
      c.assertUnpinTarget(
        v({ rows: [{ ...unpinRow, unobstructed: false }, keepRow] }),
      ),
    ).toThrow();
    const held = (patch) => c.parsePinnedView({ ...after(), ...patch });
    expect(() =>
      c.assertHeldAfterUnpin(
        held({ panel: { ...after().panel, visible: false } }),
      ),
    ).toThrow();
    expect(() =>
      c.assertHeldAfterUnpin(
        held({ items: { count: 0, order: [] }, rows: [] }),
      ),
    ).toThrow();
    expect(() =>
      c.assertHeldAfterUnpin(
        held({ panel: { ...after().panel, containsKeep: false } }),
      ),
    ).toThrow();
    expect(() =>
      c.assertHeldAfterUnpin(
        held({ panel: { ...after().panel, containsUnpin: true } }),
      ),
    ).toThrow();
  });
  it('accepts only the exact arrangement and the exact converged server pins [RF-4]', async () => {
    const c = await loadContract();
    const pinner = '@p:localhost';
    const msg = (body, id) => ({
      type: 'm.room.message',
      sender: pinner,
      event_id: id,
      content: { msgtype: 'm.text', body },
    });
    const events = [msg('unpin-me-r', '$u'), msg('keep-me-r', '$k')];
    const exp = {
      pinnerId: pinner,
      unpinBody: 'unpin-me-r',
      keepBody: 'keep-me-r',
      unpinId: '$u',
      keepId: '$k',
    };
    expect(() =>
      c.assertPinnedArrangement(events, { pinned: ['$u', '$k'] }, exp),
    ).not.toThrow();
    for (const pins of [['$k', '$u'], ['$u'], ['$u', '$k', '$x']])
      expect(() =>
        c.assertPinnedArrangement(events, { pinned: pins }, exp),
      ).toThrow();
    expect(() =>
      c.assertPinnedArrangement(
        [...events].reverse(),
        { pinned: ['$u', '$k'] },
        exp,
      ),
    ).toThrow();
    expect(() =>
      c.assertPinnedArrangement(
        [...events, msg('x', '$x')],
        { pinned: ['$u', '$k'] },
        exp,
      ),
    ).toThrow();
    expect(() => c.assertServerPins({ pinned: ['$k'] }, '$k')).not.toThrow();
    for (const pins of [[], ['$u'], ['$u', '$k'], ['$k', '$u']])
      expect(() => c.assertServerPins({ pinned: pins }, '$k')).toThrow();
  });
  it('keeps neither body a substring of the other or of the Room name', async () => {
    const c = await loadContract();
    const r = 'trn-abc-p';
    const texts = [c.pinnedRoomName(r), c.unpinBody(r), c.keepBody(r)];
    for (const a of texts)
      for (const b of texts) if (a !== b) expect(a.includes(b)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only renderer observation (jsdom)                                     */
/* -------------------------------------------------------------------------- */

const ROOM_HEADER_BOX = { x: 0, y: 160.76, width: 393.14, height: 56 };
const PANEL_BOX = { x: 0, y: 0, width: 393.14, height: 727.24 };
const PANEL_HEADER_BOX = { x: 0, y: 0, width: 393.14, height: 56 };
const PANEL_TITLE_BOX = { x: 12, y: 15.62, width: 317.14, height: 24 };
const UNPIN_ROW_BOX = { x: 8, y: 64, width: 377, height: 65.5 };
const KEEP_ROW_BOX = { x: 8, y: 129.5, width: 377, height: 65.5 };
const UNPIN_CONTROL_BOX = { x: 337.14, y: 74.75, width: 44, height: 44 };
const KEEP_CONTROL_BOX = { x: 337.14, y: 140.25, width: 44, height: 44 };
const ZERO_BOX = { x: 0, y: 0, width: 0, height: 0 };

const rect = (box) => ({
  x: box.x,
  y: box.y,
  width: box.width,
  height: box.height,
  left: box.x,
  top: box.y,
  right: box.x + box.width,
  bottom: box.y + box.height,
});

const TEXTS = {
  roomName: 'Pinned Room trn-obs-p',
  unpinBody: 'unpin-me-trn-obs-p',
  keepBody: 'keep-me-trn-obs-p',
};

function pinnedHtml({ panels = 1, hasHeader = true, texts = TEXTS } = {}) {
  const header = hasHeader
    ? `<trn-page-header><header><h1>${texts.roomName}</h1></header></trn-page-header>`
    : '';
  const row = (kind, body) => `
    <div class="pin-item" data-row="${kind}">
      <div data-testid="pinned-item">Pinner · 10:00 · ${body}</div>
      <button data-testid="pinned-unpin"></button>
    </div>`;
  const panel = `
    <div data-testid="pinned-panel">
      <div class="panel-header"><h2>Pinned messages</h2></div>
      ${row('unpin', texts.unpinBody)}
      ${row('keep', texts.keepBody)}
    </div>`;
  const panelsHtml = Array.from({ length: panels }, () => panel).join('');
  return `${header}${panelsHtml}<button data-testid="open-pinned" style="display:none"></button>`;
}

function pinnedWindow(body, options = {}) {
  const dom = new JSDOM(`<main>${body}</main>`);
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('trn-page-header header')) return rect(ROOM_HEADER_BOX);
    if (this.matches('[data-testid="pinned-panel"]')) return rect(PANEL_BOX);
    if (this.matches('.panel-header h2')) return rect(PANEL_TITLE_BOX);
    if (this.matches('.panel-header')) return rect(PANEL_HEADER_BOX);
    if (this.matches('[data-testid="open-pinned"]')) return rect(ZERO_BOX);
    if (this.matches('.pin-item[data-row="unpin"]')) return rect(UNPIN_ROW_BOX);
    if (this.matches('.pin-item[data-row="keep"]')) return rect(KEEP_ROW_BOX);
    if (
      this.matches('.pin-item[data-row="unpin"] [data-testid="pinned-unpin"]')
    )
      return rect(UNPIN_CONTROL_BOX);
    if (this.matches('.pin-item[data-row="keep"] [data-testid="pinned-unpin"]'))
      return rect(KEEP_CONTROL_BOX);
    return rect(ZERO_BOX);
  };
  // jsdom implements no layout: `getClientRects` mirrors the mocked rect above,
  // empty exactly for the display:none open-pinned control.
  window.HTMLElement.prototype.getClientRects = function () {
    return this.matches('[data-testid="open-pinned"]')
      ? []
      : [this.getBoundingClientRect()];
  };
  window.document.elementFromPoint = (x, y) => {
    const controls = [
      ...window.document.querySelectorAll('[data-testid="pinned-unpin"]'),
    ];
    return (
      controls.find((control) => {
        const box = control.getBoundingClientRect();
        return (
          x >= box.x &&
          x <= box.x + box.width &&
          y >= box.y &&
          y <= box.y + box.height
        );
      }) ?? null
    );
  };
  window.HTMLElement.prototype.getAnimations = function () {
    return options.animating ? [{ playState: 'running' }] : [];
  };
  return window;
}

function evaluateIn(body, expression, options = {}) {
  const window = pinnedWindow(body, options);
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

describe('Android pinned-message-panel read-only renderer observation (jsdom)', () => {
  it('observes both pins in published order, names the Room and finds each row its own unpin control, leaking no text', async () => {
    const contract = await loadContract();
    const { pinnedViewExpression } = await loadObserver();
    const view = contract.parsePinnedView(
      evaluateIn(pinnedHtml(), pinnedViewExpression(TEXTS)),
    );
    expect(view.roomHeader).toMatchObject({ count: 1, namesRoom: true });
    expect(view.panel).toMatchObject({
      count: 1,
      visible: true,
      containsKeep: true,
      containsUnpin: true,
      animating: false,
    });
    expect(view.panelHeader.count).toBe(1);
    expect(view.panelTitle.count).toBe(1);
    expect(view.items).toMatchObject({ count: 2, order: ['unpin', 'keep'] });
    expect(view.rows.map((row) => row.unpinCount)).toEqual([1, 1]);
    expect(view.rows.map((row) => row.unobstructed)).toEqual([true, true]);
    expect(view.openPinned.count).toBe(1);
    expect(() => contract.assertPanelVisible(view)).not.toThrow();
    expect(() => contract.assertPinOrder(view)).not.toThrow();
    expect(() => contract.assertOpenPinnedHidden(view)).not.toThrow();
    expect(() => contract.assertUnpinTarget(view)).not.toThrow();
    const serialized = JSON.stringify(view);
    for (const leaked of [
      TEXTS.unpinBody,
      TEXTS.keepBody,
      TEXTS.roomName,
      'Pinner',
    ])
      expect(serialized).not.toContain(leaked);
  });

  it('observes two panels, a missing header or a running animation as such', async () => {
    const contract = await loadContract();
    const { pinnedViewExpression } = await loadObserver();
    const observe = (options) =>
      contract.parsePinnedView(
        evaluateIn(pinnedHtml(options), pinnedViewExpression(TEXTS), options),
      );
    const twoPanels = observe({ panels: 2 });
    expect(twoPanels.panel.count).toBe(2);
    expect(() => contract.assertPanelVisible(twoPanels)).toThrow();
    const noHeader = observe({ hasHeader: false });
    expect(noHeader.roomHeader).toMatchObject({ count: 0, first: null });
    expect(() => contract.assertHeaderNamesRoom(noHeader)).toThrow();
    const animating = observe({ animating: true });
    expect(animating.panel.animating).toBe(true);
    expect(
      contract.geometrySettled(
        { at: 0, view: animating },
        { at: 600, view: animating },
      ),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Diagnostics safety                                                         */
/* -------------------------------------------------------------------------- */

const PINNER = {
  userId: '@trn_pinner_0a1b2c:localhost',
  username: 'trn_pinner_0a1b2c',
  password: 'pinner-pass-0a1b2c',
};
const ROOM = {
  id: '!Pinned_Ab+c/d:localhost',
  name: 'Pinned Room trn-pinned-0a1b2cp',
};
const UNPIN_BODY = 'unpin-me-trn-pinned-0a1b2cp';
const KEEP_BODY = 'keep-me-trn-pinned-0a1b2cp';
const UNPIN_ID = '$Pinned_unpin';
const KEEP_ID = '$Pinned_keep';
const ARTIFACT_IDS = {
  accounts: [PINNER],
  rooms: [ROOM],
  texts: [UNPIN_BODY, KEEP_BODY],
  eventIds: [UNPIN_ID, KEEP_ID],
  transactions: [UNPIN_BODY, KEEP_BODY],
};

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

describe('Android pinned-message-panel diagnostics safety', () => {
  it('registers every identifier form for the one Account and one Room, never the bare server name', async () => {
    const { pinnedPanelSecrets } = await loadArtifacts();
    const secrets = pinnedPanelSecrets(STAGE.id, ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_PANEL_LIST_UNPIN_'),
      ),
    ).toBe(true);
    const values = new Set(Object.values(secrets));
    for (const value of [
      PINNER.userId,
      encodeURIComponent(PINNER.userId),
      PINNER.username,
      PINNER.password,
      ROOM.id,
      ROOM.id.slice(1),
      encodeURIComponent(ROOM.id),
      Buffer.from(ROOM.id).toString('base64url'),
      ROOM.name,
      UNPIN_BODY,
      KEEP_BODY,
      UNPIN_ID,
      KEEP_ID,
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(
        pinnedPanelSecrets(STAGE.id, {
          accounts: [],
          rooms: [],
          texts: [],
          eventIds: [],
          transactions: [],
        }),
      ),
    ).toEqual([]);
    expect(() => pinnedPanelSecrets('not-a-stage', ARTIFACT_IDS)).toThrow();
    expect(() =>
      pinnedPanelSecrets(STAGE.id, { ...ARTIFACT_IDS, texts: [''] }),
    ).toThrow();
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier, credential and token', async () => {
    const { pinnedPanelSecrets, scanPinnedPanelArtifacts } =
      await loadArtifacts();
    const secrets = pinnedPanelSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-panel-scan-', async (output) => {
      await mkdir(join(output, STAGE.id));
      const capture = join(output, STAGE.id, 'passed.json');
      for (const unsafe of [
        JSON.stringify({ password: PINNER.password }),
        `GET /rooms/${ROOM.id}/messages`,
        `GET /rooms/${encodeURIComponent(ROOM.id)}/event/${encodeURIComponent(UNPIN_ID)}`,
        `double=${encodeURIComponent(encodeURIComponent(ROOM.id))}`,
        `route=/rooms/${Buffer.from(ROOM.id).toString('base64url')}`,
        `slice=${ROOM.id.slice(1)}`,
        `user=${PINNER.userId}`,
        `user=${encodeURIComponent(PINNER.userId)}`,
        `body=${KEEP_BODY}`,
        `name=${ROOM.name}`,
        `within=.pin-item ${UNPIN_BODY}`,
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
          scanPinnedPanelArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        capture,
        '{"eventDigest":"ab","event_id":"[REDACTED]","server":"localhost","access_token":false,"alpha":1}\n',
      );
      await expect(
        scanPinnedPanelArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of [
        'passed-webview.png',
        'failed-device.PNG',
        'opaque.bin',
      ])
        await withOutput('trinity-panel-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(scanPinnedPanelArtifacts(other, {})).rejects.toThrow();
        });
    });
  });

  it('scrubs captured diagnostics of every registered form, deletes raster, and then scans clean', async () => {
    const {
      pinnedPanelSecrets,
      scrubPinnedPanelArtifacts,
      scanPinnedPanelArtifacts,
    } = await loadArtifacts();
    const secrets = pinnedPanelSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-panel-scrub-', async (output) => {
      const stage = join(output, STAGE.id);
      await mkdir(stage);
      const path = join(stage, 'passed-surface.json');
      await writeFile(
        path,
        [
          `GET /rooms/${encodeURIComponent(ROOM.id)}/messages`,
          `sender=${PINNER.userId}`,
          JSON.stringify({ password: PINNER.password }),
          'Msg: Event $SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 already in timeline',
          'class $OnBluetoothActivityEnergyInfoProxy digest 0a1b2c',
          'unchanged=1 pin',
        ].join('\n'),
      );
      for (const name of [
        'passed-webview.png',
        'passed-device.png',
        'failed-webview.png',
        'failed-device.png',
      ])
        await writeFile(join(stage, name), 'raster of the panel');
      await scrubPinnedPanelArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe('unchanged=1 pin');
      for (const leaked of [
        ROOM.id,
        PINNER.userId,
        PINNER.password,
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
        scanPinnedPanelArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried one-stage 12-record Pixel 5 run', async () => {
    const artifacts = await loadArtifacts();
    const { DESKTOP_ACCOUNT_PROFILE, PIXEL_5_ACCOUNT_PROFILE } =
      await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 12,
      attempt: 1,
      retries: 0,
      stages: [
        {
          id: STAGE.id,
          status: 'passed',
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: 12,
          assertionRecords: 12,
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
    await withOutput('trinity-panel-gate-', async (output) => {
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
          artifacts.markPinnedPanelDiagnosticsSafe(
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
      await artifacts.markPinnedPanelDiagnosticsSafe(
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
          value.stages[0].assertionRecords = 11;
        }),
        mutate((value) => (value.expectedAssertionRecords = 11)),
      ]) {
        await arrange(invalid);
        await refused(invalid);
      }
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
        `token=${UNPIN_ID}`,
      );
      await refused(report(), {
        secrets: artifacts.pinnedPanelSecrets(STAGE.id, ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, STAGE.id, 'passed-webview.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const { runPinnedPanelStageCleanup, revokePinnedPanelPublicationOnAbort } =
      await loadArtifacts();
    const failures = [];
    const ran = [];
    await runPinnedPanelStageCleanup(
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
    await withOutput('trinity-panel-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokePinnedPanelPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokePinnedPanelPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before pinned-panel publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });

  it('redacts registered secrets and shared Matrix identifier shapes from diagnostic text', async () => {
    const { pinnedPanelSecrets, redactDiagnosticText } = await loadArtifacts();
    const secrets = pinnedPanelSecrets(STAGE.id, ARTIFACT_IDS);
    const text = `user=${PINNER.userId} room=${ROOM.id} unregistered=$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 event=${UNPIN_ID}`;
    const redacted = redactDiagnosticText(text, secrets);
    expect(redacted).not.toContain(PINNER.userId);
    expect(redacted).not.toContain(ROOM.id);
    expect(redacted).not.toContain(UNPIN_ID);
    expect(redacted).not.toContain(
      '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4',
    );
    // Removing the artifacts module's own redaction call would leak identifiers again.
    expect(read('e2e/android/pinned-message-panel-artifacts.mts')).toContain(
      'redactMatrixIdentifiers(redactSecretText(text, secrets))',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Native journey against a simulated installed app [RF-1][RF-3][RF-4]        */
/* -------------------------------------------------------------------------- */

const SUFFIXES = STAGE.suffixes;

const JOURNEY_PINNER = {
  userId: '@pinned-journey-pinner:localhost',
  username: 'pinned-journey-pinner',
  password: 'pinned-journey-pinner-secret-pw',
};
const JOURNEY_ROOM_ID = '!Pinned_Journey_Room:localhost';
const JOURNEY_UNPIN_ID = '$Pinned_Journey_unpin';
const JOURNEY_KEEP_ID = '$Pinned_Journey_keep';
const JOURNEY_RUN = 'trn-pinned-journey-0a1b2c';

const jbox = (x, y, width, height) => ({ x, y, width, height });

function journeyProbeView() {
  return {
    roomHeader: {
      count: 1,
      first: jbox(0, 160.76, 393.14, 56),
      namesRoom: true,
    },
    panel: {
      count: 1,
      visible: true,
      box: jbox(0, 0, 393.14, 727.24),
      containsKeep: true,
      containsUnpin: true,
      animating: false,
    },
    panelHeader: { count: 1, box: jbox(0, 0, 393.14, 56) },
    panelTitle: { count: 1, box: jbox(12, 15.62, 317.14, 24) },
    items: { count: 2, order: ['unpin', 'keep'] },
    rows: [
      {
        label: 'unpin',
        box: jbox(8, 64, 377, 65.5),
        unpinCount: 1,
        unpin: jbox(337.14, 74.75, 44, 44),
        unobstructed: true,
      },
      {
        label: 'keep',
        box: jbox(8, 129.5, 377, 65.5),
        unpinCount: 1,
        unpin: jbox(337.14, 140.25, 44, 44),
        unobstructed: true,
      },
    ],
    openPinned: { count: 1, box: jbox(0, 0, 0, 0) },
  };
}

function journeyAfterView() {
  const probe = journeyProbeView();
  return {
    ...probe,
    panel: { ...probe.panel, containsUnpin: false },
    items: { count: 1, order: ['keep'] },
    rows: [{ ...probe.rows[1], box: jbox(8, 64, 377, 65.5) }],
  };
}

/**
 * One minimal simulated installed app: a fake `AccountWorkspaceClient` and
 * `AccountFixtures` pair that drives the real, imported `runListUnpin`
 * end to end. `faults` injects exactly one negative control at a time.
 */
async function simulatedPinnedPanelApp(faults = {}) {
  const { pinnedRoomName, unpinBody, keepBody } = await loadContract();
  const { pinnedViewExpression, appliedProfileExpression } =
    await loadObserver();
  const TEXTS = {
    roomName: pinnedRoomName(JOURNEY_RUN),
    unpinBody: unpinBody(JOURNEY_RUN),
    keepBody: keepBody(JOURNEY_RUN),
  };
  const PINNED_VIEW_EXPR = pinnedViewExpression(TEXTS);
  const APPLIED_PROFILE_EXPR = appliedProfileExpression();
  const controller = new AbortController();
  const label = (text) =>
    text === TEXTS.roomName
      ? 'room'
      : text === TEXTS.unpinBody
        ? 'unpin'
        : text === TEXTS.keepBody
          ? 'keep'
          : text;
  const state = {
    actions: [],
    written: [],
    unpinTapped: false,
    tapReturnAt: null,
    heldReads: 0,
    serverPins: faults.arrangedReversed
      ? [JOURNEY_KEEP_ID, JOURNEY_UNPIN_ID]
      : [JOURNEY_UNPIN_ID, JOURNEY_KEEP_ID],
  };

  function currentView() {
    let switched = state.unpinTapped;
    if (faults.anchoredSwitchMs !== undefined) {
      switched =
        state.tapReturnAt !== null &&
        Date.now() - state.tapReturnAt >= faults.anchoredSwitchMs;
    }
    let view = switched ? journeyAfterView() : journeyProbeView();
    if (faults.neverVisible)
      view = {
        ...view,
        panel: { ...view.panel, count: 0, visible: false, box: null },
      };
    if (faults.openPinnedVisible)
      view = { ...view, openPinned: { count: 1, box: jbox(300, 172, 32, 32) } };
    if (faults.threeItems)
      view = {
        ...view,
        items: { count: 3, order: [...view.items.order, 'other'] },
      };
    if (faults.reversedOrder && !switched)
      view = { ...view, items: { count: 2, order: ['keep', 'unpin'] } };
    if (faults.geometryDrift) {
      state.driftTick = (state.driftTick ?? 0) + 1;
      const x = state.driftTick % 2 === 0 ? 12 : 40;
      view = {
        ...view,
        panelTitle: { count: 1, box: jbox(x, 15.62, 317.14, 24) },
      };
    }
    if (faults.unpinInsideKeepRow && !switched) {
      const [unpinRow, keepRow] = view.rows;
      view = {
        ...view,
        rows: [{ ...unpinRow, unpin: keepRow.unpin }, keepRow],
      };
    }
    if (faults.closesOnThirdHeldRead && switched) {
      state.heldReads += 1;
      if (state.heldReads >= 3)
        view = {
          ...view,
          panel: { ...view.panel, count: 0, visible: false, box: null },
        };
    }
    return view;
  }

  const client = {
    device: { clearApplicationData: async () => {} },
    signal: controller.signal,
    webview: {
      diagnostics: {
        send: async (_method, { expression }) => {
          if (expression === PINNED_VIEW_EXPR) {
            // Each fake webview read advances the simulated Date by 1 s, so the
            // anchored-window controls can cross their threshold without a real wait.
            if (faults.anchoredSwitchMs !== undefined)
              vi.setSystemTime(Date.now() + 1_000);
            return { result: { value: currentView() } };
          }
          if (expression === APPLIED_PROFILE_EXPR)
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
      if (filter.within)
        state.actions.push(
          `tap:${selector}|within ${filter.within.selector} ${label(filter.within.text)}`,
        );
      else
        state.actions.push(
          `tap:${selector}${filter.text ? `|${label(filter.text)}` : ''}`,
        );
      if (selector === '[data-testid="pinned-unpin"]') {
        if (faults.anchoredSwitchMs !== undefined)
          vi.setSystemTime(Date.now() + 45_000);
        state.unpinTapped = true;
        state.tapReturnAt = Date.now();
        if (!faults.serverPinsRejects) state.serverPins = [JOURNEY_KEEP_ID];
      }
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture() {},
  };

  const fixtures = {
    async account() {
      return { ...JOURNEY_PINNER };
    },
    async createRoom(_account, content) {
      return { id: JOURNEY_ROOM_ID, name: content.name };
    },
    async sendMessage(_account, _roomId, body) {
      if (body === TEXTS.unpinBody) return JOURNEY_UNPIN_ID;
      if (body === TEXTS.keepBody) return JOURNEY_KEEP_ID;
      throw new Error(`Unmodelled simulated sendMessage body ${body}`);
    },
    async setRoomState() {},
    async roomMessages() {
      return {
        chunk: [
          {
            type: 'm.room.message',
            event_id: JOURNEY_KEEP_ID,
            room_id: JOURNEY_ROOM_ID,
            sender: JOURNEY_PINNER.userId,
            content: { msgtype: 'm.text', body: TEXTS.keepBody },
          },
          {
            type: 'm.room.message',
            event_id: JOURNEY_UNPIN_ID,
            room_id: JOURNEY_ROOM_ID,
            sender: JOURNEY_PINNER.userId,
            content: { msgtype: 'm.text', body: TEXTS.unpinBody },
          },
          {
            type: 'm.room.create',
            event_id: '$create',
            room_id: JOURNEY_ROOM_ID,
            sender: JOURNEY_PINNER.userId,
            state_key: '',
            content: {},
          },
        ],
        start: 's',
        end: 'e',
      };
    },
    async roomState() {
      // The convergence poll rejects immediately on a genuine (id-free) read
      // failure, exactly as a real REST error would surface [step 5 note].
      if (faults.serverPinsRejects && state.unpinTapped)
        throw new Error(
          'Simulated Matrix fixture GET room-state failed with HTTP 500',
        );
      return { pinned: state.serverPins };
    },
  };

  return { client, fixtures, state, controller };
}

/** Builds one simulated stage context and cleans up its real temp directory. */
async function withSimulatedPinnedPanelStage(faults, run) {
  const { PINNED_PANEL_STAGES } = await loadContract();
  const directory = await mkdtemp(join(tmpdir(), 'trinity-panel-journey-'));
  try {
    const app = await simulatedPinnedPanelApp(faults);
    const context = {
      entry: PINNED_PANEL_STAGES[0],
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
      ledger: {
        run: JOURNEY_RUN,
        accounts: [],
        rooms: [],
        texts: [],
        eventIds: [],
        transactions: [],
      },
    };
    return await run({ context, state: app.state });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Android pinned-message-panel native journey against a simulated installed app', () => {
  it('drives the exact native sequence and records all twelve identities in order', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage({}, async ({ context, state }) => {
      await runListUnpin(context);
      expect(state.actions).toEqual([
        'reset:393',
        'login',
        'hideKeyboard',
        'tap:[data-testid="rail-rooms"]',
        'tap:.channel|room',
        'tap:[data-testid="room-actions-overflow"]',
        'tap:[data-testid="overflow-open-pinned"]',
        'tap:[data-testid="pinned-unpin"]|within .pin-item unpin',
      ]);
      expect(context.records).toEqual(
        SUFFIXES.map((s) => `pinned-message-panel.list-unpin.${s}`),
      );
    });
  });

  it('fails closed when open-pinned is visible at Pixel 5 [revisit D3]', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { openPinnedVisible: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow(/revisit D3/u);
      },
    );
  });

  it('fails closed when the pinned panel never becomes visible', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { neverVisible: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow(
          /pinned panel is visible/u,
        );
      },
    );
  }, 35_000);

  it('fails closed on a stable, wrong pinned-item count [three items]', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { threeItems: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow(/Exactly 2/u);
      },
    );
  });

  it('fails closed on a reversed rendered order', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { reversedOrder: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow(/published order/u);
      },
    );
  });

  it('fails closed when the geometry never settles [RF-2]', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { geometryDrift: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow(
          /panel geometry did not settle/u,
        );
      },
    );
  }, 25_000);

  it('fails closed when the unpin control is observed inside the keep row [RF-3]', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { unpinInsideKeepRow: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow(
          /inside its own row only/u,
        );
      },
    );
  });

  it('fails closed when the panel closes on the third held read [RF-3]', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { closesOnThirdHeldRead: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow(
          /pinned panel is visible/u,
        );
      },
    );
  });

  it('rejects when the server pinned state never converges to the kept event [RF-4]', async () => {
    const { runListUnpin } = await loadJourneys();
    // Covers both listed sub-cases: the fake fixture's immediate, id-free read
    // failure stands in for pins that stay [unpin, keep] or become [unpin].
    await withSimulatedPinnedPanelStage(
      { serverPinsRejects: true },
      async ({ context }) => {
        await expect(runListUnpin(context)).rejects.toThrow();
      },
    );
  });

  it('rejects before any native action when the arranged pins are published out of order', async () => {
    const { runListUnpin } = await loadJourneys();
    await withSimulatedPinnedPanelStage(
      { arrangedReversed: true },
      async ({ context, state }) => {
        await expect(runListUnpin(context)).rejects.toThrow(/published order/u);
        expect(state.actions).toEqual([]);
      },
    );
  });

  it('anchors the one-pinned-item window at the observed tap: passes at 25 s, rejects past 30 s [RF-1]', async () => {
    const { runListUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedPinnedPanelStage(
        { anchoredSwitchMs: 25_000 },
        async ({ context }) => {
          await expect(runListUnpin(context)).resolves.toBeUndefined();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('rejects on Exactly 1 when the switch lands after the anchored window [RF-1]', async () => {
    const { runListUnpin } = await loadJourneys();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await withSimulatedPinnedPanelStage(
        { anchoredSwitchMs: 31_000 },
        async ({ context }) => {
          await expect(runListUnpin(context)).rejects.toThrow(/Exactly 1/u);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

/* -------------------------------------------------------------------------- */
/* Teardown and redaction guards [RF-5]                                       */
/* -------------------------------------------------------------------------- */

describe('Android pinned-message-panel teardown and redaction guards [RF-5]', () => {
  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { pinnedPanelSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = pinnedPanelSecrets(STAGE.id, ARTIFACT_IDS);
    const segment = Buffer.from(ROOM.id).toString('base64url');
    const OTHER_ID = '$Pinned_other';
    const failure = new AssertionError({
      actual: '$Pinned_unpin',
      expected: OTHER_ID,
      operator: 'strictEqual',
      message: 'The unpin message has the arranged event id',
    });
    const leaked = new Error(
      `GET /rooms/${encodeURIComponent(ROOM.id)}/messages for ${PINNER.userId} at /rooms/${segment} on $Pinned_unpin body ${UNPIN_BODY}`,
    );
    const error = redactStageFailure(
      STAGE.id,
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain(
      'Android pinned-message-panel list-unpin failed',
    );
    expect(error.message).toContain(
      'The unpin message has the arranged event id',
    );
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ROOM.id,
      encodeURIComponent(ROOM.id),
      segment,
      '$Pinned_unpin',
      PINNER.userId,
      UNPIN_BODY,
      ROOM.name,
    ])
      expect(error.message).not.toContain(value);
    // Node appends an assertion's actual/expected values to its message,
    // contiguous or as an interleaved character diff; the rethrow keeps
    // exactly the first line, so no fragment of that block reaches the log,
    // nor does any unregistered event-id shape.
    const [firstLine, ...appended] = failure.message.split('\n');
    expect(firstLine).toBe('The unpin message has the arranged event id');
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
      'Android pinned-message-panel list-unpin failed\nError: Event [REDACTED] already in timeline\nAssertionError: strictEqual assertion failed\nAssertionError: Fields',
    );
    const cleanup = redactCleanupFailure(
      'fixtures',
      Object.assign(new Error(`leave ${ROOM.id}`), { status: 403 }),
    );
    expect(cleanup.message).toBe(
      'Pinned-message-panel cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
    expect(journey).not.toMatch(/throw failures\[0\]/u);
    const guardStart = journey.indexOf(
      'export function guardPinnedPanelCleanup',
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
      '$Pinned_unpin',
    );
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardPinnedPanelCleanup } = await loadJourneys();
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
    const guarded = guardPinnedPanelCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ROOM.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Pinned-message-panel cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.report.stages[0].error).toContain(ROOM.id);
    expect(state.saves).toBe(1);
    const early = { ...state, report: { status: 'running', stages: [] } };
    const later = [];
    guardPinnedPanelCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it('runs close then clear, even when close throws [RF-5]', async () => {
    const { pinnedPanelTeardown } = await loadJourneys();
    const { runPinnedPanelStageCleanup } = await loadArtifacts();
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
    await runPinnedPanelStageCleanup(
      pinnedPanelTeardown(client, device),
      failures,
    );
    expect(order).toEqual(['close', 'clear:eu.qwky.trinity']);
    expect(failures).toHaveLength(1);
  });

  it('fails when the teardown steps are reordered or a step is dropped', async () => {
    const { pinnedPanelTeardown } = await loadJourneys();
    const client = { close: async () => {} };
    const device = { clearApplicationData: async () => {} };
    const steps = pinnedPanelTeardown(client, device);
    expect(steps).toHaveLength(2);
    const order = [];
    const track = (name, fn) => async () => {
      order.push(name);
      return fn();
    };
    // The real order: close, then clear. A guard that let close run after
    // clear, or dropped either step, must not be indistinguishable from this.
    await track('close', steps[0])();
    await track('clear', steps[1])();
    expect(order).toEqual(['close', 'clear']);
    const reversed = [];
    await track('clear', steps[1])().then(() => reversed.push('clear'));
    order.length = 0;
    reversed.length = 0;
    await steps[1]();
    reversed.push('clear');
    await steps[0]();
    reversed.push('close');
    expect(reversed).toEqual(['clear', 'close']);
    expect(reversed).not.toEqual(['close', 'clear']);
  });
});

/* -------------------------------------------------------------------------- */
/* Source rules: journeys, observer and artifacts                            */
/* -------------------------------------------------------------------------- */

const PANEL_FORBIDDEN_TOKENS = [
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
  ['location =', /location\s*=(?!=)|location\.href\s*=(?!=)/u],
  ['location.assign', /location\.(?:assign|replace)\(/u],
  ['history.', /\bhistory\.\w+\(/u],
  ['Input.dispatch', /Input\.dispatch/u],
  ['input_method', /input_method/u],
  ['dumpsys', /dumpsys/u],
  ['non-zero retries', /retries:(?!\s*0\b)/u],
  [
    'CSS class or screenshot paint',
    /classList\.contains\(['"](?:border|shadow|bg-)|shadow-overlay|\.screenshot\(|toHaveScreenshot|captureScreenshot/u,
  ],
];

function assertNoPanelForbiddenTokens(source, name) {
  for (const [token, pattern] of PANEL_FORBIDDEN_TOKENS)
    expect(pattern.test(source), `${name} must not contain ${token}`).toBe(
      false,
    );
  // The product's unpin( call is forbidden outside the 'pinned-unpin' selector string.
  const stripped = source.split("'pinned-unpin'").join('');
  expect(
    /\bunpin\(/u.test(stripped),
    `${name} must not call unpin( outside 'pinned-unpin'`,
  ).toBe(false);
}

function assertPanelReadOnlyObserver(source) {
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
function assertPanelBoundedWaits(source, name) {
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

describe('Android pinned-message-panel source rules', () => {
  it('keeps the journeys, observer and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [JOURNEYS, OBSERVER_PATH, ARTIFACTS_PATH]) {
      const source = read(path);
      assertNoPanelForbiddenTokens(source, path);
    }
    for (const path of [JOURNEYS, OBSERVER_PATH]) {
      assertPanelBoundedWaits(read(path), path);
      assertPanelReadOnlyObserver(read(path));
    }
  });

  it('fails the forbidden-token, unpin( and read-only rules under each effective mutation', () => {
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
    ])
      expect(() =>
        assertNoPanelForbiddenTokens(`${observer}\n${mutation}`, OBSERVER_PATH),
      ).toThrow();
    // The selector string itself never trips the unpin( rule.
    expect(() =>
      assertNoPanelForbiddenTokens(observer, OBSERVER_PATH),
    ).not.toThrow();
    for (const mutation of [
      'element.click()',
      'input.focus()',
      'row.scrollTo(0, 0)',
      'input.value = "x"',
      'row.appendChild(node)',
    ])
      expect(() =>
        assertPanelReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    expect(() =>
      assertPanelBoundedWaits(
        `${observer}\nawait waitForNativeShellState(read, accepts, "x", signal);`,
        OBSERVER_PATH,
      ),
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Hosted wiring and parity ledger                                           */
/* -------------------------------------------------------------------------- */

const PANEL_NX_COMMAND =
  '--suite=android.pinned-message-panel --timeout-ms=900000 --entrypoint=e2e/android/pinned-message-panel-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const PANEL_CI_LINE =
  'if [ "${{ matrix.shard }}" = "3" ]; then echo \'pinned-message-panel-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:pinned-message-panel; fi';
const PANEL_GATE_PATH =
  "-path '*/android.pinned-message-panel/pinned-message-panel/publication-safe'";
const PANEL_UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.pinned-message-panel-started == 'true' && steps.pinned-message-panel-artifact-gate.outputs.pinned-message-panel-safe == 'true' }}";

function panelWiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
  };
}

/** Every hosted wiring rule for pinned-message-panel, as a pure function of the files' text. */
function assertPanelWiring({ project, pkg, workflow }) {
  const target = project.targets['pinned-message-panel'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(PANEL_NX_COMMAND);
  expect(pkg.scripts['e2e:android:pinned-message-panel']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:pinned-message-panel',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(PANEL_CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(runner).toBeLessThan(
    lines.findIndex((line) => line.includes('pnpm e2e:android --')),
  );
  expect(
    lines.filter((line) =>
      line.includes('trinity-e2e-android:pinned-message-panel'),
    ),
  ).toHaveLength(1);
  const gate = workflow
    .split('      - name: Gate Android pinned-message-panel diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: pinned-message-panel-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.pinned-message-panel-started == 'true' }}",
  );
  expect(gate).toContain(PANEL_GATE_PATH);
  expect(gate).toContain(
    'echo \'pinned-message-panel-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-pinned-message-panel\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${PANEL_UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.pinned-message-panel/**',
  );
}

describe('Android pinned-message-panel hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertPanelWiring(panelWiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.pinned-message-panel',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:pinned-message-panel',
      canonicalScript: 'e2e:android:pinned-message-panel',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      'e2e/android/pinned-message-panel-contract.mts',
      OBSERVER_PATH,
      ARTIFACTS_PATH,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:pinned-message-panel',
      ),
    ).toEqual([
      {
        name: 'e2e:android:pinned-message-panel',
        command: 'nx run trinity-e2e-android:pinned-message-panel',
        kind: 'canonical',
        suiteIds: ['android.pinned-message-panel'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.pinned-message-panel'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "3" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:pinned-message-panel',
    );
    expect(read(JOURNEYS)).toContain('timeout: 900_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = panelWiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['pinned-message-panel']);
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
            'pinned-message-panel-journeys.mts',
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
        delete inputs.pkg.scripts['e2e:android:pinned-message-panel'];
        return inputs;
      })(),
      withText(
        'workflow',
        PANEL_CI_LINE,
        PANEL_CI_LINE.replace('= "3"', '= "4"'),
      ),
      withText(
        'workflow',
        PANEL_CI_LINE,
        PANEL_CI_LINE.replace('1200000', '600000'),
      ),
      withText('workflow', `${PANEL_CI_LINE}\n`, ''),
      withText(
        'workflow',
        PANEL_GATE_PATH,
        "-path '*/android.pinned-message-panel/publication-safe'",
      ),
      withText(
        'workflow',
        PANEL_UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.pinned-message-panel-started == 'true' }}",
      ),
    ])
      expect(() => assertPanelWiring(mutated)).toThrow();
    // The runner moved after the retained Playwright command.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === PANEL_CI_LINE);
    const [line] = lines.splice(index, 1);
    const retained = lines.findIndex((entry) =>
      entry.includes('pnpm e2e:android --'),
    );
    lines.splice(retained + 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertPanelWiring(inputs)).toThrow();
  });

  it('documents exactly the 12 identities with their source lines and the 12/0 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Pinned-message panel journey')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| (\d+) \| direct \| [^\n]+ \| `(pinned-message-panel\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[3])).toEqual(ALL_IDENTITIES);
    expect(rows.map((row) => Number(row[2]))).toEqual(STAGE.direct);
    expect(rows.map((row) => row[1])).toEqual(
      ALL_IDENTITIES.map(() => STAGE.id),
    );
    expect(section).toContain('12 direct + 0');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.pinned-message-panel`');
    expect(section).toContain('Predecessor status: enabled');
    expect(section).toContain(
      'Documented reinterpretations of the predecessor:',
    );
    expect(section).not.toContain('pnpm exec nx');
  });
});
