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
const predecessor =
  'e2e/browser/journeys/conversations/message-spoiler.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
const loadContract = () =>
  import('../e2e/android/message-spoiler-contract.mts');
const loadObserver = () =>
  import('../e2e/android/message-spoiler-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-spoiler-artifacts.mts');
const loadJourneys = () =>
  import('../e2e/android/message-spoiler-journeys.mts');
const loadFixture = () => import('../e2e/android/message-spoiler-fixture.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-spoiler-journeys.mts';
const OBSERVER = 'e2e/android/message-spoiler-observer.mts';
const ARTIFACTS = 'e2e/android/message-spoiler-artifacts.mts';
const CONTRACT = 'e2e/android/message-spoiler-contract.mts';
const FIXTURE = 'e2e/android/message-spoiler-fixture.mts';
const FIXTURES = 'e2e/android/account-workspace-fixtures.mts';

/** The predecessor at the issue's pin; the branch file is unchanged. */
const PREDECESSOR_SHA256 =
  'd89c5751a43ac54b44329e2d65b9e7b0db2974118f6198d2fff1d6f0d050f673';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const SEED_SPAN = [20, 69];
const OPEN_ROOM_SPAN = [71, 79];

/** The design's identity table, verbatim. */
const STAGE = {
  id: 'conceal-reveal',
  span: [84, 110],
  title: 'conceals a spoiler and reveals it on click',
  direct: [101, 102, 104, 108, 109],
  inherited: [[76, 'openRoom', 96]],
  suffixes: [
    'room-ready',
    'spoiler-visible',
    'initial-unrevealed',
    'initial-transparent',
    'revealed',
    'revealed-painted',
  ],
};
const ALL_IDENTITIES = STAGE.suffixes.map(
  (suffix) => `message-spoiler.${STAGE.id}.${suffix}`,
);
const identity = (suffix) => `message-spoiler.${STAGE.id}.${suffix}`;

const LINE_PINS = {
  18: 'const session = synapseSession();',
  20: '/** Register a user, create their room, and drop a spoiler message straight in. */',
  21: 'async function seedRoomWithSpoiler(',
  26: 'const username = `spoiler-user-${runId}`;',
  27: 'const password = `${username}-pass`;',
  28: 'const roomName = `Spoiler E2E ${runId}`;',
  29: 'const secret = `answer-${runId}`;',
  31: 'await registerUser(request, username, password);',
  44: '.post(`${hs}/_matrix/client/v3/createRoom`, {',
  46: 'data: { name: roomName },',
  51: 'await request.put(',
  52: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/spoiler-${runId}`,',
  55: 'data: {',
  56: "msgtype: 'm.text',",
  57: 'body: `the secret is ${secret}`,',
  58: "format: 'org.matrix.custom.html',",
  59: 'formatted_body: `the secret is <span data-mx-spoiler>${secret}</span>`,',
  // The content object closes after exactly those four fields.
  60: '},',
  61: '},',
  62: ');',
  69: '}',
  71: 'async function openRoom(page: Page, roomName: string): Promise<void> {',
  72: "await page.getByTestId('rail-rooms').click();",
  73: "const channel = page.locator('.channel', { hasText: roomName });",
  74: "await channel.first().waitFor({ state: 'visible', timeout: 30_000 });",
  75: 'await channel.first().click();',
  76: "await expect(page.getByTestId('composer-input')).toBeVisible({",
  77: 'timeout: 15_000,',
  79: '}',
  82: "test.skip(!session.available, 'needs a Synapse homeserver (Docker)');",
  84: "test('conceals a spoiler and reveals it on click', async ({",
  88: "const runId = `${testResourceId('run')}s`;",
  89: 'const { user, roomName } = await seedRoomWithSpoiler(',
  95: 'await login(page, user);',
  96: 'await openRoom(page, roomName);',
  100: "const spoiler = page.locator('.scroll .mx-spoiler').first();",
  101: 'await expect(spoiler).toBeVisible({ timeout: 20_000 });',
  102: 'await expect(spoiler).not.toHaveClass(/is-revealed/);',
  104: "await expect(spoiler).toHaveCSS('color', 'rgba(0, 0, 0, 0)');",
  106: 'await spoiler.click();',
  108: 'await expect(spoiler).toHaveClass(/is-revealed/);',
  109: "await expect(spoiler).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');",
  110: '});',
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

/* ------------------------------------------------------------------------ */
/* Predecessor AST analysis                                                  */
/* ------------------------------------------------------------------------ */

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
  expect(source.split('\n')).toHaveLength(112);
  expect(source.split('\n').slice(0, 13).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  expect(assertionLines(source, ...SEED_SPAN)).toEqual([]);
  expect(assertionLines(source, ...OPEN_ROOM_SPAN)).toEqual([76]);
  expect(assertionLines(source, 1, SEED_SPAN[0] - 1)).toEqual([]);
  expect(
    assertionLines(source, OPEN_ROOM_SPAN[1] + 1, STAGE.span[0] - 1),
  ).toEqual([]);
  expect(assertionLines(source, STAGE.span[1] + 1, 112)).toEqual([]);
  expect(source).not.toMatch(
    /isAndroidE2E|sendComposerDraft|message-composer|\.fill\(|press\(/u,
  );
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

describe('Android message-spoiler predecessor pins', () => {
  it('pins the unchanged predecessor and the two shared helper sources by SHA-256', () => {
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
    expect(contract.MESSAGE_SPOILER_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_SPOILER_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_SPOILER_SOURCE_LINES).toBe(111);
    expect(contract.MESSAGE_SPOILER_SHARED_SOURCE_SHA256).toEqual(
      SHARED_SHA256,
    );
    const span = ([from, to]) => ({ from, to });
    expect(contract.MESSAGE_SPOILER_SPANS).toEqual({
      seedRoomWithSpoiler: span(SEED_SPAN),
      openRoom: span(OPEN_ROOM_SPAN),
      definitions: { [STAGE.id]: span(STAGE.span) },
    });
  });

  it('keeps the predecessor enabled in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-spoiler.spec.mts',
      ),
    ).toHaveLength(1);
    const android = read('e2e/android/playwright.config.mts');
    expect(android).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    for (const config of [android, read('e2e/browser/playwright.config.mts')]) {
      expect(config).not.toContain('testIgnore');
      expect(config).not.toContain('message-spoiler');
    }
    const source = read(predecessor);
    expect(source).not.toMatch(/test\.(?:fixme|only)\(|test\.skip\(true/u);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(1);
    expect(source.match(/^ {2}test\('/gmu)).toHaveLength(1);
    expect(source).not.toMatch(/test\.use\(/u);
  });

  it('maps the exact direct and helper sites with the house AST rule', () => {
    assertPredecessorShape(read(predecessor));
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = read(predecessor);
    const mutations = [
      // A source field, template or run suffix drifts.
      mutateLine(source, 88, (line) => line.replace('}s`', '}sp`')),
      mutateLine(source, 26, (line) =>
        line.replace('spoiler-user', 'spoil-user'),
      ),
      mutateLine(source, 28, (line) => line.replace('Spoiler E2E', 'Spoiler')),
      mutateLine(source, 29, (line) => line.replace('answer-', 'reply-')),
      mutateLine(
        source,
        46,
        () => "      data: { name: roomName, preset: 'private_chat' },",
      ),
      mutateLine(source, 52, (line) =>
        line.replace('spoiler-${runId}', 'x-${runId}'),
      ),
      mutateLine(source, 56, (line) => line.replace('m.text', 'm.notice')),
      mutateLine(source, 57, (line) =>
        line.replace('the secret is', 'secret:'),
      ),
      mutateLine(source, 58, (line) =>
        line.replace('org.matrix.custom.html', 'text/html'),
      ),
      mutateLine(source, 59, (line) =>
        line.replace('<span data-mx-spoiler>', '<span data-mx-spoiler="">'),
      ),
      mutateLine(source, 59, (line) =>
        line.replace(
          '${secret}</span>',
          '${secret}</span> <span data-mx-spoiler>x</span>',
        ),
      ),
      mutateLine(source, 100, (line) => line.replace('.scroll ', '')),
      mutateLine(source, 102, (line) =>
        line.replace('is-revealed', 'revealed'),
      ),
      mutateLine(source, 104, (line) =>
        line.replace('rgba(0, 0, 0, 0)', 'transparent'),
      ),
      mutateLine(source, 109, (line) =>
        line.replace('rgba(0, 0, 0, 0)', 'rgb(0, 0, 0)'),
      ),
      // A direct site is dropped, added or moved.
      mutateLine(source, 109, () => '    void spoiler;'),
      mutateLine(
        source,
        105,
        () => "    await expect(spoiler).toHaveAttribute('role', 'button');",
      ),
      mutateLine(source, 99, (line) => `${line}\n`),
      mutateLine(source, 60, () => "        'm.mentions': {},"),
      // The helper call changes or loses its readiness assertion.
      mutateLine(source, 96, () => '    void roomName;'),
      mutateLine(
        source,
        76,
        () => "  await page.getByTestId('composer-input').waitFor({",
      ),
      // The definition title or an import drifts.
      source.replace(
        "test('conceals a spoiler and reveals it on click'",
        "test('reveals a spoiler'",
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

describe('Android message-spoiler helper expansion by binding', () => {
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
      // Module level (line 18), outside the owned definition.
      ['synapseSession', 18],
      // Inside the fixture helper.
      ['registerUser', 31],
      ['seedRoomWithSpoiler', 89],
      ['login', 95],
      ['openRoom', 96],
    ]);
    // `testResourceId` binds to the fixtures module, outside support/.
    expect(
      calls
        .filter((call) => call.name === 'testResourceId')
        .map((call) => call.specifier),
    ).toEqual(['../../../fixtures.mts']);
  });

  it('follows helper calls and proves the fixture helper, registration and login add no sites', () => {
    const source = read(predecessor);
    expect(helperExpectLines(predecessor, 'openRoom', source)).toEqual([
      { module: predecessor, line: 76 },
    ]);
    expect(
      helperExpectLines(predecessor, 'seedRoomWithSpoiler', source),
    ).toEqual([]);
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
    // A fixture helper that asserted would add an inherited site.
    const asserting = source.replace(
      '  await registerUser(request, username, password);',
      '  await registerUser(request, username, password);\n  expect(username).toBeTruthy();',
    );
    expect(
      expandDefinition(asserting, [
        STAGE.span[0] + 1,
        STAGE.span[1] + 1,
      ]).filter((site) => site.helper === 'seedRoomWithSpoiler'),
    ).toHaveLength(1);
  });

  it('excludes a shadowing local helper, against a naive count', () => {
    const source = read(predecessor);
    const shadowed = source.replace(
      '    await openRoom(page, roomName);',
      '    const openRoom = async (_page: unknown, _name: string) => {};\n    await openRoom(page, roomName);',
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    expect(locals.map((call) => call.name)).toEqual(['openRoom']);
    expect(
      calls.filter((call) => call.name === 'openRoom' && call.line > 84),
    ).toHaveLength(0);
    expect(
      expandDefinition(shadowed, [STAGE.span[0], STAGE.span[1] + 1]).filter(
        (site) => site.helper === 'openRoom',
      ),
    ).toHaveLength(0);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
    expect(expandDefinition(source, STAGE.span)).toHaveLength(6);
  });

  it('matches the contract sites, identities and helper roles exactly', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    const expanded = expandDefinition(source, STAGE.span);
    const [stage] = contract.MESSAGE_SPOILER_STAGES;
    expect(stage.sites.map(siteTuple)).toEqual(expanded.map(siteTuple));
    expect(stage.assertions).toEqual(ALL_IDENTITIES);
    expect(stage.sites.map(siteTuple)).not.toEqual(
      expanded.slice(0, -1).map(siteTuple),
    );
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_SPOILER_HELPERS,
    ))
      expect(
        helperExpectLines(
          module,
          helper,
          module === predecessor ? source : undefined,
        ),
      ).toEqual(expectLines.map((line) => ({ module, line })));
    expect(contract.MESSAGE_SPOILER_HELPERS.openRoom.role).toBe(
      'room-readiness',
    );
    expect(Object.keys(contract.MESSAGE_SPOILER_HELPERS)).toEqual(['openRoom']);
  });
});

/* ------------------------------------------------------------------------ */
/* Contract ledger and source fields                                         */
/* ------------------------------------------------------------------------ */

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

describe('Android message-spoiler contract ledger', () => {
  it('owns one stage, 5 direct + 1 inherited = 6 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_SPOILER_STAGES.map((entry) => entry.id)).toEqual([
      STAGE.id,
    ]);
    const [stage] = contract.MESSAGE_SPOILER_STAGES;
    expect(stage.source).toBe(`${predecessor}:84-110`);
    expect(stage.title).toBe(STAGE.title);
    expect(stage.expectedAssertionRecords).toBe(6);
    expect(contract.MESSAGE_SPOILER_ASSERTION_RECORDS).toBe(6);
    expect(contract.MESSAGE_SPOILER_DIRECT).toBe(5);
    expect(contract.MESSAGE_SPOILER_INHERITED).toBe(1);
    expect(contract.MESSAGE_SPOILER_HELPER_COUNTS).toEqual({ openRoom: 1 });
    expect(new Set(ALL_IDENTITIES).size).toBe(6);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    expect(() =>
      contract.assertMessageSpoilerRecords(STAGE.id, ALL_IDENTITIES),
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
        contract.assertMessageSpoilerRecords(STAGE.id, invalid),
      ).toThrow();
    expect(() =>
      contract.messageSpoilerAssertion(STAGE.id, 'not-owned'),
    ).toThrow();
    expect(() =>
      contract.messageSpoilerAssertion('not-a-stage', 'room-ready'),
    ).toThrow();
  });

  it('arranges exactly the predecessor run suffix, Room, secret, transaction and formatted content', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    expect(predecessorTemplates(source, STAGE.span)).toMatchObject({
      runId: "`${testResourceId('run')}s`",
    });
    expect(predecessorTemplates(source, SEED_SPAN)).toMatchObject({
      roomName: '`Spoiler E2E ${runId}`',
      secret: '`answer-${runId}`',
    });
    expect(contract.MESSAGE_SPOILER_RUN_SUFFIX).toBe('s');
    expect(contract.spoilerRoomName('r-1s')).toBe('Spoiler E2E r-1s');
    expect(contract.spoilerSecret('r-1s')).toBe('answer-r-1s');
    expect(contract.spoilerTransaction('r-1s')).toBe('spoiler-r-1s');
    expect(contract.SPOILER_REVEALED_CLASS).toBe('is-revealed');
    expect(contract.spoilerContent('answer-r-1s')).toEqual({
      msgtype: 'm.text',
      body: 'the secret is answer-r-1s',
      format: 'org.matrix.custom.html',
      formatted_body: 'the secret is <span data-mx-spoiler>answer-r-1s</span>',
    });
    expect(
      contract.spoilerSpanCount(contract.spoilerContent('x').formatted_body),
    ).toBe(1);
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertMessageSpoilerReceiptName } = await loadContract();
    for (const name of [
      'spoiler-event',
      'black-bar',
      'concealed-capture',
      'native-tap',
      'revealed-capture',
    ])
      expect(() => assertMessageSpoilerReceiptName(name)).not.toThrow();
    for (const name of [
      'message-spoiler.conceal-reveal.room-ready',
      'message-spoiler-x',
      'Black Bar',
      'a/b',
      '',
    ])
      expect(() => assertMessageSpoilerReceiptName(name)).toThrow();
  });

  it('pins the product spoiler sanitizer, directive, row and conceal styles the journey relies on', () => {
    const directive = read(
      'libs/feature/rooms/src/lib/spoiler/spoiler-reveal.directive.ts',
    );
    for (const hook of [
      "const REVEALED_CLASS = 'is-revealed';",
      "selector: '[trnSpoilerReveal]',",
      "'(click)': 'onClick($event)',",
      "'.mx-spoiler',",
      'spoiler.classList.add(REVEALED_CLASS);',
    ])
      expect(directive).toContain(hook);
    const view = read('libs/util/matrix/src/lib/message-view.ts');
    for (const hook of [
      "for (const node of root.querySelectorAll('[data-mx-spoiler]')) {",
      "node.classList.add('mx-spoiler');",
    ])
      expect(view).toContain(hook);
    const styles = read('apps/trinity/src/rendered-markdown.scss');
    const concealed = styles.slice(
      styles.indexOf('.mx-spoiler:not(.is-revealed) {'),
    );
    expect(concealed).toContain(
      'background-color: var(--trinity-text-bright);',
    );
    expect(concealed).toContain('color: transparent;');
    const row = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.html',
    );
    for (const hook of [
      'class="msg msg--event"',
      '[attr.data-mid]="r.id"',
      'trnSpoilerReveal',
    ])
      expect(row).toContain(hook);
  });
});

/* ------------------------------------------------------------------------ */
/* Authoritative event                                                       */
/* ------------------------------------------------------------------------ */

const ROOM = '!Spoiler_Ab+c/d:localhost';
const SENDER = '@trn_spoiler_reveal_0a1b2c3d4e5f:localhost';
const EVENT_ID = '$Spoiler_A+b/C=d';
const OTHER_ID = '$Other_E+f/G=h';
const RUN = 'trn-spoiler-reveal-0a1b2c3d4e5fs';
const SECRET = `answer-${RUN}`;
const BODY = `the secret is ${SECRET}`;
const ROOM_NAME = `Spoiler E2E ${RUN}`;
const TRANSACTION = `spoiler-${RUN}`;
const CONTENT = {
  msgtype: 'm.text',
  body: BODY,
  format: 'org.matrix.custom.html',
  formatted_body: `the secret is <span data-mx-spoiler>${SECRET}</span>`,
};
const EXPECTED = {
  eventId: EVENT_ID,
  roomId: ROOM,
  sender: SENDER,
  secret: SECRET,
};
const serverEvent = (overrides = {}, content = CONTENT) => ({
  type: 'm.room.message',
  event_id: EVENT_ID,
  room_id: ROOM,
  sender: SENDER,
  origin_server_ts: 1_700_000_000_000,
  content,
  unsigned: { age: 5 },
  ...overrides,
});
const messagesPage = (...events) => ({
  // Newest first, as `dir=b` returns.
  chunk: [
    ...[...events].reverse(),
    {
      type: 'm.room.create',
      event_id: '$create',
      room_id: ROOM,
      sender: SENDER,
      content: {},
    },
  ],
  start: 't1',
});

describe('Android message-spoiler authoritative event contract', () => {
  it('reads every Room message of the page, oldest first', async () => {
    const contract = await loadContract();
    const first = serverEvent({ event_id: OTHER_ID });
    const second = serverEvent();
    expect(
      contract
        .authoritativeRoomMessages(messagesPage(first, second))
        .map((event) => event.event_id),
    ).toEqual([OTHER_ID, EVENT_ID]);
    expect(() => contract.authoritativeRoomMessages({})).toThrow();
  });

  it('requires exactly the one arranged formatted spoiler from the Account', async () => {
    const contract = await loadContract();
    const check = (...events) =>
      contract.assertSpoilerRoom(
        contract.authoritativeRoomMessages(messagesPage(...events)),
        EXPECTED,
      );
    expect(check(serverEvent()).event_id).toBe(EVENT_ID);
    const { format: _format, ...plain } = CONTENT;
    for (const events of [
      [],
      [serverEvent(), serverEvent({ event_id: OTHER_ID })],
      [serverEvent({ event_id: OTHER_ID })],
      [serverEvent({ room_id: '!other:localhost' })],
      [serverEvent({ sender: '@other:localhost' })],
      [serverEvent({}, plain)],
      [serverEvent({}, { ...CONTENT, body: `${BODY}!` })],
      [serverEvent({}, { ...CONTENT, msgtype: 'm.notice' })],
      [serverEvent({}, { ...CONTENT, format: 'text/html' })],
      [
        serverEvent(
          {},
          {
            ...CONTENT,
            formatted_body: `${CONTENT.formatted_body} <span data-mx-spoiler>x</span>`,
          },
        ),
      ],
      [
        serverEvent(
          {},
          { ...CONTENT, formatted_body: `the secret is ${SECRET}` },
        ),
      ],
      [
        serverEvent(
          {},
          {
            ...CONTENT,
            'm.relates_to': { rel_type: 'm.thread', event_id: '$r' },
          },
        ),
      ],
      [serverEvent({}, { ...CONTENT, 'm.new_content': CONTENT })],
    ])
      expect(() => check(...events), JSON.stringify(events)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Leaf observation and computed paint (jsdom)                               */
/* ------------------------------------------------------------------------ */

const LEAF_BOX = { left: 510, top: 359, right: 805, bottom: 377.5 };
const SCROLL_BOX = { left: 280, top: 56, right: 1024, bottom: 700 };
const CONCEALED_PAINT = {
  color: 'rgba(0, 0, 0, 0)',
  backgroundColor: 'oklch(0.16 0.014 265)',
};
const REVEALED_PAINT = {
  color: 'oklch(0.3 0.018 265)',
  backgroundColor: 'rgba(0, 0, 0, 0)',
};
const escapeHtml = (value) =>
  String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
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
const leafHtml = (text = SECRET, revealed = false, extra = '') =>
  `<span class="mx-spoiler${revealed ? ' is-revealed' : ''}" tabindex="0" role="button">${escapeHtml(text)}${extra}</span>`;
const rowHtml = (id = EVENT_ID, leaf = leafHtml()) =>
  `<div class="msg" data-mid="${escapeHtml(id)}"><div class="msg__body"><span class="msg__author">spoiler</span><div class="msg__text msg__text--html">the secret is ${leaf}</div></div></div>`;
const scrollHtml = (...rows) =>
  `<div class="scroll"><div class="msg msg--event" data-mid="$create"><span>created the room</span></div>${rows.join('')}</div>`;

/**
 * A jsdom document with measured boxes, the leaf's own computed paint (by its
 * revealed class, as the product stylesheet paints it), client rects, running
 * animations and a hit test, so the observer's exact text runs against it.
 */
function paintedWindow(body, options = {}) {
  const dom = new JSDOM(`<main>${body}</main>`, {
    url: 'https://localhost/rooms/x',
  });
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (/display:\s*none/u.test(this.getAttribute('style') ?? ''))
      return rect({ left: 0, top: 0, right: 0, bottom: 0 });
    if (this.matches('.mx-spoiler')) return rect(options.leafBox ?? LEAF_BOX);
    if (this.matches('.scroll')) return rect(options.scrollBox ?? SCROLL_BOX);
    return rect({ left: 0, top: 0, right: 120, bottom: 20 });
  };
  window.HTMLElement.prototype.getClientRects = function () {
    return this.matches('.mx-spoiler')
      ? Array.from({ length: options.rects ?? 1 }, () => rect(LEAF_BOX))
      : [];
  };
  window.Element.prototype.getAnimations = function () {
    return this.matches('.mx-spoiler') &&
      (this.classList.contains('is-revealed')
        ? options.revealedAnimations
        : options.concealedAnimations)
      ? [{}]
      : [];
  };
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => {
    const style = computed(element);
    const paint = element.matches('.mx-spoiler')
      ? element.classList.contains('is-revealed')
        ? { ...REVEALED_PAINT, ...options.revealedPaint }
        : { ...CONCEALED_PAINT, ...options.concealedPaint }
      : { color: 'oklch(0.3 0.018 265)', backgroundColor: 'rgba(0, 0, 0, 0)' };
    return {
      ...style,
      ...paint,
      visibility:
        element.closest('[style*="visibility:hidden"]') !== null
          ? 'hidden'
          : 'visible',
    };
  };
  window.matchMedia = () => ({ matches: false });
  window.Capacitor = { getPlatform: () => 'android' };
  window.document.elementFromPoint = (x, y) => {
    if (options.covered) return window.document.querySelector('.scroll');
    if (options.cornerCovered && (x < 520 || y < 365))
      return window.document.querySelector('.scroll');
    return window.document.querySelector('.mx-spoiler');
  };
  return window;
}

function evaluateIn(body, expression, options = {}) {
  const window = paintedWindow(body, options);
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

describe('Android message-spoiler leaf observation and paint (jsdom)', () => {
  it('observes the one leaf with its row, state, box, hit tests, animations and paint', async () => {
    const contract = await loadContract();
    const { spoilerExpression } = await loadObserver();
    const view = contract.parseSpoiler(
      evaluateIn(scrollHtml(rowHtml()), spoilerExpression()),
    );
    expect(view.scrollers).toBe(1);
    expect(view.leaves).toHaveLength(1);
    expect(view.leaves[0]).toMatchObject({
      rowId: EVENT_ID,
      rowEvent: false,
      text: SECRET,
      nested: 0,
      revealed: false,
      visible: true,
      rects: 1,
      hits: [true, true, true, true, true],
      animations: 0,
      ...CONCEALED_PAINT,
    });
    expect(view.leaves[0].rowText).toContain(BODY);
    expect(contract.assertSpoilerVisible(view, EXPECTED).text).toBe(SECRET);
    expect(contract.assertInitialUnrevealed(view, EXPECTED).revealed).toBe(
      false,
    );
    expect(contract.assertInitialTransparent(view, EXPECTED)).toBe(0);
    expect(contract.assertBlackBar(view, EXPECTED)).toBe(1);
    expect(contract.assertConcealedCapture(view, EXPECTED)).toEqual({
      x: LEAF_BOX.left,
      y: LEAF_BOX.top,
      width: LEAF_BOX.right - LEAF_BOX.left,
      height: LEAF_BOX.bottom - LEAF_BOX.top,
    });
    expect(() => contract.assertRevealed(view, EXPECTED)).toThrow();
    const revealed = contract.parseSpoiler(
      evaluateIn(
        scrollHtml(rowHtml(EVENT_ID, leafHtml(SECRET, true))),
        spoilerExpression(),
      ),
    );
    expect(contract.assertRevealed(revealed, EXPECTED).revealed).toBe(true);
    expect(contract.assertRevealedPainted(revealed, EXPECTED)).toBe(1);
    expect(() =>
      contract.assertRevealedCapture(revealed, EXPECTED),
    ).not.toThrow();
    expect(() =>
      contract.assertInitialUnrevealed(revealed, EXPECTED),
    ).toThrow();
  });

  it('rejects a missing, doubled, foreign, nested, hidden or covered leaf before spoiler-visible', async () => {
    const contract = await loadContract();
    const { spoilerExpression } = await loadObserver();
    const observe = (body, options) =>
      contract.parseSpoiler(evaluateIn(body, spoilerExpression(), options));
    for (const [body, options] of [
      [scrollHtml()],
      [scrollHtml(rowHtml(), rowHtml(OTHER_ID))],
      [scrollHtml(rowHtml(EVENT_ID, leafHtml(`${SECRET}!`)))],
      [scrollHtml(rowHtml(OTHER_ID))],
      [scrollHtml(rowHtml('~!Spoiler:txn1'))],
      [scrollHtml(rowHtml(EVENT_ID, leafHtml(SECRET, false, leafHtml('x'))))],
      [
        scrollHtml(
          rowHtml(
            EVENT_ID,
            leafHtml(SECRET).replace(
              '<span',
              '<span style="visibility:hidden"',
            ),
          ),
        ),
      ],
      [scrollHtml(rowHtml()), { covered: true }],
      [
        scrollHtml(rowHtml()),
        { scrollBox: { left: 0, top: 500, right: 1024, bottom: 700 } },
      ],
      [`${scrollHtml()}${scrollHtml(rowHtml())}`],
    ])
      expect(
        () => contract.assertSpoilerVisible(observe(body, options), EXPECTED),
        `${body} ${JSON.stringify(options)}`,
      ).toThrow();
    // A leaf outside the conversation scroller is never observed.
    expect(observe(`<div>${rowHtml()}</div>`).leaves).toHaveLength(0);
  });

  it('parses every computed colour syntax: transparent is alpha 0, painted text above 0', async () => {
    const { cssColorAlpha } = await loadContract();
    for (const [color, alpha] of [
      ['rgba(0, 0, 0, 0)', 0],
      ['transparent', 0],
      ['rgb(0 0 0 / 0)', 0],
      ['oklch(0.3 0.018 265 / 0%)', 0],
      ['rgba(24, 24, 27, 0.5)', 0.5],
      ['oklch(0.3 0.018 265)', 1],
      ['rgb(24, 24, 27)', 1],
      ['color(srgb 1 1 1)', 1],
      ['hsl(0 0% 0% / 25%)', 0.25],
    ])
      expect(cssColorAlpha(color), color).toBe(alpha);
    for (const color of [
      'var(--x)',
      '',
      'black',
      'rgb(1, 2)',
      'rgb(1 2 3 / x)',
    ])
      expect(cssColorAlpha(color), color).toBeNull();
  });

  it('proves initial transparency and revealed paint, and rejects each loss', async () => {
    const contract = await loadContract();
    const { spoilerExpression } = await loadObserver();
    const concealed = (concealedPaint) =>
      contract.parseSpoiler(
        evaluateIn(scrollHtml(rowHtml()), spoilerExpression(), {
          concealedPaint,
        }),
      );
    const revealed = (revealedPaint) =>
      contract.parseSpoiler(
        evaluateIn(
          scrollHtml(rowHtml(EVENT_ID, leafHtml(SECRET, true))),
          spoilerExpression(),
          { revealedPaint },
        ),
      );
    for (const color of [
      'oklch(0.3 0.018 265)',
      'rgba(0, 0, 0, 0.5)',
      'rgb(0 0 0 / 0.01)',
      'var(--trinity-text)',
    ])
      expect(
        () => contract.assertInitialTransparent(concealed({ color }), EXPECTED),
        color,
      ).toThrow();
    for (const backgroundColor of ['rgba(0, 0, 0, 0)', 'transparent', 'none'])
      expect(
        () => contract.assertBlackBar(concealed({ backgroundColor }), EXPECTED),
        backgroundColor,
      ).toThrow();
    for (const color of [
      'rgba(0, 0, 0, 0)',
      'transparent',
      'oklch(0 0 0 / 0)',
      'var(--x)',
    ])
      expect(
        () => contract.assertRevealedPainted(revealed({ color }), EXPECTED),
        color,
      ).toThrow();
    // A changed class with transparent text is not a reveal.
    expect(() =>
      contract.assertRevealed(
        revealed({ color: 'rgba(0, 0, 0, 0)' }),
        EXPECTED,
      ),
    ).not.toThrow();
  });

  it('scopes a capture to the one settled, unwrapped, uncovered leaf', async () => {
    const contract = await loadContract();
    const { spoilerExpression } = await loadObserver();
    const observe = (options, body = scrollHtml(rowHtml())) =>
      contract.parseSpoiler(evaluateIn(body, spoilerExpression(), options));
    expect(() => contract.assertCaptureScope(observe({}))).not.toThrow();
    for (const options of [
      { rects: 2 },
      { concealedAnimations: true },
      { cornerCovered: true },
      { covered: true },
      { leafBox: { left: 900, top: 359, right: 1100, bottom: 377 } },
      { leafBox: { left: 510, top: 40, right: 805, bottom: 58 } },
      { leafBox: { left: 510, top: 359, right: 511, bottom: 360 } },
    ])
      expect(
        () => contract.assertCaptureScope(observe(options)),
        JSON.stringify(options),
      ).toThrow();
    expect(() =>
      contract.assertCaptureScope(
        observe({}, scrollHtml(rowHtml(), rowHtml(OTHER_ID))),
      ),
    ).toThrow();
  });

  it('parses only complete spoiler observations', async () => {
    const contract = await loadContract();
    const { spoilerExpression } = await loadObserver();
    const valid = evaluateIn(scrollHtml(rowHtml()), spoilerExpression());
    expect(() => contract.parseSpoiler(valid)).not.toThrow();
    const leaf = valid.leaves[0];
    for (const malformed of [
      null,
      { ...valid, leaves: {} },
      { ...valid, scrollers: -1 },
      { ...valid, viewport: null },
      { ...valid, leaves: [{ ...leaf, hits: [true] }] },
      { ...valid, leaves: [{ ...leaf, revealed: 'no' }] },
      { ...valid, leaves: [{ ...leaf, color: 0 }] },
      { ...valid, leaves: [{ ...leaf, animations: -1 }] },
      { ...valid, leaves: [{ ...leaf, box: null }] },
    ])
      expect(() => contract.parseSpoiler(malformed)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Leaf-scoped raster capture                                                */
/* ------------------------------------------------------------------------ */

/** CSS-to-device factor of the 1280-wide desktop profile on the Pixel 6 WebView. */
const NATIVE_FACTOR = 0.843;
const SCREEN = { width: 1080, height: 700 };
const nativeOf = (clip) => ({
  topLeft: {
    x: Math.round((clip.x + 0.5) * NATIVE_FACTOR),
    y: Math.round((clip.y + 0.5) * NATIVE_FACTOR),
  },
  bottomRight: {
    x: Math.round((clip.x + clip.width - 0.5) * NATIVE_FACTOR),
    y: Math.round((clip.y + clip.height - 0.5) * NATIVE_FACTOR),
  },
});

/** A device screen: light everywhere, the leaf's device box dark while concealed. */
async function screenPng(leaf, concealed, options = {}) {
  const { encodePng } = await loadArtifacts();
  const channels = 4;
  const { width, height } = options.screen ?? SCREEN;
  const pixels = Buffer.alloc(width * height * channels, 0xf4);
  const native = nativeOf(leaf);
  for (let y = native.topLeft.y; y <= native.bottomRight.y; y++)
    for (let x = native.topLeft.x; x <= native.bottomRight.x; x++) {
      const offset = (y * width + x) * channels;
      pixels.fill(concealed ? 0x14 : 0xe0, offset, offset + 3);
    }
  return encodePng({ width, height, channels, colorType: 6, pixels });
}

describe('Android message-spoiler leaf-scoped capture', () => {
  it('decodes, crops and re-encodes a device PNG losslessly with every row filter', async () => {
    const { decodePng, encodePng, cropPng, pngChunkTypes } =
      await loadArtifacts();
    const { deflateSync } = await import('node:zlib');
    const { pngDimensions } = await loadContract();
    // A 4×3 RGB image whose rows use filters 1–4 over known pixels.
    const width = 4;
    const height = 3;
    const pixels = Buffer.from(
      Array.from(
        { length: width * height * 3 },
        (_, index) => (index * 37) % 256,
      ),
    );
    const stride = width * 3;
    const filtered = [];
    for (let y = 0; y < height; y++) {
      const kind = [1, 2, 4][y];
      filtered.push(kind);
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? pixels[y * stride + x - 3] : 0;
        const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
        const c = x >= 3 && y > 0 ? pixels[(y - 1) * stride + x - 3] : 0;
        const p = a + b - c;
        const paeth =
          Math.abs(p - a) <= Math.abs(p - b) &&
          Math.abs(p - a) <= Math.abs(p - c)
            ? a
            : Math.abs(p - b) <= Math.abs(p - c)
              ? b
              : c;
        const predicted = kind === 1 ? a : kind === 2 ? b : paeth;
        filtered.push((pixels[y * stride + x] - predicted + 256) % 256);
      }
    }
    const base = encodePng({
      width,
      height,
      channels: 3,
      colorType: 2,
      pixels,
    });
    const chunks = [];
    let offset = 8;
    while (offset < base.length) {
      const length = base.readUInt32BE(offset);
      chunks.push(base.subarray(offset, offset + 12 + length));
      offset += 12 + length;
    }
    // Replace the IDAT with the filtered rows, keeping a valid CRC.
    const { crc32 } = await import('node:zlib');
    const data = deflateSync(Buffer.from(filtered));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write('IDAT', 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    const png = Buffer.concat([
      base.subarray(0, 8),
      chunks[0],
      Buffer.concat([head, data, tail]),
      chunks.at(-1),
    ]);
    const decoded = decodePng(png);
    expect(decoded.pixels.equals(pixels)).toBe(true);
    const crop = cropPng(decoded, { left: 1, top: 1, width: 2, height: 2 });
    expect([...crop.pixels]).toEqual([
      ...pixels.subarray(stride + 3, stride + 9),
      ...pixels.subarray(2 * stride + 3, 2 * stride + 9),
    ]);
    const encoded = encodePng(crop);
    expect(pngDimensions(encoded)).toEqual({ width: 2, height: 2 });
    expect(pngChunkTypes(encoded)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(() =>
      cropPng(decoded, { left: 3, top: 0, width: 2, height: 1 }),
    ).toThrow();
    expect(() => decodePng(Buffer.from('not a png'))).toThrow();
    // Interlaced or 16-bit captures are refused.
    const interlaced = Buffer.from(png);
    interlaced[28] = 1;
    expect(() => decodePng(interlaced)).toThrow();
  });

  it('captures exactly the mapped leaf from the device screen and writes nothing else', async () => {
    const { captureSpoilerLeaf, decodePng } = await loadArtifacts();
    const { pngDimensions, nativeCrop } = await loadContract();
    await withOutput('trinity-spoiler-capture-', async (output) => {
      const clip = { x: 510, y: 359, width: 295, height: 18.5 };
      const calls = [];
      const client = {
        output,
        async nativeRect(value) {
          calls.push(['native-rect', value]);
          return nativeOf(value);
        },
        device: {
          async adb(...args) {
            calls.push(['adb', ...args]);
            return (await screenPng(clip, true)).toString('base64');
          },
        },
      };
      const metadata = await captureSpoilerLeaf(
        client,
        'concealed',
        clip,
        CONCEALED_PAINT,
      );
      expect(calls).toEqual([
        ['native-rect', clip],
        ['adb', 'exec-out', 'sh', '-c', 'screencap -p | base64 -w 0'],
      ]);
      const png = await readFile(join(output, 'spoiler-concealed.png'));
      const crop = nativeCrop(nativeOf(clip));
      expect(pngDimensions(png)).toEqual({
        width: crop.width,
        height: crop.height,
      });
      expect(metadata).toMatchObject({
        schemaVersion: 1,
        scope: 'spoiler-leaf',
        source: 'device-screencap',
        state: 'concealed',
        sha256: sha256(png),
        width: crop.width,
        height: crop.height,
        clip,
        native: nativeOf(clip),
        meanLuminance: 20,
        ...CONCEALED_PAINT,
      });
      // Only the leaf's own pixels: every one is the bar.
      const { pixels } = decodePng(png);
      expect(new Set(pixels.filter((_, index) => index % 4 !== 3))).toEqual(
        new Set([0x14]),
      );
      expect(
        JSON.parse(
          await readFile(join(output, 'spoiler-concealed.json'), 'utf8'),
        ),
      ).toEqual(metadata);
      // A mapping that falls off the device screen, or a degenerate one, fails.
      client.nativeRect = async () => ({
        topLeft: { x: 1000, y: 10 },
        bottomRight: { x: 1200, y: 30 },
      });
      await expect(
        captureSpoilerLeaf(client, 'revealed', clip, REVEALED_PAINT),
      ).rejects.toThrow();
      client.nativeRect = async () => ({
        topLeft: { x: 10, y: 10 },
        bottomRight: { x: 10, y: 30 },
      });
      await expect(
        captureSpoilerLeaf(client, 'revealed', clip, REVEALED_PAINT),
      ).rejects.toThrow();
      expect(existsSync(join(output, 'spoiler-revealed.png'))).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Native journey against a simulated installed app                          */
/* ------------------------------------------------------------------------ */

const USER = {
  userId: SENDER,
  username: 'trn_spoiler_reveal_0a1b2c3d4e5f',
  password: 'spoiler-pass"word\\token',
  homeserver: 'https://localhost:8448',
};
const ROUTE = `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}?account=${encodeURIComponent(SENDER)}&view=rooms`;
const SPOILER = '.scroll .msg[data-mid^="$"] .mx-spoiler';

/**
 * A model of the installed app and its Synapse Room. The DOM is rendered in
 * production shape and every observer expression runs against it in jsdom;
 * native actions resolve their target as the client does (exactly one match),
 * a tap reaches the leaf as the product directive does, and the device screen
 * paints the leaf as the stylesheet does. A settled state aborts instead of
 * waiting.
 */
function simulatedSpoilerApp(output, faults = {}) {
  const controller = new AbortController();
  const state = {
    signedIn: false,
    roomsShown: false,
    roomOpen: false,
    revealed: false,
    events: [],
    actions: [],
    written: [],
    sent: [],
  };
  let lastSignature = '';
  let stale = 0;
  const leafText = faults.leafOtherText ? `${SECRET}!` : SECRET;
  const render = () => {
    const parts = ['<nav>'];
    if (state.signedIn)
      parts.push('<button data-testid="rail-rooms">Rooms</button>');
    parts.push('</nav>');
    if (state.roomsShown)
      parts.push(
        `<aside><div class="channel">${escapeHtml(ROOM_NAME)}</div></aside>`,
      );
    if (state.roomOpen) {
      const revealed = state.revealed || faults.startsRevealed;
      let leaf = leafHtml(
        leafText,
        revealed,
        faults.nestedSpoiler ? leafHtml('x') : '',
      );
      if (faults.leafHidden)
        leaf = leaf.replace('<span', '<span style="visibility:hidden"');
      const rows = [rowHtml(faults.leafOtherRow ? OTHER_ID : EVENT_ID, leaf)];
      if (faults.twoLeaves) rows.push(rowHtml(OTHER_ID));
      parts.push(scrollHtml(...rows));
      parts.push(
        `<trn-message-composer><textarea data-testid="composer-input" placeholder="${escapeHtml(`Message #${ROOM_NAME}`)}"></textarea></trn-message-composer>`,
      );
    }
    return parts.join('');
  };
  const dom = () => {
    const window = paintedWindow(render(), {
      covered: faults.covered,
      rects: faults.wrapped ? 2 : 1,
      concealedPaint: faults.concealedPaint,
      revealedPaint: faults.revealedPaint,
      concealedAnimations: faults.unsettledConcealed,
      revealedAnimations: faults.unsettledRevealed,
    });
    if (state.roomOpen) window.history.replaceState(null, '', ROUTE);
    return window;
  };
  const settle = () => {
    const signature = JSON.stringify([render(), state.events]);
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
      focused: false,
      disabled: element.matches(':disabled'),
      value: 'value' in element ? element.value : null,
      unobstructedCenter: true,
    }));
  const actionable = (selector, filter) => {
    const found = matches(selector, filter);
    if (found.length !== 1 || found[0].matches(':disabled'))
      throw new Error(`Simulated target is not actionable: ${selector}`);
    return found[0];
  };
  const client = {
    workspaceRoot: root,
    applicationId: 'eu.qwky.trinity',
    signal: controller.signal,
    output,
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
    device: {
      async adb(...args) {
        assert.deepEqual(args, [
          'exec-out',
          'sh',
          '-c',
          'screencap -p | base64 -w 0',
        ]);
        state.actions.push('screencap');
        const clip = {
          x: LEAF_BOX.left,
          y: LEAF_BOX.top,
          width: LEAF_BOX.right - LEAF_BOX.left,
          height: LEAF_BOX.bottom - LEAF_BOX.top,
        };
        return (
          await screenPng(clip, !(state.revealed || faults.startsRevealed))
        ).toString('base64');
      },
    },
    async nativeRect(value) {
      state.actions.push('native-rect');
      if (faults.captureOffScreen)
        return { topLeft: { x: 1070, y: 0 }, bottomRight: { x: 1200, y: 20 } };
      return nativeOf(value);
    },
    async reset(profile) {
      state.actions.push('reset');
      state.profile = profile;
    },
    async login(account) {
      state.actions.push(account === USER ? 'login' : 'login:other');
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
    async tapCurrent(selector, filter = {}) {
      state.actions.push(
        `tap:${selector}${filter.text || filter.exactText ? `|${filter.text ?? filter.exactText}` : ''}`,
      );
      const element = actionable(selector, filter);
      const testId = element.getAttribute('data-testid');
      if (testId === 'rail-rooms') state.roomsShown = true;
      else if (element.classList.contains('channel')) state.roomOpen = true;
      else if (element.classList.contains('mx-spoiler')) {
        state.tapped = element.closest('.msg').getAttribute('data-mid');
        if (!faults.tapNoReveal) state.revealed = true;
      } else throw new Error(`Unmodelled simulated tap ${selector}`);
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture(name) {
      state.actions.push(`capture:${name}`);
    },
  };
  const fixtures = {
    async account(role) {
      state.actions.push(`rest-account:${role}`);
      return USER;
    },
    async createRoom(account, content) {
      state.actions.push('rest-create-room');
      assert.equal(account, USER);
      state.roomContent = content;
      return { id: ROOM, name: content.name };
    },
    async roomMessages(account, roomId) {
      assert.equal(account, USER);
      assert.equal(roomId, ROOM);
      settle();
      return messagesPage(...state.events);
    },
  };
  const spoilers = {
    async sendSpoiler(account, roomId, transaction, content) {
      state.actions.push('rest-send-spoiler');
      assert.equal(account, USER);
      assert.equal(roomId, ROOM);
      state.sent.push({ transaction, content });
      if (faults.eventMissing) return EVENT_ID;
      const stored = faults.eventContent
        ? { ...content, ...faults.eventContent }
        : content;
      state.events.push(serverEvent({}, stored));
      if (faults.extraMessage)
        state.events.push(serverEvent({ event_id: OTHER_ID }, content));
      return EVENT_ID;
    },
  };
  return { client, fixtures, spoilers, state, controller };
}

async function simulatedStage(output, faults = {}) {
  const { MESSAGE_SPOILER_STAGES } = await loadContract();
  const app = simulatedSpoilerApp(output, faults);
  const context = {
    entry: MESSAGE_SPOILER_STAGES[0],
    records: [],
    identities: new Set(),
    receipts: 0,
    client: app.client,
    fixtures: app.fixtures,
    spoilers: app.spoilers,
    secrets: {},
    safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
    native: false,
    ledger: { run: RUN, texts: [], eventIds: [] },
  };
  return { ...app, context };
}

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

const STAGE_ACTIONS = [
  'rest-account:spoiler-reveal',
  'rest-create-room',
  'rest-send-spoiler',
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|${ROOM_NAME}`,
  'native-rect',
  'screencap',
  `tap:${SPOILER}|${SECRET}`,
  'native-rect',
  'screencap',
];

/** Written evidence carries digests and booleans, never an identifier or credential. */
function assertIdFreeEvidence(state, secrets) {
  const written = JSON.stringify(state.written);
  for (const value of secrets) expect(written).not.toContain(value);
  // Selectors reach the job log: none carries an identifier or the secret.
  for (const action of state.actions)
    expect(action.split('|')[0]).not.toMatch(
      /[$!~@][A-Za-z0-9_]|data-mid[*~|]?=|trn[-_]|answer-/u,
    );
}

describe('Android message-spoiler native journey against a simulated installed app', () => {
  it('drives the exact native sequence and records all six identities in order', async () => {
    const { runConcealReveal } = await loadJourneys();
    const { DESKTOP_ACCOUNT_PROFILE } = await loadClient();
    const { decodePng } = await loadArtifacts();
    await withOutput('trinity-spoiler-journey-', async (output) => {
      const { context, state } = await simulatedStage(output);
      await runConcealReveal(context);
      expect(context.records).toEqual(ALL_IDENTITIES);
      expect(state.actions).toEqual(STAGE_ACTIONS);
      expect(state.profile).toBe(DESKTOP_ACCOUNT_PROFILE);
      // Line 46 sends no preset.
      expect(state.roomContent).toEqual({ name: ROOM_NAME });
      expect(state.sent).toEqual([
        { transaction: TRANSACTION, content: CONTENT },
      ]);
      expect(state.tapped).toBe(EVENT_ID);
      expect(context.ledger.eventIds).toEqual([EVENT_ID]);
      expect(context.ledger.texts).toEqual([BODY, SECRET, TRANSACTION]);
      expect(context.safety.unsafeSecrets).toBe(false);
      expect(
        state.written
          .map((entry) => entry.name)
          .filter((name) => name.startsWith('receipt-')),
      ).toEqual([
        'receipt-01-spoiler-event',
        'receipt-02-black-bar',
        'receipt-03-concealed-capture',
        'receipt-04-native-tap',
        'receipt-05-revealed-capture',
      ]);
      const transparent = state.written.find(
        (entry) => entry.name === identity('initial-transparent'),
      );
      expect(transparent.value.observation).toEqual({
        color: 'rgba(0, 0, 0, 0)',
        alpha: 0,
      });
      const painted = state.written.find(
        (entry) => entry.name === identity('revealed-painted'),
      );
      expect(painted.value.observation).toEqual({
        color: REVEALED_PAINT.color,
        alpha: 1,
      });
      const visible = state.written.find(
        (entry) => entry.name === identity('spoiler-visible'),
      );
      expect(visible.value.observation).toMatchObject({
        leaves: 1,
        eventDigest: sha256(EVENT_ID),
        exactSecret: true,
      });
      // The two scoped captures: the bar, then the revealed leaf.
      const concealed = decodePng(
        await readFile(join(output, 'spoiler-concealed.png')),
      );
      const revealed = decodePng(
        await readFile(join(output, 'spoiler-revealed.png')),
      );
      expect(concealed.pixels[0]).toBe(0x14);
      expect(revealed.pixels[0]).toBe(0xe0);
      expect([concealed.width, concealed.height]).toEqual([
        revealed.width,
        revealed.height,
      ]);
      assertIdFreeEvidence(state, [
        ROOM,
        EVENT_ID,
        SENDER,
        USER.password,
        USER.username,
        RUN,
        SECRET,
        BODY,
      ]);
      const metadata = await readFile(
        join(output, 'spoiler-revealed.json'),
        'utf8',
      );
      for (const value of [ROOM, EVENT_ID, SENDER, RUN, SECRET])
        expect(metadata).not.toContain(value);
    });
  });

  const FAULTS = [
    // Exact fixture on real Synapse, before any UI step.
    ['eventMissing', 'room-ready'],
    ['extraMessage', 'room-ready'],
    [{ eventContent: { format: 'text/html' } }, 'room-ready'],
    [{ eventContent: { formatted_body: BODY } }, 'room-ready'],
    [
      {
        eventContent: {
          formatted_body: `${CONTENT.formatted_body} <span data-mx-spoiler>x</span>`,
        },
      },
      'room-ready',
    ],
    [
      {
        eventContent: {
          'm.relates_to': { rel_type: 'm.thread', event_id: '$r' },
        },
      },
      'room-ready',
    ],
    // Exact spoiler identity.
    ['twoLeaves', 'spoiler-visible'],
    ['leafOtherText', 'spoiler-visible'],
    ['leafOtherRow', 'spoiler-visible'],
    ['nestedSpoiler', 'spoiler-visible'],
    ['leafHidden', 'spoiler-visible'],
    ['covered', 'spoiler-visible'],
    // Initial state and paint.
    ['startsRevealed', 'initial-unrevealed'],
    [
      { concealedPaint: { color: 'oklch(0.3 0.018 265)' } },
      'initial-transparent',
    ],
    [{ concealedPaint: { color: 'rgb(0 0 0 / 0.5)' } }, 'initial-transparent'],
    [{ concealedPaint: { color: 'var(--x)' } }, 'initial-transparent'],
    // The black bar and the concealed capture scope.
    [{ concealedPaint: { backgroundColor: 'rgba(0, 0, 0, 0)' } }, 'revealed'],
    ['wrapped', 'revealed'],
    ['unsettledConcealed', 'revealed'],
    ['captureOffScreen', 'revealed'],
    // Native activation and final paint.
    ['tapNoReveal', 'revealed'],
    [{ revealedPaint: { color: 'rgba(0, 0, 0, 0)' } }, 'revealed-painted'],
    [{ revealedPaint: { color: 'transparent' } }, 'revealed-painted'],
    // The revealed capture must settle; every record precedes it.
    ['unsettledRevealed', null],
  ];

  for (const [fault, firstMissing] of FAULTS) {
    const name = typeof fault === 'string' ? fault : JSON.stringify(fault);
    it(`fails before ${firstMissing ?? 'the revealed capture'} when ${name}`, async () => {
      const { runConcealReveal } = await loadJourneys();
      const faults = typeof fault === 'string' ? { [fault]: true } : fault;
      await withOutput('trinity-spoiler-fault-', async (output) => {
        const { context, state } = await simulatedStage(output, faults);
        await expect(runConcealReveal(context)).rejects.toThrow();
        const index =
          firstMissing === null
            ? ALL_IDENTITIES.length
            : ALL_IDENTITIES.indexOf(identity(firstMissing));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(context.records).toEqual(ALL_IDENTITIES.slice(0, index));
        if (index === 0) expect(state.actions).not.toContain('reset');
        if (state.tapped !== undefined) expect(state.tapped).toBe(EVENT_ID);
        expect(existsSync(join(output, 'spoiler-revealed.png'))).toBe(false);
      });
    });
  }

  it('captures the failed leaf only when it is still in scope', async () => {
    const { captureFailedLeaf } = await loadJourneys();
    await withOutput('trinity-spoiler-failed-', async (output) => {
      const { context, state } = await simulatedStage(output);
      state.roomOpen = true;
      state.events.push(serverEvent());
      await captureFailedLeaf(context);
      expect(existsSync(join(output, 'spoiler-failed.png'))).toBe(true);
      expect(
        state.written.find((entry) => entry.name === 'spoiler-failed-capture')
          .value,
      ).toMatchObject({ captured: true, revealed: false });
    });
    await withOutput('trinity-spoiler-failed-none-', async (output) => {
      const { context, state } = await simulatedStage(output, {
        twoLeaves: true,
      });
      state.roomOpen = true;
      await captureFailedLeaf(context);
      expect(existsSync(join(output, 'spoiler-failed.png'))).toBe(false);
      expect(
        state.written.find((entry) => entry.name === 'spoiler-failed-capture')
          .value,
      ).toEqual({ captured: false, leaves: 2 });
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Suite-local REST fixture                                                  */
/* ------------------------------------------------------------------------ */

describe('Android message-spoiler REST fixture', () => {
  const TOKEN = 'syt_c3BvaWxlcg_secretToken_0a1b';
  const fakeFetch =
    (log, failSend = false) =>
    async (url, init) => {
      log.push({
        url: String(url),
        method: init.method,
        authorization: init.headers.Authorization ?? null,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        bounded: init.signal instanceof AbortSignal,
      });
      const path = new URL(url).pathname;
      if (path.endsWith('/login'))
        return new Response(
          JSON.stringify({ user_id: SENDER, access_token: TOKEN }),
          { status: 200 },
        );
      if (path.includes('/send/m.room.message/'))
        return failSend
          ? new Response('{"errcode":"M_FORBIDDEN"}', { status: 403 })
          : new Response(JSON.stringify({ event_id: EVENT_ID }), {
              status: 200,
            });
      if (path.endsWith('/logout')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    };

  it('sends exactly the formatted content once, keeps the token private and logs out', async () => {
    const { createMessageSpoilerFixtures } = await loadFixture();
    const cleanups = [];
    const log = [];
    const fixtures = createMessageSpoilerFixtures(
      { cleanup: (label, action) => cleanups.push({ label, action }) },
      new AbortController().signal,
      fakeFetch(log),
    );
    expect(cleanups.map((entry) => entry.label)).toEqual([
      'Message-spoiler REST session',
    ]);
    const eventId = await fixtures.sendSpoiler(
      USER,
      ROOM,
      TRANSACTION,
      CONTENT,
    );
    expect(eventId).toBe(EVENT_ID);
    expect(log.map((entry) => entry.method)).toEqual(['POST', 'PUT']);
    expect(log[0].body).toMatchObject({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER.username },
      password: USER.password,
    });
    expect(new URL(log[1].url).pathname).toBe(
      `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/send/m.room.message/${encodeURIComponent(TRANSACTION)}`,
    );
    expect(log[1].authorization).toBe(`Bearer ${TOKEN}`);
    expect(log[1].body).toEqual(CONTENT);
    expect(log.every((entry) => entry.bounded)).toBe(true);
    await cleanups[0].action();
    expect(log.at(-1)).toMatchObject({
      method: 'POST',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(new URL(log.at(-1).url).pathname).toBe('/_matrix/client/v3/logout');
  });

  it('fails without the token, Room or content in its error', async () => {
    const { createMessageSpoilerFixtures } = await loadFixture();
    const fixtures = createMessageSpoilerFixtures(
      { cleanup: () => {} },
      new AbortController().signal,
      fakeFetch([], true),
    );
    const error = await fixtures
      .sendSpoiler(USER, ROOM, TRANSACTION, CONTENT)
      .then(
        () => undefined,
        (failure) => failure,
      );
    expect(error.message).toBe(
      'Message-spoiler fixture PUT send failed with HTTP 403',
    );
    expect(error.status).toBe(403);
    for (const value of [TOKEN, ROOM, encodeURIComponent(ROOM), SECRET])
      expect(error.message).not.toContain(value);
  });
});

/* ------------------------------------------------------------------------ */
/* Diagnostics safety                                                        */
/* ------------------------------------------------------------------------ */

const ARTIFACT_IDS = {
  run: RUN,
  account: {
    userId: SENDER,
    username: USER.username,
    password: USER.password,
  },
  room: { id: ROOM, name: ROOM_NAME },
  texts: [BODY, SECRET, TRANSACTION],
  eventIds: [EVENT_ID],
};

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

/** A pass capture of the Room, as the capture step writes it. */
const roomCapture = () =>
  JSON.stringify(
    {
      url: ROUTE,
      body: `${ROOM_NAME}\nspoiler\nthe secret is ${SECRET}\nMessage #${ROOM_NAME}`,
      composer: '',
    },
    null,
    2,
  );

/** Write one valid leaf-scoped raster and its metadata into a stage directory. */
async function writeScopedRaster(directory, state = 'concealed', change = {}) {
  const { encodePng } = await loadArtifacts();
  const name = `spoiler-${state}`;
  const native = {
    topLeft: { x: 431, y: 431 },
    bottomRight: { x: 679, y: 446 },
  };
  const width = 249;
  const height = 16;
  const png =
    change.png ??
    encodePng({
      width,
      height,
      channels: 4,
      colorType: 6,
      pixels: Buffer.alloc(width * height * 4, 0x14),
    });
  const metadata = {
    schemaVersion: 1,
    scope: 'spoiler-leaf',
    source: 'device-screencap',
    state,
    sha256: sha256(png),
    width,
    height,
    clip: { x: 510, y: 359, width: 295, height: 18.5 },
    native,
    meanLuminance: 20,
    ...CONCEALED_PAINT,
    ...change.metadata,
  };
  await writeFile(join(directory, `${name}.png`), png);
  if (!change.noMetadata)
    await writeFile(
      join(directory, `${name}.json`),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  return png;
}

describe('Android message-spoiler diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read(JOURNEYS);
    const current = recordProofViolations(journey);
    expect(current.records).toBe(6);
    expect(current.violations).toEqual([]);
    for (const [from, to] of [
      ['() => assertRevealed(revealed, expected)', '() => {}'],
      [
        '() => { assertInitialTransparent(concealed, expected); }',
        '() => void concealed',
      ],
      ['() => assertSpoilerVisible(shown, expected)', 'undefined'],
    ]) {
      expect(journey).toContain(from);
      expect(
        recordProofViolations(journey.replace(from, to)).violations,
      ).toHaveLength(1);
    }
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_SPOILER_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_SPOILER_STAGES[0],
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
      name: identity('room-ready'),
      value: {
        assertion: identity('room-ready'),
        observation: { ready: true },
      },
    });
    await expect(
      record(
        context,
        'spoiler-visible',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    await expect(record(context, 'room-ready', () => {}, {})).rejects.toThrow();
    await expect(
      record(context, 'revealed-painted', () => {}, {}),
    ).rejects.toThrow();
    await expect(record(context, 'not-owned', () => {}, {})).rejects.toThrow();
    expect(written).toHaveLength(1);
    await receipt(context, 'spoiler-event', { ok: true });
    expect(written.at(-1).name).toBe('receipt-01-spoiler-event');
    for (const name of [identity('room-ready'), 'Start', ''])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messageSpoilerSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageSpoilerSecrets(STAGE.id, ARTIFACT_IDS);
    const segment = Buffer.from(ROOM).toString('base64url');
    const failure = new AssertionError({
      actual: SECRET,
      expected: OTHER_ID,
      operator: 'strictEqual',
      message: 'The leaf holds exactly the secret',
    });
    const leaked = new Error(
      `GET /rooms/${encodeURIComponent(ROOM)}/messages for ${SENDER} at /rooms/${segment} on ${EVENT_ID} body ${BODY}`,
    );
    const error = redactStageFailure(
      STAGE.id,
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain(
      'Android message-spoiler conceal-reveal failed',
    );
    expect(error.message).toContain('The leaf holds exactly the secret');
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ROOM,
      encodeURIComponent(ROOM),
      segment,
      EVENT_ID,
      SENDER,
      BODY,
      SECRET,
      RUN,
    ])
      expect(error.message).not.toContain(value);
    // Node appends an assertion's actual/expected values to a custom message,
    // contiguous or as an interleaved character diff depending on the
    // terminal. The rethrow keeps exactly the first line, so no fragment of
    // that block reaches the job log, nor does any unregistered event-id shape.
    const [firstLine, ...appended] = failure.message.split('\n');
    expect(firstLine).toBe('The leaf holds exactly the secret');
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
            assert.deepEqual({ text: '$x' }, { text: '$y' }, 'Fields');
          } catch (diffed) {
            return diffed;
          }
        })(),
      ],
      {},
    );
    expect(shaped.message).toBe(
      'Android message-spoiler conceal-reveal failed\nError: Event [REDACTED] already in timeline\nAssertionError: strictEqual assertion failed\nAssertionError: Fields',
    );
    const cleanup = redactCleanupFailure(
      'fixtures',
      Object.assign(new Error(`leave ${ROOM}`), { status: 403 }),
    );
    expect(cleanup.message).toBe(
      'Message-spoiler cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
    // Removing the redaction leaks the identifiers again.
    expect(redactStageFailure(STAGE.id, [leaked], {}).message).toContain(
      EVENT_ID,
    );
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardMessageSpoilerCleanup } = await loadJourneys();
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
    const guarded = guardMessageSpoilerCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ROOM}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-spoiler cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.report.stages[0].error).toContain(ROOM);
    expect(state.saves).toBe(1);
    const early = { ...state, report: { status: 'running', stages: [] } };
    const later = [];
    guardMessageSpoilerCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it('registers every identifier form before any UI step, including the event id, never the bare server name', async () => {
    const { messageSpoilerSecrets } = await loadArtifacts();
    const secrets = messageSpoilerSecrets(STAGE.id, ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_SPOILER_CONCEAL_REVEAL_'),
      ),
    ).toBe(true);
    const values = new Set(Object.values(secrets));
    for (const value of [
      RUN,
      SENDER,
      encodeURIComponent(SENDER),
      USER.username,
      USER.password,
      ROOM,
      ROOM.slice(1),
      encodeURIComponent(ROOM),
      Buffer.from(ROOM).toString('base64url'),
      ROOM_NAME,
      BODY,
      encodeURIComponent(BODY),
      SECRET,
      TRANSACTION,
      EVENT_ID,
      encodeURIComponent(EVENT_ID),
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(messageSpoilerSecrets(STAGE.id, { run: 'trn-p' })),
    ).toEqual(['SECRET_SPOILER_CONCEAL_REVEAL_RUN']);
    expect(() => messageSpoilerSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messageSpoilerSecrets(STAGE.id, { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
    const journey = read(JOURNEYS);
    for (const step of [
      'protect(context, { room: { name }, texts: [content.body, secret, transaction] });',
      'protect(context, { account });',
      'protect(context, { room: { id: room.id } });',
      'protect(context, { eventIds: [eventId] });',
    ])
      expect(journey).toContain(step);
    const run = functionSource(journey, 'runConcealReveal');
    expect(run.indexOf('await arrangeSpoiler(context);')).toBeLessThan(
      run.indexOf('context.safety.unsafeSecrets = false;'),
    );
    expect(run.indexOf('context.safety.unsafeSecrets = false;')).toBeLessThan(
      run.indexOf('await startNative(context);'),
    );
    const arrange = functionSource(journey, 'arrangeSpoiler');
    expect(
      arrange.indexOf('protect(context, { eventIds: [eventId] });'),
    ).toBeGreaterThan(arrange.indexOf('spoilers.sendSpoiler('));
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier, credential and event-id shape', async () => {
    const { messageSpoilerSecrets, scanMessageSpoilerArtifacts } =
      await loadArtifacts();
    const secrets = messageSpoilerSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-spoiler-scan-', async (output) => {
      await mkdir(join(output, STAGE.id));
      const capture = join(output, STAGE.id, 'passed.json');
      for (const unsafe of [
        roomCapture(),
        JSON.stringify(serverEvent()),
        `GET /rooms/${ROOM}/messages`,
        JSON.stringify({ password: USER.password }),
        `GET /rooms/${mixedCase(encodeURIComponent(ROOM))}/event/${mixedCase(encodeURIComponent(EVENT_ID))}`,
        `double=${encodeURIComponent(encodeURIComponent(ROOM))}`,
        `route=/rooms/${Buffer.from(ROOM).toString('base64url')}`,
        `slice=${ROOM.slice(1)}`,
        `selector=.scroll .msg[data-mid="${EVENT_ID}"] .mx-spoiler`,
        `user=${SENDER}`,
        `user=${encodeURIComponent(SENDER)}`,
        `body=${BODY}`,
        `secret=${SECRET}`,
        `txn=${TRANSACTION}`,
        `name=${ROOM_NAME}`,
        // A state event id the SDK logs, never registered, raw or encoded.
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
          scanMessageSpoilerArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        capture,
        '{"eventDigest":"ab","text":"[REDACTED]","server":"localhost","access_token":false,"alpha":0}\n',
      );
      await expect(
        scanMessageSpoilerArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  it('allows only valid leaf-scoped rasters at their exact paths, and rejects every other raster', async () => {
    const { scanMessageSpoilerArtifacts } = await loadArtifacts();
    const valid = async (output) => {
      await mkdir(join(output, STAGE.id), { recursive: true });
      return writeScopedRaster(join(output, STAGE.id));
    };
    await withOutput('trinity-spoiler-raster-ok-', async (output) => {
      await valid(output);
      await writeScopedRaster(join(output, STAGE.id), 'revealed', {
        metadata: REVEALED_PAINT,
      });
      await expect(
        scanMessageSpoilerArtifacts(output, {}),
      ).resolves.toBeUndefined();
    });
    const cases = [
      // A full-screen or Maestro raster.
      async (output) => {
        await valid(output);
        await writeFile(join(output, STAGE.id, 'passed-webview.png'), 'raster');
      },
      async (output) => {
        await valid(output);
        await writeFile(join(output, STAGE.id, 'passed-device.PNG'), 'raster');
      },
      async (output) => {
        await writeFile(join(output, 'screenshot-❌-1.png'), 'raster');
      },
      // An allowlisted name outside its stage, or in another format.
      async (output) => {
        await writeScopedRaster(output);
      },
      async (output) => {
        await mkdir(join(output, STAGE.id, 'nested'), { recursive: true });
        await writeScopedRaster(join(output, STAGE.id, 'nested'));
      },
      async (output) => {
        await mkdir(join(output, STAGE.id));
        await writeFile(join(output, STAGE.id, 'spoiler-concealed.jpg'), 'x');
      },
      // Missing or mismatched metadata, or a text chunk.
      async (output) => {
        await mkdir(join(output, STAGE.id));
        await writeScopedRaster(join(output, STAGE.id), 'concealed', {
          noMetadata: true,
        });
      },
      async (output) => {
        await mkdir(join(output, STAGE.id));
        await writeScopedRaster(join(output, STAGE.id), 'concealed', {
          metadata: { sha256: sha256('other') },
        });
      },
      async (output) => {
        await mkdir(join(output, STAGE.id));
        await writeScopedRaster(join(output, STAGE.id), 'concealed', {
          metadata: { width: 1080 },
        });
      },
      async (output) => {
        await mkdir(join(output, STAGE.id));
        await writeScopedRaster(join(output, STAGE.id), 'concealed', {
          metadata: {
            native: {
              topLeft: { x: 0, y: 0 },
              bottomRight: { x: 1079, y: 2399 },
            },
          },
        });
      },
      async (output) => {
        await mkdir(join(output, STAGE.id));
        await writeScopedRaster(join(output, STAGE.id), 'concealed', {
          metadata: { state: 'revealed' },
        });
      },
      async (output) => {
        await mkdir(join(output, STAGE.id));
        await writeScopedRaster(join(output, STAGE.id), 'concealed', {
          metadata: { scope: 'screen' },
        });
      },
      async (output) => {
        const { encodePng } = await loadArtifacts();
        const { crc32 } = await import('node:zlib');
        const base = encodePng({
          width: 249,
          height: 16,
          channels: 4,
          colorType: 6,
          pixels: Buffer.alloc(249 * 16 * 4, 0x14),
        });
        const data = Buffer.from(`Comment\0${SECRET}`, 'latin1');
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write('tEXt', 4, 'latin1');
        const tail = Buffer.alloc(4);
        tail.writeUInt32BE(
          crc32(Buffer.concat([head.subarray(4), data])) >>> 0,
          0,
        );
        const png = Buffer.concat([
          base.subarray(0, 33),
          head,
          data,
          tail,
          base.subarray(33),
        ]);
        await mkdir(join(output, STAGE.id));
        await writeScopedRaster(join(output, STAGE.id), 'concealed', { png });
      },
    ];
    for (const [index, arrange] of cases.entries())
      await withOutput('trinity-spoiler-raster-', async (output) => {
        await arrange(output);
        await expect(
          scanMessageSpoilerArtifacts(output, {}),
          `case ${index}`,
        ).rejects.toThrow();
      });
  });

  it('scrubs text and every unscoped raster, keeps valid leaf captures and then scans clean', async () => {
    const {
      messageSpoilerSecrets,
      scrubMessageSpoilerArtifacts,
      scanMessageSpoilerArtifacts,
    } = await loadArtifacts();
    const secrets = messageSpoilerSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-spoiler-scrub-', async (output) => {
      const stage = join(output, STAGE.id);
      await mkdir(stage);
      const flow = join(output, 'accounts-current-point-tap-1');
      await mkdir(flow);
      const path = join(stage, 'passed-surface.json');
      await writeFile(
        path,
        [
          roomCapture(),
          `GET /rooms/${mixedCase(encodeURIComponent(ROOM))}/messages`,
          `leaf=.scroll .msg[data-mid=${JSON.stringify(EVENT_ID)}]`,
          JSON.stringify({ password: USER.password }),
          'class $OnBluetoothActivityEnergyInfoProxy digest 0a1b2c',
          'unchanged=1 leaf',
        ].join('\n'),
      );
      await writeFile(
        join(flow, 'device-logcat.txt'),
        `I chromium: Msg: Event $SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 already in timeline\nI chromium: ${SECRET}\n`,
      );
      await writeFile(join(flow, 'screenshot-❌-1.png'), 'raster of the Room');
      for (const name of [
        'passed-webview.png',
        'passed-device.png',
        'failed-webview.png',
        'failed-device.png',
      ])
        await writeFile(join(stage, name), 'raster of the Room');
      const concealed = await writeScopedRaster(stage);
      await writeScopedRaster(stage, 'revealed', {
        metadata: { sha256: sha256('tampered') },
      });
      await scrubMessageSpoilerArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe('unchanged=1 leaf');
      for (const leaked of [
        ROOM,
        EVENT_ID,
        SENDER,
        BODY,
        SECRET,
        RUN,
        'spoiler-pass',
      ])
        expect(scrubbed).not.toContain(leaked);
      expect(scrubbed).toContain('$OnBluetoothActivityEnergyInfoProxy');
      const logcat = await readFile(join(flow, 'device-logcat.txt'), 'utf8');
      expect(logcat).not.toContain('$SJXdpxxWrrm9mq1XxwAx1Kq');
      expect(logcat).not.toContain(SECRET);
      for (const file of [
        join(flow, 'screenshot-❌-1.png'),
        join(stage, 'passed-webview.png'),
        join(stage, 'passed-device.png'),
        join(stage, 'failed-webview.png'),
        join(stage, 'failed-device.png'),
        // A scoped name whose metadata no longer matches is removed too.
        join(stage, 'spoiler-revealed.png'),
      ])
        expect(existsSync(file), file).toBe(false);
      expect(await readFile(join(stage, 'spoiler-concealed.png'))).toEqual(
        concealed,
      );
      await expect(
        scanMessageSpoilerArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried one-stage 6-record desktop run with both leaf captures', async () => {
    const artifacts = await loadArtifacts();
    const { DESKTOP_ACCOUNT_PROFILE, PIXEL_5_ACCOUNT_PROFILE } =
      await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 6,
      attempt: 1,
      retries: 0,
      stages: [
        {
          id: STAGE.id,
          status: 'passed',
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: 6,
          assertionRecords: 6,
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
    await withOutput('trinity-spoiler-gate-', async (output) => {
      const marker = join(output, 'publication-safe');
      const stage = join(output, STAGE.id);
      const write = (path, value) =>
        writeFile(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
      const provenance = (profile = DESKTOP_ACCOUNT_PROFILE) => ({
        schemaVersion: 1,
        profile: {
          requested: profile,
          digest: sha256(JSON.stringify(profile)),
        },
      });
      const arrange = async (value = report()) => {
        await rm(stage, { recursive: true, force: true });
        await write('journeys.json', value);
        await write('runtime-provenance.json', provenance());
        await mkdir(stage, { recursive: true });
        await write(join(STAGE.id, 'profile-applied.json'), {
          requested: DESKTOP_ACCOUNT_PROFILE,
        });
        for (const name of [
          'passed.json',
          'passed-ui.json',
          'passed-surface.json',
        ])
          await write(join(STAGE.id, name), { ok: true });
        await writeScopedRaster(stage);
        await writeScopedRaster(stage, 'revealed', {
          metadata: REVEALED_PAINT,
        });
      };
      const refused = async (value, options = {}) => {
        await writeFile(marker, 'stale\n');
        await expect(
          artifacts.markMessageSpoilerDiagnosticsSafe(
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
      await artifacts.markMessageSpoilerDiagnosticsSafe(
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
          value.stages[0].assertionRecords = 5;
        }),
        mutate((value) => {
          value.stages[0].assertions[5] = value.stages[0].assertions[4];
        }),
        mutate((value) => (value.expectedAssertionRecords = 5)),
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
        join(STAGE.id, 'spoiler-concealed.png'),
        join(STAGE.id, 'spoiler-revealed.png'),
        join(STAGE.id, 'spoiler-revealed.json'),
        'runtime-provenance.json',
      ]) {
        await arrange();
        await rm(join(output, missing));
        await refused(report());
      }
      await arrange();
      await write(join(STAGE.id, 'profile-applied.json'), {
        requested: PIXEL_5_ACCOUNT_PROFILE,
      });
      await refused(report());
      await arrange();
      await write(
        'runtime-provenance.json',
        provenance(PIXEL_5_ACCOUNT_PROFILE),
      );
      await refused(report());
      await arrange();
      await writeFile(join(stage, 'passed-surface.json'), roomCapture());
      await refused(report(), {
        secrets: artifacts.messageSpoilerSecrets(STAGE.id, ARTIFACT_IDS),
      });
      await arrange();
      await writeScopedRaster(stage, 'failed');
      await refused(report());
      await arrange();
      await writeFile(join(stage, 'passed-webview.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const {
      runMessageSpoilerStageCleanup,
      revokeMessageSpoilerPublicationOnAbort,
    } = await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessageSpoilerStageCleanup(
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
    await withOutput('trinity-spoiler-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageSpoilerPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageSpoilerPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-spoiler publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });

  it('tears down the REST session, Account and Room through guarded cleanups', () => {
    const fixtures = read(FIXTURES);
    const cleanup = fixtures.slice(
      fixtures.indexOf(
        "resources.cleanup('cleanup fixture rooms and accounts'",
      ),
      fixtures.indexOf('  function requestSignal('),
    );
    for (const hook of [
      'for (const [roomId, members] of roomMembers) {',
      "for (const action of ['leave', 'forget'] as const) {",
      'AbortSignal.timeout(REQUEST_TIMEOUT_MS),',
      "'/logout',",
      "throw new AggregateError(failures, 'Fixture cleanup failed');",
    ])
      expect(cleanup).toContain(hook);
    const journey = read(JOURNEYS);
    expect(journey).toContain('resources.cleanup = guardedCleanup;');
    expect(journey).toContain(
      '() => device.clearApplicationData(APPLICATION_ID),',
    );
    const runner = functionSource(journey, 'runMessageSpoilerSuite');
    expect(
      runner.indexOf('createAccountFixtures(resources, signal)'),
    ).toBeLessThan(
      runner.indexOf('createMessageSpoilerFixtures(resources, signal)'),
    );
    const fixture = read(FIXTURE);
    expect(fixture).toContain(
      "resources.cleanup('Message-spoiler REST session', async () => {",
    );
    expect(fixture).toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)');
  });
});

/* ------------------------------------------------------------------------ */
/* Hosted wiring and parity ledger                                           */
/* ------------------------------------------------------------------------ */

const NX_COMMAND =
  '--suite=android.message-spoiler --timeout-ms=900000 --entrypoint=e2e/android/message-spoiler-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "3" ]; then echo \'message-spoiler-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:message-spoiler; fi';
const GATE_PATH =
  "-path '*/android.message-spoiler/message-spoiler/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-spoiler-started == 'true' && steps.message-spoiler-artifact-gate.outputs.message-spoiler-safe == 'true' }}";

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
  const target = project.targets['message-spoiler'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-spoiler']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-spoiler',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(
    lines.filter((line) =>
      line.includes('trinity-e2e-android:message-spoiler'),
    ),
  ).toHaveLength(1);
  expect(lines[runner - 1]).toContain("echo 'message-source-started=true'");
  expect(
    lines
      .filter((line) => line.startsWith('if [ "${{ matrix.shard }}" = "3" ]'))
      .at(-1),
  ).toBe(CI_LINE);
  const gate = workflow
    .split('      - name: Gate Android message-spoiler diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-spoiler-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-spoiler-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain(
    'echo \'message-spoiler-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-spoiler\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-spoiler/**',
  );
  expect(workflow).toContain('shard 2 about 117, shard 3 about 173\n');
  expect(workflow).toContain(
    "# Shard 3's figure also adds a provisional 5 minutes for message-spoiler.",
  );
  expect(ciSpec).toContain('expect(uploads.length).toBe(79);');
  expect(ciSpec).toContain('expect(lines).toHaveLength(72);');
  expect(ciSpec).toContain("step.with.surface === 'android-message-spoiler'");
  expect(ciSpec).toContain(
    'runs message-spoiler after message-source at the end of shard 3',
  );
  expect(ciSpec).toContain(
    'budgets message-spoiler in the shard-3 figure of the Android budget comment',
  );
}

describe('Android message-spoiler hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-spoiler',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-spoiler',
      canonicalScript: 'e2e:android:message-spoiler',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      CONTRACT,
      FIXTURE,
      OBSERVER,
      ARTIFACTS,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-spoiler',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-spoiler',
        command: 'nx run trinity-e2e-android:message-spoiler',
        kind: 'canonical',
        suiteIds: ['android.message-spoiler'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-spoiler'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "3" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-spoiler',
    );
    expect(read(JOURNEYS)).toContain('timeout: 600_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-spoiler']);
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
            'message-spoiler-journeys.mts',
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
        delete inputs.pkg.scripts['e2e:android:message-spoiler'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "3"', '= "2"')),
      withText('workflow', CI_LINE, CI_LINE.replace('1200000', '600000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-spoiler/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-spoiler-started == 'true' }}",
      ),
      withText('workflow', 'shard 3 about 173', 'shard 3 about 168'),
      withText(
        'ciSpec',
        'expect(uploads.length).toBe(79);',
        'expect(uploads.length).toBe(78);',
      ),
      withText(
        'ciSpec',
        'expect(lines).toHaveLength(72);',
        'expect(lines).toHaveLength(71);',
      ),
    ])
      expect(() => assertWiring(mutated)).toThrow();
    // The runner moved before message-source.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === CI_LINE);
    const [line] = lines.splice(index, 1);
    lines.splice(index - 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 6 identities with their source lines and the 5/1 prose, as the last section', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-spoiler journey')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-spoiler\.[^`]+)` \|$/gmu,
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
    expect(section).toContain('5 direct + 1');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-spoiler`');
    expect(section).toMatch(/remains enabled and untouched/u);
    expect(section).toContain('data-mx-spoiler');
    expect(section).toContain('1280×720');
    expect(section).toContain('spoiler-concealed.png');
    expect(section).toContain('spoiler-revealed.png');
    expect(section).toContain('acceptance gate for #753');
    expect(section).not.toContain('pnpm exec nx');
    expect(migration.trimEnd().endsWith(section.trimEnd())).toBe(true);
    // The message-source section, and only it, precedes this one.
    expect(
      migration.split('\n## ').at(-2).startsWith('Message-source journey\n'),
    ).toBe(true);
    const design = read(
      'docs/superpowers/specs/2026-09-26-android-spoiler-reveal-maestro-design.md',
    );
    for (const suffix of STAGE.suffixes)
      expect(design).toContain(`\`${suffix}\``);
    expect(design).toContain(PREDECESSOR_SHA256);
  });
});

/* ------------------------------------------------------------------------ */
/* Source rules: journeys, observer, contract, artifacts and fixture         */
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
  ['handler call', /onClick\(|onKey\(|\.reveal\(|SpoilerRevealDirective/u],
  ['location =', /location\s*=(?!=)|location\.href\s*=(?!=)/u],
  ['location.assign', /location\.(?:assign|replace)\(/u],
  ['Input.dispatch', /Input\.dispatch/u],
  [
    'REST text send',
    /sendMessage\(|sendEvent\(|sendImageMessage\(|\/send\/m\.room\.message|setRoomState\(/u,
  ],
  [
    'CSS class or screenshot paint',
    /classList\.contains\(['"](?:bg-|text-)|\.screenshot\(|toHaveScreenshot|captureScreenshot/u,
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
      if (['readComposer', 'readSpoiler'].includes(called)) {
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
    /(?:\.scrollTop|\.scrollLeft|\.value|\.selectionStart|\.selectionEnd|\.innerHTML|\.textContent|\.className|\.style\.[\w]+)\s*=(?!=)/u,
  );
  expect(source).not.toMatch(
    /Input\.dispatch|\.goto\s*\(|window\.location\s*=|location\.assign\s*\(|\.style\.(?:setProperty|removeProperty)\s*\(|classList\.(?:add|remove|toggle|replace)\s*\(|appendChild|insertBefore|replaceChildren/u,
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

/** The source text of argument `index` of every call to `name`, from the AST. */
function callArguments(source, name, index) {
  const tree = ts.createSourceFile(
    'journeys.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found.push(node.arguments[index]?.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** The native order and invariants required by the issue. */
function assertJourneyRules(journeys) {
  assertNoForbiddenTokens(journeys, JOURNEYS);
  assertReadOnlyObserver(journeys);
  assertBoundedWaits(journeys, JOURNEYS);
  expect(journeys).not.toMatch(/evaluateNative|webview\./u);
  expect(journeys).not.toMatch(
    /client\.(?:fill|replace|tap|focusCurrent|fillFocused|longPressCurrent|swipeCurrent|key|keyCombination)\(/u,
  );
  // REST arranges only the Account, Room and message, and observes the event.
  expect(journeys.match(/(?:fixtures|spoilers)\.\w+\(/gu)).toEqual([
    'fixtures.account(',
    'fixtures.createRoom(',
    'spoilers.sendSpoiler(',
    'fixtures.roomMessages(',
  ]);
  const arrange = functionSource(journeys, 'arrangeSpoiler');
  assertOrder(
    arrange,
    [
      /protect\(context, \{ room: \{ name \}, texts: \[content\.body, secret, transaction\] \}\)/u,
      /fixtures\.account\('spoiler-reveal'\)/u,
      /protect\(context, \{ account \}\)/u,
      /fixtures\.createRoom\(account, \{ name \}\)/u,
      /protect\(context, \{ room: \{ id: room\.id \} \}\)/u,
      /spoilers\.sendSpoiler\(account, room\.id, transaction, content\)/u,
      /protect\(context, \{ eventIds: \[eventId\] \}\)/u,
    ],
    'arrangeSpoiler',
  );
  const run = functionSource(journeys, 'runConcealReveal');
  assertOrder(
    run,
    [
      callOf('arrangeSpoiler'),
      /context\.safety\.unsafeSecrets = false/u,
      /proveSpoilerEvent\(context, arranged\)/u,
      callOf('startNative'),
      /client\.login\(account\)/u,
      /client\.hideKeyboard\(\)/u,
      /openRoom\(context, room, account\)/u,
      /\(value\) => assertSpoilerVisible\(value, expected\)/u,
      recordOf('spoiler-visible'),
      /\(value\) => assertInitialUnrevealed\(value, expected\)/u,
      recordOf('initial-unrevealed'),
      /\(value\) => assertInitialTransparent\(value, expected\)/u,
      recordOf('initial-transparent'),
      /\(value\) => assertConcealedCapture\(value, expected\)/u,
      /receipt\(context, 'black-bar'/u,
      /captureSpoilerLeaf\(client, 'concealed'/u,
      /receipt\(context, 'concealed-capture'/u,
      /client\.tapCurrent\(SPOILER, \{ exactText: expected\.secret \}\)/u,
      /receipt\(context, 'native-tap'/u,
      /\(value\) => assertRevealed\(value, expected\)/u,
      recordOf('revealed'),
      /\(value\) => assertRevealedPainted\(value, expected\)/u,
      recordOf('revealed-painted'),
      /\(value\) => assertRevealedCapture\(value, expected\)/u,
      /captureSpoilerLeaf\(client, 'revealed'/u,
      /receipt\(context, 'revealed-capture'/u,
    ],
    'runConcealReveal',
  );
  expect(run.match(/client\.tapCurrent\(/gu)).toHaveLength(1);
  // Each record proves the observation it names.
  for (const [suffix, proof] of [
    ['spoiler-visible', '() => assertSpoilerVisible(shown, expected)'],
    [
      'initial-unrevealed',
      '() => assertInitialUnrevealed(unrevealed, expected)',
    ],
    [
      'initial-transparent',
      '() => { assertInitialTransparent(concealed, expected); }',
    ],
    ['revealed', '() => assertRevealed(revealed, expected)'],
    ['revealed-painted', '() => { assertRevealedPainted(painted, expected); }'],
  ])
    expect(run).toContain(`record(context, '${suffix}', ${proof}`);
  const event = functionSource(journeys, 'proveSpoilerEvent');
  expect(event).toContain('context.fixtures.roomMessages(account, room.id)');
  expect(event).toContain('assertSpoilerRoom(value, expected)');
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
  // Native actions log their selectors to stdout, the published job log and
  // process.log, which the artifact scan does not cover: no selector may carry
  // a Room, event or user identifier, and no wait description interpolates one.
  expect(journeys).not.toMatch(/data-mid(?:[*~|]?=)|\[data-mid="\$\{/u);
  expect(journeys).toContain(
    'const SPOILER = \'.scroll .msg[data-mid^="$"] .mx-spoiler\';',
  );
  const calls = [
    ...journeys.matchAll(
      /client\.(?:tapCurrent|visible|waitElements|elements)\(([^;]*?)\);/gsu,
    ),
  ];
  expect(calls.length).toBeGreaterThanOrEqual(5);
  for (const call of calls)
    expect(call[1], call[0]).not.toMatch(
      /`|\$\{|Id\b|\.id\b|eventId|userId|sender|roomId/u,
    );
  for (const call of journeys.matchAll(/\bdescription: (?!string)([^\n]+)/gu))
    expect(call[1], call[0]).toMatch(/^'[^'$`]+',$/u);
  for (const argument of callArguments(journeys, 'leaf', 2))
    expect(argument, 'leaf description').toMatch(/^'[A-Za-z -]+'$/u);
  expect(journeys).not.toMatch(
    /console\.\w+\([^)]*\$\{(?!entry\.id|stage\.status)/u,
  );
  const runner = functionSource(journeys, 'runMessageSpoilerSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /createAccountFixtures\(/u,
      /createMessageSpoilerFixtures\(/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /MESSAGE_SPOILER_STAGES/u,
      /captureFailedLeaf\(context\)/u,
      /client\.capture\('failed'\)/u,
      /runMessageSpoilerStageCleanup\(/u,
      /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
    ],
    'runMessageSpoilerSuite',
  );
  for (const required of [
    'expectedStages: 1',
    'expectedAssertionRecords: 6',
    'attempt: 1',
    'retries: 0',
    'markMessageSpoilerDiagnosticsSafe(',
    'scrubMessageSpoilerArtifacts(',
    'revokeMessageSpoilerPublicationOnAbort(',
    "client.capture('passed')",
    "client.capture('failed')",
    'client.reset(DESKTOP_ACCOUNT_PROFILE)',
    'profile: DESKTOP_ACCOUNT_PROFILE',
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  ])
    expect(journeys).toContain(required);
}

describe('Android message-spoiler source rules', () => {
  it('keeps the observer, contract and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [OBSERVER, ARTIFACTS, CONTRACT]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    const observer = read(OBSERVER);
    assertReadOnlyObserver(observer);
    // Paint comes from the measured leaf's own computed style.
    for (const hook of [
      'const style = view.getComputedStyle(leaf);',
      'color: style.color,',
      'backgroundColor: style.backgroundColor,',
      "revealed: leaf.classList.contains('is-revealed'),",
      "const leaves = [...document.querySelectorAll('.scroll .mx-spoiler')];",
      'rects: leaf.getClientRects().length,',
    ])
      expect(observer).toContain(hook);
    expect(observer).not.toMatch(
      /classList\.contains\('(?!msg--event|is-revealed)/u,
    );
    // Rasters are evidence, never an oracle: the contract's assertions read no pixels.
    const contract = read(CONTRACT);
    expect(contract).not.toMatch(/screencap|decodePng|meanLuminance|readFile/u);
    // The artifacts module's only device call is the in-memory screencap.
    const artifacts = read(ARTIFACTS);
    expect(artifacts.match(/\.adb\(/gu)).toHaveLength(1);
    expect(artifacts).toContain(
      "'exec-out', 'sh', '-c', 'screencap -p | base64 -w 0'), 'base64'));",
    );
    expect(artifacts).not.toMatch(/webview|evaluateNative/u);
    expect(artifacts).toContain(
      'await redactMaestroArtifacts(output, secrets, false);',
    );
    expect(artifacts).not.toMatch(
      /message-source-artifacts|message-receipts-artifacts/u,
    );
  });

  it('keeps the REST fixture to one bounded send, login and logout with a closure-private token', () => {
    const fixture = read(FIXTURE);
    assertBoundedWaits(fixture, FIXTURE);
    expect(fixture.match(/\/send\/m\.room\.message\//gu)).toHaveLength(1);
    expect(fixture.match(/fetchImpl\(/gu)).toHaveLength(1);
    expect(fixture).toContain(
      'signal: AbortSignal.any([parent, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),',
    );
    // The token never leaves the closure: one export, which returns only the sender.
    expect(fixture.match(/^export /gmu)).toHaveLength(1);
    expect(fixture).toContain('export function createMessageSpoilerFixtures(');
    expect(fixture).toContain('  return { sendSpoiler };\n}');
    expect(fixture).not.toMatch(/console\./u);
    expect(fixture).not.toMatch(/\$\{token\}.*Error|Error\([^)]*token/u);
    const fixtures = read(FIXTURES);
    expect(fixtures).toContain(
      '`/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`,',
    );
    expect(read(JOURNEYS)).not.toMatch(
      /fixtures\.(?:sendMessage|roomEvent)\(/u,
    );
  });

  it('fails the forbidden-token and read-only rules under each effective mutation', () => {
    const observer = read(OBSERVER);
    for (const mutation of [
      'leaf.click()',
      'leaf.focus()',
      'input.value = "x"',
      "document.execCommand('insertText', false, 'x')",
      'leaf.dispatchEvent(new MouseEvent("click"))',
      "leaf.classList.add('is-revealed')",
      'leaf.setAttribute("class", "mx-spoiler is-revealed")',
      'leaf.style.color = "black"',
      'directive.onClick(event)',
      'window.location = "/rooms"',
      "const revealed = leaf.classList.contains('text-transparent')",
      'await page.screenshot()',
      "await webview.send('Page.captureScreenshot')",
      'await fixtures.sendMessage(account, room.id, body, "txn")',
      'const report = { retries: 1 }',
    ])
      expect(() =>
        assertNoForbiddenTokens(`${observer}\n${mutation}`, OBSERVER),
      ).toThrow();
    for (const mutation of [
      'leaf.click()',
      'leaf.focus()',
      'row.scrollTo(0, 0)',
      'leaf.className = "mx-spoiler is-revealed"',
      "leaf.classList.toggle('is-revealed')",
      'row.appendChild(node)',
    ])
      expect(() =>
        assertReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    for (const unbounded of [
      'await waitForNativeShellState(read, accepts, "x", signal);',
      'await client.waitElements(SPOILER, accepts, "x");',
    ])
      expect(() =>
        assertBoundedWaits(`${observer}\n${unbounded}`, OBSERVER),
      ).toThrow();
  });

  it('drives every product action natively in source order', () => {
    const journeys = read(JOURNEYS);
    assertJourneyRules(journeys);
    const replace = (from, to) => {
      expect(journeys).toMatch(from);
      return journeys.replace(from, to);
    };
    for (const mutated of [
      // A DOM activation, handler call or renderer write replaces the native tap.
      replace(
        /  await client\.tapCurrent\(SPOILER, \{ exactText: expected\.secret \}\);\n/u,
        '  await evaluateNative(client.webview, "document.querySelector(\'.mx-spoiler\').click()");\n',
      ),
      replace(
        /  await client\.tapCurrent\(SPOILER, \{ exactText: expected\.secret \}\);\n/u,
        '',
      ),
      `${journeys}\nawait client.tap(SPOILER, { exactText: secret });`,
      `${journeys}\nawait fixtures.sendMessage(account, room.id, body, 'txn');`,
      `${journeys}\nawait client.fillFocused(COMPOSER, body);`,
      // The fixture proof, a capture or a record is dropped or reordered.
      replace(/  await proveSpoilerEvent\(context, arranged\);\n/u, ''),
      replace(
        /captureSpoilerLeaf\(client, 'concealed'/u,
        "captureSpoilerLeaf(client, 'revealed'",
      ),
      replace(
        /record\(context, 'revealed-painted'/u,
        "receipt(context, 'revealed-painted'",
      ),
      // A record proves the wrong observation: markup or class alone.
      replace(
        /record\(context, 'revealed-painted', \(\) => \{ assertRevealedPainted\(painted, expected\); \}/u,
        "record(context, 'revealed-painted', () => { assertRevealed(painted, expected); }",
      ),
      replace(
        /record\(context, 'initial-transparent', \(\) => \{ assertInitialTransparent\(concealed, expected\); \}/u,
        "record(context, 'initial-transparent', () => { assertInitialUnrevealed(concealed, expected); }",
      ),
      // The event id is protected late, or a selector carries an identifier.
      replace(/  protect\(context, \{ eventIds: \[eventId\] \}\);\n/u, ''),
      replace(
        /client\.tapCurrent\(SPOILER, \{ exactText: expected\.secret \}\)/u,
        'client.tapCurrent(`.scroll .msg[data-mid="${expected.eventId}"] .mx-spoiler`, {})',
      ),
      replace(
        /'one visible rendered spoiler leaf'/u,
        '`leaf ${expected.secret}`',
      ),
      replace(
        /description: 'exact Room composer and route after native open',/u,
        'description: `Room ${room.id}`,',
      ),
      // A preset is sent where the predecessor sends none.
      replace(
        /fixtures\.createRoom\(account, \{ name \}\)/u,
        "fixtures.createRoom(account, { name, preset: 'private_chat' })",
      ),
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });
});
