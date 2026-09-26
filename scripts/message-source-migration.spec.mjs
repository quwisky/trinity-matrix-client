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
  'e2e/browser/journeys/conversations/message-source.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
const loadContract = () => import('../e2e/android/message-source-contract.mts');
const loadObserver = () => import('../e2e/android/message-source-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-source-artifacts.mts');
const loadJourneys = () => import('../e2e/android/message-source-journeys.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-source-journeys.mts';
const OBSERVER = 'e2e/android/message-source-observer.mts';
const ARTIFACTS = 'e2e/android/message-source-artifacts.mts';
const CONTRACT = 'e2e/android/message-source-contract.mts';
const FIXTURES = 'e2e/android/account-workspace-fixtures.mts';

/** The predecessor at its branch hash, after fe2c7c3e's Send-button change. */
const PREDECESSOR_SHA256 =
  '1a18b0772645d8d1a9cfeb38c8f620f53f37c818543d32b044a7c48be0151ca6';
/** The issue's pin: the same file on develop, before fe2c7c3e. */
const ISSUE_SHA256 =
  '3d7637643bb5f9b4c8124077f9eb880cb5b8e95e22a899f0ab82269f55115512';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/message-composer.mts':
    '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
};
const OPEN_ROOM_SPAN = [18, 26];

/** The design's identity table, verbatim. */
const STAGE = {
  id: 'view-source',
  span: [31, 105],
  title: 'shows an event’s raw JSON in the view-source dialog',
  android: [[69, 71]],
  desktop: [[72, 74]],
  direct: [65, 78, 80, 81, 100, 103, 104],
  inherited: [
    [23, 'openRoom', 59],
    [53, 'sendComposerDraft', 63],
    [178, 'waitForSent', 66],
    [220, 'openMessageActionSheet', 70],
  ],
  suffixes: [
    'room-ready',
    'send-enabled',
    'row-visible',
    'server-echo',
    'sheet-ready',
    'dialog-visible',
    'json-event',
    'json-body',
    'surface-opaque',
    'surface-border',
    'surface-shadow',
  ],
};
const ALL_IDENTITIES = STAGE.suffixes.map(
  (suffix) => `message-source.${STAGE.id}.${suffix}`,
);
const identity = (suffix) => `message-source.${STAGE.id}.${suffix}`;

const LINE_PINS = {
  16: 'const session = synapseSession();',
  18: 'async function openRoom(page: Page, roomName: string): Promise<void> {',
  19: "await page.getByTestId('rail-rooms').click();",
  20: "const channel = page.locator('.channel', { hasText: roomName });",
  21: "await channel.first().waitFor({ state: 'visible', timeout: 30_000 });",
  22: 'await channel.first().click();',
  23: "await expect(page.getByTestId('composer-input')).toBeVisible({",
  24: 'timeout: 15_000,',
  29: "test.skip(!session.available, 'needs a Synapse homeserver (Docker)');",
  31: "test('shows an event’s raw JSON in the view-source dialog', async ({",
  36: "const runId = `${testResourceId('run')}src`;",
  37: 'const user = `src-${runId}`;',
  39: 'const roomName = `Source ${runId}`;',
  40: 'const body = `inspect me ${runId}`;',
  42: 'await registerUser(request, user, pass);',
  53: 'await request.post(`${hs}/_matrix/client/v3/createRoom`, {',
  55: "data: { name: roomName, preset: 'private_chat' },",
  58: 'await login(page, { available: true, hs, user, pass } as SynapseSession);',
  59: 'await openRoom(page, roomName);',
  61: "const composer = page.getByTestId('composer-input');",
  62: 'await composer.fill(body);',
  63: 'await sendComposerDraft(composer);',
  64: "const row = page.locator('.scroll .msg', { hasText: body });",
  65: 'await expect(row.first()).toBeVisible({ timeout: 20_000 });',
  66: 'await waitForSent(row.first());',
  69: 'if (isAndroidE2E) {',
  70: 'const sheet = await openMessageActionSheet(page, row.first());',
  71: "await sheet.getByTestId('sheet-view-source').click();",
  72: '} else {',
  73: "await clickRowMenuItem(row.first(), page.getByTestId('msg-view-source'));",
  74: '}',
  77: "const dialog = page.getByTestId('message-source');",
  78: 'await expect(dialog).toBeVisible({ timeout: 10_000 });',
  79: "const json = dialog.getByTestId('message-source-json');",
  80: "await expect(json).toContainText('m.room.message');",
  81: 'await expect(json).toContainText(body);',
  87: 'const surface = await dialog.evaluate((el) => {',
  88: 'const style = getComputedStyle(el);',
  92: 'const channels = style.backgroundColor.match(/[\\d.]+/g) ?? [];',
  95: 'opaque: channels.length === 4 ? Number(channels[3]) === 1 : true,',
  96: 'hasBorder: parseFloat(style.borderTopWidth) > 0,',
  97: "hasShadow: style.boxShadow !== 'none',",
  100: 'expect(surface.opaque, `background was ${surface.backgroundColor}`).toBe(',
  103: 'expect(surface.hasBorder).toBe(true);',
  104: 'expect(surface.hasShadow).toBe(true);',
};

const IMPORTS = `import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  type SynapseSession,
  waitForSent,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { sendComposerDraft } from '../../../support/message-composer.mts';`;

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

/**
 * Every `if (isAndroidE2E) { … } else { … }` inside a span, read from the AST:
 * the then-block is the Android branch and the else-block the desktop branch.
 */
function platformBranches(source, [from, to]) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const branches = [];
  const visit = (node) => {
    if (
      ts.isIfStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'isAndroidE2E' &&
      lineOf(tree, node) >= from &&
      lineOf(tree, node) <= to
    ) {
      // `} else {` shares one line; it opens the desktop branch.
      const desktop = node.elseStatement
        ? [
            lineOf(tree, node.elseStatement),
            endLineOf(tree, node.elseStatement),
          ]
        : null;
      branches.push({
        android: [
          lineOf(tree, node),
          desktop ? desktop[0] - 1 : endLineOf(tree, node.thenStatement),
        ],
        desktop,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return branches;
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

const inside = (line, spans) =>
  spans.some(([from, to]) => line >= from && line <= to);

/**
 * Expand the definition's Android path into parity sites: direct `expect`
 * calls and binding-resolved helper calls, excluding every desktop branch the
 * AST names as the `else` of `if (isAndroidE2E)`.
 */
function expandDefinition(source, span) {
  const [from, to] = span;
  const desktop = platformBranches(source, span)
    .map((branch) => branch.desktop)
    .filter(Boolean);
  const { calls } = importedCalls(source);
  const inherited = calls
    .filter(
      (call) =>
        call.line >= from &&
        call.line <= to &&
        !inside(call.line, desktop) &&
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
  const direct = assertionLines(source, from, to)
    .filter((line) => !inside(line, desktop))
    .map((line) => ({ kind: 'direct', line }));
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
  expect(source.split('\n')).toHaveLength(107);
  expect(source.split('\n').slice(0, 12).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  expect(lineAt(source, OPEN_ROOM_SPAN[1])).toBe('}');
  expect(assertionLines(source, ...OPEN_ROOM_SPAN)).toEqual([23]);
  expect(assertionLines(source, 1, OPEN_ROOM_SPAN[0] - 1)).toEqual([]);
  expect(
    assertionLines(source, OPEN_ROOM_SPAN[1] + 1, STAGE.span[0] - 1),
  ).toEqual([]);
  expect(assertionLines(source, STAGE.span[1] + 1, 107)).toEqual([]);
  expect(lineAt(source, STAGE.span[1])).toBe('});');
  const branches = platformBranches(source, STAGE.span);
  expect(branches.map((branch) => branch.android)).toEqual(STAGE.android);
  expect(branches.map((branch) => branch.desktop)).toEqual(STAGE.desktop);
  const expanded = expandDefinition(source, STAGE.span);
  expect(expanded.map(siteTuple)).toEqual(ledgerTuples());
  expect(
    expanded.filter((site) => site.kind === 'direct').map((s) => s.line),
  ).toEqual(STAGE.direct);
  expect(expanded.filter((site) => site.kind === 'inherited')).toHaveLength(4);
  // The desktop branch holds no direct site; its helper is excluded by branch.
  expect(
    STAGE.desktop.flatMap((span) => assertionLines(source, ...span)),
  ).toEqual([]);
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-source predecessor pins', () => {
  it('pins the unchanged predecessor and the three shared helper sources by SHA-256', () => {
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

  it('reconciles the issue pin: the develop file differs only by the Send-button change', () => {
    const source = read(predecessor);
    const lines = source.split('\n');
    const undo = (text) =>
      text
        .split('\n')
        .filter(
          (line) =>
            line !==
            "import { sendComposerDraft } from '../../../support/message-composer.mts';",
        )
        .map((line) =>
          line === '    await sendComposerDraft(composer);'
            ? "    await composer.press('Enter');"
            : line,
        )
        .join('\n');
    const develop = undo(source);
    expect(lines.length - develop.split('\n').length).toBe(1);
    expect(source.match(/await sendComposerDraft\(composer\);/gu)).toHaveLength(
      1,
    );
    expect(sha256(develop)).toBe(ISSUE_SHA256);
    // Any other difference from develop breaks the reconstruction.
    expect(sha256(undo(source.replace('inspect me', 'inspect it')))).not.toBe(
      ISSUE_SHA256,
    );
    // On develop the issue's spans hold: the definition at 30–104 and the
    // helper at 17–25, one line above the branch spans.
    const developLines = develop.split('\n');
    expect(developLines[29]).toContain(`test('${STAGE.title}'`);
    expect(developLines[16]).toBe(
      'async function openRoom(page: Page, roomName: string): Promise<void> {',
    );
    expect(developLines[103].trim()).toBe('});');
  });

  it('pins the same sources, spans and branches in the contract', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_SOURCE_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_SOURCE_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_SOURCE_ISSUE_SOURCE_SHA256).toBe(ISSUE_SHA256);
    expect(contract.MESSAGE_SOURCE_SOURCE_LINES).toBe(106);
    expect(contract.MESSAGE_SOURCE_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    const span = ([from, to]) => ({ from, to });
    expect(contract.MESSAGE_SOURCE_SPANS).toEqual({
      openRoom: span(OPEN_ROOM_SPAN),
      definitions: { [STAGE.id]: span(STAGE.span) },
      androidBranches: { [STAGE.id]: STAGE.android.map(span) },
      desktopBranches: { [STAGE.id]: STAGE.desktop.map(span) },
    });
  });

  it('keeps the predecessor enabled in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-source.spec.mts',
      ),
    ).toHaveLength(1);
    const android = read('e2e/android/playwright.config.mts');
    expect(android).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    for (const config of [android, read('e2e/browser/playwright.config.mts')]) {
      expect(config).not.toContain('testIgnore');
      expect(config).not.toContain('message-source');
    }
    const source = read(predecessor);
    expect(source).not.toMatch(/test\.(?:fixme|only)\(|test\.skip\(true/u);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(1);
    expect(source.match(/^ {2}test\('/gmu)).toHaveLength(1);
    expect(source).not.toMatch(/test\.use\(/u);
  });

  it('maps the exact Android-path direct and helper sites with the house AST rule', () => {
    assertPredecessorShape(read(predecessor));
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = read(predecessor);
    const mutations = [
      // A source field, test id or run suffix drifts.
      mutateLine(source, 36, (line) => line.replace('}src`', '}s`')),
      mutateLine(source, 39, (line) => line.replace('Source', 'Src')),
      mutateLine(source, 40, (line) =>
        line.replace('inspect me', 'Inspect me'),
      ),
      mutateLine(source, 55, (line) =>
        line.replace('private_chat', 'public_chat'),
      ),
      mutateLine(source, 64, (line) => line.replace('.scroll ', '')),
      mutateLine(source, 71, (line) =>
        line.replace('sheet-view-source', 'sheet-copy'),
      ),
      mutateLine(source, 77, (line) =>
        line.replace("'message-source'", "'message-source-json'"),
      ),
      mutateLine(source, 79, (line) =>
        line.replace('message-source-json', 'message-source'),
      ),
      mutateLine(source, 80, (line) =>
        line.replace('m.room.message', 'm.room'),
      ),
      mutateLine(source, 81, (line) => line.replace('(body)', '(roomName)')),
      mutateLine(source, 95, (line) => line.replace('=== 4', '>= 3')),
      mutateLine(source, 96, (line) =>
        line.replace('borderTopWidth', 'outlineWidth'),
      ),
      mutateLine(source, 97, (line) => line.replace("!== 'none'", "!== ''")),
      // A direct site is dropped, added or moved.
      mutateLine(source, 104, () => '    void surface;'),
      mutateLine(
        source,
        82,
        () => "    await expect(json).toContainText('event_id');",
      ),
      mutateLine(source, 76, (line) => `${line}\n`),
      // A helper call changes, or a desktop call moves into the Android branch.
      mutateLine(source, 66, () => '    void row;'),
      mutateLine(source, 63, () => "    await composer.press('Enter');"),
      mutateLine(
        source,
        23,
        () => "  await page.getByTestId('composer-input').waitFor({",
      ),
      mutateLine(source, 70, () => '      const sheet = page;'),
      source.replace(
        "      await sheet.getByTestId('sheet-view-source').click();\n",
        "      await sheet.getByTestId('sheet-view-source').click();\n      await clickRowMenuItem(row.first(), page.getByTestId('msg-view-source'));\n",
      ),
      // The definition title or an import drifts.
      source.replace(
        "test('shows an event’s raw JSON in the view-source dialog'",
        "test('shows raw JSON'",
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

describe('Android message-source helper expansion by binding', () => {
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
      // Module level (line 16), outside the owned definition.
      ['synapseSession', 16],
      ['registerUser', 42],
      ['login', 58],
      ['openRoom', 59],
      ['sendComposerDraft', 63],
      ['waitForSent', 66],
      ['openMessageActionSheet', 70],
      // Desktop-only; excluded by branch.
      ['clickRowMenuItem', 73],
    ]);
  });

  it('follows helper calls and proves registration and login add no sites', () => {
    const source = read(predecessor);
    expect(helperExpectLines(predecessor, 'openRoom', source)).toEqual([
      { module: predecessor, line: 23 },
    ]);
    expect(
      helperExpectLines(
        'e2e/support/message-composer.mts',
        'sendComposerDraft',
      ),
    ).toEqual([{ module: 'e2e/support/message-composer.mts', line: 53 }]);
    expect(helperExpectLines('e2e/support/app.mts', 'waitForSent')).toEqual([
      { module: 'e2e/support/app.mts', line: 178 },
    ]);
    expect(
      helperExpectLines('e2e/support/app.mts', 'openMessageActionSheet'),
    ).toEqual([{ module: 'e2e/support/app.mts', line: 220 }]);
    // The desktop helper reaches its own retrying expect; it stays excluded.
    expect(
      helperExpectLines('e2e/support/app.mts', 'clickRowMenuItem'),
    ).toEqual([{ module: 'e2e/support/app.mts', line: 206 }]);
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
  });

  it('excludes a shadowing local helper and the desktop branch, against a naive count', () => {
    const source = read(predecessor);
    const shadowed = source.replace(
      '    await waitForSent(row.first());',
      '    const waitForSent = async (_row: unknown) => {};\n    await waitForSent(row.first());',
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    expect(locals.map((call) => call.name)).toEqual(['waitForSent']);
    expect(calls.filter((call) => call.name === 'waitForSent')).toHaveLength(0);
    expect(shadowed.match(/\bwaitForSent\(/gu)).toHaveLength(1);
    expect(
      expandDefinition(shadowed, STAGE.span).filter(
        (site) => site.helper === 'waitForSent',
      ),
    ).toHaveLength(0);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
    // Without branch selection the desktop menu would add a site.
    const naive = [
      ...expandDefinition(source, STAGE.span),
      ...importedCalls(source).calls.filter(
        (call) => call.name === 'clickRowMenuItem',
      ),
    ];
    expect(naive).toHaveLength(12);
    expect(expandDefinition(source, STAGE.span)).toHaveLength(11);
  });

  it('expands 1 Room + 1 composer-send + 1 real-server echo + 1 sheet readiness = 4 inherited sites', () => {
    const inherited = expandDefinition(read(predecessor), STAGE.span).filter(
      (site) => site.kind === 'inherited',
    );
    expect(inherited.map(siteTuple)).toEqual([
      ['inherited', 23, 'openRoom', 59],
      ['inherited', 53, 'sendComposerDraft', 63],
      ['inherited', 178, 'waitForSent', 66],
      ['inherited', 220, 'openMessageActionSheet', 70],
    ]);
  });

  it('matches the contract sites, identities and helper roles exactly', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    const expanded = expandDefinition(source, STAGE.span);
    const [stage] = contract.MESSAGE_SOURCE_STAGES;
    expect(stage.sites.map(siteTuple)).toEqual(expanded.map(siteTuple));
    expect(stage.assertions).toEqual(ALL_IDENTITIES);
    expect(stage.sites.map(siteTuple)).not.toEqual(
      expanded.slice(0, -1).map(siteTuple),
    );
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_SOURCE_HELPERS,
    ))
      expect(
        helperExpectLines(
          module,
          helper,
          module === predecessor ? source : undefined,
        ),
      ).toEqual(expectLines.map((line) => ({ module, line })));
    expect(
      Object.fromEntries(
        Object.entries(contract.MESSAGE_SOURCE_HELPERS).map(([name, value]) => [
          name,
          value.role,
        ]),
      ),
    ).toEqual({
      openRoom: 'room-readiness',
      sendComposerDraft: 'composer-send-readiness',
      waitForSent: 'real-server-echo',
      openMessageActionSheet: 'action-sheet-readiness',
    });
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

describe('Android message-source contract ledger', () => {
  it('owns one stage, 7 direct + 4 inherited = 11 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_SOURCE_STAGES.map((entry) => entry.id)).toEqual([
      STAGE.id,
    ]);
    const [stage] = contract.MESSAGE_SOURCE_STAGES;
    expect(stage.source).toBe(`${predecessor}:31-105`);
    expect(stage.title).toBe(STAGE.title);
    expect(stage.expectedAssertionRecords).toBe(11);
    expect(contract.MESSAGE_SOURCE_ASSERTION_RECORDS).toBe(11);
    expect(contract.MESSAGE_SOURCE_DIRECT).toBe(7);
    expect(contract.MESSAGE_SOURCE_INHERITED).toBe(4);
    expect(contract.MESSAGE_SOURCE_HELPER_COUNTS).toEqual({
      openRoom: 1,
      sendComposerDraft: 1,
      waitForSent: 1,
      openMessageActionSheet: 1,
    });
    expect(new Set(ALL_IDENTITIES).size).toBe(11);
    // The issue's 10 identities are the 11 without the Send-button wait.
    expect(
      stage.sites.filter(
        (site) => site.kind === 'direct' || site.helper !== 'sendComposerDraft',
      ),
    ).toHaveLength(10);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    expect(() =>
      contract.assertMessageSourceRecords(STAGE.id, ALL_IDENTITIES),
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
        contract.assertMessageSourceRecords(STAGE.id, invalid),
      ).toThrow();
    expect(() =>
      contract.messageSourceAssertion(STAGE.id, 'not-owned'),
    ).toThrow();
    expect(() =>
      contract.messageSourceAssertion('not-a-stage', 'room-ready'),
    ).toThrow();
  });

  it('types exactly the predecessor run suffix, Room name and body', async () => {
    const contract = await loadContract();
    expect(predecessorTemplates(read(predecessor), STAGE.span)).toMatchObject({
      runId: "`${testResourceId('run')}src`",
      roomName: '`Source ${runId}`',
      body: '`inspect me ${runId}`',
    });
    expect(contract.MESSAGE_SOURCE_RUN_SUFFIX).toBe('src');
    expect(contract.sourceRoomName('r-1src')).toBe('Source r-1src');
    expect(contract.sourceBody('r-1src')).toBe('inspect me r-1src');
    expect(contract.SOURCE_EVENT_TYPE).toBe('m.room.message');
    expect(contract.BODY_SENTINEL).toBe('1');
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertMessageSourceReceiptName } = await loadContract();
    for (const name of [
      'native-draft',
      'message-event',
      'view-source-picked',
      'surface-over-conversation',
    ])
      expect(() => assertMessageSourceReceiptName(name)).not.toThrow();
    for (const name of [
      'message-source.view-source.room-ready',
      'message-source-x',
      'Message Event',
      'a/b',
      '',
    ])
      expect(() => assertMessageSourceReceiptName(name)).toThrow();
  });

  it('pins the product View-source dialog, sheet and raw-event surfaces the journey relies on', () => {
    const component = read(
      'libs/feature/rooms/src/lib/message-source/message-source.component.ts',
    );
    for (const hook of [
      'trnOverlaySurface',
      'data-testid="message-source"',
      'data-testid="message-source-json"',
      '>{{ source() }}</pre>',
    ])
      expect(component).toContain(hook);
    const service = read(
      'libs/feature/rooms/src/lib/message-source/message-source.service.ts',
    );
    expect(service).toContain(
      'inputs: { source: JSON.stringify(raw, null, 2) },',
    );
    expect(service).toContain("ariaLabel: 'Message source',");
    const timeline = read(
      'libs/data-access/timeline/src/lib/timeline.service.ts',
    );
    expect(timeline).toContain('return event?.getEffectiveEvent() ?? null;');
    const list = read(
      'libs/feature/rooms/src/lib/message-list/message-list-base.ts',
    );
    expect(list).toContain(
      "case 'view-source':\n        this.sourceSvc.open(this.roomId() ?? '', row.id);",
    );
    const sheet = read(
      'libs/feature/rooms/src/lib/message-actions/message-action-sheet.service.ts',
    );
    for (const hook of [
      "testId: 'sheet-forward',",
      "testId: 'sheet-view-source',",
      "handler: act('view-source'),",
      "'Message actions',",
    ])
      expect(sheet).toContain(hook);
    expect(sheet.indexOf("testId: 'sheet-view-source',")).toBeGreaterThan(
      sheet.indexOf("testId: 'sheet-forward',"),
    );
    const surface = read(
      'libs/components/overlay/src/lib/action-sheet/trn-action-sheet.component.ts',
    );
    expect(surface).toContain('data-testid="action-sheet-surface"');
    expect(surface).toContain('[attr.data-testid]="button.testId"');
    const recipe = read(
      'libs/components/overlay/src/lib/surface/trn-overlay-surface-recipe.ts',
    );
    expect(recipe).toContain(
      "'block overflow-hidden border border-solid shadow-overlay',",
    );
    const row = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.html',
    );
    for (const hook of ['class="msg msg--event"', '[attr.data-mid]="r.id"'])
      expect(row).toContain(hook);
  });
});

/* ------------------------------------------------------------------------ */
/* Authoritative event and dialog JSON                                       */
/* ------------------------------------------------------------------------ */

const ROOM = '!Source_Ab+c/d:localhost';
const SENDER = '@trn_source_view_source_0a1b2c:localhost';
const EVENT_ID = '$Source_A+b/C=d';
const OTHER_ID = '$Other_E+f/G=h';
const RUN = 'trn-source-view-source-0a1b2csrc';
const BODY = `inspect me ${RUN}`;
const ROOM_NAME = `Source ${RUN}`;
const CONTENT = { msgtype: 'm.text', body: BODY, 'm.mentions': {} };
const EXPECTED = {
  eventId: EVENT_ID,
  roomId: ROOM,
  sender: SENDER,
  body: BODY,
};

const serverEvent = (overrides = {}, content = CONTENT) => ({
  type: 'm.room.message',
  event_id: EVENT_ID,
  room_id: ROOM,
  sender: SENDER,
  origin_server_ts: 1_700_000_000_000,
  content,
  unsigned: { age: 12 },
  ...overrides,
});
const messagesPage = (...events) => ({
  chunk: [
    ...events,
    {
      type: 'm.room.create',
      event_id: '$create',
      room_id: ROOM,
      sender: SENDER,
      state_key: '',
      content: {},
    },
  ].reverse(),
  start: 's',
  end: 'e',
});
/** The raw effective event the product renders with `JSON.stringify(raw, null, 2)`. */
const rawEvent = (overrides = {}, content = CONTENT) =>
  JSON.stringify(
    {
      type: 'm.room.message',
      content,
      sender: SENDER,
      origin_server_ts: 1_700_000_000_000,
      unsigned: { transaction_id: 'm1700.1', age: 3 },
      event_id: EVENT_ID,
      room_id: ROOM,
      ...overrides,
    },
    null,
    2,
  );

describe('Android message-source authoritative event contract', () => {
  it('reads every Room message of the page, oldest first', async () => {
    const { authoritativeRoomMessages } = await loadContract();
    expect(
      authoritativeRoomMessages(
        messagesPage(serverEvent({ event_id: '$b' }), serverEvent()),
      ).map((event) => event.event_id),
    ).toEqual(['$b', EVENT_ID]);
    for (const malformed of [null, {}, { chunk: {} }, { chunk: [null] }])
      expect(() => authoritativeRoomMessages(malformed)).toThrow();
  });

  it('requires exactly the one native send as an original m.text from the active sender', async () => {
    const { assertSourceRoom, authoritativeRoomMessages } =
      await loadContract();
    const check = (...events) =>
      assertSourceRoom(
        authoritativeRoomMessages(messagesPage(...events)),
        EXPECTED,
      );
    expect(check(serverEvent())).toMatchObject({ event_id: EVENT_ID });
    for (const events of [
      [],
      [serverEvent(), serverEvent({ event_id: OTHER_ID })],
      [serverEvent({ event_id: '~!Source:txn1' })],
      [serverEvent({ event_id: OTHER_ID })],
      [serverEvent({ room_id: '!other:localhost' })],
      [serverEvent({ sender: '@other:localhost' })],
      [serverEvent({}, { ...CONTENT, body: `${BODY} ` })],
      [serverEvent({}, { ...CONTENT, msgtype: 'm.notice' })],
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

const SURFACE_BOX = { left: 16, top: 120, right: 377, bottom: 560 };
const SCROLL_BOX = { left: 0, top: 56, right: 393, bottom: 640 };
const OPAQUE_PAINT = {
  backgroundColor: 'oklch(0.21 0.006 285.885)',
  borderTopWidth: '1px',
  borderTopStyle: 'solid',
  // As measured on the device: Tailwind's four transparent ring layers, then the shadow.
  boxShadow:
    'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklch(0 0 0 / 0.18) 0px 12px 32px 0px',
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
const dialogHtml = (json = rawEvent(), extra = '') =>
  `<div class="cdk-overlay-container"><div class="cdk-overlay-pane"><div role="dialog" aria-label="Message source" class="cdk-dialog-container"><div data-testid="message-source" data-trn-variant="neutral" class="block border border-solid shadow-overlay"><h2>Message source</h2><pre data-testid="message-source-json">${escapeHtml(json)}</pre>${extra}<div><button>Copy</button><button>Close</button></div></div></div></div></div>`;
const conversationHtml = () =>
  `<div class="scroll"><div class="msg" data-mid="${EVENT_ID}"><p class="msg__text">${escapeHtml(BODY)}</p></div></div>`;

/**
 * A jsdom document with measured boxes, the surface's own computed paint and a
 * hit test, so the observer's exact expression text runs against it.
 */
function paintedWindow(body, options = {}) {
  const dom = new JSDOM(`<main>${body}</main>`, {
    url: 'https://localhost/rooms/x',
  });
  const { window } = dom;
  const surfaceBox = options.surfaceBox ?? SURFACE_BOX;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (/display:\s*none/u.test(this.getAttribute('style') ?? ''))
      return rect({ left: 0, top: 0, right: 0, bottom: 0 });
    if (this.matches('[data-testid="message-source"]')) return rect(surfaceBox);
    if (this.matches('.scroll')) return rect(options.scrollBox ?? SCROLL_BOX);
    return rect({ left: 0, top: 0, right: 120, bottom: 20 });
  };
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => {
    const style = computed(element);
    const paint = element.matches('[data-testid="message-source"]')
      ? { ...OPAQUE_PAINT, ...options.paint }
      : {
          backgroundColor: 'rgba(0, 0, 0, 0)',
          borderTopWidth: '0px',
          borderTopStyle: 'none',
          boxShadow: 'none',
        };
    return {
      ...style,
      ...paint,
      visibility:
        element.closest('[style*="visibility:hidden"]') !== null
          ? 'hidden'
          : 'visible',
    };
  };
  window.matchMedia = (query) => ({
    matches: query === '(hover: none)' || query === '(pointer: coarse)',
  });
  window.Capacitor = { getPlatform: () => 'android' };
  window.document.elementFromPoint = () =>
    options.covered
      ? window.document.querySelector('.scroll')
      : window.document.querySelector('[data-testid="message-source-json"]');
  return window;
}

function evaluateIn(body, expression, options = {}) {
  const window = paintedWindow(body, options);
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

describe('Android message-source dialog JSON and paint (jsdom)', () => {
  it('observes one dialog and parses its JSON as exactly the authoritative event', async () => {
    const contract = await loadContract();
    const { sourceExpression } = await loadObserver();
    const observe = (body, options) =>
      contract.parseSourceDialog(evaluateIn(body, sourceExpression(), options));
    const view = observe(`${conversationHtml()}${dialogHtml()}`);
    expect(view).toMatchObject({
      dialogs: 1,
      surfaces: 1,
      surfaceVisible: true,
      surfaceInDialog: true,
      jsonElements: 1,
      sheets: 0,
      centerInside: true,
    });
    expect(view.json).toBe(rawEvent());
    const authoritative = serverEvent();
    expect(() => contract.assertDialogVisible(view)).not.toThrow();
    expect(
      contract.assertJsonEvent(view, authoritative, EXPECTED).event_id,
    ).toBe(EVENT_ID);
    expect(() =>
      contract.assertJsonBody(view, authoritative, EXPECTED),
    ).not.toThrow();
    // Each field drifting, alone, fails; the fields are compared, not searched.
    const fieldDrifts = [
      rawEvent({ event_id: OTHER_ID }),
      rawEvent({ event_id: '~!Source:txn1' }),
      rawEvent({ event_id: undefined }),
      rawEvent({ type: 'm.room.encrypted' }),
      rawEvent({ sender: '@other:localhost' }),
      rawEvent({ room_id: '!other:localhost' }),
      // The generic text is still present, but only as a substring.
      `${rawEvent({ type: 'm.sticker' })}\n"m.room.message"`,
      `m.room.message ${BODY} ${EVENT_ID} ${SENDER} ${ROOM}`,
      JSON.stringify([JSON.parse(rawEvent())]),
      '',
      'null',
      `${rawEvent()},`,
    ];
    for (const json of fieldDrifts) {
      const drifted = observe(`${conversationHtml()}${dialogHtml(json)}`);
      expect(
        () => contract.assertJsonEvent(drifted, authoritative, EXPECTED),
        json,
      ).toThrow();
    }
    // The body and content: exact, never merely containing the body.
    for (const content of [
      { ...CONTENT, body: `${BODY} and more` },
      { ...CONTENT, body: BODY.toUpperCase() },
      { ...CONTENT, formatted_body: BODY },
      { msgtype: 'm.text', body: BODY },
      { ...CONTENT, msgtype: 'm.notice' },
    ]) {
      const drifted = observe(
        `${conversationHtml()}${dialogHtml(rawEvent({}, content))}`,
      );
      expect(() =>
        contract.assertJsonEvent(drifted, authoritative, EXPECTED),
      ).not.toThrow();
      expect(
        () => contract.assertJsonBody(drifted, authoritative, EXPECTED),
        JSON.stringify(content),
      ).toThrow();
    }
    // Each check stands on its own, even where a neighbour would also fail.
    expect(() =>
      contract.assertDialogVisible({ ...view, surfaces: 2 }),
    ).toThrow();
    expect(() =>
      contract.assertDialogVisible({ ...view, sheets: 1 }),
    ).toThrow();
    for (const json of [
      JSON.stringify([JSON.parse(rawEvent())]),
      'null',
      '"x"',
    ])
      expect(() => contract.parseSourceJson({ ...view, json }), json).toThrow();
    // Server and dialog agree on a body that is not the native one.
    const otherBody = { ...CONTENT, body: 'inspect me other' };
    expect(() =>
      contract.assertJsonBody(
        observe(`${conversationHtml()}${dialogHtml(rawEvent({}, otherBody))}`),
        serverEvent({}, otherBody),
        EXPECTED,
      ),
    ).toThrow();
    // The dialog agreeing with itself is not enough: the server event decides.
    expect(() =>
      contract.assertJsonEvent(
        view,
        serverEvent({ event_id: OTHER_ID }),
        EXPECTED,
      ),
    ).toThrow();
    expect(() =>
      contract.assertJsonBody(
        view,
        serverEvent({}, { ...CONTENT, body: 'other' }),
        EXPECTED,
      ),
    ).toThrow();
  });

  it('rejects a missing, doubled, hidden or sheet-covered dialog', async () => {
    const contract = await loadContract();
    const { sourceExpression } = await loadObserver();
    const observe = (body) =>
      contract.parseSourceDialog(evaluateIn(body, sourceExpression()));
    const sheet =
      '<div role="dialog" aria-label="Message actions"><button data-testid="sheet-view-source">View source</button></div>';
    for (const body of [
      conversationHtml(),
      `${conversationHtml()}${dialogHtml()}${dialogHtml()}`,
      `${conversationHtml()}${dialogHtml().replace('data-testid="message-source" ', 'data-testid="message-source" style="visibility:hidden" ')}`,
      `${conversationHtml()}${dialogHtml().replace('<pre data-testid="message-source-json">', '<pre>')}`,
      `${conversationHtml()}${dialogHtml(rawEvent(), '<pre data-testid="message-source-json">{}</pre>')}`,
      `${conversationHtml()}${dialogHtml().replace('aria-label="Message source"', 'aria-label="Forward message"')}`,
      `${conversationHtml()}${dialogHtml().replace('role="dialog" aria-label="Message source" ', '')}<div role="dialog" aria-label="Message source"></div>`,
      `${conversationHtml()}${dialogHtml()}${sheet}`,
    ])
      expect(() => contract.assertDialogVisible(observe(body)), body).toThrow();
  });

  it('counts only the box-shadow layers that paint', async () => {
    const { visibleShadowLayers } = await loadContract();
    for (const [shadow, visible] of [
      [OPAQUE_PAINT.boxShadow, 1],
      ['none', 0],
      ['rgba(0, 0, 0, 0.3) 0px 1px 2px 0px', 1],
      [
        'rgba(0, 0, 0, 0.3) 0px 1px 2px 0px, rgb(0 0 0 / 0.1) 0px 4px 8px -2px',
        2,
      ],
      ['rgba(0, 0, 0, 0.3) 0px 0px 0px 1px inset', 1],
      ['rgba(0, 0, 0, 0) 0px 12px 32px 0px', 0],
      ['rgba(0, 0, 0, 0.5) 0px 0px 0px 0px', 0],
      ['transparent 0px 4px 8px 0px', 0],
    ])
      expect(visibleShadowLayers(shadow), shadow).toBe(visible);
    for (const shadow of [
      'var(--tw-shadow)',
      '0px 4px 8px 0px',
      'rgba(0, 0, 0, 0.3) 4px',
      'rgba(0, 0, 0, 0.3) 0px 1px 2px 3px 4px',
      'rgba(0, 0, 0, 0.3) 0px 1em 2px',
    ])
      expect(visibleShadowLayers(shadow), shadow).toBeNull();
  });

  it('parses every computed colour syntax and accepts only alpha exactly 1', async () => {
    const { cssColorAlpha } = await loadContract();
    for (const [color, alpha] of [
      ['rgb(24, 24, 27)', 1],
      ['rgba(24, 24, 27, 1)', 1],
      ['rgb(24 24 27)', 1],
      ['rgb(24 24 27 / 1)', 1],
      ['rgb(24 24 27 / 100%)', 1],
      ['oklch(0.21 0.006 285.885)', 1],
      ['oklch(0.21 0.006 285.885 / 1)', 1],
      ['color(srgb 0.1 0.1 0.1)', 1],
      ['hsl(240, 5%, 10%)', 1],
      ['rgba(0, 0, 0, 0)', 0],
      ['transparent', 0],
      ['rgba(24, 24, 27, 0.95)', 0.95],
      ['rgb(24 24 27 / 0.5)', 0.5],
      ['rgb(24 24 27 / 50%)', 0.5],
      ['oklch(0.21 0.006 285.885 / 0.9)', 0.9],
      ['color(srgb 0.1 0.1 0.1 / 0.8)', 0.8],
      ['hsla(240, 5%, 10%, 0.2)', 0.2],
    ])
      expect(cssColorAlpha(color), color).toBe(alpha);
    for (const color of [
      '',
      'var(--trinity-surface-raised)',
      'rgb(24, 24)',
      'rgb(24 24)',
      'rgba(1, 2, 3, 4, 5)',
      'rgb(1 2 3 / 0.5 / 1)',
      'rgb(1 2 3 / x)',
      'url(a.png)',
      'color(srgb 0.1 0.1)',
      'red',
    ])
      expect(cssColorAlpha(color), color).toBeNull();
    // The predecessor's own rule would pass a bare three-channel alpha-bearing form.
    expect('oklch(0.21 0.006 285.885 / 0.5)'.match(/[\d.]+/g)).toHaveLength(4);
    expect(cssColorAlpha('oklch(0.21 0.006 / 0.5)')).toBe(0.5);
  });

  it('proves an opaque, bordered, shadowed surface over the conversation, and rejects each loss', async () => {
    const contract = await loadContract();
    const { sourceExpression } = await loadObserver();
    const body = `${conversationHtml()}${dialogHtml()}`;
    const observe = (options) =>
      contract.parseSourceDialog(evaluateIn(body, sourceExpression(), options));
    const good = observe();
    expect(contract.assertSurfaceOpaque(good)).toBe(1);
    expect(contract.assertSurfaceBorder(good)).toBe(1);
    expect(() => contract.assertSurfaceShadow(good)).not.toThrow();
    expect(contract.assertSurfaceOverConversation(good).box).toMatchObject({
      width: 361,
      height: 440,
    });
    for (const backgroundColor of [
      'rgba(0, 0, 0, 0)',
      'transparent',
      'rgba(24, 24, 27, 0.99)',
      'rgb(24 24 27 / 0.5)',
      'oklch(0.21 0.006 285.885 / 95%)',
      'var(--trinity-surface-raised)',
    ])
      expect(
        () =>
          contract.assertSurfaceOpaque(observe({ paint: { backgroundColor } })),
        backgroundColor,
      ).toThrow();
    for (const paint of [
      { borderTopWidth: '0px' },
      { borderTopWidth: 'medium' },
      { borderTopWidth: '' },
      { borderTopStyle: 'none' },
      { borderTopStyle: 'hidden' },
    ])
      expect(
        () => contract.assertSurfaceBorder(observe({ paint })),
        JSON.stringify(paint),
      ).toThrow();
    expect(contract.assertSurfaceShadow(good)).toBe(1);
    for (const boxShadow of [
      'none',
      '',
      // Only Tailwind's transparent ring layers: no shadow paints.
      'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px',
      'oklch(0 0 0 / 0) 0px 12px 32px 0px',
      'rgba(0, 0, 0, 0.2) 0px 0px 0px 0px',
      'var(--shadow)',
    ])
      expect(
        () => contract.assertSurfaceShadow(observe({ paint: { boxShadow } })),
        boxShadow,
      ).toThrow();
    // Off the conversation, covered at its centre, zero-size or non-finite.
    for (const options of [
      { scrollBox: { left: 0, top: 600, right: 393, bottom: 640 } },
      { scrollBox: { left: 0, top: 0, right: 0, bottom: 0 } },
      { covered: true },
      { surfaceBox: { ...SURFACE_BOX, left: Number.NaN } },
    ])
      for (const assertPaint of [
        contract.assertSurfaceOpaque,
        contract.assertSurfaceBorder,
        contract.assertSurfaceShadow,
      ])
        expect(
          () => assertPaint(observe(options)),
          JSON.stringify(options),
        ).toThrow();
    const zero = observe({ surfaceBox: { ...SURFACE_BOX, bottom: 120 } });
    expect(() => contract.assertDialogVisible(zero)).toThrow();
    expect(() => contract.assertSurfaceOpaque(zero)).toThrow();
    // Two conversation scrollers are not one measured conversation.
    const twoScrollers = contract.parseSourceDialog(
      evaluateIn(`${conversationHtml()}${body}`, sourceExpression()),
    );
    expect(() => contract.assertSurfaceOpaque(twoScrollers)).toThrow();
  });

  it('parses only complete dialog observations', async () => {
    const contract = await loadContract();
    const { sourceExpression } = await loadObserver();
    const view = evaluateIn(
      `${conversationHtml()}${dialogHtml()}`,
      sourceExpression(),
    );
    for (const malformed of [
      null,
      { ...view, dialogs: -1 },
      { ...view, json: 1 },
      { ...view, box: { left: 1 } },
      { ...view, paint: { backgroundColor: 'rgb(0, 0, 0)' } },
      { ...view, centerInside: 'yes' },
    ])
      expect(() => contract.parseSourceDialog(malformed)).toThrow();
    const empty = contract.parseSourceDialog(
      evaluateIn('<main></main>', sourceExpression()),
    );
    expect(empty).toMatchObject({
      dialogs: 0,
      surfaces: 0,
      json: null,
      box: null,
      paint: null,
      centerInside: false,
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Simulated installed app: the exact journey against production-shaped DOM  */
/* ------------------------------------------------------------------------ */

const USER = {
  userId: SENDER,
  username: 'trn_source_view_source_0a1b2c',
  password: 'source-pass"word\\token',
  homeserver: 'https://localhost:8448',
};
const ROUTE = `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}?account=${encodeURIComponent(SENDER)}&view=rooms`;
const SHEET_SCROLL_BOX = { left: 0, top: 300, right: 393, bottom: 727 };

/**
 * A model of the installed app, its Synapse Room and Gboard. The DOM is
 * rendered in production shape and every observer expression runs against it
 * in jsdom; native actions resolve their target as the client does (exactly
 * one match) and the server holds the events the product would send. A settled
 * state aborts instead of waiting.
 */
function simulatedSourceApp(faults = {}) {
  const controller = new AbortController();
  const state = {
    signedIn: false,
    roomsShown: false,
    roomOpen: false,
    composer: { value: '', start: 0, end: 0, focused: false },
    sheet: null,
    sheetScroll: 0,
    dialog: false,
    rows: [],
    events: [],
    actions: [],
    written: [],
  };
  let lastSignature = '';
  let stale = 0;
  const progress = () => {
    for (const row of state.rows) {
      if (!row.id.startsWith('~') || faults.echoNever) continue;
      if (--row.echoIn > 0) continue;
      row.id = EVENT_ID;
      const content = { msgtype: 'm.text', body: row.body, 'm.mentions': {} };
      if (faults.serverBodyDrift) content.body = `${row.body}!`;
      if (faults.serverRelation)
        content['m.relates_to'] = { rel_type: 'm.thread', event_id: '$root' };
      state.events.push(serverEvent({}, content));
      if (faults.extraSeeded)
        state.events.push(serverEvent({ event_id: OTHER_ID }, content));
    }
  };
  const composerSelector = '[data-testid="composer-input"]';
  const dialogJson = () => {
    const content = state.events[0]?.content ?? CONTENT;
    if (faults.jsonInvalid) return `${rawEvent({}, content)},`;
    if (faults.jsonArray)
      return JSON.stringify([JSON.parse(rawEvent({}, content))]);
    if (faults.jsonTextOnly)
      return `m.room.message ${content.body} ${EVENT_ID} ${SENDER} ${ROOM}`;
    const overrides = {
      ...(faults.jsonEventId ? { event_id: '~!Source:txn1' } : {}),
      ...(faults.jsonOtherEvent ? { event_id: OTHER_ID } : {}),
      ...(faults.jsonType ? { type: 'm.room.encrypted' } : {}),
      ...(faults.jsonSender ? { sender: '@other:localhost' } : {}),
      ...(faults.jsonRoom ? { room_id: '!other:localhost' } : {}),
    };
    const shown = faults.jsonBodyContains
      ? { ...content, body: `${content.body} and more` }
      : faults.jsonContentExtra
        ? { ...content, formatted_body: content.body }
        : content;
    return rawEvent(overrides, shown);
  };
  const sheetButtons = () =>
    [
      '<button data-testid="sheet-reply">Reply</button>',
      '<button data-testid="sheet-react-more">More reactions…</button>',
      '<button data-testid="sheet-quote">Quote</button>',
      '<button data-testid="sheet-copy">Copy text</button>',
      '<button data-testid="sheet-copy-link">Copy link</button>',
      '<button data-testid="sheet-forward">Forward</button>',
      faults.sheetNoViewSource
        ? ''
        : '<button data-testid="sheet-view-source">View source</button>',
      '<button data-testid="sheet-report">Report message</button>',
      '<button>Cancel</button>',
    ].join('');
  const sheetHtml = () =>
    `<div role="dialog" aria-label="Message actions"><div data-testid="action-sheet-surface"><div class="overflow-y-auto">${sheetButtons()}</div></div></div>`;
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
      parts.push(
        '<div class="scroll"><div class="msg msg--event" data-mid="$create"><span class="msg__event-text">created the room</span></div>',
      );
      for (const row of state.rows)
        parts.push(
          `<div class="msg" data-mid="${escapeHtml(row.id)}"><div class="msg__body"><div class="msg__content"><div class="msg__head"><span class="msg__author">source</span></div><p class="msg__text">${escapeHtml(row.body)}</p></div></div></div>`,
        );
      parts.push('</div>');
      parts.push(
        `<trn-message-composer><textarea data-testid="composer-input" placeholder="${escapeHtml(`Message #${ROOM_NAME}`)}"></textarea><button data-testid="composer-send"${state.composer.value.trim() ? '' : ' disabled'}>Send</button></trn-message-composer>`,
      );
    }
    if (state.sheet) {
      parts.push(sheetHtml());
      if (faults.twoSheets) parts.push(sheetHtml());
    }
    if (state.dialog && !faults.dialogMissing) {
      const html = dialogHtml(dialogJson());
      parts.push(
        faults.dialogHidden
          ? html.replace(
              'data-testid="message-source" ',
              'data-testid="message-source" style="visibility:hidden" ',
            )
          : html,
      );
      if (faults.twoDialogs) parts.push(html);
    }
    return parts.join('');
  };
  const viewSourceBox = () => {
    // One native swipe brings View source inside the sheet scroller.
    const top =
      state.sheetScroll >= 1 && !faults.viewSourceUnreachable ? 520 : 760;
    return { left: 0, top, right: 393, bottom: top + 48 };
  };
  const dom = () => {
    const window = paintedWindow(`${render()}`, {
      paint: faults.paint,
      covered: faults.covered,
      scrollBox: faults.offConversation
        ? { left: 0, top: 600, right: 393, bottom: 640 }
        : undefined,
    });
    const base = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.matches('[data-testid="sheet-view-source"]'))
        return rect(viewSourceBox());
      if (this.matches('.overflow-y-auto')) return rect(SHEET_SCROLL_BOX);
      return base.call(this);
    };
    // The route of the opened Room.
    if (state.roomOpen) window.history.replaceState(null, '', ROUTE);
    const input = window.document.querySelector(composerSelector);
    if (input) {
      input.value = state.composer.value;
      input.setSelectionRange(state.composer.start, state.composer.end);
      if (state.composer.focused) input.focus();
    }
    return window;
  };
  const settle = () => {
    progress();
    const signature = JSON.stringify([
      render(),
      state.events,
      state.composer,
      state.sheetScroll,
    ]);
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
    matches(selector, filter).map((element) => {
      const box = element.getBoundingClientRect();
      return {
        text: element.textContent?.trim() ?? '',
        visible: true,
        focused: state.composer.focused && element.matches(composerSelector),
        disabled: element.matches(':disabled'),
        value: 'value' in element ? element.value : null,
        unobstructedCenter: box.bottom <= 727,
        rect: {
          x: box.left,
          y: box.top,
          width: box.width,
          height: box.height,
          bottom: box.bottom,
          right: box.right,
        },
        scrollHeight: 800,
        clientHeight: 427,
      };
    });
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
      else if (testId === 'composer-send') {
        state.rows.push({
          id: '~!Source:txn1',
          echoIn: 2,
          body: state.composer.value,
        });
        state.composer = { value: '', start: 0, end: 0, focused: false };
      } else if (testId === 'sheet-view-source') {
        if (viewSourceBox().bottom > SHEET_SCROLL_BOX.bottom)
          throw new Error('View source is not reachable');
        if (!faults.sheetStaysOpen) state.sheet = null;
        state.dialog = true;
      } else throw new Error(`Unmodelled simulated tap ${selector}`);
    },
    async focusCurrent(selector) {
      state.actions.push(`focus:${selector}`);
      actionable(selector, {});
      state.composer.focused = true;
    },
    async fillFocused(selector, value, sentinel = 'x') {
      state.actions.push(`fill:${selector}|${sentinel}`);
      assert.equal(selector, composerSelector);
      assert(state.composer.focused, `${selector} is focused before the fill`);
      assert.equal(state.composer.value, '', 'The focused fill starts empty');
      // Android capitalises a letter typed into an empty field; a letter
      // sentinel joined to the first word is autocorrected (`x` + `plain`
      // became `Explain`); a digit-led word is kept.
      let typed = `${sentinel}${value}`;
      if (/^\p{L}$/u.test(sentinel))
        typed = `E${typed.toLowerCase().slice(0, 1)}${typed.slice(1)}`;
      else if (/^[a-z]/u.test(typed))
        typed = `${typed[0].toUpperCase()}${typed.slice(1)}`;
      state.composer.value = typed.slice(1);
      state.composer.start = state.composer.end = state.composer.value.length;
    },
    async longPressCurrent(selector, filter = {}) {
      state.actions.push(
        `long-press:${selector}${filter.text ? `|${filter.text}` : ''}`,
      );
      const found = matches(selector, filter);
      if (found.length !== 1)
        throw new Error(`Simulated long press needs one target: ${selector}`);
      const mid = found[0].closest('.msg').getAttribute('data-mid');
      state.pressed = mid;
      if (!faults.sheetMissing) state.sheet = { id: mid };
      state.sheetScroll = 0;
    },
    async swipeCurrent(selector, options) {
      state.actions.push(`swipe:${selector}|${options.direction}`);
      state.sheetScroll++;
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
  return { client, fixtures, state, controller };
}

async function simulatedStage(faults = {}) {
  const { MESSAGE_SOURCE_STAGES } = await loadContract();
  const app = simulatedSourceApp(faults);
  const context = {
    entry: MESSAGE_SOURCE_STAGES[0],
    records: [],
    identities: new Set(),
    receipts: 0,
    client: app.client,
    fixtures: app.fixtures,
    secrets: {},
    safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
    native: false,
    ledger: { run: RUN, texts: [], eventIds: [] },
  };
  return { ...app, context };
}

const COMPOSER = '[data-testid="composer-input"]';
const READY_ROW = '.scroll .msg[data-mid^="$"]';
const SHEET_SCROLL =
  '[role="dialog"][aria-label="Message actions"] [data-testid="action-sheet-surface"] .overflow-y-auto';
const STAGE_ACTIONS = [
  'rest-account:source-view-source',
  'rest-create-room',
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|${ROOM_NAME}`,
  `focus:${COMPOSER}`,
  `fill:${COMPOSER}|1`,
  'hide-keyboard',
  'tap:[data-testid="composer-send"]',
  'hide-keyboard',
  `long-press:${READY_ROW}|${BODY}`,
  `swipe:${SHEET_SCROLL}|increase-scroll-top`,
  'tap:[data-testid="sheet-view-source"]',
];

/** Written evidence carries digests and booleans, never an identifier or credential. */
function assertIdFreeEvidence(state, secrets) {
  const written = JSON.stringify(state.written);
  for (const value of secrets) expect(written).not.toContain(value);
  // Selectors reach the job log: none carries an identifier.
  for (const action of state.actions)
    expect(action.split('|')[0]).not.toMatch(
      /[$!~@][A-Za-z0-9_]|data-mid[*~|]?=|trn[-_]/u,
    );
}

describe('Android message-source native journey against a simulated installed app', () => {
  it('drives the exact native sequence and records all eleven identities in order', async () => {
    const { runViewSource } = await loadJourneys();
    const { PIXEL_5_ACCOUNT_PROFILE } = await loadClient();
    const { context, state } = await simulatedStage();
    await runViewSource(context);
    expect(context.records).toEqual(ALL_IDENTITIES);
    expect(state.actions).toEqual(STAGE_ACTIONS);
    expect(state.profile).toBe(PIXEL_5_ACCOUNT_PROFILE);
    expect(state.roomContent).toEqual({
      name: ROOM_NAME,
      preset: 'private_chat',
    });
    expect(state.pressed).toBe(EVENT_ID);
    expect(state.events.map((event) => event.content.body)).toEqual([BODY]);
    expect(context.ledger.eventIds).toEqual([EVENT_ID]);
    expect(context.ledger.texts).toEqual([BODY]);
    expect(
      state.written
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('receipt-')),
    ).toEqual([
      'receipt-01-native-draft',
      'receipt-02-native-sent',
      'receipt-03-message-event',
      'receipt-04-view-source-picked',
      'receipt-05-surface-over-conversation',
    ]);
    const event = state.written.find(
      (entry) => entry.name === identity('json-event'),
    );
    expect(event.value.observation).toMatchObject({
      parsedObject: true,
      eventDigest: sha256(EVENT_ID),
      roomDigest: sha256(ROOM),
      senderDigest: sha256(SENDER),
      exactFields: ['event_id', 'type', 'sender', 'room_id'],
    });
    const opaque = state.written.find(
      (entry) => entry.name === identity('surface-opaque'),
    );
    expect(opaque.value.observation).toEqual({
      backgroundColor: OPAQUE_PAINT.backgroundColor,
      alpha: 1,
    });
    const shadow = state.written.find(
      (entry) => entry.name === identity('surface-shadow'),
    );
    expect(shadow.value.observation).toEqual({
      boxShadow: OPAQUE_PAINT.boxShadow,
      visibleLayers: 1,
    });
    assertIdFreeEvidence(state, [
      ROOM,
      EVENT_ID,
      SENDER,
      USER.password,
      USER.username,
      RUN,
      BODY,
      // No part of the raw event JSON is written.
      'origin_server_ts',
      '"content"',
      'm1700.1',
    ]);
  });

  it('models the typing hazards: a letter sentinel is autocorrected, a bare body is capitalised', async () => {
    const { context, state } = await simulatedStage();
    state.roomOpen = true;
    await context.client.focusCurrent(COMPOSER);
    await context.client.fillFocused(COMPOSER, BODY, 'x');
    expect(state.composer.value).toBe(`x${BODY}`);
    const digit = await simulatedStage();
    digit.state.roomOpen = true;
    await digit.context.client.focusCurrent(COMPOSER);
    await digit.context.client.fillFocused(COMPOSER, BODY, '1');
    expect(digit.state.composer.value).toBe(BODY);
    // A journey that types behind a letter sentinel never reaches Send.
    const letter = await simulatedStage();
    const fill = letter.context.client.fillFocused;
    letter.context.client.fillFocused = (selector, value) =>
      fill(selector, value, 'x');
    const { runViewSource } = await loadJourneys();
    await expect(runViewSource(letter.context)).rejects.toThrow();
    expect(letter.context.records).toEqual([identity('room-ready')]);
  });

  const FAULTS = [
    // Ready event identity.
    ['echoNever', 'server-echo'],
    ['extraSeeded', 'sheet-ready'],
    ['serverBodyDrift', 'sheet-ready'],
    ['serverRelation', 'sheet-ready'],
    // Native sheet and View-source ownership.
    ['sheetMissing', 'sheet-ready'],
    ['twoSheets', 'sheet-ready'],
    ['sheetNoViewSource', 'sheet-ready'],
    ['viewSourceUnreachable', 'dialog-visible'],
    ['sheetStaysOpen', 'dialog-visible'],
    // One visible dialog.
    ['dialogMissing', 'dialog-visible'],
    ['twoDialogs', 'dialog-visible'],
    ['dialogHidden', 'dialog-visible'],
    // Exact parsed JSON fields.
    ['jsonInvalid', 'json-event'],
    ['jsonArray', 'json-event'],
    ['jsonTextOnly', 'json-event'],
    ['jsonEventId', 'json-event'],
    ['jsonOtherEvent', 'json-event'],
    ['jsonType', 'json-event'],
    ['jsonSender', 'json-event'],
    ['jsonRoom', 'json-event'],
    ['jsonBodyContains', 'json-event'],
    ['jsonContentExtra', 'json-event'],
    // Opaque paint over the conversation.
    [{ paint: { backgroundColor: 'rgba(0, 0, 0, 0)' } }, 'surface-opaque'],
    [{ paint: { backgroundColor: 'rgb(24 24 27 / 0.9)' } }, 'surface-opaque'],
    [{ paint: { backgroundColor: 'var(--x)' } }, 'surface-opaque'],
    [{ offConversation: true }, 'surface-opaque'],
    [{ covered: true }, 'surface-opaque'],
    [{ paint: { borderTopWidth: '0px' } }, 'surface-border'],
    [{ paint: { borderTopStyle: 'none' } }, 'surface-border'],
    [{ paint: { boxShadow: 'none' } }, 'surface-shadow'],
    [
      { paint: { boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 0px' } },
      'surface-shadow',
    ],
  ];

  for (const [fault, firstMissing] of FAULTS) {
    const name = typeof fault === 'string' ? fault : JSON.stringify(fault);
    it(`fails before ${firstMissing} when ${name}`, async () => {
      const { runViewSource } = await loadJourneys();
      const faults = typeof fault === 'string' ? { [fault]: true } : fault;
      const { context, state } = await simulatedStage(faults);
      await expect(runViewSource(context)).rejects.toThrow();
      const index = ALL_IDENTITIES.indexOf(identity(firstMissing));
      expect(index).toBeGreaterThan(0);
      expect(context.records).toEqual(ALL_IDENTITIES.slice(0, index));
      // A pending local echo is never long-pressed.
      if (state.pressed !== undefined) expect(state.pressed).toBe(EVENT_ID);
    });
  }

  it('drops the json-event record into json-body when only the content drifts', async () => {
    // jsonBodyContains and jsonContentExtra are collected by the one bounded
    // dialog wait that accepts only the exact body and content; a record of the
    // event fields alone would otherwise pass. Prove the body assertion itself
    // rejects them on the observed dialog.
    const contract = await loadContract();
    const { sourceExpression } = await loadObserver();
    for (const content of [
      { ...CONTENT, body: `${BODY} and more` },
      { ...CONTENT, formatted_body: BODY },
    ]) {
      const view = contract.parseSourceDialog(
        evaluateIn(
          `${conversationHtml()}${dialogHtml(rawEvent({}, content))}`,
          sourceExpression(),
        ),
      );
      expect(() =>
        contract.assertJsonEvent(view, serverEvent(), EXPECTED),
      ).not.toThrow();
      expect(() =>
        contract.assertJsonBody(view, serverEvent(), EXPECTED),
      ).toThrow();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Read-only renderer observation (jsdom)                                    */
/* ------------------------------------------------------------------------ */

describe('Android message-source read-only renderer observation (jsdom)', () => {
  it('observes the exact row, rejects a pending echo, another id or a doubled row', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const row = (id, text = BODY) =>
      `<div class="msg" data-mid="${id}"><p class="msg__text">${escapeHtml(text)}</p></div>`;
    const scroll = (...rows) =>
      `<div class="scroll"><div class="msg msg--event" data-mid="$create">created the room</div>${rows.join('')}</div>`;
    const observe = (body) =>
      contract.parseTimeline(evaluateIn(body, timelineExpression()));
    const view = observe(scroll(row(EVENT_ID)));
    expect(contract.assertSameRow(view, BODY, EVENT_ID).id).toBe(EVENT_ID);
    expect(() =>
      contract.assertServerEcho(observe(scroll(row('~!Source:txn1'))), BODY),
    ).toThrow();
    expect(() =>
      contract.assertRowVisible(observe(scroll(row('~!Source:txn1'))), BODY),
    ).not.toThrow();
    for (const body of [
      scroll(row(OTHER_ID)),
      scroll(row(EVENT_ID), row(OTHER_ID)),
      scroll(row(EVENT_ID, 'inspect me other')),
      `${scroll()}${row(EVENT_ID)}`,
    ])
      expect(() =>
        contract.assertSameRow(observe(body), BODY, EVENT_ID),
      ).toThrow();
    // The id-free long-press selector and filter match exactly the ready row.
    const dom = new JSDOM(
      `<main>${scroll(row('~!Source:txn0', 'inspect me earlier'), row(EVENT_ID))}</main>`,
    );
    expect(
      [...dom.window.document.querySelectorAll(READY_ROW)]
        .filter((element) => element.textContent.includes(BODY))
        .map((element) => element.getAttribute('data-mid')),
    ).toEqual([EVENT_ID]);
    for (const malformed of [null, { rows: {} }, { rows: [{ id: 1 }] }])
      expect(() => contract.parseTimeline(malformed)).toThrow();
  });

  it('observes the sheet with Forward and View source, and a closed sheet', async () => {
    const contract = await loadContract();
    const { sheetExpression } = await loadObserver();
    const sheetHtml = (buttons) =>
      `<div role="dialog" aria-label="Message actions"><div data-testid="action-sheet-surface"><div class="overflow-y-auto">${buttons}</div></div></div>`;
    const observe = (body) =>
      contract.parseSheet(evaluateIn(body, sheetExpression()));
    const open = observe(
      sheetHtml(
        '<button data-testid="sheet-forward">Forward</button><button data-testid="sheet-view-source">View source</button><button>Cancel</button>',
      ),
    );
    expect(() => contract.assertNativeSheetReady(open)).not.toThrow();
    expect(() => contract.assertSheetClosed(open)).toThrow();
    expect(() =>
      contract.assertSheetClosed(observe('<main></main>')),
    ).not.toThrow();
    // A sheet left behind without any control is not a closed sheet.
    expect(() => contract.assertSheetClosed(observe(sheetHtml('')))).toThrow();
    for (const body of [
      '<main></main>',
      sheetHtml('<button data-testid="sheet-view-source">View source</button>'),
      sheetHtml('<button data-testid="sheet-forward">Forward</button>'),
      sheetHtml(
        '<button data-testid="sheet-forward" style="display:none">Forward</button><button data-testid="sheet-view-source">View source</button>',
      ),
      `${sheetHtml('<button data-testid="sheet-forward">Forward</button><button data-testid="sheet-view-source">View source</button>')}${sheetHtml('')}`,
    ])
      expect(() => contract.assertNativeSheetReady(observe(body))).toThrow();
    for (const malformed of [
      null,
      { ...open, dialogs: -1 },
      { ...open, viewSource: undefined },
      { ...open, forward: { count: 1, visible: 'yes' } },
    ])
      expect(() => contract.parseSheet(malformed)).toThrow();
  });

  it('observes the exact composer value, caret and Send state, and parses only complete observations', async () => {
    const contract = await loadContract();
    const { composerExpression } = await loadObserver();
    const composer = (value, caret = value.length) =>
      contract.parseComposer(
        (() => {
          const window = paintedWindow(
            `<trn-message-composer><textarea data-testid="composer-input" placeholder="Message #${ROOM_NAME}"></textarea><button data-testid="composer-send"${value ? '' : ' disabled'}>Send</button></trn-message-composer>`,
          );
          window.history.replaceState(null, '', ROUTE);
          const input = window.document.querySelector(COMPOSER);
          input.value = value;
          input.setSelectionRange(caret, caret);
          input.focus();
          return JSON.parse(
            JSON.stringify(
              runInNewContext(composerExpression(), {
                document: window.document,
              }),
            ),
          );
        })(),
      );
    expect(() =>
      contract.assertNativeComposerValue(composer(BODY), BODY),
    ).not.toThrow();
    for (const [value, caret] of [
      [`1${BODY}`],
      [`I${BODY.slice(1)}`],
      [`${BODY} `],
      [BODY, 0],
    ])
      expect(() =>
        contract.assertNativeComposerValue(composer(value, caret), BODY),
      ).toThrow();
    expect(() =>
      contract.assertSendEnabled(composer(BODY), BODY),
    ).not.toThrow();
    expect(() => contract.assertSendEnabled(composer(''), BODY)).toThrow();
    expect(() => contract.assertDraftSent(composer(''))).not.toThrow();
    expect(() => contract.assertDraftSent(composer(BODY))).toThrow();
    const identityOf = { name: ROOM_NAME, roomId: ROOM, userId: SENDER };
    expect(() =>
      contract.assertRoomReady(composer(''), identityOf),
    ).not.toThrow();
    for (const other of [
      { ...identityOf, name: 'Source other' },
      { ...identityOf, roomId: '!other:localhost' },
      { ...identityOf, userId: '@other:localhost' },
    ])
      expect(() => contract.assertRoomReady(composer(''), other)).toThrow();
    for (const malformed of [
      null,
      { ...composer(''), count: -1 },
      { ...composer(''), href: undefined },
      { ...composer(''), focused: 'yes' },
    ])
      expect(() => contract.parseComposer(malformed)).toThrow();
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
  texts: [BODY],
  eventIds: [EVENT_ID],
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

/** A pass capture of the open dialog, as the capture step writes it. */
const dialogCapture = () =>
  JSON.stringify(
    {
      url: ROUTE,
      body: `Message source\n${rawEvent()}\nCopy\nClose`,
      composer: '',
    },
    null,
    2,
  );

describe('Android message-source diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read(JOURNEYS);
    const current = recordProofViolations(journey);
    expect(current.records).toBe(11);
    expect(current.violations).toEqual([]);
    for (const [from, to] of [
      ['() => assertJsonEvent(parsed, authoritative, expected)', '() => {}'],
      ['() => { assertSurfaceOpaque(painted); }', '() => void painted'],
      ['() => assertDialogVisible(shown)', 'undefined'],
    ]) {
      expect(journey).toContain(from);
      expect(
        recordProofViolations(journey.replace(from, to)).violations,
      ).toHaveLength(1);
    }
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_SOURCE_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_SOURCE_STAGES[0],
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
        'send-enabled',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    await expect(record(context, 'room-ready', () => {}, {})).rejects.toThrow();
    await expect(
      record(context, 'surface-shadow', () => {}, {}),
    ).rejects.toThrow();
    await expect(record(context, 'not-owned', () => {}, {})).rejects.toThrow();
    expect(written).toHaveLength(1);
    await receipt(context, 'message-event', { ok: true });
    expect(written.at(-1).name).toBe('receipt-01-message-event');
    for (const name of [identity('room-ready'), 'Start', ''])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messageSourceSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageSourceSecrets(STAGE.id, ARTIFACT_IDS);
    const segment = Buffer.from(ROOM).toString('base64url');
    const failure = new AssertionError({
      actual: EVENT_ID,
      expected: OTHER_ID,
      operator: 'strictEqual',
      message: "The dialog event_id is the server event's",
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
      'Android message-source view-source failed',
    );
    expect(error.message).toContain(
      "The dialog event_id is the server event's",
    );
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ROOM,
      encodeURIComponent(ROOM),
      segment,
      EVENT_ID,
      SENDER,
      BODY,
      RUN,
    ])
      expect(error.message).not.toContain(value);
    // Node appends an assertion's actual/expected values to a custom message;
    // they never reach the job log, nor does any unregistered event-id shape.
    expect(failure.message).toContain(OTHER_ID);
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
      'Android message-source view-source failed\nError: Event [REDACTED] already in timeline\nAssertionError: strictEqual assertion failed\nAssertionError: Fields',
    );
    const cleanup = redactCleanupFailure(
      'fixtures',
      Object.assign(new Error(`leave ${ROOM}`), { status: 403 }),
    );
    expect(cleanup.message).toBe(
      'Message-source cleanup failed: fixtures (Error HTTP 403)',
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
    const { guardMessageSourceCleanup } = await loadJourneys();
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
    const guarded = guardMessageSourceCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ROOM}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-source cleanup failed: Room cleanup (Error)',
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
    guardMessageSourceCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it('registers every identifier form, including the event id before the dialog, never the bare server name', async () => {
    const { messageSourceSecrets } = await loadArtifacts();
    const secrets = messageSourceSecrets(STAGE.id, ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_SOURCE_VIEW_SOURCE_'),
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
      EVENT_ID,
      encodeURIComponent(EVENT_ID),
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(messageSourceSecrets(STAGE.id, { run: 'trn-p' })),
    ).toEqual(['SECRET_SOURCE_VIEW_SOURCE_RUN']);
    expect(() => messageSourceSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messageSourceSecrets(STAGE.id, { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
    const journey = read(JOURNEYS);
    for (const step of [
      'protect(context, { room: { name }, texts: [sourceBody(ledger.run)] });',
      'protect(context, { account });',
      'protect(context, { room: { id: room.id } });',
      'protect(context, { eventIds: [eventId] });',
    ])
      expect(journey).toContain(step);
    const run = functionSource(journey, 'runViewSource');
    expect(run.indexOf('await arrangeSource(context);')).toBeLessThan(
      run.indexOf('context.safety.unsafeSecrets = false;'),
    );
    expect(run.indexOf('context.safety.unsafeSecrets = false;')).toBeLessThan(
      run.indexOf('await startNative(context);'),
    );
    // The event id is protected the moment it is known, before the sheet or dialog.
    expect(
      run.indexOf('protect(context, { eventIds: [eventId] });'),
    ).toBeLessThan(run.indexOf('client.longPressCurrent('));
    expect(
      run.indexOf('protect(context, { eventIds: [eventId] });'),
    ).toBeLessThan(run.indexOf("record(context, 'server-echo'"));
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier, credential and dialog JSON', async () => {
    const { messageSourceSecrets, scanMessageSourceArtifacts } =
      await loadArtifacts();
    const secrets = messageSourceSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-source-scan-', async (output) => {
      await mkdir(join(output, STAGE.id));
      const capture = join(output, STAGE.id, 'passed.json');
      for (const unsafe of [
        dialogCapture(),
        rawEvent(),
        `GET /rooms/${ROOM}/messages`,
        JSON.stringify({ password: USER.password }),
        `GET /rooms/${mixedCase(encodeURIComponent(ROOM))}/event/${mixedCase(encodeURIComponent(EVENT_ID))}`,
        `double=${encodeURIComponent(encodeURIComponent(ROOM))}`,
        `route=/rooms/${Buffer.from(ROOM).toString('base64url')}`,
        `slice=${ROOM.slice(1)}`,
        `selector=.scroll .msg[data-mid="${EVENT_ID}"]`,
        `user=${SENDER}`,
        `user=${encodeURIComponent(SENDER)}`,
        `body=${BODY}`,
        `name=${ROOM_NAME}`,
        // An event JSON whose ids were never registered still blocks publication.
        JSON.stringify({ body: '"event_id": "$Unregistered_X"' }),
        '{"room_id": "!unregistered:localhost"}',
        '{\\"sender\\": \\"@unregistered:localhost\\"}',
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
          scanMessageSourceArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        capture,
        '{"eventDigest":"ab","event_id":"[REDACTED]","server":"localhost","access_token":false,"alpha":1}\n',
      );
      await expect(
        scanMessageSourceArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of [
        'passed-webview.png',
        'failed-device.PNG',
        'opaque.bin',
      ])
        await withOutput('trinity-source-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(scanMessageSourceArtifacts(other, {})).rejects.toThrow();
        });
    });
  });

  it('scrubs a captured dialog JSON and encoded identifiers, deletes dialog screenshots and then scans clean', async () => {
    const {
      messageSourceSecrets,
      scrubMessageSourceArtifacts,
      scanMessageSourceArtifacts,
    } = await loadArtifacts();
    const secrets = messageSourceSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-source-scrub-', async (output) => {
      const stage = join(output, STAGE.id);
      await mkdir(stage);
      const path = join(stage, 'passed-surface.json');
      await writeFile(
        path,
        [
          dialogCapture(),
          `GET /rooms/${mixedCase(encodeURIComponent(ROOM))}/messages`,
          `row=.scroll .msg[data-mid=${JSON.stringify(EVENT_ID)}]`,
          JSON.stringify({ password: USER.password }),
          'Msg: Event $SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 already in timeline',
          'class $OnBluetoothActivityEnergyInfoProxy digest 0a1b2c',
          'unchanged=1 dialog',
        ].join('\n'),
      );
      for (const name of [
        'passed-webview.png',
        'passed-device.png',
        'failed-webview.png',
        'failed-device.png',
      ])
        await writeFile(join(stage, name), 'raster of the dialog');
      await scrubMessageSourceArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe('unchanged=1 dialog');
      for (const leaked of [
        ROOM,
        EVENT_ID,
        SENDER,
        BODY,
        RUN,
        'source-pass',
        '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4',
      ])
        expect(scrubbed).not.toContain(leaked);
      // Only event-id shapes are removed; other `$` names stay.
      expect(scrubbed).toContain('$OnBluetoothActivityEnergyInfoProxy');
      expect(scrubbed).toContain('\\"event_id\\": \\"[REDACTED]\\"');
      for (const name of [
        'passed-webview.png',
        'passed-device.png',
        'failed-webview.png',
        'failed-device.png',
      ])
        expect(existsSync(join(stage, name))).toBe(false);
      await expect(
        scanMessageSourceArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
    // Without the event id registered, the scrubbed dialog capture still fails the scan.
    await withOutput('trinity-source-scrub-unregistered-', async (output) => {
      await writeFile(join(output, 'passed.json'), dialogCapture());
      const partial = messageSourceSecrets(STAGE.id, {
        ...ARTIFACT_IDS,
        eventIds: [],
      });
      await scrubMessageSourceArtifacts(output, partial);
      await expect(
        scanMessageSourceArtifacts(output, partial),
      ).rejects.toThrow();
    });
  });

  it('publishes only a complete, clean, unretried one-stage 11-record Pixel 5 run', async () => {
    const artifacts = await loadArtifacts();
    const { DESKTOP_ACCOUNT_PROFILE, PIXEL_5_ACCOUNT_PROFILE } =
      await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 11,
      attempt: 1,
      retries: 0,
      stages: [
        {
          id: STAGE.id,
          status: 'passed',
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: 11,
          assertionRecords: 11,
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
    await withOutput('trinity-source-gate-', async (output) => {
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
          artifacts.markMessageSourceDiagnosticsSafe(
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
      await artifacts.markMessageSourceDiagnosticsSafe(
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
          value.stages[0].assertionRecords = 10;
        }),
        mutate((value) => {
          value.stages[0].assertions[10] = value.stages[0].assertions[9];
        }),
        mutate((value) => (value.expectedAssertionRecords = 10)),
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
        dialogCapture(),
      );
      await refused(report(), {
        secrets: artifacts.messageSourceSecrets(STAGE.id, ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, STAGE.id, 'passed-webview.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const {
      runMessageSourceStageCleanup,
      revokeMessageSourcePublicationOnAbort,
    } = await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessageSourceStageCleanup(
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
    await withOutput('trinity-source-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageSourcePublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageSourcePublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-source publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });

  it('tears down the Account and Room through the shared fixture cleanup', () => {
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
  });
});

/* ------------------------------------------------------------------------ */
/* Hosted wiring and parity ledger                                           */
/* ------------------------------------------------------------------------ */

const NX_COMMAND =
  '--suite=android.message-source --timeout-ms=900000 --entrypoint=e2e/android/message-source-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "3" ]; then echo \'message-source-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:message-source; fi';
const GATE_PATH =
  "-path '*/android.message-source/message-source/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-source-started == 'true' && steps.message-source-artifact-gate.outputs.message-source-safe == 'true' }}";

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
  const target = project.targets['message-source'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-source']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-source',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(
    lines.filter((line) => line.includes('trinity-e2e-android:message-source')),
  ).toHaveLength(1);
  expect(lines[runner - 1]).toContain("echo 'message-receipts-started=true'");
  expect(
    lines
      .filter((line) => line.startsWith('if [ "${{ matrix.shard }}" = "3" ]'))
      .at(-1),
  ).toBe(CI_LINE);
  const gate = workflow
    .split('      - name: Gate Android message-source diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-source-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-source-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain(
    'echo \'message-source-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-source\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-source/**',
  );
  expect(workflow).toContain('shard 2 about 117, shard 3 about 168\n');
  expect(workflow).toContain(
    "# Shard 3's figure also adds a provisional 5 minutes for message-source.",
  );
  expect(ciSpec).toContain('expect(uploads.length).toBe(78);');
  expect(ciSpec).toContain('expect(lines).toHaveLength(71);');
  expect(ciSpec).toContain("step.with.surface === 'android-message-source'");
  expect(ciSpec).toContain(
    'runs message-source after message-receipts at the end of shard 3',
  );
  expect(ciSpec).toContain(
    'budgets message-source in the shard-3 figure of the Android budget comment',
  );
}

describe('Android message-source hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-source',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-source',
      canonicalScript: 'e2e:android:message-source',
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
        (item) => item.name === 'e2e:android:message-source',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-source',
        command: 'nx run trinity-e2e-android:message-source',
        kind: 'canonical',
        suiteIds: ['android.message-source'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-source'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "3" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-source',
    );
    expect(read(JOURNEYS)).toContain('timeout: 600_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-source']);
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
            'message-source-journeys.mts',
            'message-receipts-journeys.mts',
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
        delete inputs.pkg.scripts['e2e:android:message-source'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "3"', '= "5"')),
      withText('workflow', CI_LINE, CI_LINE.replace('1200000', '600000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-source/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-source-started == 'true' }}",
      ),
      withText('workflow', 'shard 3 about 168', 'shard 3 about 163'),
      withText(
        'ciSpec',
        'expect(uploads.length).toBe(78);',
        'expect(uploads.length).toBe(77);',
      ),
      withText(
        'ciSpec',
        'expect(lines).toHaveLength(71);',
        'expect(lines).toHaveLength(70);',
      ),
    ])
      expect(() => assertWiring(mutated)).toThrow();
    // The runner moved before message-receipts.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === CI_LINE);
    const [line] = lines.splice(index, 1);
    lines.splice(index - 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 11 identities with their source lines and the 7/4 prose, as the last section', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-source journey')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-source\.[^`]+)` \|$/gmu,
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
    expect(section).toContain('7 direct + 4');
    expect(section).toContain(PREDECESSOR_SHA256);
    expect(section).toContain(ISSUE_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-source`');
    expect(section).toMatch(/remains enabled and untouched/u);
    expect(section).toContain('sheet-view-source');
    expect(section).toContain('393×727');
    expect(section).toContain('acceptance gate for #752');
    expect(section).not.toContain('pnpm exec nx');
    expect(migration.trimEnd().endsWith(section.trimEnd())).toBe(true);
    // The read-receipt section, and only it, precedes this one.
    expect(
      migration.split('\n## ').at(-2).startsWith('Message-receipts journey\n'),
    ).toBe(true);
    const design = read(
      'docs/superpowers/specs/2026-09-26-android-message-source-maestro-design.md',
    );
    for (const suffix of STAGE.suffixes)
      expect(design).toContain(`\`${suffix}\``);
    expect(design).toContain(PREDECESSOR_SHA256);
    expect(design).toContain(ISSUE_SHA256);
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
    'REST text seed',
    /sendMessage\(|sendEvent\(|sendImageMessage\(|\/send\/m\.room\.message|setRoomState\(/u,
  ],
  [
    'desktop hover path',
    /clickRowToolbar|clickRowMenuItem|msg-more|msg-view-source|\.hover\(/u,
  ],
  [
    'CSS class or screenshot paint',
    /classList\.contains\(['"](?:border|shadow|bg-)|shadow-overlay|\.screenshot\(|toHaveScreenshot|captureScreenshot/u,
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
      if (
        [
          'readComposer',
          'readTimeline',
          'readSheet',
          'readSourceDialog',
        ].includes(called)
      ) {
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
  expect(journeys).not.toMatch(/client\.(?:fill|replace|tap)\(/u);
  // REST arranges only the Account and Room, and observes the event.
  expect(journeys.match(/fixtures\.\w+\(/gu)).toEqual([
    'fixtures.account(',
    'fixtures.createRoom(',
    'fixtures.roomMessages(',
  ]);
  const arrange = functionSource(journeys, 'arrangeSource');
  assertOrder(
    arrange,
    [
      /protect\(context, \{ room: \{ name \}, texts: \[sourceBody\(ledger\.run\)\] \}\)/u,
      /fixtures\.account\('source-view-source'\)/u,
      /protect\(context, \{ account \}\)/u,
      /fixtures\.createRoom\(account, \{ name, preset: 'private_chat' \}\)/u,
      /protect\(context, \{ room: \{ id: room\.id \} \}\)/u,
    ],
    'arrangeSource',
  );
  const run = functionSource(journeys, 'runViewSource');
  assertOrder(
    run,
    [
      callOf('arrangeSource'),
      /context\.safety\.unsafeSecrets = false/u,
      callOf('startNative'),
      /client\.login\(account\)/u,
      /client\.hideKeyboard\(\)/u,
      /openRoom\(context, room, account\)/u,
      /sendBodyNatively\(context, body\)/u,
      recordOf('row-visible'),
      /assertServerEcho\(value, body\)/u,
      /protect\(context, \{ eventIds: \[eventId\] \}\)/u,
      recordOf('server-echo'),
      /serverEvent\(context, account, room, expected\)/u,
      /receipt\(context, 'message-event'/u,
      /assertSameRow\(target, body, eventId\)/u,
      /client\.hideKeyboard\(\)/u,
      /client\.longPressCurrent\(READY_ROW, \{ text: body \}\)/u,
      /assertNativeSheetReady/u,
      recordOf('sheet-ready'),
      /reachViewSource\(client\)/u,
      /client\.tapCurrent\(VIEW_SOURCE\)/u,
      /assertSheetClosed/u,
      recordOf('dialog-visible'),
      /\(value\) => assertJsonBody\(value, authoritative, expected\)/u,
      recordOf('json-event'),
      recordOf('json-body'),
      /assertSurfaceOverConversation/u,
      recordOf('surface-opaque'),
      recordOf('surface-border'),
      recordOf('surface-shadow'),
    ],
    'runViewSource',
  );
  // The JSON is compared with the server's authoritative event, never only itself.
  expect(run).toContain(
    "record(context, 'json-event', () => assertJsonEvent(parsed, authoritative, expected)",
  );
  expect(run).toContain(
    "record(context, 'json-body', () => assertJsonBody(parsed, authoritative, expected)",
  );
  const send = functionSource(journeys, 'sendBodyNatively');
  assertOrder(
    send,
    [
      /client\.focusCurrent\(COMPOSER\)/u,
      /client\.fillFocused\(COMPOSER, body, BODY_SENTINEL\)/u,
      /assertNativeComposerValue\(value, body\)/u,
      /client\.hideKeyboard\(\)/u,
      /assertSendEnabled\(value, body\)/u,
      recordOf('send-enabled'),
      /client\.tapCurrent\(SEND\)/u,
      /assertDraftSent/u,
    ],
    'sendBodyNatively',
  );
  const event = functionSource(journeys, 'serverEvent');
  expect(event).toContain('context.fixtures.roomMessages(account, room.id)');
  expect(event).toContain('assertSourceRoom(value, expected)');
  const reach = functionSource(journeys, 'reachViewSource');
  assertOrder(
    reach,
    [
      /for \(let swipe = 0; swipe <= SHEET_SWIPES; swipe\+\+\)/u,
      /client\.waitElements\(VIEW_SOURCE/u,
      /action!\.unobstructedCenter/u,
      /client\.swipeCurrent\(SHEET_SCROLL, \{ direction: 'increase-scroll-top' \}\)/u,
    ],
    'reachViewSource',
  );
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
    'const READY_ROW = \'.scroll .msg[data-mid^="$"]\';',
  );
  expect(journeys).toContain(
    'const VIEW_SOURCE = \'[data-testid="sheet-view-source"]\';',
  );
  const calls = [
    ...journeys.matchAll(
      /client\.(?:tapCurrent|longPressCurrent|focusCurrent|fillFocused|swipeCurrent|visible|waitElements|elements)\(([^;]*?)\);/gsu,
    ),
  ];
  expect(calls.length).toBeGreaterThanOrEqual(10);
  for (const call of calls)
    expect(call[1], call[0]).not.toMatch(
      /`|\$\{|Id\b|\.id\b|eventId|userId|sender|roomId/u,
    );
  for (const call of journeys.matchAll(/\bdescription: (?!string)([^\n]+)/gu))
    expect(call[1], call[0]).toMatch(/^'[^'$`]+',$/u);
  for (const name of ['timeline', 'sheet', 'dialog'])
    for (const argument of callArguments(journeys, name, 2))
      expect(argument, `${name} description`).toMatch(/^'[A-Za-z -]+'$/u);
  expect(journeys).not.toMatch(
    /console\.\w+\([^)]*\$\{(?!entry\.id|stage\.status)/u,
  );
  const runner = functionSource(journeys, 'runMessageSourceSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /createAccountFixtures\(/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /MESSAGE_SOURCE_STAGES/u,
      /runMessageSourceStageCleanup\(/u,
      /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
    ],
    'runMessageSourceSuite',
  );
  for (const required of [
    'expectedStages: 1',
    'expectedAssertionRecords: 11',
    'attempt: 1',
    'retries: 0',
    'markMessageSourceDiagnosticsSafe(',
    'scrubMessageSourceArtifacts(',
    'revokeMessageSourcePublicationOnAbort(',
    "client.capture('passed')",
    "client.capture('failed')",
    'client.reset(PIXEL_5_ACCOUNT_PROFILE)',
    'profile: PIXEL_5_ACCOUNT_PROFILE',
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  ])
    expect(journeys).toContain(required);
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

describe('Android message-source source rules', () => {
  it('keeps the observer and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [OBSERVER, ARTIFACTS, CONTRACT]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    const observer = read(OBSERVER);
    assertReadOnlyObserver(observer);
    // Paint and geometry come from the measured surface's computed style.
    expect(observer).toContain(
      'const style = surface ? view.getComputedStyle(surface) : null;',
    );
    expect(observer).toContain('const box = element.getBoundingClientRect();');
    for (const property of [
      'backgroundColor: style.backgroundColor,',
      'borderTopWidth: style.borderTopWidth,',
      'borderTopStyle: style.borderTopStyle,',
      'boxShadow: style.boxShadow,',
    ])
      expect(observer).toContain(property);
    expect(observer).not.toMatch(/classList\.contains\('(?!msg--event)/u);
    expect(read(ARTIFACTS)).not.toMatch(
      /message-quote-artifacts|message-receipts-artifacts/u,
    );
  });

  it('adds no shared fixture: the Account, Room and event reader are reused unchanged', () => {
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
      'element.click()',
      'element.focus()',
      'input.value = "x"',
      "document.execCommand('insertText', false, 'x')",
      'element.dispatchEvent(new MouseEvent("click"))',
      'surface.classList.add("bg-popover")',
      'surface.setAttribute("style", "background: white")',
      'surface.style.backgroundColor = "white"',
      'window.location = "/rooms"',
      "const opaque = surface.classList.contains('bg-popover')",
      'const opaque = className.includes("shadow-overlay")',
      'await page.screenshot()',
      'await fixtures.sendMessage(account, room.id, body, "txn")',
      "await clickRowMenuItem(row, page.getByTestId('msg-view-source'))",
      'const report = { retries: 1 }',
    ])
      expect(() =>
        assertNoForbiddenTokens(`${observer}\n${mutation}`, OBSERVER),
      ).toThrow();
    for (const mutation of [
      'element.click()',
      'input.focus()',
      'row.scrollTo(0, 0)',
      'input.value = "x"',
      'row.appendChild(node)',
    ])
      expect(() =>
        assertReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    for (const unbounded of [
      'await waitForNativeShellState(read, accepts, "x", signal);',
      'await client.waitElements(SHEET, accepts, "x");',
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
      // REST seeding of the message, DOM input or a desktop path.
      `${journeys}\nawait fixtures.sendMessage(account, room.id, body, 'txn');`,
      `${journeys}\nawait evaluateNative(client.webview, 'x');`,
      `${journeys}\nawait client.fill(COMPOSER, body);`,
      `${journeys}\nawait client.tap('[data-testid="msg-more"]');`,
      `${journeys}\nawait fixtures.roomEvent(account, room.id, eventId);`,
      // The body is typed without the digit sentinel.
      replace(
        /await client\.fillFocused\(COMPOSER, body, BODY_SENTINEL\);/u,
        'await client.fillFocused(COMPOSER, body);',
      ),
      // The ready-event proof or the row identity before the long press is dropped.
      replace(
        /  const authoritative = await serverEvent\(context, account, room, expected\);\n/u,
        '  const authoritative = { event_id: eventId };\n',
      ),
      replace(/  assertSameRow\(target, body, eventId\);\n/u, ''),
      // The sheet or View source is skipped, or the event id is protected late.
      replace(/  await client\.tapCurrent\(VIEW_SOURCE\);\n/u, ''),
      replace(
        /  await client\.longPressCurrent\(READY_ROW, \{ text: body \}\);\n/u,
        '',
      ),
      replace(/  protect\(context, \{ eventIds: \[eventId\] \}\);\n/u, ''),
      // The JSON is only compared with itself, or a field is dropped.
      replace(
        /\(\) => assertJsonEvent\(parsed, authoritative, expected\)/u,
        '() => assertDialogVisible(parsed)',
      ),
      replace(
        /\(value\) => assertJsonBody\(value, authoritative, expected\)/u,
        '(value) => assertDialogVisible(value)',
      ),
      // A proof becomes a receipt, or a row is targeted by its event id.
      replace(
        /record\(context, 'surface-shadow'/u,
        "receipt(context, 'surface-shadow'",
      ),
      replace(
        /client\.longPressCurrent\(READY_ROW, \{ text: body \}\)/u,
        'client.longPressCurrent(`.scroll .msg[data-mid="${eventId}"]`, {})',
      ),
      replace(
        /description: 'exact native body in the composer',/u,
        'description: `body ${body}`,',
      ),
      replace(
        /'dialog JSON is exactly the authoritative event'/u,
        '`dialog JSON for ${eventId}`',
      ),
      // An unbounded sheet scroll.
      replace(
        /for \(let swipe = 0; swipe <= SHEET_SWIPES; swipe\+\+\)/u,
        'for (let swipe = 0; ; swipe++)',
      ),
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });
});
