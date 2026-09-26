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
const predecessor = 'e2e/browser/journeys/conversations/message-quote.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
const loadContract = () => import('../e2e/android/message-quote-contract.mts');
const loadObserver = () => import('../e2e/android/message-quote-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-quote-artifacts.mts');
const loadJourneys = () => import('../e2e/android/message-quote-journeys.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-quote-journeys.mts';
const OBSERVER = 'e2e/android/message-quote-observer.mts';
const ARTIFACTS = 'e2e/android/message-quote-artifacts.mts';
const CONTRACT = 'e2e/android/message-quote-contract.mts';
const APPEND_FLOW = 'e2e/android/flows/message-quote-append.yaml';

/** The predecessor at its branch hash, after fe2c7c3e's Send-button change. */
const PREDECESSOR_SHA256 =
  '50b0e8a42aa1d61ee59b1c5dce97664365977aef7bc8b36aa3502e23e731064f';
/** The issue's pin: the same file on develop, before fe2c7c3e. */
const ISSUE_SHA256 =
  'fdd2a9dc98324aaea47a4d6fd3bf768bd35756119eafd4751faee849da5baf66';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/message-composer.mts':
    '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
};
const OPEN_ROOM_SPAN = [29, 37];

/** The design's identity tables, verbatim. */
const STAGES = [
  {
    id: 'quote-block',
    span: [42, 115],
    title:
      'pulls a message into the composer as a > block and sends it as a blockquote',
    android: [[85, 87]],
    desktop: [[88, 90]],
    direct: [82, 94, 104, 110, 111, 112, 114],
    inherited: [
      [34, 'openRoom', 71],
      [53, 'sendComposerDraft', 79],
      [178, 'waitForSent', 83],
      [220, 'openMessageActionSheet', 86],
      [53, 'sendComposerDraft', 101],
    ],
    suffixes: [
      'room-ready',
      'source-send-enabled',
      'source-visible',
      'source-server-echo',
      'sheet-ready',
      'composer-quote',
      'answer-send-enabled',
      'answer-visible',
      'one-blockquote',
      'quotes-first',
      'quotes-second',
      'answer-outside',
    ],
  },
  {
    id: 'quote-capability',
    span: [117, 217],
    title: 'offers no Quote for a message with no text to bring',
    android: [
      [183, 187],
      [201, 205],
    ],
    desktop: [
      [188, 197],
      [206, 216],
    ],
    direct: [181, 185, 187, 200, 204, 205],
    inherited: [
      [34, 'openRoom', 172],
      [53, 'sendComposerDraft', 178],
      [178, 'waitForSent', 182],
      [220, 'openMessageActionSheet', 184],
      [220, 'openMessageActionSheet', 202],
    ],
    suffixes: [
      'room-ready',
      'control-send-enabled',
      'control-visible',
      'control-server-echo',
      'text-sheet-ready',
      'text-quote-visible',
      'text-sheet-closed',
      'image-visible',
      'image-sheet-ready',
      'image-copy-visible',
      'image-no-quote',
    ],
  },
];
const EXCLUDED_DESKTOP_SITES = [193, 212, 215];
const identitiesOf = (stage) =>
  stage.suffixes.map((suffix) => `message-quote.${stage.id}.${suffix}`);
const ALL_IDENTITIES = STAGES.flatMap(identitiesOf);
const [BLOCK, CAPABILITY] = STAGES;

const LINE_PINS = {
  27: 'const session = synapseSession();',
  29: 'async function openRoom(page: Page, roomName: string): Promise<void> {',
  30: "await page.getByTestId('rail-rooms').click();",
  31: "const channel = page.locator('.channel', { hasText: roomName });",
  32: "await channel.first().waitFor({ state: 'visible', timeout: 30_000 });",
  33: 'await channel.first().click();',
  34: "await expect(page.getByTestId('composer-input')).toBeVisible({",
  35: 'timeout: 15_000,',
  40: "test.skip(!session.available, 'needs a Synapse homeserver (Docker)');",
  47: "const runId = `${testResourceId('run')}q`;",
  50: 'const roomName = `Quote ${runId}`;',
  51: 'const first = `alpha ${runId}`;',
  52: 'const second = `omega ${runId}`;',
  70: 'await login(page, { available: true, hs, user, pass } as SynapseSession);',
  71: 'await openRoom(page, roomName);',
  74: "const composer = page.getByTestId('composer-input');",
  75: 'await composer.fill(first);',
  76: "await composer.press('Shift+Enter');",
  77: "await composer.press('Shift+Enter');",
  78: 'await composer.pressSequentially(second);',
  79: 'await sendComposerDraft(composer);',
  81: "const row = page.locator('.scroll .msg', { hasText: first });",
  82: 'await expect(row.first()).toBeVisible({ timeout: 20_000 });',
  83: 'await waitForSent(row.first());',
  85: 'if (isAndroidE2E) {',
  86: 'const sheet = await openMessageActionSheet(page, row.first());',
  87: "await sheet.getByTestId('sheet-quote').click();",
  88: '} else {',
  89: "await clickRowMenuItem(row.first(), page.getByTestId('msg-quote'));",
  90: '}',
  94: 'await expect(composer).toHaveValue(`> ${first}\\n>\\n> ${second}\\n\\n`, {',
  99: 'const answer = `my point ${runId}`;',
  100: 'await composer.pressSequentially(answer);',
  101: 'await sendComposerDraft(composer);',
  103: "const sent = page.locator('.scroll .msg', { hasText: answer });",
  104: 'await expect(sent.first()).toBeVisible({ timeout: 20_000 });',
  109: "const quoted = sent.first().locator('blockquote');",
  110: 'await expect(quoted).toHaveCount(1);',
  111: 'await expect(quoted).toContainText(first);',
  112: 'await expect(quoted).toContainText(second);',
  114: 'await expect(quoted).not.toContainText(answer);',
  122: "const runId = `${testResourceId('run')}qn`;",
  125: 'const roomName = `Quote none ${runId}`;',
  126: 'const body = `plain ${runId}`;',
  150: '.post(`${hs}/_matrix/media/v3/upload?filename=shot.png`, {',
  153: "'Content-Type': 'image/png',",
  157: "'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',",
  164: '`${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}img`,',
  167: "data: { msgtype: 'm.image', body: 'shot.png', url: mxc },",
  171: 'await login(page, { available: true, hs, user, pass } as SynapseSession);',
  172: 'await openRoom(page, roomName);',
  177: 'await composer.fill(body);',
  178: 'await sendComposerDraft(composer);',
  180: "const textRow = page.locator('.scroll .msg', { hasText: body });",
  181: 'await expect(textRow.first()).toBeVisible({ timeout: 20_000 });',
  182: 'await waitForSent(textRow.first());',
  183: 'if (isAndroidE2E) {',
  184: 'const sheet = await openMessageActionSheet(page, textRow.first());',
  185: "await expect(sheet.getByTestId('sheet-quote')).toBeVisible();",
  186: "await sheet.getByText('Cancel', { exact: true }).click();",
  187: 'await expect(sheet).toHaveCount(0);',
  188: '} else {',
  199: "const imageRow = page.locator('.scroll .msg', { hasText: 'shot.png' });",
  200: 'await expect(imageRow.first()).toBeVisible({ timeout: 20_000 });',
  201: 'if (isAndroidE2E) {',
  202: 'const sheet = await openMessageActionSheet(page, imageRow.first());',
  204: "await expect(sheet.getByTestId('sheet-copy')).toBeVisible();",
  205: "await expect(sheet.getByTestId('sheet-quote')).toHaveCount(0);",
  206: '} else {',
  216: '}',
};

const IMPORTS = `import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  clickRowMenuItem,
  clickRowToolbar,
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
 * Expand one definition's Android path into parity sites: direct `expect`
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
const ledgerTuples = (stage) => {
  const inherited = stage.inherited.map(([line, helper, call]) => [
    'inherited',
    line,
    helper,
    call,
  ]);
  const key = (tuple) =>
    tuple[0] === 'direct' ? [tuple[1], 1] : [tuple[3], 0];
  return [...inherited, ...stage.direct.map((line) => ['direct', line])].sort(
    (a, b) => {
      const [left, right] = [key(a), key(b)];
      return left[0] - right[0] || left[1] - right[1];
    },
  );
};

const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

/** Every text-level predecessor pin, independent of the byte hash. */
function assertPredecessorShape(source) {
  expect(source.split('\n')).toHaveLength(219);
  expect(source.split('\n').slice(0, 13).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  expect(lineAt(source, OPEN_ROOM_SPAN[1])).toBe('}');
  expect(assertionLines(source, ...OPEN_ROOM_SPAN)).toEqual([34]);
  expect(assertionLines(source, 1, OPEN_ROOM_SPAN[0] - 1)).toEqual([]);
  expect(
    assertionLines(source, OPEN_ROOM_SPAN[1] + 1, BLOCK.span[0] - 1),
  ).toEqual([]);
  expect(
    assertionLines(source, BLOCK.span[1] + 1, CAPABILITY.span[0] - 1),
  ).toEqual([]);
  expect(assertionLines(source, CAPABILITY.span[1] + 1, 219)).toEqual([]);
  let direct = 0;
  let inherited = 0;
  for (const stage of STAGES) {
    expect(source.split('\n')[stage.span[0] - 1]).toContain(
      `test('${stage.title}'`,
    );
    expect(lineAt(source, stage.span[1])).toBe('});');
    const branches = platformBranches(source, stage.span);
    expect(branches.map((branch) => branch.android)).toEqual(stage.android);
    expect(branches.map((branch) => branch.desktop)).toEqual(stage.desktop);
    const expanded = expandDefinition(source, stage.span);
    expect(expanded.map(siteTuple)).toEqual(ledgerTuples(stage));
    expect(
      expanded.filter((site) => site.kind === 'direct').map((s) => s.line),
    ).toEqual(stage.direct);
    direct += stage.direct.length;
    inherited += expanded.filter((site) => site.kind === 'inherited').length;
  }
  expect(direct).toBe(13);
  expect(inherited).toBe(10);
  const desktopSites = STAGES.flatMap((stage) =>
    stage.desktop.flatMap((span) => assertionLines(source, ...span)),
  );
  expect(desktopSites).toEqual(EXCLUDED_DESKTOP_SITES);
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-quote predecessor pins', () => {
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
    // Undo fe2c7c3e: drop the import and restore the three Enter presses.
    const develop = lines
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
    expect(lines.length - develop.split('\n').length).toBe(1);
    expect(source.match(/await sendComposerDraft\(composer\);/gu)).toHaveLength(
      3,
    );
    expect(sha256(develop)).toBe(ISSUE_SHA256);
  });

  it('pins the same sources, spans and branches in the contract', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_QUOTE_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_QUOTE_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_QUOTE_ISSUE_SOURCE_SHA256).toBe(ISSUE_SHA256);
    expect(contract.MESSAGE_QUOTE_SOURCE_LINES).toBe(218);
    expect(contract.MESSAGE_QUOTE_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    const span = ([from, to]) => ({ from, to });
    expect(contract.MESSAGE_QUOTE_SPANS).toEqual({
      openRoom: span(OPEN_ROOM_SPAN),
      definitions: Object.fromEntries(
        STAGES.map((stage) => [stage.id, span(stage.span)]),
      ),
      androidBranches: Object.fromEntries(
        STAGES.map((stage) => [stage.id, stage.android.map(span)]),
      ),
      desktopBranches: Object.fromEntries(
        STAGES.map((stage) => [stage.id, stage.desktop.map(span)]),
      ),
    });
    expect([...contract.MESSAGE_QUOTE_EXCLUDED_DESKTOP_SITES]).toEqual(
      EXCLUDED_DESKTOP_SITES,
    );
  });

  it('keeps the predecessor enabled in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-quote.spec.mts',
      ),
    ).toHaveLength(1);
    const android = read('e2e/android/playwright.config.mts');
    expect(android).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    for (const config of [android, read('e2e/browser/playwright.config.mts')]) {
      expect(config).not.toContain('testIgnore');
      expect(config).not.toContain('message-quote');
    }
    const source = read(predecessor);
    expect(source).not.toMatch(/test\.(?:fixme|only)\(|test\.skip\(true/u);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(1);
    expect(source.match(/^ {2}test\('/gmu)).toHaveLength(2);
  });

  it('maps the exact Android-path direct and helper sites with the house AST rule', () => {
    assertPredecessorShape(read(predecessor));
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = read(predecessor);
    const mutations = [
      // A quote field, fixture byte, test id or run suffix drifts.
      mutateLine(source, 51, (line) => line.replace('alpha', 'Alpha')),
      mutateLine(source, 52, (line) => line.replace('omega', 'beta')),
      mutateLine(source, 94, (line) => line.replace('\\n>\\n', '\\n\\n')),
      mutateLine(source, 94, (line) => line.replace('\\n\\n`', '\\n`')),
      mutateLine(source, 99, (line) => line.replace('my point', 'my answer')),
      mutateLine(source, 126, (line) => line.replace('plain', 'text')),
      mutateLine(source, 47, (line) => line.replace('}q`', '}p`')),
      mutateLine(source, 122, (line) => line.replace('}qn`', '}q`')),
      mutateLine(source, 157, (line) => line.replace('iVBOR', 'iVBOr')),
      mutateLine(source, 153, (line) => line.replace('image/png', 'image/gif')),
      mutateLine(source, 150, (line) => line.replace('shot.png', 'shot.gif')),
      mutateLine(source, 167, (line) => line.replace("'m.image'", "'m.file'")),
      mutateLine(source, 205, (line) =>
        line.replace('sheet-quote', 'sheet-copy'),
      ),
      mutateLine(source, 204, (line) =>
        line.replace('sheet-copy', 'sheet-forward'),
      ),
      // The blank line becomes a single Shift+Enter.
      mutateLine(source, 77, () => '    void composer;'),
      // A direct site is dropped, added or moved.
      mutateLine(source, 112, () => '    void quoted;'),
      mutateLine(
        source,
        113,
        () => '    await expect(quoted).toContainText(answer);',
      ),
      mutateLine(source, 102, (line) => `${line}\n`),
      // A helper call changes, or a desktop site moves into an Android branch.
      mutateLine(source, 83, () => '    void row;'),
      mutateLine(source, 79, () => "    await composer.press('Enter');"),
      mutateLine(
        source,
        34,
        () => "  await page.getByTestId('composer-input').waitFor();",
      ),
      mutateLine(source, 185, () => '      void sheet;'),
      source.replace(
        "      await sheet.getByText('Cancel', { exact: true }).click();\n",
        "      await sheet.getByText('Cancel', { exact: true }).click();\n      await expect(page.getByTestId('msg-quote')).toHaveCount(0);\n",
      ),
      // A definition title or import drifts.
      source.replace(
        "test('offers no Quote for a message with no text to bring'",
        "test('offers no Quote for an image'",
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

describe('Android message-quote helper expansion by binding', () => {
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
      // Module level (line 27), outside the owned definitions.
      ['synapseSession', 27],
      ['registerUser', 54],
      ['login', 70],
      ['openRoom', 71],
      ['sendComposerDraft', 79],
      ['waitForSent', 83],
      ['openMessageActionSheet', 86],
      // Desktop-only; excluded by branch.
      ['clickRowMenuItem', 89],
      ['sendComposerDraft', 101],
      ['registerUser', 128],
      ['login', 171],
      ['openRoom', 172],
      ['sendComposerDraft', 178],
      ['waitForSent', 182],
      ['openMessageActionSheet', 184],
      ['clickRowToolbar', 189],
      ['openMessageActionSheet', 202],
      ['clickRowToolbar', 207],
    ]);
  });

  it('follows helper calls and proves registration and login add no sites', () => {
    const source = read(predecessor);
    expect(helperExpectLines(predecessor, 'openRoom', source)).toEqual([
      { module: predecessor, line: 34 },
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
    // The desktop helpers reach their own retrying expect; they stay excluded.
    expect(helperExpectLines('e2e/support/app.mts', 'clickRowToolbar')).toEqual(
      [{ module: 'e2e/support/app.mts', line: 195 }],
    );
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
  });

  it('excludes a shadowing local helper and the desktop branches, against a naive count', () => {
    const source = read(predecessor);
    const shadowed = source.replace(
      '    await waitForSent(row.first());',
      '    const waitForSent = async (_row: unknown) => {};\n    await waitForSent(row.first());',
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    expect(locals.map((call) => call.name)).toEqual(['waitForSent']);
    expect(calls.filter((call) => call.name === 'waitForSent')).toHaveLength(1);
    expect(shadowed.match(/\bwaitForSent\(/gu)).toHaveLength(2);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
    // Without branch selection the desktop paths would add sites.
    const naive = (span) =>
      assertionLines(source, ...span).length +
      importedCalls(source).calls.filter(
        (call) =>
          call.line >= span[0] &&
          call.line <= span[1] &&
          ['clickRowToolbar', 'clickRowMenuItem'].includes(call.name),
      ).length;
    expect(naive(BLOCK.span)).toBe(8);
    expect(naive(CAPABILITY.span)).toBe(11);
    expect(
      expandDefinition(source, BLOCK.span).filter((s) => s.kind === 'direct'),
    ).toHaveLength(7);
  });

  it('expands 2 Room + 3 composer-send + 2 real-server echo + 3 sheet readiness = 10 inherited sites', () => {
    const source = read(predecessor);
    const inherited = STAGES.flatMap((stage) =>
      expandDefinition(source, stage.span).filter(
        (site) => site.kind === 'inherited',
      ),
    );
    const count = (helper) =>
      inherited.filter((site) => site.helper === helper).length;
    expect(count('openRoom')).toBe(2);
    expect(count('sendComposerDraft')).toBe(3);
    expect(count('waitForSent')).toBe(2);
    expect(count('openMessageActionSheet')).toBe(3);
    expect(inherited).toHaveLength(10);
  });

  it('matches the contract sites, identities and helper roles exactly', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    for (const [index, stage] of STAGES.entries()) {
      const expanded = expandDefinition(source, stage.span);
      expect(contract.MESSAGE_QUOTE_STAGES[index].sites.map(siteTuple)).toEqual(
        expanded.map(siteTuple),
      );
      expect(contract.MESSAGE_QUOTE_STAGES[index].assertions).toEqual(
        identitiesOf(stage),
      );
      expect(
        contract.MESSAGE_QUOTE_STAGES[index].sites.map(siteTuple),
      ).not.toEqual(expanded.slice(0, -1).map(siteTuple));
    }
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_QUOTE_HELPERS,
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
        Object.entries(contract.MESSAGE_QUOTE_HELPERS).map(([name, value]) => [
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
/* Contract ledger and quote fields                                          */
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

/** The exact image fixture the predecessor uploads and sends, from its AST. */
function predecessorImageFixture(source) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const strings = [];
  const objects = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) &&
      lineOf(tree, node) >= 147 &&
      lineOf(tree, node) <= 169
    )
      strings.push(node.text);
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) => property.name?.getText(tree) === 'msgtype',
      )
    )
      objects.push(node.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { strings, objects };
}

describe('Android message-quote contract ledger', () => {
  it('owns two stages, 13 direct + 10 inherited = 23 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_QUOTE_STAGES.map((entry) => entry.id)).toEqual(
      STAGES.map((stage) => stage.id),
    );
    expect(contract.MESSAGE_QUOTE_STAGES.map((entry) => entry.source)).toEqual([
      `${predecessor}:42-115`,
      `${predecessor}:117-217`,
    ]);
    expect(contract.MESSAGE_QUOTE_STAGES.map((entry) => entry.title)).toEqual(
      STAGES.map((stage) => stage.title),
    );
    expect(contract.MESSAGE_QUOTE_ASSERTION_RECORDS).toBe(23);
    expect(contract.MESSAGE_QUOTE_DIRECT).toBe(13);
    expect(contract.MESSAGE_QUOTE_INHERITED).toBe(10);
    expect([...contract.MESSAGE_QUOTE_STAGE_COUNTS]).toEqual([12, 11]);
    expect([...contract.MESSAGE_QUOTE_DIRECT_COUNTS]).toEqual([7, 6]);
    expect([...contract.MESSAGE_QUOTE_INHERITED_COUNTS]).toEqual([5, 5]);
    expect(contract.MESSAGE_QUOTE_HELPER_COUNTS).toEqual({
      openRoom: 2,
      sendComposerDraft: 3,
      waitForSent: 2,
      openMessageActionSheet: 3,
    });
    expect(new Set(ALL_IDENTITIES).size).toBe(23);
    // The issue's 20 identities are the 23 without the three Send-button waits.
    expect(
      contract.MESSAGE_QUOTE_STAGES.flatMap((entry) => entry.sites).filter(
        (site) => site.kind === 'direct' || site.helper !== 'sendComposerDraft',
      ),
    ).toHaveLength(20);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    for (const stage of STAGES) {
      const valid = identitiesOf(stage);
      expect(() =>
        contract.assertMessageQuoteRecords(stage.id, valid),
      ).not.toThrow();
      for (const invalid of [
        [],
        valid.slice(0, -1),
        [...valid, valid.at(-1)],
        [...valid].reverse(),
        valid.map((identity, index) => (index === 1 ? valid[0] : identity)),
      ])
        expect(() =>
          contract.assertMessageQuoteRecords(stage.id, invalid),
        ).toThrow();
      expect(() =>
        contract.messageQuoteAssertion(stage.id, 'not-owned'),
      ).toThrow();
    }
    expect(() =>
      contract.messageQuoteAssertion('quote-block', 'image-no-quote'),
    ).toThrow();
  });

  it('types exactly the predecessor paragraphs, answer, control, Room names and image fixture', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    expect(predecessorTemplates(source, BLOCK.span)).toMatchObject({
      runId: "`${testResourceId('run')}q`",
      roomName: '`Quote ${runId}`',
      first: '`alpha ${runId}`',
      second: '`omega ${runId}`',
      answer: '`my point ${runId}`',
    });
    expect(predecessorTemplates(source, CAPABILITY.span)).toMatchObject({
      runId: "`${testResourceId('run')}qn`",
      roomName: '`Quote none ${runId}`',
      body: '`plain ${runId}`',
    });
    const fixture = predecessorImageFixture(source);
    expect(fixture.strings).toEqual(
      expect.arrayContaining([
        'image/png',
        contract.QUOTE_IMAGE_PNG_BASE64,
        'base64',
      ]),
    );
    expect(fixture.objects).toEqual([
      "{ msgtype: 'm.image', body: 'shot.png', url: mxc }",
    ]);
    expect(contract.MESSAGE_QUOTE_RUN_SUFFIX).toEqual({
      'quote-block': 'q',
      'quote-capability': 'qn',
    });
    const run = 'run-1q';
    expect(contract.messageQuoteRoomName['quote-block'](run)).toBe(
      'Quote run-1q',
    );
    expect(contract.messageQuoteRoomName['quote-capability']('r')).toBe(
      'Quote none r',
    );
    expect(contract.quoteSourceBody(run)).toBe('alpha run-1q\n\nomega run-1q');
    expect(contract.quotedComposer(run)).toBe(
      '> alpha run-1q\n>\n> omega run-1q\n\n',
    );
    expect(contract.quoteEventBody(run)).toBe(
      '> alpha run-1q\n>\n> omega run-1q\n\nmy point run-1q',
    );
    expect(contract.quoteControl(run)).toBe('plain run-1q');
    expect(contract.quoteImageTransaction(run)).toBe('run-1qimg');
    expect(contract.QUOTE_IMAGE_FILENAME).toBe('shot.png');
    expect(contract.QUOTE_IMAGE_BODY).toBe('shot.png');
    expect(contract.QUOTE_IMAGE_MIME).toBe('image/png');
    const png = contract.quoteImagePng();
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(sha256(png)).toBe(
      sha256(Buffer.from(contract.QUOTE_IMAGE_PNG_BASE64, 'base64')),
    );
    expect(contract.PARAGRAPH_SENTINEL).toBe('1');
    // Lines 75–78: fill, two line breaks, then the second paragraph.
    expect(contract.quoteSourceSteps(run)).toEqual([
      { kind: 'fill', text: 'alpha run-1q', value: 'alpha run-1q' },
      { kind: 'enter', value: 'alpha run-1q\n' },
      { kind: 'enter', value: 'alpha run-1q\n\n' },
      {
        kind: 'append',
        text: 'omega run-1q',
        value: 'alpha run-1q\n\nomega run-1q',
      },
    ]);
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertMessageQuoteReceiptName } = await loadContract();
    for (const name of ['source-event', 'quote-event', 'image-fixture-event'])
      expect(() => assertMessageQuoteReceiptName(name)).not.toThrow();
    for (const name of [
      'message-quote.quote-block.room-ready',
      'message-quote-x',
      'Quote Event',
      'a/b',
      '',
    ])
      expect(() => assertMessageQuoteReceiptName(name)).toThrow();
  });

  it('pins the product quote, sheet, media and composer surfaces the journey relies on', () => {
    const markdown = read('libs/util/matrix/src/lib/markdown-edit.ts');
    for (const hook of [
      'export function quoteBlock(body: string): string {',
      ".map((line) => (line.trim() === '' ? '>' : `${BLOCK_MARKER.quote}${line}`))",
      'return `${quoted}\\n\\n`;',
    ])
      expect(markdown).toContain(hook);
    const composer = read(
      'libs/feature/rooms/src/lib/message-composer/message-composer.component.ts',
    );
    for (const hook of [
      'const text = existing ? block + existing : block;',
      'selectionStart: text.length,',
      'selectionEnd: text.length,',
    ])
      expect(composer).toContain(hook);
    const list = read(
      'libs/feature/rooms/src/lib/message-list/message-list-base.ts',
    );
    expect(list).toContain('canQuote: isQuotableMessage(message),');
    expect(list).toContain(
      'this.composer()?.insertQuote(quoteBlock(row.body));',
    );
    const quotable = read(
      'libs/data-access/timeline/src/lib/message-presentation.ts',
    );
    expect(quotable).toContain(
      "(message.kind === 'text' ||\n      message.kind === 'emote' ||\n      message.kind === 'notice') &&",
    );
    const sheet = read(
      'libs/feature/rooms/src/lib/message-actions/message-action-sheet.service.ts',
    );
    for (const hook of [
      'if (caps.canQuote) {',
      "testId: 'sheet-quote',",
      "testId: 'sheet-copy',",
      "testId: 'sheet-forward',",
      "buttons.push({ text: 'Cancel', role: 'cancel' });",
      "'Message actions',",
    ])
      expect(sheet).toContain(hook);
    expect(sheet.indexOf("testId: 'sheet-copy',")).toBeGreaterThan(
      sheet.indexOf('if (caps.canQuote) {'),
    );
    const surface = read(
      'libs/components/overlay/src/lib/action-sheet/trn-action-sheet.component.ts',
    );
    expect(surface).toContain('data-testid="action-sheet-surface"');
    expect(surface).toContain('[attr.data-testid]="button.testId"');
    const bubble = read(
      'libs/feature/rooms/src/lib/media-bubble/media-bubble.component.html',
    );
    expect(bubble).toContain("} @else if (kind() === 'image') {");
    expect(bubble).toContain('class="media media--image"');
    const row = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.html',
    );
    for (const hook of [
      'class="msg msg--event"',
      '[attr.data-mid]="r.id"',
      '<trn-media-attachment class="msg__media" [media]="r.media" />',
      'class="msg__text msg__text--html"',
      '<p class="msg__text">{{ r.body }}</p>',
    ])
      expect(row).toContain(hook);
  });
});

/* ------------------------------------------------------------------------ */
/* Authoritative events                                                      */
/* ------------------------------------------------------------------------ */

const ROOM = '!Room-AbC:example.test';
const SENDER = '@quote:example.test';
const SOURCE_ID = '$Source_A+b/C=d';
const QUOTE_ID = '$Quote_E+f/G=h';
const IMAGE_ID = '$Image_I+j/K=l';
const CONTROL_ID = '$Control_M+n/O=p';
const MXC = 'mxc://localhost/MediaAbCdEf012345';
const RUN = 'trn-quote-quote-block-0a1b2cq';
const CAP_RUN = 'trn-quote-quote-capability-0a1b2cqn';
const FIRST = `alpha ${RUN}`;
const SECOND = `omega ${RUN}`;
const ANSWER = `my point ${RUN}`;
const CONTROL = `plain ${CAP_RUN}`;
const QUOTE_HTML = `<blockquote>\n<p>${FIRST}</p>\n<p>${SECOND}</p>\n</blockquote>\n<p>${ANSWER}</p>\n`;

const textEvent = (event_id, body, content = {}, overrides = {}) => ({
  event_id,
  room_id: ROOM,
  sender: SENDER,
  type: 'm.room.message',
  content: { msgtype: 'm.text', body, ...content },
  ...overrides,
});
const sourceEvent = (content, overrides) =>
  textEvent(SOURCE_ID, `${FIRST}\n\n${SECOND}`, content, overrides);
const quoteEvent = (content = {}, overrides) =>
  textEvent(
    QUOTE_ID,
    `> ${FIRST}\n>\n> ${SECOND}\n\n${ANSWER}`,
    {
      format: 'org.matrix.custom.html',
      formatted_body: QUOTE_HTML,
      ...content,
    },
    overrides,
  );
const imageEvent = (content = {}, overrides = {}) => ({
  event_id: IMAGE_ID,
  room_id: ROOM,
  sender: SENDER,
  type: 'm.room.message',
  content: { msgtype: 'm.image', body: 'shot.png', url: MXC, ...content },
  ...overrides,
});
const controlEvent = (content, overrides) =>
  textEvent(CONTROL_ID, CONTROL, content, overrides);
const messagesPage = (...events) => ({
  chunk: [
    ...[...events].reverse(),
    { type: 'm.room.member', event_id: '$member', content: {} },
    { type: 'm.room.create', event_id: '$create', content: {} },
  ],
});

describe('Android message-quote authoritative event contract', () => {
  it('reads every Room message of the page, oldest first', async () => {
    const { authoritativeRoomMessages } = await loadContract();
    expect(
      authoritativeRoomMessages(messagesPage(sourceEvent(), quoteEvent())).map(
        (event) => event.event_id,
      ),
    ).toEqual([SOURCE_ID, QUOTE_ID]);
    for (const malformed of [null, {}, { chunk: {} }, { chunk: [null] }])
      expect(() => authoritativeRoomMessages(malformed)).toThrow();
    expect(read('e2e/android/account-workspace-fixtures.mts')).toContain(
      '`/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`',
    );
  });

  it('requires the exact source, then the exact quote with one blockquote and no relation', async () => {
    const { assertQuoteBlockRoom, authoritativeRoomMessages } =
      await loadContract();
    const room = (quoteId, ...events) =>
      assertQuoteBlockRoom(authoritativeRoomMessages(messagesPage(...events)), {
        roomId: ROOM,
        sender: SENDER,
        run: RUN,
        sourceId: SOURCE_ID,
        ...(quoteId ? { quoteId } : {}),
      });
    expect(() => room(undefined, sourceEvent())).not.toThrow();
    expect(() => room(QUOTE_ID, sourceEvent(), quoteEvent())).not.toThrow();
    const failing = [
      // Native multiline source: the blank line, the paragraphs and the send.
      [undefined],
      [undefined, sourceEvent({ body: `${FIRST}\n${SECOND}` })],
      [undefined, sourceEvent({ body: `${FIRST}\r\n\r\n${SECOND}` })],
      [undefined, sourceEvent({ body: `A${FIRST.slice(1)}\n\n${SECOND}` })],
      [undefined, sourceEvent({ body: `1${FIRST}\n\n${SECOND}` })],
      [undefined, sourceEvent({ body: `${FIRST}\n\n1${SECOND}` })],
      [undefined, sourceEvent({}, { event_id: '~!room:txn1' })],
      [undefined, sourceEvent({}, { sender: '@other:example.test' })],
      [undefined, sourceEvent({}, { room_id: '!other:example.test' })],
      [undefined, sourceEvent({ msgtype: 'm.notice' })],
      [undefined, sourceEvent(), quoteEvent()],
      // Ready quote: body, HTML, blockquote and relation.
      [QUOTE_ID, sourceEvent()],
      [QUOTE_ID, sourceEvent(), quoteEvent(), controlEvent()],
      [QUOTE_ID, sourceEvent(), quoteEvent({}, { event_id: '$Other' })],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({ body: `> ${FIRST}\n\n> ${SECOND}\n\n${ANSWER}` }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({ body: `> ${FIRST}\n>\n> ${SECOND}\n${ANSWER}` }),
      ],
      [QUOTE_ID, sourceEvent(), quoteEvent({ format: undefined })],
      [QUOTE_ID, sourceEvent(), quoteEvent({ formatted_body: undefined })],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          formatted_body: `<p>&gt; ${FIRST}</p><p>&gt; ${SECOND}</p><p>${ANSWER}</p>`,
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          formatted_body: `<blockquote><p>${FIRST}</p></blockquote><p>${SECOND}</p><p>${ANSWER}</p>`,
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          formatted_body: `<blockquote><p>${FIRST}</p></blockquote><blockquote><p>${SECOND}</p></blockquote><p>${ANSWER}</p>`,
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          formatted_body: `<blockquote><p>${FIRST}</p><p>${SECOND}</p><p>${ANSWER}</p></blockquote>`,
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          'm.relates_to': { 'm.in_reply_to': { event_id: SOURCE_ID } },
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          'm.relates_to': { rel_type: 'm.thread', event_id: SOURCE_ID },
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          formatted_body: `<mx-reply><blockquote>In reply to</blockquote></mx-reply>${QUOTE_HTML}`,
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          formatted_body: `<blockquote><p>${FIRST}</p><p>${SECOND}</p></blockquote><blockquote><p>${FIRST}</p><p>${SECOND}</p></blockquote><p>${ANSWER}</p>`,
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({
          formatted_body: `<mx-reply>In reply to</mx-reply>${QUOTE_HTML}`,
        }),
      ],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({ 'm.in_reply_to': { event_id: SOURCE_ID } }),
      ],
      [QUOTE_ID, sourceEvent(), quoteEvent({ 'm.new_content': {} })],
      [
        QUOTE_ID,
        sourceEvent(),
        quoteEvent({}, { sender: '@other:example.test' }),
      ],
    ];
    for (const [quoteId, ...events] of failing)
      expect(
        () => room(quoteId, ...events),
        JSON.stringify([quoteId, events.length]),
      ).toThrow();
  });

  it('requires the exact image fixture, then the exact text control after it', async () => {
    const { assertCapabilityRoom, authoritativeRoomMessages } =
      await loadContract();
    const room = (controlId, ...events) =>
      assertCapabilityRoom(authoritativeRoomMessages(messagesPage(...events)), {
        roomId: ROOM,
        sender: SENDER,
        run: CAP_RUN,
        imageId: IMAGE_ID,
        contentUri: MXC,
        ...(controlId ? { controlId } : {}),
      });
    expect(() => room(undefined, imageEvent())).not.toThrow();
    expect(() => room(CONTROL_ID, imageEvent(), controlEvent())).not.toThrow();
    for (const [controlId, ...events] of [
      [undefined],
      [undefined, imageEvent({ body: 'other.png' })],
      [undefined, imageEvent({ msgtype: 'm.file' })],
      [undefined, imageEvent({ url: 'mxc://localhost/Other' })],
      [undefined, imageEvent({}, { event_id: '$Other' })],
      [undefined, imageEvent(), controlEvent()],
      [CONTROL_ID, imageEvent()],
      [CONTROL_ID, controlEvent(), imageEvent()],
      [CONTROL_ID, imageEvent(), controlEvent({ body: `Plain ${CAP_RUN}` })],
      [CONTROL_ID, imageEvent(), controlEvent({ body: `1plain ${CAP_RUN}` })],
      [
        CONTROL_ID,
        imageEvent(),
        controlEvent({
          'm.relates_to': { 'm.in_reply_to': { event_id: IMAGE_ID } },
        }),
      ],
    ])
      expect(
        () => room(controlId, ...events),
        JSON.stringify([controlId, events.length]),
      ).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Simulated installed app: the exact journey against production-shaped DOM  */
/* ------------------------------------------------------------------------ */

const USER = {
  userId: SENDER,
  username: 'quote',
  password: 'quote-pass"word\\token',
  homeserver: 'https://localhost:8448',
};
const ROUTE = `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}?account=${encodeURIComponent(SENDER)}&view=rooms`;
const escapeHtml = (value) =>
  String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');

/**
 * A minimal CommonMark model of the renderer: consecutive `>` lines form one
 * blockquote (a bare `>` is a paragraph break inside it), and an unmarked blank
 * line ends it, which is exactly the hazard the quote fixture exists to catch.
 */
function renderMarkdown(body) {
  const blocks = [];
  let quote = null;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length)
      (quote ?? blocks).push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('>')) {
      if (!quote) {
        flush();
        quote = [];
      }
      const text = line.replace(/^> ?/u, '');
      if (text === '') flush();
      else paragraph.push(escapeHtml(text));
      continue;
    }
    flush();
    if (quote) {
      blocks.push(`<blockquote>${quote.join('')}</blockquote>`);
      quote = null;
    }
    if (line !== '') paragraph.push(escapeHtml(line));
  }
  flush();
  if (quote) blocks.push(`<blockquote>${quote.join('')}</blockquote>`);
  return blocks.join('');
}

/**
 * A model of the installed app, its Synapse Room and Gboard. The DOM is
 * rendered in production shape and every observer expression runs against it
 * in jsdom; native actions resolve their target as the client does (exactly
 * one match) and the server holds the events the product would send. A settled
 * state aborts instead of waiting.
 */
function simulatedQuoteApp(stageId, faults = {}) {
  const controller = new AbortController();
  const run = faults.run ?? (stageId === 'quote-block' ? RUN : CAP_RUN);
  const roomName =
    stageId === 'quote-block' ? `Quote ${run}` : `Quote none ${run}`;
  const state = {
    signedIn: false,
    roomsShown: false,
    roomOpen: false,
    composer: { value: '', start: 0, end: 0, focused: false },
    keyboard: false,
    sheet: null,
    rows: [],
    events: [],
    actions: [],
    written: [],
    txn: 0,
    enters: 0,
  };
  let lastSignature = '';
  let stale = 0;
  const ids = [SOURCE_ID, QUOTE_ID];
  const progress = () => {
    for (const row of state.rows) {
      if (!row.id.startsWith('~')) continue;
      if (faults.echoNever === row.kind || faults.echoNever === true) continue;
      if (--row.echoIn > 0) continue;
      row.id = row.serverId;
      const html =
        row.body.includes('\n>') || row.body.startsWith('>')
          ? renderMarkdown(row.body)
          : null;
      const content = { msgtype: 'm.text', body: row.body };
      if (html && !faults.plainFormat) {
        content.format = 'org.matrix.custom.html';
        content.formatted_body = html;
      }
      if (faults.replyRelation && html)
        content['m.relates_to'] = { 'm.in_reply_to': { event_id: SOURCE_ID } };
      state.events.push(textEvent(row.serverId, row.body, content));
      state.events.at(-1).content = content;
      row.html = html;
    }
  };
  const composerSelector = '[data-testid="composer-input"]';
  const sheetButtons = () => {
    const row = state.sheet;
    const quotable = row.kind === 'text' && !faults.textQuoteMissing;
    const offerQuote = quotable || (row.kind === 'image' && faults.imageQuote);
    return [
      '<button data-testid="sheet-reply">Reply</button>',
      '<button data-testid="sheet-react-more">More reactions…</button>',
      offerQuote ? '<button data-testid="sheet-quote">Quote</button>' : '',
      row.kind === 'image' && faults.imageCopyMissing
        ? ''
        : '<button data-testid="sheet-copy">Copy text</button>',
      '<button data-testid="sheet-copy-link">Copy link</button>',
      '<button data-testid="sheet-forward">Forward</button>',
      '<button data-testid="sheet-view-source">View source</button>',
      '<button>Cancel</button>',
    ].join('');
  };
  const renderRow = (row) => {
    const head =
      '<div class="msg__head"><span class="msg__author">quote</span></div>';
    if (row.kind === 'image' && faults.imageMissing) return '';
    if (row.kind === 'image') {
      // Production: the fixture has no info.mimetype, so it renders as a
      // named download tile (application/octet-stream).
      const tile =
        '<button class="media media--file" aria-label="Download shot.png"><span class="media__icon" aria-hidden="true">↓</span><span class="media__meta"><span class="media__name">shot.png</span><span class="media__sub">application/octet-stream</span></span></button>';
      const media = faults.imageTwoMedia ? `${tile}${tile}` : tile;
      const caption = faults.imageRowText
        ? '<p class="msg__text">shot.png</p>'
        : '';
      return `<div class="msg" data-mid="${escapeHtml(row.id)}"><div class="msg__body"><div class="msg__content">${head}<trn-media-attachment class="msg__media"><trn-media-bubble>${media}</trn-media-bubble></trn-media-attachment>${caption}</div></div></div>`;
    }
    let html = row.html;
    if (html && faults.renderNoBlockquote)
      html = row.body
        .split('\n')
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');
    if (html && faults.renderAnswerInside)
      html = html.replace(/<\/blockquote>(<p>[^<]*<\/p>)$/u, '$1</blockquote>');
    if (html && faults.renderTwoQuotes)
      html = html.replace('</p><p>', '</p></blockquote><blockquote><p>');
    const text = html
      ? `<div class="msg__text msg__text--html">${html}</div>`
      : `<p class="msg__text">${escapeHtml(row.body)}</p>`;
    return `<div class="msg" data-mid="${escapeHtml(row.id)}"><div class="msg__body"><div class="msg__content">${head}${text}</div></div></div>`;
  };
  const render = () => {
    const parts = ['<nav>'];
    if (state.signedIn)
      parts.push('<button data-testid="rail-rooms">Rooms</button>');
    parts.push('</nav>');
    if (state.roomsShown)
      parts.push(
        `<aside><div class="channel">${escapeHtml(roomName)}</div></aside>`,
      );
    if (state.roomOpen) {
      parts.push(
        '<div class="scroll"><div class="msg msg--event" data-mid="$create"><span class="msg__event-text">created the room</span></div>',
      );
      for (const row of state.rows) parts.push(renderRow(row));
      parts.push('</div>');
      parts.push(
        `<trn-message-composer><textarea data-testid="composer-input" placeholder="${escapeHtml(`Message #${roomName}`)}"></textarea><button data-testid="composer-send"${state.composer.value.trim() ? '' : ' disabled'}>Send</button></trn-message-composer>`,
      );
    }
    if (state.sheet)
      parts.push(
        `<div role="dialog" aria-label="Message actions"><div data-testid="action-sheet-surface"><div class="overflow-y-auto">${sheetButtons()}</div></div></div>`,
      );
    return parts.join('');
  };
  const dom = () => {
    const jsdom = new JSDOM(`<main>${render()}</main>`, {
      url: state.roomOpen ? ROUTE : 'https://localhost/rooms?account=x',
    });
    const { window } = jsdom;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 120,
      height: 20,
      bottom: 20,
      right: 120,
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
    const signature = JSON.stringify([render(), state.events, state.composer]);
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
      focused: state.composer.focused && element.matches(composerSelector),
      disabled: element.matches(':disabled'),
      value: 'value' in element ? element.value : null,
      unobstructedCenter: true,
      rect: { x: 0, y: 0, width: 120, height: 20, bottom: 20, right: 120 },
      scrollHeight: 400,
      clientHeight: 200,
    }));
  const actionable = (selector, filter) => {
    const found = matches(selector, filter);
    if (found.length !== 1 || found[0].matches(':disabled'))
      throw new Error(`Simulated target is not actionable: ${selector}`);
    return found[0];
  };
  const insert = (text) => {
    const { value, start, end } = state.composer;
    state.composer.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
    state.composer.start = state.composer.end = start + text.length;
  };
  /** Android capitalises a lowercase letter typed at the start of a paragraph. */
  const autoCap = (text) => {
    const before = state.composer.value.slice(0, state.composer.start);
    return (before === '' || before.endsWith('\n')) && /^[a-z]/u.test(text)
      ? `${text[0].toUpperCase()}${text.slice(1)}`
      : text;
  };
  const rowOf = (element) => {
    const mid = element.closest('.msg').getAttribute('data-mid');
    return state.rows.find((row) => row.id === mid);
  };
  const client = {
    workspaceRoot: root,
    applicationId: 'eu.qwky.trinity',
    signal: controller.signal,
    device: {
      async runFlow(flow, env) {
        assert(flow.endsWith(APPEND_FLOW), 'Only the append flow is modelled');
        state.actions.push(`append|${env.SECRET_TEXT.slice(0, 1)}`);
        assert(
          state.composer.focused,
          'The append types into the focused composer',
        );
        insert(autoCap(env.SECRET_TEXT));
      },
    },
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
      state.keyboard = false;
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
        `tap:${selector}${filter.text || filter.exactText ? `|${filter.text ?? filter.exactText}` : ''}`,
      );
      const element = actionable(selector, filter);
      const testId = element.getAttribute('data-testid');
      if (testId === 'rail-rooms') state.roomsShown = true;
      else if (element.classList.contains('channel')) state.roomOpen = true;
      else if (testId === 'composer-send') {
        const kind = state.composer.value.startsWith('>') ? 'quote' : 'text';
        state.rows.push({
          id: `~!Room:txn${++state.txn}`,
          serverId: stageId === 'quote-block' ? ids[state.txn - 1] : CONTROL_ID,
          echoIn: 2,
          kind: 'text',
          body: state.composer.value,
          html: null,
          sent: kind,
        });
        state.composer = {
          value: '',
          start: 0,
          end: 0,
          focused: state.composer.focused,
        };
      } else if (testId === 'sheet-quote') {
        const body = state.sheet.body;
        let block = body
          .split('\n')
          .map((line) =>
            line.trim() === ''
              ? faults.quoteUnmarkedBlank
                ? ''
                : '>'
              : `> ${line}`,
          )
          .join('\n');
        block += faults.quoteNoTrailingBlank ? '\n' : '\n\n';
        state.sheet = null;
        const text = block + state.composer.value;
        const caret = faults.quoteCaretStart ? 0 : text.length;
        state.composer = {
          value: text,
          start: caret,
          end: caret,
          focused: true,
        };
      } else if (element.textContent.trim() === 'Cancel') {
        if (!faults.cancelIgnored) state.sheet = null;
      } else throw new Error(`Unmodelled simulated tap ${selector}`);
    },
    async focusCurrent(selector) {
      state.actions.push(`focus:${selector}`);
      actionable(selector, {});
      state.composer.focused = true;
      state.composer.start = state.composer.end = state.composer.value.length;
      state.keyboard = true;
    },
    async fillFocused(selector, value, sentinel = 'x') {
      state.actions.push(`fill:${selector}|${sentinel}`);
      assert.equal(selector, composerSelector);
      assert(state.composer.focused, `${selector} is focused before the fill`);
      assert.equal(state.composer.value, '', 'The focused fill starts empty');
      // Measured on the emulator: a letter sentinel joined to a lowercase
      // word is autocorrected (`xplain` became `Explain`, so removing the
      // first character left `xplain`); a digit-led word is kept.
      let typed = autoCap(`${sentinel}${value}`);
      if (/^\p{L}$/u.test(sentinel))
        typed = `E${typed.toLowerCase().slice(0, 1)}${typed.slice(1)}`;
      state.composer.value = typed.slice(1);
      state.composer.start = state.composer.end = state.composer.value.length;
    },
    async key(name) {
      state.actions.push(`key:${name}`);
      const { value, start } = state.composer;
      if (name === 'enter') {
        state.enters++;
        if (faults.enterSwallowed === state.enters) return;
        insert(faults.enterDoubles ? '\n\n' : '\n');
      } else if (name === 'arrowLeft') {
        if (faults.arrowIgnored && !state.arrowDropped) {
          state.arrowDropped = true;
          return;
        }
        state.composer.start = state.composer.end = Math.max(0, start - 1);
      } else if (name === 'backspace') {
        if (faults.sentinelKept) return;
        state.composer.value = `${value.slice(0, start - 1)}${value.slice(start)}`;
        state.composer.start = state.composer.end = start - 1;
      } else throw new Error(`Unmodelled key ${name}`);
    },
    async keyCombination(name) {
      state.actions.push(`chord:${name}`);
      assert.equal(name, 'documentEnd');
      state.composer.start = state.composer.end = state.composer.value.length;
    },
    async longPressCurrent(selector, filter = {}) {
      state.actions.push(
        `long-press:${selector}${filter.text ? `|${filter.text}` : ''}`,
      );
      const found = matches(selector, filter);
      if (found.length !== 1)
        throw new Error(`Simulated long press needs one target: ${selector}`);
      const row = rowOf(found[0]);
      assert(row, 'The long press lands on a message row');
      state.sheet =
        faults.pressLandsOnControl && row.kind === 'image'
          ? state.rows.find((candidate) => candidate.kind === 'text')
          : row;
    },
    async swipeCurrent(selector) {
      state.actions.push(`swipe:${selector}`);
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture(name) {
      state.actions.push(`capture:${name}`);
    },
  };
  const fixtures = {
    async account() {
      return USER;
    },
    async createRoom(_account, { name, preset }) {
      assert.equal(preset, 'private_chat');
      return { id: ROOM, name };
    },
    async sendImageMessage(account, roomId, image) {
      assert.equal(account, USER);
      assert.equal(roomId, ROOM);
      state.actions.push(`rest-image:${image.filename}|${image.body}`);
      state.image = image;
      const body = faults.imageFixtureBody ?? image.body;
      state.events.push(imageEvent({ body }));
      state.rows.push({ id: IMAGE_ID, kind: 'image', body });
      return { contentUri: MXC, eventId: IMAGE_ID };
    },
    async roomMessages(account, roomId) {
      assert.equal(account, USER);
      assert.equal(roomId, ROOM);
      settle();
      return messagesPage(...state.events);
    },
  };
  return { client, fixtures, state, controller, run };
}

async function simulatedStage(stageId, faults = {}) {
  const { MESSAGE_QUOTE_STAGES } = await loadContract();
  const app = simulatedQuoteApp(stageId, faults);
  const context = {
    entry: MESSAGE_QUOTE_STAGES.find((entry) => entry.id === stageId),
    records: [],
    identities: new Set(),
    receipts: 0,
    client: app.client,
    fixtures: app.fixtures,
    secrets: {},
    safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
    native: false,
    ledger: { run: app.run, eventIds: [] },
  };
  return { ...app, context };
}

const COMPOSER = '[data-testid="composer-input"]';
const READY_ROW = '.scroll .msg[data-mid^="$"]';
const appendKeys = (line) => [
  'append|1',
  ...Array.from({ length: line.length }, () => 'key:arrowLeft'),
  'key:backspace',
  'chord:documentEnd',
];
const BLOCK_ACTIONS = [
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|Quote ${RUN}`,
  `focus:${COMPOSER}`,
  `fill:${COMPOSER}|1`,
  'key:enter',
  'key:enter',
  ...appendKeys(SECOND),
  'hide-keyboard',
  'tap:[data-testid="composer-send"]',
  'hide-keyboard',
  `long-press:${READY_ROW}|${FIRST}`,
  'tap:[data-testid="sheet-quote"]',
  ...appendKeys(ANSWER),
  'hide-keyboard',
  'tap:[data-testid="composer-send"]',
];
const CAPABILITY_ACTIONS = [
  'rest-image:shot.png|shot.png',
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|Quote none ${CAP_RUN}`,
  `focus:${COMPOSER}`,
  `fill:${COMPOSER}|1`,
  'hide-keyboard',
  'tap:[data-testid="composer-send"]',
  'hide-keyboard',
  `long-press:${READY_ROW}|${CONTROL}`,
  'tap:[role="dialog"][aria-label="Message actions"] button|Cancel',
  'hide-keyboard',
  `long-press:${READY_ROW}|shot.png`,
];

const runnerOf = async (stageId) => {
  const journeys = await loadJourneys();
  return stageId === 'quote-block'
    ? journeys.runQuoteBlock
    : journeys.runQuoteCapability;
};

/** Written evidence carries digests and booleans, never an identifier or credential. */
function assertIdFreeEvidence(state, secrets) {
  const written = JSON.stringify(state.written);
  for (const value of secrets) expect(written).not.toContain(value);
  // Selectors reach the job log: none carries an identifier.
  for (const action of state.actions)
    expect(action.split('|')[0]).not.toMatch(
      /[$!~][A-Za-z0-9_]|data-mid[*~|]?=|mxc:/u,
    );
}

describe('Android message-quote native journeys against a simulated installed app', () => {
  it('drives the exact native quote sequence and records all twelve identities in order', async () => {
    const run = await runnerOf('quote-block');
    const { context, state } = await simulatedStage('quote-block');
    await run(context);
    expect(context.records).toEqual(identitiesOf(BLOCK));
    expect(state.actions).toEqual(BLOCK_ACTIONS);
    expect(state.events.map((event) => event.event_id)).toEqual([
      SOURCE_ID,
      QUOTE_ID,
    ]);
    expect(state.events[0].content.body).toBe(`${FIRST}\n\n${SECOND}`);
    expect(state.events[1].content.body).toBe(
      `> ${FIRST}\n>\n> ${SECOND}\n\n${ANSWER}`,
    );
    expect(context.ledger.eventIds).toEqual([SOURCE_ID, QUOTE_ID]);
    expect(
      state.written
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('receipt-')),
    ).toEqual([
      'receipt-01-source-native-draft',
      'receipt-02-source-sent',
      'receipt-03-source-event',
      'receipt-04-quote-picked',
      'receipt-05-answer-native-draft',
      'receipt-06-answer-sent',
      'receipt-07-quote-event',
    ]);
    assertIdFreeEvidence(state, [
      ROOM,
      SOURCE_ID,
      QUOTE_ID,
      SENDER,
      USER.password,
      RUN,
    ]);
    const written = JSON.stringify(state.written);
    expect(written).toContain(sha256(SOURCE_ID));
    expect(written).toContain(sha256(QUOTE_ID));
    expect(written).toContain(sha256(ROOM));
  });

  it('drives the exact native capability sequence and records all eleven identities in order', async () => {
    const run = await runnerOf('quote-capability');
    const { context, state } = await simulatedStage('quote-capability');
    await run(context);
    expect(context.records).toEqual(identitiesOf(CAPABILITY));
    expect(state.actions).toEqual(CAPABILITY_ACTIONS);
    expect(state.image.filename).toBe('shot.png');
    expect(state.image.body).toBe('shot.png');
    expect(state.image.transactionId).toBe(`${CAP_RUN}img`);
    expect(sha256(state.image.png)).toBe(
      sha256(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
    );
    expect(state.events.map((event) => event.event_id)).toEqual([
      IMAGE_ID,
      CONTROL_ID,
    ]);
    expect(context.ledger.eventIds).toEqual([IMAGE_ID, CONTROL_ID]);
    expect(context.ledger.contentUri).toBe(MXC);
    // The image sheet stays open: Quote absence is read inside it, with Copy.
    expect(state.sheet?.kind).toBe('image');
    assertIdFreeEvidence(state, [
      ROOM,
      IMAGE_ID,
      CONTROL_ID,
      SENDER,
      MXC,
      CAP_RUN,
    ]);
  });

  it('models the hazards: no sentinel is capitalised, a letter sentinel is autocorrected', async () => {
    const { context, state } = await simulatedStage('quote-block');
    state.roomOpen = true;
    await context.client.focusCurrent(COMPOSER);
    await context.client.device.runFlow(join(root, APPEND_FLOW), {
      SECRET_TEXT: 'omega',
    });
    expect(state.composer.value).toBe('Omega');
    const other = await simulatedStage('quote-capability');
    other.state.roomOpen = true;
    await other.context.client.focusCurrent(COMPOSER);
    await other.context.client.fillFocused(COMPOSER, 'plain one', 'x');
    expect(other.state.composer.value).toBe('xplain one');
    const digit = await simulatedStage('quote-capability');
    digit.state.roomOpen = true;
    await digit.context.client.focusCurrent(COMPOSER);
    await digit.context.client.fillFocused(COMPOSER, 'plain one', '1');
    expect(digit.state.composer.value).toBe('plain one');
  });

  const FAULTS = [
    // Native multiline source.
    ['quote-block', { enterSwallowed: 2 }, 'source-send-enabled'],
    ['quote-block', 'enterDoubles', 'source-send-enabled'],
    ['quote-block', 'sentinelKept', 'source-send-enabled'],
    ['quote-block', 'arrowIgnored', 'source-send-enabled'],
    // Server readiness of the source.
    ['quote-block', { echoNever: true }, 'source-server-echo'],
    // Exact composer quote insertion.
    ['quote-block', 'quoteUnmarkedBlank', 'composer-quote'],
    ['quote-block', 'quoteNoTrailingBlank', 'composer-quote'],
    ['quote-block', 'quoteCaretStart', 'composer-quote'],
    // Ready quote event body, HTML and relation.
    ['quote-block', 'replyRelation', 'answer-visible'],
    ['quote-block', 'plainFormat', 'answer-visible'],
    // Rendered blockquote and answer exclusion.
    ['quote-block', 'renderNoBlockquote', 'answer-visible'],
    ['quote-block', 'renderAnswerInside', 'answer-visible'],
    ['quote-block', 'renderTwoQuotes', 'answer-visible'],
    // Image fixture.
    ['quote-capability', { imageFixtureBody: 'other.png' }, 'room-ready'],
    // Text positive control and Cancel.
    ['quote-capability', { echoNever: true }, 'control-server-echo'],
    ['quote-capability', 'textQuoteMissing', 'text-quote-visible'],
    ['quote-capability', 'cancelIgnored', 'text-sheet-closed'],
    // Image Copy-positive and Quote-negative capability.
    ['quote-capability', 'imageMissing', 'image-visible'],
    ['quote-capability', 'imageTwoMedia', 'image-visible'],
    ['quote-capability', 'imageRowText', 'image-visible'],
    ['quote-capability', 'imageCopyMissing', 'image-copy-visible'],
    ['quote-capability', 'imageQuote', 'image-no-quote'],
    ['quote-capability', 'pressLandsOnControl', 'image-no-quote'],
  ];

  for (const [stageId, fault, firstMissing] of FAULTS) {
    const name = typeof fault === 'string' ? fault : Object.keys(fault)[0];
    it(`${stageId} fails before ${firstMissing} when ${name}`, async () => {
      const run = await runnerOf(stageId);
      const faults = typeof fault === 'string' ? { [fault]: true } : fault;
      const { context, state } = await simulatedStage(stageId, faults);
      await expect(run(context)).rejects.toThrow();
      const identities = identitiesOf(
        STAGES.find((stage) => stage.id === stageId),
      );
      const index = identities.indexOf(
        `message-quote.${stageId}.${firstMissing}`,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(context.records).toEqual(identities.slice(0, index));
      // A failed source or quote never reaches a send of the answer.
      if (stageId === 'quote-block' && index <= 5)
        expect(
          state.actions.filter(
            (action) => action === 'tap:[data-testid="composer-send"]',
          ).length,
        ).toBeLessThanOrEqual(1);
    });
  }

  it('never long-presses a pending local echo or another row', async () => {
    for (const stageId of ['quote-block', 'quote-capability']) {
      const run = await runnerOf(stageId);
      const { context, state } = await simulatedStage(stageId);
      const press = context.client.longPressCurrent;
      const pressed = [];
      context.client.longPressCurrent = async (selector, filter) => {
        await press(selector, filter);
        pressed.push(state.sheet.id);
      };
      await run(context);
      expect(pressed).toEqual(
        stageId === 'quote-block' ? [SOURCE_ID] : [CONTROL_ID, IMAGE_ID],
      );
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Read-only renderer observation (jsdom)                                    */
/* ------------------------------------------------------------------------ */

function evaluateIn(body, expression, setup = () => {}) {
  const dom = new JSDOM(`<main>${body}</main>`, { url: ROUTE });
  const { window } = dom;
  setup(window.document);
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

const textRow = (id, text, html = null, style = '') =>
  `<div class="msg" data-mid="${id}"${style}><div class="msg__body"><div class="msg__content"><div class="msg__head"><span class="msg__author">quote</span></div>${
    html === null
      ? `<p class="msg__text">${text}</p>`
      : `<div class="msg__text msg__text--html">${html}</div>`
  }</div></div></div>`;
const imageRowHtml = (id = IMAGE_ID, extra = '') =>
  `<div class="msg" data-mid="${id}"><div class="msg__body"><div class="msg__content"><trn-media-attachment class="msg__media"><trn-media-bubble><button class="media media--file" aria-label="Download shot.png"><span class="media__icon" aria-hidden="true">↓</span><span class="media__meta"><span class="media__name">shot.png</span><span class="media__sub">application/octet-stream</span></span></button></trn-media-bubble></trn-media-attachment>${extra}</div></div></div>`;
const scroll = (...rows) =>
  `<div class="scroll"><div class="msg msg--event" data-mid="$create">created the room</div>${rows.join('')}</div>`;
const QUOTE_ROW_HTML = `<blockquote><p>${FIRST}</p><p>${SECOND}</p></blockquote><p>${ANSWER}</p>`;

describe('Android message-quote read-only renderer observation (jsdom)', () => {
  it('observes the one quote row and its one blockquote, and rejects look-alikes', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const observe = (body) =>
      contract.parseTimeline(evaluateIn(body, timelineExpression()));
    const production = observe(
      scroll(
        textRow(SOURCE_ID, `${FIRST}\n\n${SECOND}`),
        textRow(QUOTE_ID, '', QUOTE_ROW_HTML),
      ),
    );
    const row = contract.assertAnswerVisible(production, ANSWER, QUOTE_ID);
    const quote = contract.assertOneBlockquote(row);
    expect(() => contract.assertQuotesFirst(quote, RUN)).not.toThrow();
    expect(() => contract.assertQuotesSecond(quote, RUN)).not.toThrow();
    expect(() => contract.assertAnswerOutside(row, quote, RUN)).not.toThrow();
    // Before the quote exists the source row alone carries the first
    // paragraph; afterwards the text no longer identifies one row.
    const before = observe(scroll(textRow(SOURCE_ID, `${FIRST}\n\n${SECOND}`)));
    expect(contract.assertSameRow(before, FIRST, SOURCE_ID).id).toBe(SOURCE_ID);
    expect(() => contract.assertSameRow(before, FIRST, QUOTE_ID)).toThrow();
    expect(() => contract.assertRowVisible(production, FIRST)).toThrow();
    const variants = [
      // Plain quote-looking text, no real blockquote.
      `<p>&gt; ${FIRST}</p><p>&gt; ${SECOND}</p><p>${ANSWER}</p>`,
      // The blank line ended the quote.
      `<blockquote><p>${FIRST}</p></blockquote><p>${SECOND}</p><p>${ANSWER}</p>`,
      // Two blockquotes.
      `<blockquote><p>${FIRST}</p></blockquote><blockquote><p>${SECOND}</p></blockquote><p>${ANSWER}</p>`,
      // The answer inside.
      `<blockquote><p>${FIRST}</p><p>${SECOND}</p><p>${ANSWER}</p></blockquote>`,
      // A duplicated quote, each copy holding both paragraphs.
      `<blockquote><p>${FIRST}</p><p>${SECOND}</p></blockquote><blockquote><p>${FIRST}</p><p>${SECOND}</p></blockquote><p>${ANSWER}</p>`,
    ];
    // A blockquote outside the rendered message text is not the quote.
    const stray = observe(
      scroll(
        `<div class="msg" data-mid="${QUOTE_ID}"><div class="msg__body"><div class="msg__content"><div class="msg__text msg__text--html">${QUOTE_ROW_HTML}</div><trn-link-preview><blockquote>${FIRST}</blockquote></trn-link-preview></div></div></div>`,
      ),
    );
    expect(() =>
      contract.assertOneBlockquote(
        contract.assertAnswerVisible(stray, ANSWER, QUOTE_ID),
      ),
    ).toThrow();
    for (const html of variants) {
      const view = observe(scroll(textRow(QUOTE_ID, '', html)));
      expect(() => {
        const candidate = contract.assertAnswerVisible(view, ANSWER, QUOTE_ID);
        const found = contract.assertOneBlockquote(candidate);
        contract.assertQuotesFirst(found, RUN);
        contract.assertQuotesSecond(found, RUN);
        contract.assertAnswerOutside(candidate, found, RUN);
      }, html).toThrow();
    }
    // A local echo, another event id, a hidden row or a doubled row.
    for (const body of [
      scroll(textRow('~!room:txn1', '', QUOTE_ROW_HTML)),
      scroll(textRow('$Other', '', QUOTE_ROW_HTML)),
      scroll(
        textRow(QUOTE_ID, '', QUOTE_ROW_HTML, ' style="visibility:hidden"'),
      ),
      scroll(
        textRow(QUOTE_ID, '', QUOTE_ROW_HTML),
        textRow('$Two', '', QUOTE_ROW_HTML),
      ),
      `${scroll()}${textRow(QUOTE_ID, '', QUOTE_ROW_HTML)}`,
    ])
      expect(() =>
        contract.assertAnswerVisible(observe(body), ANSWER, QUOTE_ID),
      ).toThrow();
  });

  it('observes the exact image row and rejects an image with text, a second image or another id', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const observe = (body) =>
      contract.parseTimeline(evaluateIn(body, timelineExpression()));
    const view = observe(scroll(imageRowHtml(), textRow(CONTROL_ID, CONTROL)));
    const found = contract.assertImageRow(view, IMAGE_ID);
    expect(found.media).toBe(1);
    expect(found.mediaKinds).toEqual(['media--file']);
    // As the predecessor finds it: the attachment name, never message text.
    expect(found.text).toContain('shot.png');
    expect(found.texts).toEqual([]);
    for (const body of [
      scroll(textRow(CONTROL_ID, CONTROL)),
      scroll(imageRowHtml('$Other')),
      scroll(imageRowHtml(), imageRowHtml('$Two')),
      scroll(imageRowHtml(IMAGE_ID, '<p class="msg__text">shot.png</p>')),
    ])
      expect(() => contract.assertImageRow(observe(body), IMAGE_ID)).toThrow();
    // The id-free long-press selector and filter match exactly the image row.
    const dom = new JSDOM(
      `<main>${scroll(imageRowHtml(), textRow(CONTROL_ID, CONTROL))}</main>`,
    );
    expect(
      [...dom.window.document.querySelectorAll(READY_ROW)]
        .filter((row) => row.textContent.includes('shot.png'))
        .map((row) => row.getAttribute('data-mid')),
    ).toEqual([IMAGE_ID]);
    // A pending image or a second attachment is not the one exact row.
    expect(() =>
      contract.assertImageRow(
        observe(scroll(imageRowHtml('~!pending'))),
        IMAGE_ID,
      ),
    ).toThrow();
  });

  it('observes the sheet controls, the exact Cancel and a closed sheet', async () => {
    const contract = await loadContract();
    const { sheetExpression } = await loadObserver();
    const sheetHtml = (buttons) =>
      `<div role="dialog" aria-label="Message actions"><div data-testid="action-sheet-surface"><div class="overflow-y-auto">${buttons}</div></div></div>`;
    const text = contract.parseSheet(
      evaluateIn(
        sheetHtml(
          '<button data-testid="sheet-reply">Reply</button><button data-testid="sheet-quote">Quote</button><button data-testid="sheet-copy">Copy text</button><button data-testid="sheet-forward">Forward</button><button>Cancel</button>',
        ),
        sheetExpression(),
      ),
    );
    expect(() => contract.assertQuoteVisible(text)).not.toThrow();
    expect(text.cancel).toEqual({ count: 1, visible: true });
    expect(() => contract.assertNoQuote(text)).toThrow();
    const image = contract.parseSheet(
      evaluateIn(
        sheetHtml(
          '<button data-testid="sheet-reply">Reply</button><button data-testid="sheet-copy">Copy text</button><button data-testid="sheet-forward">Forward</button><button>Cancel</button>',
        ),
        sheetExpression(),
      ),
    );
    expect(() => contract.assertNoQuote(image)).not.toThrow();
    expect(() => contract.assertQuoteVisible(image)).toThrow();
    // Quote absence without the opened sheet or its Copy control is not success.
    const closed = contract.parseSheet(
      evaluateIn('<main></main>', sheetExpression()),
    );
    expect(() => contract.assertSheetClosed(closed)).not.toThrow();
    expect(() => contract.assertNoQuote(closed)).toThrow();
    const noCopy = contract.parseSheet(
      evaluateIn(
        sheetHtml(
          '<button data-testid="sheet-forward">Forward</button><button>Cancel</button>',
        ),
        sheetExpression(),
      ),
    );
    expect(() => contract.assertNoQuote(noCopy)).toThrow();
    for (const buttons of [
      '<button data-testid="sheet-quote" style="display:none">Quote</button><button data-testid="sheet-forward">Forward</button>',
      '<button data-testid="sheet-quote">Quote</button><button data-testid="sheet-quote">Quote</button><button data-testid="sheet-forward">Forward</button>',
      '<button data-testid="sheet-quote">Quote</button>',
    ])
      expect(() =>
        contract.assertQuoteVisible(
          contract.parseSheet(
            evaluateIn(sheetHtml(buttons), sheetExpression()),
          ),
        ),
      ).toThrow();
    const open = contract.parseSheet(
      evaluateIn(sheetHtml('<button>Cancel</button>'), sheetExpression()),
    );
    expect(() => contract.assertSheetClosed(open)).toThrow();
    // A dialog left behind without any control is not a closed sheet.
    const leftover = contract.parseSheet(
      evaluateIn(sheetHtml(''), sheetExpression()),
    );
    expect(() => contract.assertSheetClosed(leftover)).toThrow();
    // Two stacked sheets are not the one native sheet, whatever else is visible.
    expect(() =>
      contract.assertNativeSheetReady({ ...text, dialogs: 2 }),
    ).toThrow();
    for (const malformed of [
      null,
      { ...text, dialogs: -1 },
      { ...text, quote: undefined },
      { ...text, copy: { count: 1, visible: 'yes' } },
    ])
      expect(() => contract.parseSheet(malformed)).toThrow();
  });

  it('observes the exact composer value and caret, and parses only complete observations', async () => {
    const contract = await loadContract();
    const { composerExpression } = await loadObserver();
    const composer = (value, caret = value.length, focused = true) =>
      contract.parseComposer(
        evaluateIn(
          `<trn-message-composer><textarea data-testid="composer-input" placeholder="Message #Quote ${RUN}"></textarea><button data-testid="composer-send">Send</button></trn-message-composer>`,
          composerExpression(),
          (document) => {
            const input = document.querySelector(COMPOSER);
            input.value = value;
            input.setSelectionRange(caret, caret);
            if (focused) input.focus();
          },
        ),
      );
    const quoted = `> ${FIRST}\n>\n> ${SECOND}\n\n`;
    expect(() =>
      contract.assertComposerQuote(composer(quoted), RUN),
    ).not.toThrow();
    for (const [value, caret, focused] of [
      [`> ${FIRST}\n\n> ${SECOND}\n\n`],
      [`> ${FIRST}\n>\n> ${SECOND}\n`],
      [`> ${FIRST}\n>\n> ${SECOND}\n\n> ${FIRST}\n>\n> ${SECOND}\n\n`],
      [quoted, 0],
      [quoted, quoted.length, false],
    ])
      expect(() =>
        contract.assertComposerQuote(composer(value, caret, focused), RUN),
      ).toThrow();
    expect(() =>
      contract.assertRoomReady(composer(''), {
        name: `Quote ${RUN}`,
        roomId: ROOM,
        userId: SENDER,
      }),
    ).not.toThrow();
    expect(() =>
      contract.assertRoomReady(composer(''), {
        name: 'Quote other',
        roomId: ROOM,
        userId: SENDER,
      }),
    ).toThrow();
    expect(() =>
      contract.assertComposerCaret(composer('abcd', 1), 'abcd', 1),
    ).not.toThrow();
    const ranged = contract.parseComposer(
      evaluateIn(
        '<textarea data-testid="composer-input"></textarea>',
        composerExpression(),
        (document) => {
          const input = document.querySelector(COMPOSER);
          input.value = 'abcd';
          input.setSelectionRange(1, 3);
          input.focus();
        },
      ),
    );
    expect(() => contract.assertComposerCaret(ranged, 'abcd', 1)).toThrow();
    expect(() => contract.assertSendEnabled(composer('x'), 'x')).not.toThrow();
    expect(() => contract.assertSendEnabled(composer('x '), 'x')).toThrow();
    for (const malformed of [
      null,
      { ...composer(''), count: -1 },
      { ...composer(''), href: undefined },
      { ...composer(''), focused: 'yes' },
    ])
      expect(() => contract.parseComposer(malformed)).toThrow();
    for (const malformed of [
      null,
      { rows: {} },
      { rows: [{ id: 1 }] },
      {
        rows: [
          {
            id: '$a',
            event: false,
            visible: true,
            text: '',
            media: 0,
            mediaKinds: [],
            blockquotes: 0,
            texts: [{ html: true }],
          },
        ],
      },
    ])
      expect(() => contract.parseTimeline(malformed)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Diagnostics safety                                                        */
/* ------------------------------------------------------------------------ */

const ARTIFACT_IDS = {
  run: RUN,
  account: {
    userId: '@trn_quote_quote_block_0a1b2c:localhost',
    username: 'trn_quote_quote_block_0a1b2c',
    password: 'quote-pass"word\\token',
  },
  room: {
    id: '!Room_Ab+c/d:localhost',
    name: `Quote ${RUN}`,
  },
  contentUri: MXC,
  eventIds: [SOURCE_ID, QUOTE_ID, IMAGE_ID, CONTROL_ID],
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

describe('Android message-quote diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read(JOURNEYS);
    const current = recordProofViolations(journey);
    // 17 record() call sites emit the 23 identities (shared helpers record once per call).
    expect(current.records).toBe(17);
    expect(current.violations).toEqual([]);
    for (const [from, to] of [
      ['() => assertOneBlockquote(row)', '() => {}'],
      ['() => assertNoQuote(imageSheet)', '() => void imageSheet'],
      ['() => assertComposerQuote(quoted, run)', 'undefined'],
    ]) {
      expect(journey).toContain(from);
      expect(
        recordProofViolations(journey.replace(from, to)).violations,
      ).toHaveLength(1);
    }
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_QUOTE_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_QUOTE_STAGES[0],
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
      name: 'message-quote.quote-block.room-ready',
      value: {
        assertion: 'message-quote.quote-block.room-ready',
        observation: { ready: true },
      },
    });
    await expect(
      record(
        context,
        'source-send-enabled',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    await expect(record(context, 'room-ready', () => {}, {})).rejects.toThrow();
    await expect(
      record(context, 'answer-outside', () => {}, {}),
    ).rejects.toThrow();
    await expect(
      record(context, 'image-no-quote', () => {}, {}),
    ).rejects.toThrow();
    expect(written).toHaveLength(1);
    await receipt(context, 'quote-event', { ok: true });
    expect(written.at(-1).name).toBe('receipt-01-quote-event');
    for (const name of ['message-quote.quote-block.room-ready', 'Start', ''])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messageQuoteSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageQuoteSecrets(BLOCK.id, ARTIFACT_IDS);
    const segment = Buffer.from(ARTIFACT_IDS.room.id).toString('base64url');
    const failure = new AssertionError({
      actual: `/rooms/${segment}?account=${encodeURIComponent(ARTIFACT_IDS.account.userId)}`,
      expected: `/rooms/${ARTIFACT_IDS.room.id}`,
      operator: 'strictEqual',
      message: 'Native navigation reached the exact Room',
    });
    const leaked = new Error(
      `Quote ${QUOTE_ID} of ${SOURCE_ID} for my point ${ARTIFACT_IDS.run} at ${MXC}`,
    );
    const error = redactStageFailure(
      BLOCK.id,
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain('Android message-quote quote-block failed');
    expect(error.message).toContain('Native navigation reached the exact Room');
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ARTIFACT_IDS.room.id,
      segment,
      QUOTE_ID,
      SOURCE_ID,
      MXC,
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
      'Message-quote cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardMessageQuoteCleanup } = await loadJourneys();
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
    const guarded = guardMessageQuoteCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ARTIFACT_IDS.room.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-quote cleanup failed: Room cleanup (Error)',
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

  it('registers every identifier form, including each event id and the media URI, never the bare server name', async () => {
    const { messageQuoteSecrets } = await loadArtifacts();
    const secrets = messageQuoteSecrets(BLOCK.id, ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_QUOTE_QUOTE_BLOCK_'),
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
      SOURCE_ID,
      encodeURIComponent(SOURCE_ID),
      QUOTE_ID,
      IMAGE_ID,
      CONTROL_ID,
      MXC,
      encodeURIComponent(MXC),
      'MediaAbCdEf012345',
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(messageQuoteSecrets(BLOCK.id, { run: 'trn-p' })),
    ).toEqual(['SECRET_QUOTE_QUOTE_BLOCK_RUN']);
    expect(() => messageQuoteSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messageQuoteSecrets(BLOCK.id, { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
    const journey = read(JOURNEYS);
    for (const step of [
      'protect(context, { room: { name } });',
      'protect(context, { account });',
      'protect(context, { room: { id: room.id } });',
      'protect(context, { eventIds: [quoteId] });',
      'protect(context, { contentUri: image.contentUri, eventIds: [image.eventId] });',
    ])
      expect(journey).toContain(step);
    expect(
      journey.indexOf('context.safety.unsafeSecrets = false;'),
    ).toBeGreaterThan(
      journey.indexOf('protect(context, { room: { id: room.id } });'),
    );
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier and credential', async () => {
    const { messageQuoteSecrets, scanMessageQuoteArtifacts } =
      await loadArtifacts();
    const secrets = messageQuoteSecrets(BLOCK.id, ARTIFACT_IDS);
    await withOutput('trinity-quote-scan-', async (output) => {
      await mkdir(join(output, BLOCK.id));
      const receipt = join(output, BLOCK.id, 'receipt-01-tray-open.json');
      for (const unsafe of [
        `GET /rooms/${ARTIFACT_IDS.room.id}/messages`,
        JSON.stringify({ password: ARTIFACT_IDS.account.password }),
        `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_IDS.room.id))}/event/${mixedCase(encodeURIComponent(QUOTE_ID))}`,
        `double=${encodeURIComponent(encodeURIComponent(ARTIFACT_IDS.room.id))}`,
        `route=/rooms/${Buffer.from(ARTIFACT_IDS.room.id).toString('base64url')}`,
        `slice=${ARTIFACT_IDS.room.id.slice(1)}`,
        `selector=.scroll .msg[data-mid="${SOURCE_ID}"]`,
        `image=${IMAGE_ID}`,
        `control=${CONTROL_ID}`,
        `src=${MXC}`,
        `download=/_matrix/client/v1/media/download/localhost/MediaAbCdEf012345`,
        `thumb=${encodeURIComponent(MXC)}`,
        `body=my point ${ARTIFACT_IDS.run}`,
        '/_matrix/media/v3/download/localhost/x?access_token=unregisteredTokenValue',
        '{"access_token":"unregistered_token_value"}',
        `name=${ARTIFACT_IDS.room.name}`,
        `account=${encodeURIComponent(ARTIFACT_IDS.account.userId)}`,
        'Authorization: Bearer unregistered-token',
        'token=syt_dW5yZWdpc3RlcmVk_abc',
        '<map><string name="CapacitorStorage.trinity">{}</string></map>',
        'pluginId: Preferences, methodName: get, methodData: {"key":"trinity.appearance.mode"}',
      ]) {
        await writeFile(receipt, unsafe);
        await expect(
          scanMessageQuoteArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        receipt,
        '{"blockquotes":1,"server":"localhost","access_token":false}\n',
      );
      await expect(
        scanMessageQuoteArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of ['capture.png', 'capture.PNG', 'opaque.bin'])
        await withOutput('trinity-quote-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(scanMessageQuoteArtifacts(other, {})).rejects.toThrow();
        });
    });
  });

  it('scrubs raw and encoded identifiers, deletes rasters and then scans clean', async () => {
    const {
      messageQuoteSecrets,
      scrubMessageQuoteArtifacts,
      scanMessageQuoteArtifacts,
    } = await loadArtifacts();
    const secrets = messageQuoteSecrets(BLOCK.id, ARTIFACT_IDS);
    await withOutput('trinity-quote-scrub-', async (output) => {
      const stage = join(output, BLOCK.id);
      await mkdir(stage);
      const path = join(stage, 'passed-ui.json');
      await writeFile(
        path,
        [
          `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_IDS.room.id))}/messages`,
          `row=.scroll .msg[data-mid=${JSON.stringify(QUOTE_ID)}]`,
          `media=${MXC}`,
          `body=> alpha ${ARTIFACT_IDS.run}`,
          JSON.stringify({ password: ARTIFACT_IDS.account.password }),
          'unchanged=1 blockquote',
        ].join('\n'),
      );
      await writeFile(join(stage, 'passed.png'), 'raster');
      await scrubMessageQuoteArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe('unchanged=1 blockquote');
      for (const leaked of [
        ARTIFACT_IDS.room.id,
        QUOTE_ID,
        MXC,
        ARTIFACT_IDS.run,
        'quote-pass',
      ])
        expect(scrubbed).not.toContain(leaked);
      expect(scrubbed).toContain('[REDACTED]');
      expect(existsSync(join(stage, 'passed.png'))).toBe(false);
      await expect(
        scanMessageQuoteArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
    // The suite's own pass removes rasters even before any secret is registered.
    await withOutput('trinity-quote-scrub-raster-', async (output) => {
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        await writeFile(join(output, name), 'raster');
      await scrubMessageQuoteArtifacts(output, {});
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        expect(existsSync(join(output, name))).toBe(false);
      await expect(
        scanMessageQuoteArtifacts(output, {}),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried two-stage 23-record run', async () => {
    const artifacts = await loadArtifacts();
    const { MESSAGE_QUOTE_STAGES } = await loadContract();
    const { PIXEL_5_ACCOUNT_PROFILE } = await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 2,
      expectedAssertionRecords: 23,
      attempt: 1,
      retries: 0,
      stages: MESSAGE_QUOTE_STAGES.map((entry) => ({
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
    await withOutput('trinity-quote-gate-', async (output) => {
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
        for (const { id } of STAGES) {
          await mkdir(join(output, id), { recursive: true });
          await write(join(id, 'profile-applied.json'), {
            requested: PIXEL_5_ACCOUNT_PROFILE,
          });
          for (const name of [
            'passed.json',
            'passed-ui.json',
            'passed-surface.json',
          ])
            await write(join(id, name), { ok: true });
        }
      };
      const refused = async (value, options = {}) => {
        await writeFile(marker, 'stale\n');
        await expect(
          artifacts.markMessageQuoteDiagnosticsSafe(
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
      await artifacts.markMessageQuoteDiagnosticsSafe(
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
          value.stages[1].assertions.pop();
          value.stages[1].assertionRecords = 10;
        }),
        mutate((value) => {
          value.stages[0].assertions[9] = value.stages[0].assertions[8];
        }),
        mutate((value) => {
          value.stages.reverse();
        }),
        mutate((value) => (value.expectedAssertionRecords = 20)),
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
        join(BLOCK.id, 'profile-applied.json'),
        join(BLOCK.id, 'passed-ui.json'),
        'runtime-provenance.json',
      ]) {
        await arrange();
        await rm(join(output, missing));
        await refused(report());
      }
      await arrange();
      await write(join(BLOCK.id, 'profile-applied.json'), {
        requested: { ...PIXEL_5_ACCOUNT_PROFILE, width: 1280 },
      });
      await refused(report());
      await arrange();
      await write(join(BLOCK.id, 'passed-surface.json'), {
        url: `https://localhost/rooms/${Buffer.from(ARTIFACT_IDS.room.id).toString('base64url')}`,
      });
      await refused(report(), {
        secrets: artifacts.messageQuoteSecrets(BLOCK.id, ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, BLOCK.id, 'passed.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const {
      runMessageQuoteStageCleanup,
      revokeMessageQuotePublicationOnAbort,
    } = await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessageQuoteStageCleanup(
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
    await withOutput('trinity-quote-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageQuotePublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageQuotePublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-quote publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });
});
/* Hosted wiring and parity ledger                                           */
/* ------------------------------------------------------------------------ */

const NX_COMMAND =
  '--suite=android.message-quote --timeout-ms=1500000 --entrypoint=e2e/android/message-quote-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "6" ]; then echo \'message-quote-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1800000 -- pnpm exec nx run trinity-e2e-android:message-quote; fi';
const GATE_PATH =
  "-path '*/android.message-quote/message-quote/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-quote-started == 'true' && steps.message-quote-artifact-gate.outputs.message-quote-safe == 'true' }}";

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
  const target = project.targets['message-quote'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-quote']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-quote',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(
    lines.filter((line) => line.includes('trinity-e2e-android:message-quote')),
  ).toHaveLength(1);
  expect(lines[runner - 1]).toContain(
    "echo 'room-widget-settings-started=true'",
  );
  expect(
    lines
      .filter((line) => line.startsWith('if [ "${{ matrix.shard }}" = "6" ]'))
      .at(-1),
  ).toBe(CI_LINE);
  const gate = workflow
    .split('      - name: Gate Android message-quote diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-quote-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-quote-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain(
    'echo \'message-quote-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-quote\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-quote/**',
  );
  expect(workflow).toContain('shard 5 about 110 and shard 6 about 118.');
  expect(workflow).toContain(
    "# Shard 6's figure adds a provisional 12 minutes for message-quote.",
  );
  expect(ciSpec).toContain('expect(uploads.length).toBe(79);');
  expect(ciSpec).toContain('expect(lines).toHaveLength(72);');
  expect(ciSpec).toContain("step.with.surface === 'android-message-quote'");
  expect(ciSpec).toContain(
    'runs message-quote after room-widget-settings at the end of shard 6',
  );
  expect(ciSpec).toContain(
    'budgets message-quote in the shard-6 figure of the Android budget comment',
  );
}

describe('Android message-quote hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-quote',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-quote',
      canonicalScript: 'e2e:android:message-quote',
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
        (item) => item.name === 'e2e:android:message-quote',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-quote',
        command: 'nx run trinity-e2e-android:message-quote',
        kind: 'canonical',
        suiteIds: ['android.message-quote'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-quote'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "6" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-quote',
    );
    expect(read(JOURNEYS)).toContain('timeout: 1_200_000');
    expect(read(APPEND_FLOW)).toBe(
      'appId: ${APP_ID}\n---\n# Append one paragraph at the focused composer caret. It never erases and\n# never calls hideKeyboard, which Maestro implements as an unconditional\n# Android Back.\n- inputText: ${SECRET_TEXT}\n',
    );
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-quote']);
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
            'message-quote-journeys.mts',
            'message-poll-journeys.mts',
          )),
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:message-quote'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "6"', '= "1"')),
      withText('workflow', CI_LINE, CI_LINE.replace('1800000', '900000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-quote/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-quote-started == 'true' }}",
      ),
      withText('workflow', 'shard 6 about 118', 'shard 6 about 106'),
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
    // The runner moved before room-widget-settings.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === CI_LINE);
    const [line] = lines.splice(index, 1);
    lines.splice(index - 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 23 identities with their source lines and the 13/10 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-quote journeys')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-quote\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[4])).toEqual(ALL_IDENTITIES);
    expect(rows.map((row) => row[2].trim())).toEqual(
      STAGES.flatMap((stage) =>
        ledgerTuples(stage).map((tuple) =>
          tuple[0] === 'direct' ? String(tuple[1]) : `${tuple[1]}@${tuple[3]}`,
        ),
      ),
    );
    expect(rows.map((row) => row[1])).toEqual(
      STAGES.flatMap((stage) => stage.suffixes.map(() => stage.id)),
    );
    expect(rows.map((row) => row[3])).toEqual(
      STAGES.flatMap((stage) => ledgerTuples(stage).map((tuple) => tuple[0])),
    );
    expect(section).toContain('13 direct + 10');
    expect(section).toContain(PREDECESSOR_SHA256);
    expect(section).toContain(ISSUE_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-quote`');
    expect(section).toMatch(/remains enabled and untouched/u);
    expect(section).toContain('m.in_reply_to');
    expect(section).toContain('application/octet-stream');
    expect(section).toContain('acceptance gate for #750');
    expect(section).not.toContain('pnpm exec nx');
    // The next migration's section, and only it, follows this one.
    expect(
      migration.split('## Message-quote journeys')[1].split('\n## ')[1],
    ).toMatch(/^Message-receipts journey\n/u);
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
    /sendMessage\(|sendEvent\(|\/send\/m\.room\.message|setRoomState\(/u,
  ],
  [
    'desktop hover path',
    /clickRowToolbar|clickRowMenuItem|msg-more|msg-quote|msg-copy|\.hover\(/u,
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
      if (['readComposer', 'readTimeline', 'readSheet'].includes(called)) {
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
  // The only REST send is the pinned image fixture, once.
  expect(journeys.match(/fixtures\.sendImageMessage\(/gu)).toHaveLength(1);
  const block = functionSource(journeys, 'runQuoteBlock');
  assertOrder(
    block,
    [
      callOf('arrangeStage'),
      callOf('startNative'),
      /client\.login\(account\)/u,
      /client\.hideKeyboard\(\)/u,
      callOf('openRoom'),
      /enterSourceNatively\(context\)/u,
      /sendDraft\(context, quoteSourceBody\(run\), 'source-send-enabled', 'source'\)/u,
      recordOf('source-visible'),
      /serverEcho\(context, first, 'source-server-echo'\)/u,
      /assertQuoteBlockRoom\(events, \{ \.\.\.expected, sourceId \}\)/u,
      /assertSameRow\(target, first, sourceId\)/u,
      /openSheet\(context, READY_ROW, \{ text: first \}, 'sheet-ready'\)/u,
      /client\.tapCurrent\(QUOTE\)/u,
      /assertSheetClosed/u,
      recordOf('composer-quote'),
      /appendNativeLine\(client, quotedComposer\(run\), answer\)/u,
      /sendDraft\(context, quoteEventBody\(run\), 'answer-send-enabled', 'answer'\)/u,
      /assertQuoteBlockRoom\(events, \{ \.\.\.expected, sourceId, quoteId \}\)/u,
      recordOf('answer-visible'),
      recordOf('one-blockquote'),
      recordOf('quotes-first'),
      recordOf('quotes-second'),
      recordOf('answer-outside'),
    ],
    'runQuoteBlock',
  );
  const capability = functionSource(journeys, 'runQuoteCapability');
  assertOrder(
    capability,
    [
      callOf('arrangeStage'),
      /fixtures\.sendImageMessage\(account, room\.id, \{\n\s+png: quoteImagePng\(\),\n\s+filename: QUOTE_IMAGE_FILENAME,\n\s+body: QUOTE_IMAGE_BODY,\n\s+transactionId: quoteImageTransaction\(run\),/u,
      /protect\(context, \{ contentUri: image\.contentUri, eventIds: \[image\.eventId\] \}\)/u,
      /context\.safety\.unsafeSecrets = false/u,
      /assertCapabilityRoom\(events, expected\)/u,
      callOf('startNative'),
      /client\.login\(account\)/u,
      callOf('openRoom'),
      /client\.focusCurrent\(COMPOSER\)/u,
      /client\.fillFocused\(COMPOSER, body, PARAGRAPH_SENTINEL\)/u,
      /sendDraft\(context, body, 'control-send-enabled', 'control'\)/u,
      recordOf('control-visible'),
      /serverEcho\(context, body, 'control-server-echo'\)/u,
      /assertCapabilityRoom\(events, \{ \.\.\.expected, controlId \}\)/u,
      /assertSameRow\(target, body, controlId\)/u,
      /openSheet\(context, READY_ROW, \{ text: body \}, 'text-sheet-ready'\)/u,
      recordOf('text-quote-visible'),
      /reachCancel\(client\)/u,
      /client\.tapCurrent\(CANCEL, \{ exactText: 'Cancel' \}\)/u,
      recordOf('text-sheet-closed'),
      recordOf('image-visible'),
      /openSheet\(context, READY_ROW, \{ text: QUOTE_IMAGE_FILENAME \}, 'image-sheet-ready'\)/u,
      recordOf('image-copy-visible'),
      recordOf('image-no-quote'),
    ],
    'runQuoteCapability',
  );
  // Quote absence is read from the same open sheet that shows Copy.
  expect(capability).toMatch(
    /record\(context, 'image-no-quote', \(\) => assertNoQuote\(imageSheet\)/u,
  );
  const source = functionSource(journeys, 'enterSourceNatively');
  assertOrder(
    source,
    [
      /client\.focusCurrent\(COMPOSER\)/u,
      /quoteSourceSteps\(context\.ledger\.run\)/u,
      /client\.fillFocused\(COMPOSER, step\.text, PARAGRAPH_SENTINEL\)/u,
      /client\.key\('enter'\)/u,
      /appendNativeLine\(client, value, step\.text\)/u,
      /composerAt\(client, step\.value, step\.value\.length/u,
    ],
    'enterSourceNatively',
  );
  const append = functionSource(journeys, 'appendNativeLine');
  assertOrder(
    append,
    [
      /const typed = `\$\{PARAGRAPH_SENTINEL\}\$\{line\}`;/u,
      /client\.focused\(COMPOSER\)/u,
      /client\.device\.runFlow\(join\(client\.workspaceRoot, APPEND_FLOW\)/u,
      /SECRET_TEXT: typed/u,
      /composerAt\(client, `\$\{prefix\}\$\{typed\}`, prefix\.length \+ typed\.length/u,
      /client\.key\('arrowLeft'\)/u,
      /composerAt\(client, `\$\{prefix\}\$\{typed\}`, prefix\.length \+ 1/u,
      /client\.key\('backspace'\)/u,
      /composerAt\(client, `\$\{prefix\}\$\{line\}`, prefix\.length,/u,
      /client\.keyCombination\('documentEnd'\)/u,
      /composerAt\(client, `\$\{prefix\}\$\{line\}`, prefix\.length \+ line\.length/u,
    ],
    'appendNativeLine',
  );
  const send = functionSource(journeys, 'sendDraft');
  assertOrder(
    send,
    [
      /client\.hideKeyboard\(\)/u,
      /assertSendEnabled\(value, draft\)/u,
      /record\(context, suffix/u,
      /client\.tapCurrent\(SEND\)/u,
      /assertDraftSent/u,
    ],
    'sendDraft',
  );
  const sheet = functionSource(journeys, 'openSheet');
  assertOrder(
    sheet,
    [
      /client\.hideKeyboard\(\)/u,
      /client\.longPressCurrent\(selector, filter\)/u,
      /assertNativeSheetReady/u,
      /record\(context, suffix/u,
    ],
    'openSheet',
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
  // a Room, event or media identifier.
  expect(journeys).not.toMatch(/data-mid(?:[*~|]?=)|\[data-mid="\$\{/u);
  expect(journeys).toContain(
    'const READY_ROW = \'.scroll .msg[data-mid^="$"]\';',
  );
  for (const call of journeys.matchAll(
    /client\.(?:tapCurrent|longPressCurrent|focusCurrent|swipeCurrent|visible|waitElements|elements)\(([^;]*?)\);/gsu,
  ))
    expect(call[1], call[0]).not.toMatch(
      /\$\{[^}]*(?:Id|\.id|Uri)\b[^}]*\}|sourceId|quoteId|controlId|eventId|contentUri/u,
    );
  for (const call of journeys.matchAll(/openSheet\(([^;]*?)\);/gsu))
    expect(call[1]).not.toMatch(/Id\b|eventId|\.id\b/u);
  const runner = functionSource(journeys, 'runMessageQuoteSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /createAccountFixtures\(/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /MESSAGE_QUOTE_STAGES/u,
      /runMessageQuoteStageCleanup\(/u,
      /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
    ],
    'runMessageQuoteSuite',
  );
  for (const required of [
    'expectedStages: 2',
    'expectedAssertionRecords: 23',
    'attempt: 1',
    'retries: 0',
    'markMessageQuoteDiagnosticsSafe(',
    'scrubMessageQuoteArtifacts(',
    'revokeMessageQuotePublicationOnAbort(',
    "client.capture('passed')",
    "client.capture('failed')",
    'client.reset(PIXEL_5_ACCOUNT_PROFILE)',
    'profile: PIXEL_5_ACCOUNT_PROFILE',
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  ])
    expect(journeys).toContain(required);
}

describe('Android message-quote source rules', () => {
  it('keeps the observer and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [OBSERVER, ARTIFACTS, CONTRACT]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    assertReadOnlyObserver(read(OBSERVER));
    expect(read(ARTIFACTS)).not.toMatch(
      /message-poll-artifacts|message-markdown-artifacts/u,
    );
  });

  it('adds one REST image fixture to the shared fixtures without exposing its token', () => {
    const fixtures = read('e2e/android/account-workspace-fixtures.mts');
    const start = fixtures.indexOf('  async function sendImageMessage(');
    expect(start).toBeGreaterThan(-1);
    const body = fixtures.slice(start, fixtures.indexOf('\n  }\n', start));
    for (const hook of [
      '/_matrix/media/v3/upload?filename=${encodeURIComponent(image.filename)}',
      "'Content-Type': 'image/png',",
      "{ msgtype: 'm.image', body: image.body, url: contentUri },",
      "assert(contentUri.startsWith('mxc://'),",
      'signal: requestSignal(signal),',
    ])
      expect(body).toContain(hook);
    expect(body).not.toMatch(/return[^;]*token/u);
    expect(fixtures).toContain('    sendImageMessage,\n');
  });

  it('fails the forbidden-token and read-only rules under each effective mutation', () => {
    const observer = read(OBSERVER);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'input.value = "> alpha"',
      "document.execCommand('insertText', false, 'x')",
      'element.dispatchEvent(new MouseEvent("click"))',
      'row.classList.add("msg--revealed")',
      'quote.setAttribute("hidden", "")',
      'row.style.opacity = "1"',
      'window.location = "/rooms"',
      'await fixtures.sendMessage(account, room.id, first, "txn")',
      'await request.put(`/rooms/${id}/send/m.room.message/txn`)',
      'await clickRowToolbar(row, row.getByTestId("msg-more"))',
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
      // REST seeding of owned text, DOM input or a desktop path.
      `${journeys}\nawait fixtures.sendMessage(account, room.id, first, 'txn');`,
      `${journeys}\nawait evaluateNative(client.webview, 'x');`,
      `${journeys}\nawait client.fill(COMPOSER, first);`,
      `${journeys}\nawait client.tap('[data-testid="msg-more"]');`,
      // A second image upload.
      `${journeys}\nawait fixtures.sendImageMessage(account, room.id, image);`,
      // The blank line is typed with one Enter, or the sentinel is dropped.
      replace(
        /await client\.fillFocused\(COMPOSER, step\.text, PARAGRAPH_SENTINEL\);/u,
        'await client.fillFocused(COMPOSER, step.text);',
      ),
      replace(
        /const typed = `\$\{PARAGRAPH_SENTINEL\}\$\{line\}`;/u,
        'const typed = line;',
      ),
      // A caret wait between injected keys is removed.
      replace(
        /await composerAt\(client, `\$\{prefix\}\$\{typed\}`, prefix\.length \+ 1,\n\s+'native caret just after the sentinel'\);\n/u,
        '',
      ),
      // The quote is sent before the composer proof, or the sheet is skipped.
      replace(/await client\.tapCurrent\(QUOTE\);\n/u, ''),
      replace(
        /await openSheet\(context, READY_ROW, \{ text: first \}, 'sheet-ready'\);\n/u,
        '',
      ),
      // A rendered record is taken before the quote event's wire proof.
      replace(
        /\(events\) => assertQuoteBlockRoom\(events, \{ \.\.\.expected, sourceId, quoteId \}\),/u,
        '() => {},',
      ),
      // The text sheet is closed without Cancel.
      replace(
        /await client\.tapCurrent\(CANCEL, \{ exactText: 'Cancel' \}\);\n/u,
        '',
      ),
      // Quote absence is proved on a separate read, without Copy.
      replace(
        /record\(context, 'image-no-quote', \(\) => assertNoQuote\(imageSheet\)/u,
        "record(context, 'image-no-quote', () => assert.equal(imageSheet.quote.count, 0)",
      ),
      // A proof becomes a receipt, or a row is targeted by its event id.
      replace(
        /record\(context, 'answer-outside'/u,
        "receipt(context, 'answer-outside'",
      ),
      replace(
        /openSheet\(context, READY_ROW, \{ text: QUOTE_IMAGE_FILENAME \}, 'image-sheet-ready'\)/u,
        'openSheet(context, `.scroll .msg[data-mid="${image.eventId}"]`, {}, \'image-sheet-ready\')',
      ),
      replace(
        /openSheet\(context, READY_ROW, \{ text: body \}, 'text-sheet-ready'\)/u,
        'openSheet(context, `.msg[data-mid^="${controlId}"]`, {}, \'text-sheet-ready\')',
      ),
      // The identity proof before a long press is dropped.
      replace(/  assertSameRow\(target, first, sourceId\);\n/u, ''),
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });
});
