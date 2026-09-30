import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  readRetiredPredecessor,
  RETIRED_PREDECESSOR_COMMIT,
} from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));

const PREDECESSOR =
  'e2e/browser/journeys/conversations/quote-mentions.spec.mts';
const predecessor = PREDECESSOR;
/** The canonical bytes (ruled Q1): the dd0cb53c blob, equal to the working tree. */
const SOURCE_SHA256 =
  '5186fc3b45f12fd03e2ad71e79ae636a688fce41b96d05fb0e38f278f80266e5';
/** The issue's stale pin: the same file before fe2c7c3e (provenance only). */
const ISSUE_SHA256 =
  '354f8f2ccd02e32b12bf74bea400abb4dec40bad31715fd80e03c4fd79fd49f8';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/message-composer.mts':
    '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
};
const SEND_IMPORT =
  "import { sendComposerDraft } from '../../../support/message-composer.mts';";
const SEND_CALL = '    await sendComposerDraft(composer);';
const ENTER_PRESS = "    await composer.press('Enter');";
const blob = () => readRetiredPredecessor(PREDECESSOR).toString('utf8');
const readPredecessor = blob;
/** Provenance only: undo fe2c7c3e (drop the line-16 import, restore Enter at line 135). */
function issueBytesOf(source) {
  const lines = source.split('\n');
  assert.equal(lines[15], SEND_IMPORT, 'fe2c7c3e import at line 16');
  assert.equal(lines[134], SEND_CALL, 'fe2c7c3e Send call at line 135');
  return [
    ...lines.slice(0, 15),
    ...lines.slice(16, 134),
    ENTER_PRESS,
    ...lines.slice(135),
  ].join('\n');
}
const loadContract = () =>
  import('../e2e/android/quote-notification-contract.mts');
const loadArtifacts = () =>
  import('../e2e/android/quote-notification-artifacts.mts');
const STAGE = {
  id: 'quoted-display-name',
  span: [64, 174],
  direct: [118, 123, 132, 136, 153, 173],
  suffixes: [
    'composer-visible',
    'source-row-visible',
    'sheet-ready',
    'composer-quote',
    'answer-send-enabled',
    'answer-visible',
    'notification-positive',
    'highlight-zero',
  ],
};
const ALL_IDENTITIES = STAGE.suffixes.map(
  (s) => `quote-notification.${STAGE.id}.${s}`,
);

const LINE_PINS = {
  16: "import { sendComposerDraft } from '../../../support/message-composer.mts';",
  41: "const READER_DISPLAY_NAME = 'Zephyrine';",
  69: "const runId = `${testResourceId('run')}qm`;",
  70: 'const writer = `qmw-${runId}`;',
  71: 'const reader = `qmr-${runId}`;',
  73: 'const roomName = `Quote mentions ${runId}`;',
  85: '{ headers: rHeaders, data: { displayname: READER_DISPLAY_NAME } },',
  91: "data: { name: roomName, preset: 'private_chat', invite: [r.userId] },",
  95: 'await request.post(`${hs}/_matrix/client/v3/rooms/${roomId}/join`, {',
  101: 'const named = `${READER_DISPLAY_NAME}, can you look at this?`;',
  103: '`${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}-src`,',
  104: "{ headers: rHeaders, data: { msgtype: 'm.text', body: named } },",
  114: "await page.getByTestId('rail-rooms').click();",
  116: "await channel.first().waitFor({ state: 'visible', timeout: 30_000 });",
  119: 'timeout: 15_000,',
  122: "const row = page.locator('.scroll .msg', { hasText: named });",
  123: 'await expect(row.first()).toBeVisible({ timeout: 30_000 });',
  124: 'if (isAndroidE2E) {',
  125: 'const sheet = await openMessageActionSheet(page, row.first());',
  126: "await sheet.getByTestId('sheet-quote').click();",
  127: '} else {',
  132: 'await expect(composer).toHaveValue(`> ${named}\\n\\n`, { timeout: 10_000 });',
  133: 'const answer = `on it ${runId}`;',
  134: 'await composer.pressSequentially(answer);',
  135: 'await sendComposerDraft(composer);',
  138: ').toBeVisible({ timeout: 30_000 });',
  144: '.get(`${hs}/_matrix/client/v3/sync?timeout=0`, { headers: rHeaders })',
  148: '`${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}-probe`,',
  149: "{ headers: wHeaders, data: { msgtype: 'm.text', body: `poke ${runId}` } },",
  157: '.get(`${hs}/_matrix/client/v3/sync?since=${since}&timeout=0`, {',
  161: 'const unread = sync?.rooms?.join?.[roomId]?.unread_notifications;',
  165: 'return counts.notification_count;',
  167: '{ timeout: 30_000 },',
  169: '.toBeGreaterThan(0);',
  173: 'expect(counts.highlight_count).toBe(0);',
};

function assertPredecessorShape(source) {
  expect(source.split('\n')).toHaveLength(176);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  expect(assertionLines(source, ...STAGE.span)).toEqual(STAGE.direct);
}

const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
const endLineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

function assertionLines(
  source,
  start,
  end,
  name = predecessor,
  identifierOnly = false,
) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    const isExpect =
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === 'expect') ||
        (!identifierOnly &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'expect' &&
          node.expression.name.text === 'poll'));
    if (isExpect) {
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

describe('Android quote-notification predecessor pins', () => {
  it('pins the dd0cb53c blob and the working tree at one hash, byte-equal, and three shared sources', () => {
    expect(RETIRED_PREDECESSOR_COMMIT.startsWith('dd0cb53c')).toBe(true);
    expect(sha256(blob())).toBe(SOURCE_SHA256);
    expect(sha256(read(PREDECESSOR))).toBe(SOURCE_SHA256);
    expect(read(PREDECESSOR) === blob()).toBe(true);
    for (const [path, hash] of Object.entries(SHARED_SHA256))
      expect(digest(path)).toBe(hash);
    const flippedBlob = Buffer.from(blob());
    flippedBlob[0] ^= 1;
    expect(sha256(flippedBlob)).not.toBe(SOURCE_SHA256);
    const flippedTree = Buffer.from(readFileSync(resolve(root, PREDECESSOR)));
    flippedTree[0] ^= 1;
    expect(sha256(flippedTree)).not.toBe(SOURCE_SHA256);
    expect(flippedTree.toString('utf8') === blob()).toBe(false);
    for (const path of Object.keys(SHARED_SHA256)) {
      const shared = Buffer.from(readFileSync(resolve(root, path)));
      shared[0] ^= 1;
      expect(sha256(shared)).not.toBe(SHARED_SHA256[path]);
    }
  });

  it("records the issue's stale pin as these bytes before fe2c7c3e (provenance)", () => {
    const current = blob();
    const issue = issueBytesOf(current);
    expect(sha256(issue)).toBe(ISSUE_SHA256);
    expect(issue.split('\n')).toHaveLength(175);
    const c = issue.split('\n');
    expect(
      [
        ...c.slice(0, 15),
        SEND_IMPORT,
        ...c.slice(15, 133),
        SEND_CALL,
        ...c.slice(134),
      ].join('\n'),
    ).toBe(current);
    const lines = current.split('\n');
    [lines[15], lines[16]] = [lines[16], lines[15]];
    expect(() => issueBytesOf(lines.join('\n'))).toThrow();
    expect(
      sha256(issueBytesOf(mutateLine(current, 41, (raw) => `${raw}x`))),
    ).not.toBe(ISSUE_SHA256);
  });

  it('maps exactly six direct sites, counting expect.poll', () => {
    assertPredecessorShape(readPredecessor());
    expect(
      assertionLines(readPredecessor(), 64, 174, predecessor, true),
    ).toEqual([118, 123, 132, 136, 173]);
  });

  it('fails every text pin under an effective in-memory mutation', () => {
    const source = readPredecessor();
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

  it('pins the same sources, spans and hashes in the contract', async () => {
    const c = await loadContract();
    expect(c.QUOTE_NOTIFICATION_SOURCE).toBe(PREDECESSOR);
    expect(c.QUOTE_NOTIFICATION_SOURCE_SHA256).toBe(SOURCE_SHA256);
    expect(c.QUOTE_NOTIFICATION_ISSUE_SOURCE_SHA256).toBe(ISSUE_SHA256);
    expect(c.QUOTE_NOTIFICATION_SOURCE_LINES).toBe(175);
    expect(c.QUOTE_NOTIFICATION_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    expect(c.QUOTE_NOTIFICATION_SPANS).toEqual({
      displayName: { from: 40, to: 59 },
      loginApi: { from: 43, to: 59 },
      definition: { from: 64, to: 174 },
      androidBranch: { from: 124, to: 126 },
      desktopBranch: { from: 127, to: 129 },
    });
    const tree = ts.createSourceFile(
      PREDECESSOR,
      readPredecessor(),
      ts.ScriptTarget.Latest,
      true,
    );
    const statement = (pick) => tree.statements.find(pick);
    const displayName = statement(
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations[0].name.text === 'READER_DISPLAY_NAME',
    );
    expect(lineOf(tree, displayName)).toBe(41);
    expect(lineAt(readPredecessor(), 40).startsWith('/**')).toBe(true);
    const login = statement(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === 'loginApi',
    );
    expect([lineOf(tree, login), endLineOf(tree, login)]).toEqual([43, 59]);
    let testCall;
    let branch;
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'test'
      )
        testCall ??= node;
      if (ts.isIfStatement(node) && lineOf(tree, node) === 124) branch = node;
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect([lineOf(tree, testCall), endLineOf(tree, testCall)]).toEqual([
      64, 174,
    ]);
    expect(lineOf(tree, branch.elseStatement) - 0).toBe(127);
    expect(endLineOf(tree, branch)).toBe(129);
  });
});

describe('Android quote-notification helper expansion by binding', () => {
  it('expands the Android branch and the Send helper, with every line AST-derived', async () => {
    const source = readPredecessor();
    expect(lineAt(source, 124)).toBe('if (isAndroidE2E) {');
    expect(lineAt(source, 127)).toBe('} else {');
    const { calls } = importedCalls(readPredecessor());
    const callOf = (name) => calls.filter((c) => c.name === name);
    const derived = {
      sheet: helperExpectLines(
        'e2e/support/app.mts',
        'openMessageActionSheet',
      ).map((e) => e.line),
      sheetCalls: callOf('openMessageActionSheet').map((c) => c.line),
      send: helperExpectLines(
        'e2e/support/message-composer.mts',
        'sendComposerDraft',
      ).map((e) => e.line),
      sendCalls: callOf('sendComposerDraft').map((c) => c.line),
      menu: helperExpectLines('e2e/support/app.mts', 'clickRowMenuItem').map(
        (e) => e.line,
      ),
      menuCalls: callOf('clickRowMenuItem').map((c) => c.line),
    };
    expect(derived).toEqual({
      sheet: [220],
      sheetCalls: [125],
      send: [53],
      sendCalls: [135],
      menu: [206],
      menuCalls: [128],
    });
    const c = await loadContract();
    const sites = c.QUOTE_NOTIFICATION_STAGES[0].sites;
    const directs = () =>
      sites.filter((s) => s.kind === 'direct').map((s) => s.line);
    const inherited = (list) =>
      list
        .filter((s) => s.kind === 'inherited')
        .map(({ helper, line, call }) => [helper, line, call]);
    const expectedInherited = [
      ['openMessageActionSheet', derived.sheet[0], derived.sheetCalls[0]],
      ['sendComposerDraft', derived.send[0], derived.sendCalls[0]],
    ];
    expect(directs()).toEqual(assertionLines(readPredecessor(), 64, 174));
    expect(inherited(sites)).toEqual(expectedInherited);
    expect(
      c.QUOTE_NOTIFICATION_EXCLUDED.map(({ helper, line, call }) => [
        helper,
        line,
        call,
      ]),
    ).toEqual([['clickRowMenuItem', derived.menu[0], derived.menuCalls[0]]]);
    const mutated = sites.map((site) =>
      site.line === 53 ? { ...site, line: 54 } : site,
    );
    expect(inherited(mutated)).not.toEqual(expectedInherited);
  });

  it('reaches no site through login, registerUser, loginApi, synapseSession or touchLongPress', () => {
    for (const [module, name] of [
      ['e2e/support/app.mts', 'login'],
      ['e2e/support/app.mts', 'synapseSession'],
      ['e2e/support/account.mts', 'registerUser'],
      ['e2e/support/touch-platform.mts', 'touchLongPress'],
    ])
      expect(helperExpectLines(module, name), `${module}#${name}`).toEqual([]);
    expect(
      helperExpectLines(predecessor, 'loginApi', readPredecessor()),
    ).toEqual([]);
  });

  it("a naive expansion counts 9 sites, not the contract's 8", async () => {
    const c = await loadContract();
    const naive = expandDefinition(readPredecessor(), [64, 174]);
    expect(naive.length).toBe(9);
    expect(naive.some((site) => site.line === 206)).toBe(true);
    expect(naive.length).not.toBe(c.QUOTE_NOTIFICATION_ASSERTION_RECORDS);
  });

  it('does not expand a shadowing local', () => {
    const source = readPredecessor();
    const cases = [
      [
        'openMessageActionSheet',
        '      const sheet = await openMessageActionSheet(page, row.first());',
        '      const openMessageActionSheet = async (_p: unknown, _r: unknown) => null;\n      const sheet = await openMessageActionSheet(page, row.first());',
      ],
      [
        'sendComposerDraft',
        '    await sendComposerDraft(composer);',
        '    const sendComposerDraft = async (_c: unknown) => {};\n    await sendComposerDraft(composer);',
      ],
    ];
    for (const [name, from, to] of cases) {
      expect(source).toContain(from);
      const shadowed = source.replace(from, to);
      const found = importedCalls(shadowed);
      expect(found.shadowed.map((s) => s.name)).toContain(name);
      expect(found.calls.filter((c) => c.name === name)).toEqual([]);
      expect(() => assertPredecessorShape(shadowed)).toThrow();
    }
  });
});

const IMPORTED_SHAPES = {
  'e2e/android/message-quote-observer.mts': {
    ObservationOptions: 'accepts,description,timeoutMs',
    readComposer:
      '(client: AccountWorkspaceClient, options: ObservationOptions<ComposerObservation> = {}): Promise<ComposerObservation>',
    readTimeline:
      '(client: AccountWorkspaceClient, options: ObservationOptions<TimelineObservation> = {}): Promise<TimelineObservation>',
    readSheet:
      '(client: AccountWorkspaceClient, options: ObservationOptions<SheetObservation> = {}): Promise<SheetObservation>',
    readAppliedProfile:
      '(client: AccountWorkspaceClient, options: ObservationOptions<AppliedProfileObservation> = {}): Promise<AppliedProfileObservation>',
  },
  'e2e/android/message-quote-contract.mts': {
    PARAGRAPH_SENTINEL: "const '1'",
    ComposerObservation:
      'count,visible,focused,value,placeholder,selectionStart,selectionEnd,sendCount,sendDisabled,href',
    SheetObservation: 'dialogs,dialogVisible,quote,copy,forward,cancel',
    TimelineObservation: 'rows',
    assertRoomReady:
      '(composer: ComposerObservation, room: RoomIdentity): void',
    assertSendEnabled: '(composer: ComposerObservation, draft: string): void',
    assertDraftSent: '(composer: ComposerObservation): void',
    assertServerEcho:
      '(timeline: TimelineObservation, needle: string): MessageRowObservation',
    assertSameRow:
      '(timeline: TimelineObservation, needle: string, eventId: string): MessageRowObservation',
    assertSheetClosed: '(sheet: SheetObservation): void',
  },
  'e2e/android/message-quote-journeys.mts': {
    appendNativeLine:
      '(client: AccountWorkspaceClient, prefix: string, line: string): Promise<void>',
  },
  'e2e/android/pinned-message-panel-artifacts.mts': {
    PinnedPanelPublicationSafety: 'unsafeSecrets,cleanupFailed,scrubFailed',
    redactDiagnosticText:
      '(text: string, secrets: Readonly<Record<string, string>>): string',
    scrubPinnedPanelArtifacts:
      '(output: string, secrets: Readonly<Record<string, string>>): Promise<void>',
    scanPinnedPanelArtifacts:
      '(output: string, secrets: Readonly<Record<string, string>>): Promise<void>',
    runPinnedPanelStageCleanup:
      '(actions: readonly (() => Promise<void>)[], failures: unknown[]): Promise<void>',
  },
};
const APPEND_FLOW_SHA256 =
  'd5484742203e25b7ba90cd58831219e0dcd5889080caaa3d8f106b2155eb7cd4';

/** Exported declarations' normalized shapes, keyed by name. */
function exportedShapes(file, source = read(file)) {
  const norm = (t) =>
    t
      .replace(/\s+/gu, ' ')
      .replace(/,\s*\)/gu, ')')
      .trim();
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = {};
  for (const st of tree.statements) {
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    if (ts.isFunctionDeclaration(st))
      out[st.name.text] = norm(
        `(${st.parameters.map((p) => p.getText(tree)).join(', ')}): ${st.type?.getText(tree)}`,
      );
    else if (ts.isInterfaceDeclaration(st))
      out[st.name.text] = st.members
        .map((m) => m.name?.getText(tree))
        .join(',');
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        out[d.name.text] = `const ${d.initializer.getText(tree)}`;
  }
  return out;
}

describe('Android quote-notification imported-export shape (ruled Q4)', () => {
  it('pins the shape of every name imported from message-quote and pinned-message-panel', () => {
    for (const [file, names] of Object.entries(IMPORTED_SHAPES)) {
      const shapes = exportedShapes(file);
      for (const [name, shape] of Object.entries(names))
        expect(shapes[name], `${file}#${name}`).toBe(shape);
    }
    expect(digest('e2e/android/flows/message-quote-append.yaml')).toBe(
      APPEND_FLOW_SHA256,
    );
  });

  it('imports exactly these names and nothing else from those modules', () => {
    for (const path of [
      'e2e/android/quote-notification-contract.mts',
      'e2e/android/quote-notification-journeys.mts',
    ]) {
      if (!existsSync(resolve(root, path))) continue;
      const tree = ts.createSourceFile(
        path,
        read(path),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const st of tree.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const spec = st.moduleSpecifier.text;
        if (
          !spec.startsWith('./message-quote-') &&
          !spec.startsWith('./pinned-message-panel-')
        )
          continue;
        const shapes =
          IMPORTED_SHAPES[
            `e2e/android/${spec.slice(2).replace(/\.mts$/u, '')}.mts`
          ];
        expect(shapes, `${path} imports ${spec}`).toBeDefined();
        for (const element of st.importClause?.namedBindings?.elements ?? [])
          expect(
            Object.keys(shapes),
            `${path}: ${element.name.text}`,
          ).toContain((element.propertyName ?? element.name).text);
      }
    }
  });

  it('fails each shape pin under an effective mutation', () => {
    const cases = [
      [
        'e2e/android/message-quote-contract.mts',
        'assertSameRow',
        (s) => s.replace(/(assertSameRow[\s\S]*?)needle/u, '$1text'),
      ],
      [
        'e2e/android/message-quote-journeys.mts',
        'appendNativeLine',
        (s) =>
          s.replace(
            /(export async function appendNativeLine\(\s*client: AccountWorkspaceClient,)/u,
            '$1 extra: string,',
          ),
      ],
      [
        'e2e/android/message-quote-observer.mts',
        'readComposer',
        (s) => s.replace(/Promise<ComposerObservation>/u, 'Promise<unknown>'),
      ],
      [
        'e2e/android/message-quote-contract.mts',
        'ComposerObservation',
        (s) => s.replace(/\n\s*readonly sendDisabled[^\n]*/u, ''),
      ],
      [
        'e2e/android/message-quote-contract.mts',
        'PARAGRAPH_SENTINEL',
        (s) => s.replace(/(PARAGRAPH_SENTINEL\s*=\s*)'1'/u, "$1'2'"),
      ],
      [
        'e2e/android/pinned-message-panel-artifacts.mts',
        'runPinnedPanelStageCleanup',
        (s) =>
          s
            .replace(
              /export (async )?function runPinnedPanelStageCleanup/u,
              '$1function runPinnedPanelStageCleanup',
            )
            .replace(
              /export (async function runPinnedPanelStageCleanup)/u,
              '$1',
            ),
      ],
    ];
    for (const [file, name, mutate] of cases) {
      const source = read(file);
      const mutated = mutate(source);
      expect(mutated, `${file}#${name} mutation applied`).not.toBe(source);
      expect(exportedShapes(file, mutated)[name], `${file}#${name}`).not.toBe(
        IMPORTED_SHAPES[file][name],
      );
    }
  });
});

describe('Android quote-notification contract ledger', () => {
  it('owns one stage, 6 direct + 2 inherited = 8 unique identities', async () => {
    const c = await loadContract();
    expect(c.QUOTE_NOTIFICATION_STAGES.map((entry) => entry.id)).toEqual([
      ...c.QUOTE_NOTIFICATION_STAGE_IDS,
    ]);
    expect(c.QUOTE_NOTIFICATION_STAGE_IDS).toEqual(['quoted-display-name']);
    expect(
      c.QUOTE_NOTIFICATION_STAGES.flatMap((entry) => entry.assertions),
    ).toEqual(ALL_IDENTITIES);
    expect(c.QUOTE_NOTIFICATION_STAGES[0].title).toBe(
      'a quoted display name gives the reader no highlight',
    );
    expect(c.QUOTE_NOTIFICATION_STAGES[0].source).toBe(`${PREDECESSOR}:64-174`);
    expect(c.QUOTE_NOTIFICATION_ASSERTION_RECORDS).toBe(8);
    expect(c.QUOTE_NOTIFICATION_DIRECT).toBe(6);
    expect(c.QUOTE_NOTIFICATION_INHERITED).toBe(2);
    expect(new Set(ALL_IDENTITIES).size).toBe(8);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const c = await loadContract();
    expect(() =>
      c.assertQuoteNotificationRecords(STAGE.id, ALL_IDENTITIES),
    ).not.toThrow();
    for (const invalid of [
      [],
      ALL_IDENTITIES.slice(0, -1),
      [...ALL_IDENTITIES, ALL_IDENTITIES.at(-1)],
      [...ALL_IDENTITIES].reverse(),
    ])
      expect(() =>
        c.assertQuoteNotificationRecords(STAGE.id, invalid),
      ).toThrow();
    for (const suffix of STAGE.suffixes)
      expect(c.quoteNotificationAssertion(STAGE.id, suffix)).toBe(
        `quote-notification.${STAGE.id}.${suffix}`,
      );
    expect(() => c.quoteNotificationAssertion(STAGE.id, 'not-owned')).toThrow();
    expect(() =>
      c.quoteNotificationAssertion('not-a-stage', 'composer-visible'),
    ).toThrow();
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertQuoteNotificationReceiptName } = await loadContract();
    for (const name of ['room-open', 'source-sent', 'pre-probe', 'probe-sent'])
      expect(() => assertQuoteNotificationReceiptName(name)).not.toThrow();
    for (const name of [...STAGE.suffixes, 'Room-Open', 'a/b', '', '1abc'])
      expect(() => assertQuoteNotificationReceiptName(name)).toThrow();
  });
});

describe('Android quote-notification texts and asserters', () => {
  const WRITER = '@qmw:localhost';
  const READER = '@qmr:localhost';
  const create = () => ({
    type: 'm.room.create',
    event_id: '$create',
    sender: WRITER,
    content: {},
  });
  const member = (user, membership, displayname) => ({
    type: 'm.room.member',
    state_key: user,
    sender: user,
    event_id: `$m-${user}-${membership}`,
    content: { membership, ...(displayname ? { displayname } : {}) },
  });
  const message = (sender, body, id, content = {}) => ({
    type: 'm.room.message',
    sender,
    event_id: id,
    content: { msgtype: 'm.text', body, ...content },
  });
  const arrangedEvents = () => [
    create(),
    member(WRITER, 'join'),
    member(READER, 'invite', 'Zephyrine'),
    member(READER, 'join', 'Zephyrine'),
    message(READER, 'Zephyrine, can you look at this?', '$src'),
  ];
  const arranged = { writerId: WRITER, readerId: READER, sourceId: '$src' };
  const sheet = (change = {}) => ({
    dialogs: 1,
    dialogVisible: true,
    quote: { count: 1, visible: true },
    copy: { count: 1, visible: true },
    forward: { count: 1, visible: true },
    cancel: { count: 1, visible: true },
    ...change,
  });
  const composer = (change = {}) => ({
    count: 1,
    visible: true,
    focused: true,
    value: '',
    placeholder: '',
    selectionStart: 0,
    selectionEnd: 0,
    sendCount: 1,
    sendDisabled: false,
    href: '',
    ...change,
  });

  it('types exactly the predecessor texts', async () => {
    const c = await loadContract();
    expect([c.READER_DISPLAY_NAME, c.SOURCE_BODY]).toEqual([
      'Zephyrine',
      'Zephyrine, can you look at this?',
    ]);
    expect(c.QUOTED_COMPOSER).toBe('> Zephyrine, can you look at this?\n\n');
    expect(c.QUOTED_COMPOSER.length).toBe(36);
    expect([c.RUN_SUFFIX, c.WRITER_ROLE, c.READER_ROLE]).toEqual([
      'qm',
      'qm-writer',
      'qm-reader',
    ]);
    expect([
      c.quoteRoomName('r'),
      c.answerText('r'),
      c.probeText('r'),
      c.sourceTxn('r'),
      c.probeTxn('r'),
    ]).toEqual(['Quote mentions r', 'on it r', 'poke r', 'r-src', 'r-probe']);
  });

  it('asserts the arrangement: the reader sent the source, joined as Zephyrine, nothing else', async () => {
    const c = await loadContract();
    expect(() => c.assertArrangement(arrangedEvents(), arranged)).not.toThrow();
    const swap = (index, event) =>
      arrangedEvents().map((e, i) => (i === index ? event : e));
    for (const invalid of [
      swap(4, message(WRITER, 'Zephyrine, can you look at this?', '$src')),
      [...arrangedEvents(), message(WRITER, 'again', '$two')],
      swap(3, member(READER, 'join', 'Zephyrin')),
      swap(3, member(READER, 'invite', 'Zephyrine')),
      arrangedEvents().slice(1),
    ])
      expect(() => c.assertArrangement(invalid, arranged)).toThrow();
  });

  it('asserts the answer event, exactly', async () => {
    const c = await loadContract();
    const run = { writerId: WRITER, answerId: '$a', run: 'r' };
    const body = '> Zephyrine, can you look at this?\n\non it r';
    const good = message(WRITER, body, '$a', {
      format: 'org.matrix.custom.html',
      'm.mentions': {},
    });
    expect(c.assertAnswerEvent([good], run)).toEqual({
      namesReader: true,
      mentionsKey: true,
      relation: false,
    });
    for (const invalid of [
      [message(WRITER, body.replace('this?', 'this!'), '$a')],
      [message(WRITER, 'on it r', '$a')],
      [message(READER, body, '$a')],
      [message(WRITER, body, '$other')],
    ])
      expect(() => c.assertAnswerEvent(invalid, run)).toThrow();
  });

  it('asserts the sheet and the Quote action', async () => {
    const c = await loadContract();
    expect(() => c.assertSheetVisible(sheet())).not.toThrow();
    expect(() => c.assertQuoteOffered(sheet())).not.toThrow();
    for (const change of [
      { dialogs: 0 },
      { dialogs: 2 },
      { dialogVisible: false },
    ])
      expect(() => c.assertSheetVisible(sheet(change))).toThrow();
    for (const change of [
      { quote: { count: 0, visible: false } },
      { quote: { count: 2, visible: true } },
      { quote: { count: 1, visible: false } },
    ])
      expect(() => c.assertQuoteOffered(sheet(change))).toThrow();
  });

  it('asserts the composer before and after the native Quote [RF-4]', async () => {
    const c = await loadContract();
    expect(() => c.assertComposerEmpty(composer())).not.toThrow();
    expect(() =>
      c.assertComposerEmpty(composer({ value: c.QUOTED_COMPOSER })),
    ).toThrow();
    const quoted = (change = {}) =>
      composer({
        value: c.QUOTED_COMPOSER,
        selectionStart: 36,
        selectionEnd: 36,
        ...change,
      });
    expect(() => c.assertComposerQuote(quoted())).not.toThrow();
    for (const value of [
      '> Zephyrine, can you look at this!\n\n',
      '> Zephyrine, can you look at this?\n',
      '> Zephyrine, can you look at this?\n>\n\n',
    ])
      expect(() => c.assertComposerQuote(quoted({ value }))).toThrow();
    expect(() => c.assertQuoteCaret(quoted())).not.toThrow();
    for (const change of [
      { selectionStart: 0 },
      { selectionStart: 30 },
      { focused: false },
    ])
      expect(() => c.assertQuoteCaret(quoted(change))).toThrow();
  });

  it('decides the notification and highlight on one incremental response [RF-1]', async () => {
    const c = await loadContract();
    const ok = {
      since: 'b1',
      nextBatch: 'b2',
      room: {
        notificationCount: 2,
        highlightCount: 0,
        timelineEventIds: ['$probe'],
      },
    };
    const e = { since: 'b1', probeId: '$probe' };
    expect(() => c.assertNotificationPositive(ok, e)).not.toThrow();
    expect(() => c.assertHighlightZero(ok)).not.toThrow();
    for (const since of [null, 'b0'])
      expect(() => c.assertNotificationPositive({ ...ok, since }, e)).toThrow(
        /incremental sync/,
      );
    expect(() =>
      c.assertNotificationPositive({ since: 'b1', nextBatch: 'b2' }, e),
    ).toThrow(/carries the Room/);
    expect(() =>
      c.assertNotificationPositive(
        { ...ok, room: { ...ok.room, timelineEventIds: [] } },
        e,
      ),
    ).toThrow(/probe landed/);
    expect(() =>
      c.assertNotificationPositive(
        { ...ok, room: { ...ok.room, notificationCount: 0 } },
        e,
      ),
    ).toThrow(/positive notification count/);
    expect(() =>
      c.assertHighlightZero({ ...ok, room: { ...ok.room, highlightCount: 1 } }),
    ).toThrow(/no highlight/);
  });
});

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

describe('Android quote-notification diagnostics safety', () => {
  const RUN = 'r';
  const WRITER = {
    userId: '@qmw-r:localhost',
    username: 'qmw-r',
    password: 'writer-Pass-1!',
  };
  const READER = {
    userId: '@qmr-r:localhost',
    username: 'qmr-r',
    password: 'reader-Pass-2!',
  };
  const ROOM = { id: '!quoteRoom:localhost', name: 'Quote mentions r' };
  const IDS = { source: '$src', answer: '$answer', probe: '$probe' };
  const stageIds = (c) => ({
    accounts: [WRITER, READER],
    rooms: [ROOM],
    texts: [c.answerText(RUN), c.probeText(RUN)],
    transactions: [c.sourceTxn(RUN), c.probeTxn(RUN)],
    eventIds: [IDS.source, IDS.answer, IDS.probe],
  });

  it('registers every identifier for the two Accounts and the Room, excludes the fixed texts, never the bare server name', async () => {
    const c = await loadContract();
    const { quoteNotificationSecrets } = await loadArtifacts();
    const secrets = quoteNotificationSecrets(
      'quoted-display-name',
      stageIds(c),
    );
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_QUOTE_NOTIFICATION_QUOTED_DISPLAY_NAME_'),
      ),
    ).toBe(true);
    const values = new Set(Object.values(secrets));
    for (const value of [
      WRITER.userId,
      encodeURIComponent(WRITER.userId),
      WRITER.username,
      WRITER.password,
      READER.userId,
      READER.username,
      READER.password,
      ROOM.id,
      ROOM.id.slice(1),
      encodeURIComponent(ROOM.id),
      Buffer.from(ROOM.id).toString('base64url'),
      ROOM.name,
      'on it r',
      'poke r',
      'r-src',
      'r-probe',
      '$src',
      '$answer',
      '$probe',
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    for (const fixed of [
      c.READER_DISPLAY_NAME,
      c.SOURCE_BODY,
      c.QUOTED_COMPOSER,
    ])
      expect(Object.values(secrets)).not.toContain(fixed);
    expect(() =>
      quoteNotificationSecrets('not-a-stage', stageIds(c)),
    ).toThrow();
  });

  it('rejects a leaked answer, probe, Room name, token, password and event id', async () => {
    const c = await loadContract();
    const { quoteNotificationSecrets } = await loadArtifacts();
    const { scanPinnedPanelArtifacts } =
      await import('../e2e/android/pinned-message-panel-artifacts.mts');
    const secrets = quoteNotificationSecrets(
      'quoted-display-name',
      stageIds(c),
    );
    await withOutput('trinity-quote-scan-', async (output) => {
      await mkdir(join(output, 'quoted-display-name'));
      const capture = join(output, 'quoted-display-name', 'receipt-01-x.json');
      for (const unsafe of [
        `body=${c.answerText(RUN)}`,
        `body=${c.probeText(RUN)}`,
        `room=${ROOM.name}`,
        'syt_writerFixtureToken_abc',
        'syt_readerFixtureToken_def',
        'syt_writerDeviceToken_ghi',
        WRITER.password,
        READER.password,
        IDS.answer,
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

  it('publishes only a complete, clean, unretried one-stage 8-record Pixel 5 run', async () => {
    const c = await loadContract();
    const artifacts = await loadArtifacts();
    const { PIXEL_5_ACCOUNT_PROFILE, DESKTOP_ACCOUNT_PROFILE } =
      await import('../e2e/android/account-workspace-client.mts');
    const report = () => ({
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 8,
      attempt: 1,
      retries: 0,
      stages: c.QUOTE_NOTIFICATION_STAGES.map((entry) => ({
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
      const arrange = async (value = report()) => {
        await write('journeys.json', value);
        await write('runtime-provenance.json', {
          schemaVersion: 1,
          profile: {
            requested: PIXEL_5_ACCOUNT_PROFILE,
            digest: sha256(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
          },
        });
        for (const entry of c.QUOTE_NOTIFICATION_STAGES) {
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
          artifacts.markQuoteNotificationDiagnosticsSafe(
            output,
            options.secrets ?? {},
            options.flags ?? flags,
            undefined,
            value,
          ),
        ).rejects.toThrow();
        expect(existsSync(marker)).toBe(false);
      };

      await arrange();
      await artifacts.markQuoteNotificationDiagnosticsSafe(
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
        mutate((value) => value.stages.pop()), // 0 stages
        mutate((value) => {
          value.stages[0].assertions.pop();
          value.stages[0].assertionRecords = 7;
        }), // 7 records
        mutate((value) => {
          const a = value.stages[0].assertions;
          [a[6], a[7]] = [a[7], a[6]];
        }), // records 7 and 8 swapped
        mutate((value) => (value.retries = 1)), // retries: 1
      ]) {
        await arrange(invalid);
        await refused(invalid);
      }

      await arrange();
      await write(join('quoted-display-name', 'profile-applied.json'), {
        requested: DESKTOP_ACCOUNT_PROFILE,
      });
      await refused(report()); // wrong profile

      await arrange();
      await refused(report(), { flags: { ...flags, cleanupFailed: true } });

      await arrange();
      const secrets = artifacts.quoteNotificationSecrets(
        'quoted-display-name',
        {
          accounts: [],
          rooms: [],
          texts: [],
          eventIds: [IDS.answer],
          transactions: [],
        },
      );
      await writeFile(
        join(output, 'quoted-display-name', 'passed-surface.json'),
        `token=${IDS.answer}`,
      );
      await refused(report(), { secrets }); // an unscrubbed identifier
    });
  });

  it('revokes publication on abort with the exact message', async () => {
    const { revokeQuoteNotificationPublicationOnAbort } = await loadArtifacts();
    await withOutput('trinity-quote-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeQuoteNotificationPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeQuoteNotificationPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before quote-notification publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Simulated installed app: the exact journey against production-shaped DOM   */
/* -------------------------------------------------------------------------- */

const JOURNEYS = 'e2e/android/quote-notification-journeys.mts';
const CONTRACT_PATH = 'e2e/android/quote-notification-contract.mts';
const ARTIFACTS_PATH = 'e2e/android/quote-notification-artifacts.mts';
const loadJourneys = () =>
  import('../e2e/android/quote-notification-journeys.mts');

const SIM_ROOM = '!Room-AbC:example.test';
const SIM_HOMESERVER = 'https://localhost:8448';
const SIM_WRITER = {
  userId: '@qmw:example.test',
  username: 'qmw',
  password: 'w-pass"word\\token',
  homeserver: SIM_HOMESERVER,
};
const SIM_READER = {
  userId: '@qmr:example.test',
  username: 'qmr',
  password: 'r-pass"word\\token',
  homeserver: SIM_HOMESERVER,
};
const SIM_ROUTE = `https://localhost/rooms/${Buffer.from(SIM_ROOM).toString('base64url')}?account=${encodeURIComponent(SIM_WRITER.userId)}&view=rooms`;
const SIM_RUN = 'r';
const SIM_ROOM_NAME = `Quote mentions ${SIM_RUN}`;
const SIM_ANSWER = `on it ${SIM_RUN}`;
const SIM_PROBE = `poke ${SIM_RUN}`;
const simEscape = (value) =>
  String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
const SIM_COMPOSER = '[data-testid="composer-input"]';
const SIM_APPEND_FLOW = 'e2e/android/flows/message-quote-append.yaml';

/**
 * A model of the installed app, its Synapse Room and Gboard. Every state is a
 * pure function of the fake clock and of the returns recorded when a native
 * call finished (#757 final review): a tap only enqueues its transition, and
 * a later render or read applies it once `lag[label]` has elapsed since the
 * call returned. Only the composer edits of runFlow/key/keyCombination apply
 * inside the call, because appendNativeLine waits on each with its own window.
 */
async function simulatedQuoteNotificationApp(faults = {}) {
  const c = await loadContract();
  const controller = new AbortController();
  const advance = (ms) => vi.setSystemTime(Date.now() + ms);
  const state = {
    actions: [],
    rest: [],
    written: [],
    returns: {},
    queue: [],
    signedIn: false,
    roomsShown: false,
    roomOpen: false,
    composer: { value: '', start: 0, end: 0, focused: false },
    sendReady: false,
    sheet: false,
    local: null,
    answerRows: [],
    firstReadyRead: undefined,
    probeReturn: undefined,
    secretsAtReset: undefined,
    syncs: 0,
  };
  const lagOf = (label) => faults.lag?.[label] ?? 0;
  const applyDue = () => {
    state.queue = state.queue.filter((entry) => {
      if (Date.now() - state.returns[entry.label] < lagOf(entry.label))
        return true;
      return entry.apply() === false;
    });
  };
  const sourceShown = () =>
    state.roomOpen &&
    state.firstReadyRead !== undefined &&
    Date.now() - state.firstReadyRead >= lagOf('sourceRow');
  const rowHtml = (id, body) =>
    `<div class="msg" data-mid="${simEscape(id)}"><div class="msg__body"><div class="msg__content"><p class="msg__text">${simEscape(body)}</p></div></div></div>`;
  const sheetButtons = () =>
    [
      faults.quoteMissing
        ? ''
        : '<button data-testid="sheet-quote">Quote</button>',
      faults.twoQuotes
        ? '<button data-testid="sheet-quote">Quote</button>'
        : '',
      '<button data-testid="sheet-copy">Copy text</button>',
      '<button data-testid="sheet-forward">Forward</button>',
      '<button>Cancel</button>',
    ].join('');
  const render = () => {
    applyDue();
    const parts = ['<nav>'];
    if (state.signedIn)
      parts.push('<button data-testid="rail-rooms">Rooms</button>');
    parts.push('</nav>');
    if (state.roomsShown)
      parts.push(
        `<aside><div class="channel">${simEscape(SIM_ROOM_NAME)}</div></aside>`,
      );
    if (state.roomOpen) {
      parts.push(
        '<div class="scroll"><div class="msg msg--event" data-mid="$create"><span class="msg__event-text">created the room</span></div>',
      );
      if (sourceShown()) parts.push(rowHtml('$src', c.SOURCE_BODY));
      if (state.local) parts.push(rowHtml('~local', state.local.body));
      for (const row of state.answerRows) parts.push(rowHtml(row.id, row.body));
      parts.push('</div>');
      const enabled =
        state.composer.value.trim() &&
        state.sendReady &&
        !faults.sendNeverEnabled;
      parts.push(
        `<trn-message-composer><textarea data-testid="composer-input" placeholder="${simEscape(`Message #${SIM_ROOM_NAME}`)}"></textarea><button data-testid="composer-send"${enabled ? '' : ' disabled'}>Send</button></trn-message-composer>`,
      );
    }
    if (state.sheet)
      parts.push(
        `<div role="dialog" aria-label="Message actions"><div data-testid="action-sheet-surface">${sheetButtons()}</div></div>`,
      );
    return parts.join('');
  };
  const dom = () => {
    const jsdom = new JSDOM(`<main>${render()}</main>`, {
      url: state.roomOpen ? SIM_ROUTE : 'https://localhost/rooms?account=x',
    });
    const { window } = jsdom;
    Object.defineProperty(window, 'innerWidth', {
      value: faults.profileWidth ?? 393,
    });
    Object.defineProperty(window, 'innerHeight', { value: 727 });
    Object.defineProperty(window, 'devicePixelRatio', { value: 2.75 });
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
    const input = window.document.querySelector(SIM_COMPOSER);
    if (input) {
      input.value = state.composer.value;
      input.setSelectionRange(state.composer.start, state.composer.end);
      if (state.composer.focused) input.focus();
    }
    return window;
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
      focused: state.composer.focused && element.matches(SIM_COMPOSER),
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
  /** A native call that only takes time: it advances the clock and records its return. */
  const finish = (label, ms = 1_000) => {
    advance(ms);
    state.returns[label] = Date.now();
  };
  const label = (selector, filter) =>
    `${selector}${filter.text || filter.exactText ? `|${filter.text ?? filter.exactText}` : ''}`;
  let context;
  const client = {
    workspaceRoot: root,
    applicationId: 'eu.qwky.trinity',
    signal: controller.signal,
    device: {
      async runFlow(flow, env) {
        assert(
          flow.endsWith(SIM_APPEND_FLOW),
          'Only the append flow is modelled',
        );
        applyDue();
        state.actions.push(`append|${env.SECRET_TEXT.slice(0, 1)}`);
        assert(
          state.composer.focused,
          'The append types into the focused composer',
        );
        advance(1_000);
        let typed = env.SECRET_TEXT;
        // Gboard capitalises the first letter after the sentinel.
        if (faults.capitalised)
          typed = `${typed.slice(0, 1)}${typed.slice(1, 2).toUpperCase()}${typed.slice(2)}`;
        if (faults.eraseQuote)
          state.composer = {
            value: typed,
            start: typed.length,
            end: typed.length,
            focused: true,
          };
        else insert(typed);
        state.sendReady = false;
        state.returns.runFlow = Date.now();
      },
    },
    webview: {
      diagnostics: {
        send: async (_method, { expression }) => {
          advance(faults.readMs ?? 1_000);
          const window = dom();
          if (
            state.roomOpen &&
            state.firstReadyRead === undefined &&
            expression.includes('sendCount')
          )
            state.firstReadyRead = Date.now();
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
      state.secretsAtReset = Object.values(context.secrets);
      finish('reset');
    },
    async login() {
      state.actions.push('login');
      finish('login');
      state.queue.push({
        label: 'login',
        apply: () => (state.signedIn = true),
      });
    },
    async hideKeyboard() {
      state.actions.push('hide-keyboard');
      finish('hide');
      state.queue.push({
        label: 'hide',
        apply: () => (state.sendReady = true),
      });
    },
    async elements(selector, filter) {
      advance(faults.readMs ?? 1_000);
      return elementsOf(selector, filter);
    },
    async waitElements(selector, accepts, description, filter, timeoutMs) {
      assert(Number.isFinite(timeoutMs), 'Simulated waits are bounded');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        controller.signal.throwIfAborted();
        advance(faults.readMs ?? 1_000);
        const values = elementsOf(selector, filter);
        if (accepts(values)) return values;
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for ${description}`);
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
      state.actions.push(`tap:${label(selector, filter)}`);
      const element = actionable(selector, filter);
      const testId = element.getAttribute('data-testid');
      const entries = [];
      if (testId === 'rail-rooms')
        entries.push({ label: 'rail', apply: () => (state.roomsShown = true) });
      else if (element.classList.contains('channel'))
        entries.push({
          label: 'room',
          apply: () => {
            state.roomOpen = true;
            const value = faults.prefilled ? c.QUOTED_COMPOSER : '';
            state.composer = {
              value,
              start: value.length,
              end: value.length,
              focused: false,
            };
          },
        });
      else if (testId === 'sheet-quote')
        entries.push({
          label: 'quote',
          apply: () => {
            if (faults.quoteIgnored) return;
            state.sheet = false;
            const value = faults.quoteValue ?? c.QUOTED_COMPOSER;
            const caret = faults.caretStart ? 0 : value.length;
            state.composer = {
              value,
              start: caret,
              end: caret,
              focused: !faults.blurAfterQuote,
            };
            state.sendReady = false;
          },
        });
      else if (testId === 'composer-send')
        entries.push(
          {
            label: 'send',
            apply: () => {
              state.local = { body: state.composer.value };
              if (!faults.notCleared)
                state.composer = {
                  value: '',
                  start: 0,
                  end: 0,
                  focused: state.composer.focused,
                };
            },
          },
          {
            label: 'echo',
            apply: () => {
              if (!state.local) return false;
              if (faults.echoNever) return undefined;
              const { body } = state.local;
              state.answerRows = [
                { id: '$answer', body },
                ...(faults.twoAnswerRows ? [{ id: '$answer2', body }] : []),
              ];
              state.local = null;
              return undefined;
            },
          },
        );
      else throw new Error(`Unmodelled simulated tap ${selector}`);
      advance(faults.tapMs ?? 1_000);
      for (const entry of entries) {
        state.returns[entry.label] = Date.now();
        state.queue.push(entry);
      }
    },
    async longPressCurrent(selector, filter = {}) {
      state.actions.push(`long-press:${label(selector, filter)}`);
      const found = matches(selector, filter);
      if (found.length !== 1)
        throw new Error(`Simulated long press needs one target: ${selector}`);
      advance(faults.tapMs ?? 1_000);
      state.returns.sheet = Date.now();
      state.queue.push({ label: 'sheet', apply: () => (state.sheet = true) });
    },
    async key(name) {
      applyDue();
      state.actions.push(`key:${name}`);
      advance(1_000);
      const { value, start } = state.composer;
      if (name === 'arrowLeft')
        state.composer.start = state.composer.end = Math.max(0, start - 1);
      else if (name === 'backspace') {
        if (!faults.sentinelKept) {
          state.composer.value = `${value.slice(0, start - 1)}${value.slice(start)}`;
          state.composer.start = state.composer.end = start - 1;
        }
      } else throw new Error(`Unmodelled key ${name}`);
      state.returns.key = Date.now();
    },
    async keyCombination(name) {
      applyDue();
      state.actions.push(`chord:${name}`);
      assert.equal(name, 'documentEnd');
      advance(1_000);
      state.composer.start = state.composer.end = state.composer.value.length;
      state.returns.chord = Date.now();
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture(name) {
      state.actions.push(`capture:${name}`);
    },
  };
  const history = () => {
    const member = (userId, membership, displayname) => ({
      type: 'm.room.member',
      event_id: `$member-${membership}`,
      state_key: userId,
      content: { membership, displayname },
    });
    const events = [
      ...(faults.noCreate
        ? []
        : [{ type: 'm.room.create', event_id: '$create', content: {} }]),
      member(SIM_WRITER.userId, 'join', 'Writer'),
      member(
        SIM_READER.userId,
        faults.readerInvited ? 'invite' : 'join',
        faults.displayName ?? c.READER_DISPLAY_NAME,
      ),
      {
        type: 'm.room.message',
        event_id: '$src',
        sender: faults.sourceFromWriter ? SIM_WRITER.userId : SIM_READER.userId,
        content: { msgtype: 'm.text', body: c.SOURCE_BODY },
      },
    ];
    if (faults.extraMessage)
      events.push({
        type: 'm.room.message',
        event_id: '$extra',
        sender: SIM_READER.userId,
        content: { msgtype: 'm.text', body: 'extra' },
      });
    if (
      state.returns.send !== undefined &&
      !faults.serverNever &&
      Date.now() - state.returns.send >= lagOf('server')
    ) {
      const body = faults.serverBody ?? `${c.QUOTED_COMPOSER}${SIM_ANSWER}`;
      events.push({
        type: 'm.room.message',
        event_id: '$answer',
        sender: faults.answerFromReader ? SIM_READER.userId : SIM_WRITER.userId,
        content: {
          msgtype: 'm.text',
          body,
          format: 'org.matrix.custom.html',
          formatted_body: `<blockquote>${simEscape(body)}</blockquote>`,
          'm.mentions': {},
        },
      });
    }
    return { chunk: [...events].reverse() };
  };
  const fixtures = {
    async account(role) {
      assert(
        [c.WRITER_ROLE, c.READER_ROLE].includes(role),
        `Unknown role ${role}`,
      );
      return role === c.WRITER_ROLE ? SIM_WRITER : SIM_READER;
    },
    async setDisplayName(account, name) {
      assert.equal(account, SIM_READER);
      assert.equal(name, c.READER_DISPLAY_NAME);
      state.rest.push('rest:setDisplayName');
    },
    async createRoom(account, { name, preset, invite }) {
      assert.equal(account, SIM_WRITER);
      assert.equal(preset, 'private_chat');
      assert.deepEqual(invite, [SIM_READER.userId]);
      state.rest.push('rest:createRoom');
      return { id: SIM_ROOM, name };
    },
    async join(account, roomId) {
      assert.equal(account, SIM_READER);
      assert.equal(roomId, SIM_ROOM);
      state.rest.push('rest:join');
    },
    async sendMessage(account, roomId, body, txn) {
      assert.equal(roomId, SIM_ROOM);
      if (txn === c.sourceTxn(SIM_RUN)) {
        assert.equal(account, SIM_READER);
        assert.equal(body, c.SOURCE_BODY);
        state.rest.push('rest:sendMessage:source');
        return '$src';
      }
      assert.equal(txn, c.probeTxn(SIM_RUN));
      assert.equal(account, SIM_WRITER);
      assert.equal(body, SIM_PROBE);
      state.rest.push('rest:sendMessage:probe');
      advance(faults.sendMs ?? 0);
      state.probeReturn = Date.now();
      return '$probe';
    },
    async roomMessages(account, roomId) {
      assert.equal(account, SIM_WRITER);
      assert.equal(roomId, SIM_ROOM);
      advance(faults.readMs ?? 1_000);
      return history();
    },
    async roomUnreadSync(observer, roomId, requestedSince) {
      assert.equal(observer, SIM_READER);
      assert.equal(roomId, SIM_ROOM);
      advance(faults.readMs ?? 1_000);
      const since = faults.dropSince ? undefined : requestedSince;
      state.rest.push(
        since === undefined
          ? 'rest:roomUnreadSync'
          : 'rest:roomUnreadSync:since',
      );
      if (since === undefined)
        return {
          since: null,
          nextBatch: 'b1',
          room: {
            notificationCount: 1,
            highlightCount: 0,
            timelineEventIds: ['$src', '$answer'],
          },
        };
      if (state.probeReturn === undefined)
        throw new Error('Incremental sync before the probe');
      if (
        faults.notifyNever ||
        Date.now() - state.probeReturn < lagOf('notify')
      )
        return { since, nextBatch: 'b2' };
      const sequence = faults.highlightSequence ?? [faults.highlight ?? 0];
      const highlightCount =
        sequence[Math.min(state.syncs++, sequence.length - 1)];
      return {
        since,
        nextBatch: 'b3',
        room: {
          notificationCount: faults.notificationCount ?? 2,
          highlightCount,
          timelineEventIds: faults.probeMissing ? [] : ['$probe'],
        },
      };
    },
  };
  context = {
    entry: c.QUOTE_NOTIFICATION_STAGES[0],
    records: [],
    identities: new Set(),
    receipts: 0,
    client,
    fixtures,
    secrets: {},
    safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
    native: false,
    signal: controller.signal,
    ledger: {
      run: SIM_RUN,
      accounts: [],
      rooms: [],
      texts: [],
      eventIds: [],
      transactions: [],
    },
  };
  return { client, fixtures, state, context };
}

/** Runs one simulated stage on the fake clock, restoring real timers afterwards. */
async function withSimulatedStage(faults, run) {
  const journeys = await loadJourneys();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  try {
    const app = await simulatedQuoteNotificationApp(faults);
    return await run({
      ...app,
      runQuotedDisplayName: journeys.runQuotedDisplayName,
    });
  } finally {
    vi.useRealTimers();
  }
}

const SIM_LINE = `on it ${SIM_RUN}`;
const SIM_ACTIONS = [
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|${SIM_ROOM_NAME}`,
  'hide-keyboard',
  'long-press:.scroll .msg[data-mid^="$"]|Zephyrine, can you look at this?',
  'tap:[data-testid="sheet-quote"]',
  'append|1',
  ...Array(SIM_LINE.length).fill('key:arrowLeft'),
  'key:backspace',
  'chord:documentEnd',
  'hide-keyboard',
  'tap:[data-testid="composer-send"]',
];
const SIM_RECEIPTS = [
  'arranged',
  'composer-empty',
  'quote-offered',
  'quote-picked',
  'quote-caret',
  'answer-native-draft',
  'answer-sent',
  'answer-event',
  'sync-token',
  'probe-sent',
];
const SIM_SLICE = {
  none: 0,
  reset: 1,
  room: 5,
  press: 7,
  quote: 8,
  append: 9,
  backspace: 9 + SIM_LINE.length + 1,
  noSend: SIM_ACTIONS.length - 1,
  send: SIM_ACTIONS.length,
};

/** Written evidence carries digests and booleans, never an identifier, a credential or the sync token. */
function assertIdFreeEvidence(state, secrets) {
  const written = JSON.stringify(state.written);
  for (const value of [...secrets, 'b1'])
    expect(written, `written evidence leaks ${value}`).not.toContain(value);
  for (const action of state.actions)
    expect(action.split('|')[0]).not.toMatch(
      /[$!~][A-Za-z0-9_]{2,}|data-mid[*~|]?=[^^]/u,
    );
}

describe('Android quote-notification native journey against a simulated installed app', () => {
  it('drives the exact native sequence and records all eight identities in order', async () => {
    await withSimulatedStage(
      {},
      async ({ context, state, runQuotedDisplayName }) => {
        await runQuotedDisplayName(context);
        expect(context.records).toEqual(ALL_IDENTITIES);
        expect(state.actions).toEqual(SIM_ACTIONS);
        const at = (entry) => state.rest.indexOf(entry);
        expect(state.rest.slice(0, 4)).toEqual([
          'rest:setDisplayName',
          'rest:createRoom',
          'rest:join',
          'rest:sendMessage:source',
        ]);
        expect(at('rest:sendMessage:probe')).toBeGreaterThan(-1);
        expect(at('rest:sendMessage:probe')).toBeLessThan(
          at('rest:roomUnreadSync:since'),
        );
        expect(
          state.written
            .map(({ name }) => name)
            .filter((name) => name.startsWith('receipt-'))
            .map((name) => name.replace(/^receipt-\d+-/u, '')),
        ).toEqual(SIM_RECEIPTS);
        for (const value of [
          SIM_WRITER.userId,
          SIM_WRITER.username,
          SIM_WRITER.password,
          SIM_READER.userId,
          SIM_READER.username,
          SIM_READER.password,
          SIM_ROOM,
          SIM_ROOM_NAME,
          '$src',
          SIM_ANSWER,
          SIM_PROBE,
          'r-src',
          'r-probe',
        ])
          expect(state.secretsAtReset).toContain(value);
        assertIdFreeEvidence(state, Object.values(context.secrets));
      },
    );
  }, 30_000);

  const CONTROLS = [
    ['sourceFromWriter', { sourceFromWriter: true }, /reader sent/u, 'none'],
    ['extraMessage', { extraMessage: true }, /exactly the arranged/u, 'none'],
    [
      'displayName',
      { displayName: 'Zephyrin' },
      /joined as Zephyrine/u,
      'none',
    ],
    ['readerInvited', { readerInvited: true }, /joined the Room/u, 'none'],
    ['noCreate', { noCreate: true }, /m\.room\.create/u, 'none'],
    ['profileWidth', { profileWidth: 412 }, /Pixel 5/u, 'reset'],
    [
      'prefilled [RF-4]',
      { prefilled: true },
      /empty before the native Quote/u,
      'room',
    ],
    [
      'quoteMissing',
      { quoteMissing: true },
      /Exactly one Quote action/u,
      'press',
    ],
    ['twoQuotes', { twoQuotes: true }, /Exactly one Quote action/u, 'press'],
    [
      'quoteIgnored [RF-4]',
      { quoteIgnored: true },
      /No message-action sheet remains/u,
      'quote',
    ],
    [
      'quote value: changed punctuation',
      { quoteValue: '> Zephyrine, can you look at this!\n\n' },
      /quote block and a blank line/u,
      'quote',
    ],
    [
      'quote value: no blank line',
      { quoteValue: '> Zephyrine, can you look at this?\n' },
      /quote block and a blank line/u,
      'quote',
    ],
    [
      'quote value: marked blank line',
      { quoteValue: '> Zephyrine, can you look at this?\n>\n\n' },
      /quote block and a blank line/u,
      'quote',
    ],
    ['caretStart', { caretStart: true }, /end of the quote/u, 'quote'],
    ['blurAfterQuote', { blurAfterQuote: true }, /native focus/u, 'quote'],
    [
      'capitalised',
      { capitalised: true },
      /sentinel-prefixed native paragraph/u,
      'append',
    ],
    [
      'eraseQuote',
      { eraseQuote: true },
      /sentinel-prefixed native paragraph/u,
      'append',
    ],
    ['sentinelKept', { sentinelKept: true }, /sentinel removed/u, 'backspace'],
    [
      'sendNeverEnabled',
      { sendNeverEnabled: true },
      /Send button is enabled/u,
      'noSend',
      4,
    ],
    [
      'notCleared',
      { notCleared: true },
      /empty after the native send/u,
      'send',
    ],
    ['echoNever', { echoNever: true }, /homeserver event id/u, 'send'],
    ['twoAnswerRows', { twoAnswerRows: true }, /Exactly one Room row/u, 'send'],
    [
      'serverBody with one character changed',
      { serverBody: `${'> Zephyrine, can you look at this?\n\n'}on it q` },
      /quote and the answer, exactly/u,
      'send',
    ],
    [
      'answerFromReader',
      { answerFromReader: true },
      /writer sent the answer/u,
      'send',
    ],
    ['notifyNever', { notifyNever: true }, /carries the Room/u, 'send'],
    [
      'notificationCount 0',
      { notificationCount: 0 },
      /positive notification count/u,
      'send',
    ],
    ['probeMissing [RF-1]', { probeMissing: true }, /probe landed/u, 'send'],
    [
      'dropSince [RF-1]',
      { dropSince: true },
      /incremental sync since the pre-probe token/u,
      'send',
    ],
    ['highlight 1', { highlight: 1 }, /no highlight/u, 'send', 7],
    [
      'highlightSequence [1, 0] [RF-2]',
      { highlightSequence: [1, 0] },
      /no highlight/u,
      'send',
      7,
    ],
  ];
  for (const [name, faults, message, upTo, recordCount] of CONTROLS)
    it(`rejects ${name} with ${message}`, async () => {
      await withSimulatedStage(
        faults,
        async ({ context, state, runQuotedDisplayName }) => {
          await expect(runQuotedDisplayName(context)).rejects.toThrow(message);
          expect(state.actions).toEqual(SIM_ACTIONS.slice(0, SIM_SLICE[upTo]));
          if (recordCount !== undefined)
            expect(context.records).toHaveLength(recordCount);
        },
      );
    }, 40_000);

  it('rejects an incremental sync read before the probe send [RF-1, journeys mutation]', async () => {
    const path = resolve(root, JOURNEYS);
    const source = readFileSync(path, 'utf8');
    const tree = ts.createSourceFile(
      JOURNEYS,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const statements = [];
    const collect = (node) => {
      if (ts.isVariableStatement(node)) statements.push(node);
      ts.forEachChild(node, collect);
    };
    collect(tree);
    const named = (name) =>
      statements.find(
        (st) => st.declarationList.declarations[0].name.getText(tree) === name,
      );
    const decided = named('decided');
    const probeId = named('probeId');
    expect(decided).toBeDefined();
    expect(probeId).toBeDefined();
    expect(probeId.getStart(tree)).toBeLessThan(decided.getStart(tree));
    // The anchor const would sit in its temporal dead zone; the moved read anchors at now.
    const moved = decided.getText(tree).replaceAll('probeSentAt', 'Date.now()');
    const mutated = [
      source.slice(0, probeId.getStart(tree)),
      moved,
      '\n  ',
      source.slice(probeId.getStart(tree), decided.getStart(tree)),
      source.slice(decided.getEnd()),
    ].join('');
    expect(mutated).not.toBe(source);
    const temp = resolve(
      root,
      `e2e/android/quote-notification-journeys.probe-order-${process.pid}.mts`,
    );
    try {
      await writeFile(temp, mutated);
      const journeys = await import(pathToFileURL(temp).href);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
      try {
        const app = await simulatedQuoteNotificationApp({});
        await expect(
          journeys.runQuotedDisplayName(app.context),
        ).rejects.toThrow('Incremental sync before the probe');
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }, 40_000);

  // [RF-3] Every window is anchored after its event: 45 s native calls, one pass 5 s inside the bound, one fail 1 s past it.
  const WINDOWS = [
    ['room', 15_000, 21_000, /composer/u],
    ['sourceRow', 25_000, 31_000, /Exactly one Room row/u],
    ['sheet', 15_000, 21_000, /Message actions sheet/u],
    ['quote', 15_000, 21_000, /No message-action sheet remains/u],
    ['hide', 15_000, 21_000, /Send button is enabled/u],
    ['echo', 25_000, 31_000, /homeserver event id/u],
    ['server', 15_000, undefined, /answer event is on the server/u],
    ['notify', 25_000, 31_000, /carries the Room/u],
  ];
  const SLOW = { tapMs: 45_000, sendMs: 45_000 };
  for (const [key, passAt, failAt, message] of WINDOWS) {
    it(`passes the ${key} window at ${passAt} ms [RF-3]`, async () => {
      await withSimulatedStage(
        { ...SLOW, lag: { [key]: passAt } },
        async ({ context, runQuotedDisplayName }) => {
          await runQuotedDisplayName(context);
          expect(context.records).toEqual(ALL_IDENTITIES);
        },
      );
    }, 60_000);
    it(`fails the ${key} window at ${failAt ?? 'never'} ms [RF-3]`, async () => {
      const faults =
        failAt === undefined
          ? { ...SLOW, serverNever: true }
          : { ...SLOW, lag: { [key]: failAt } };
      await withSimulatedStage(
        faults,
        async ({ context, runQuotedDisplayName }) => {
          await expect(runQuotedDisplayName(context)).rejects.toThrow(message);
        },
      );
    }, 60_000);
  }
  for (const [key, message] of [
    ['server', /answer event is on the server/u],
    ['notify', /carries the Room/u],
  ])
    it(`fails a ${key} convergence at 31 000 ms even when every read takes 10 s [RF-3]`, async () => {
      await withSimulatedStage(
        { ...SLOW, readMs: 10_000, lag: { [key]: 31_000 } },
        async ({ context, runQuotedDisplayName }) => {
          await expect(runQuotedDisplayName(context)).rejects.toThrow(message);
        },
      );
    }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Teardown, must-run steps and redaction                                     */
/* -------------------------------------------------------------------------- */

const treeOf = (source) =>
  ts.createSourceFile(JOURNEYS, source, ts.ScriptTarget.Latest, true);

/** Apply source edits (`{ start, end, text }`) from the back, so earlier offsets stay valid. */
function applyEdits(source, edits) {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, { start, end, text: replacement }) =>
        `${text.slice(0, start)}${replacement}${text.slice(end)}`,
      source,
    );
}

const allNodes = (tree) => {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return nodes;
};

/** The structure of `runQuoteNotificationSuite` that the must-run steps depend on (rule d). */
function runnerShape(source) {
  const tree = treeOf(source);
  const runner = allNodes(tree).find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'runQuoteNotificationSuite',
  );
  expect(runner, 'runQuoteNotificationSuite is declared').toBeDefined();
  const inside = allNodes(runner);
  const stageCall = 'STAGE_RUNNERS[entry.id](context)';
  const stageTry = inside
    .filter(
      (node) =>
        ts.isTryStatement(node) &&
        node.tryBlock.getText(tree).includes(stageCall),
    )
    .sort((a, b) => a.tryBlock.getWidth(tree) - b.tryBlock.getWidth(tree))[0];
  const tryCalls = stageTry
    ? allNodes(stageTry.tryBlock)
        .filter(ts.isCallExpression)
        .map((node) => node.getText(tree))
    : [];
  const firstDevice = inside.find(
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'openMaestroDevice',
  );
  const outerTry = inside.find(ts.isTryStatement);
  const outerFinally = outerTry?.finallyBlock?.statements.find(
    ts.isIfStatement,
  );
  return {
    finallyFirst: stageTry?.finallyBlock?.statements[0]?.getText(tree),
    tryOrder: tryCalls,
    cleanups: inside
      .filter(
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(tree) === 'guardedCleanup' &&
          (!firstDevice || node.getStart(tree) < firstDevice.getStart(tree)),
      )
      .map((node) => node.arguments[0]?.getText(tree).slice(1, -1)),
    outerFinally: outerFinally?.getText(tree),
    throws: allNodes(tree)
      .filter(ts.isThrowStatement)
      .map((node) => node.getText(tree)),
  };
}

const STAGE_THROW = 'throw redactStageFailure(entry.id, failures, secrets);';

function assertRunnerShape(shape) {
  expect(shape.finallyFirst).toBe(
    'if (await finishQuoteNotificationStage(client, device, failures)) safety.cleanupFailed = true;',
  );
  const positions = [
    'STAGE_RUNNERS[entry.id](context)',
    'assertQuoteNotificationRecords(entry.id, records)',
    "client.capture('passed')",
  ].map((call) => shape.tryOrder.indexOf(call));
  expect(positions[0]).toBeGreaterThan(-1);
  expect(positions[1]).toBeGreaterThan(positions[0]);
  expect(positions[2]).toBeGreaterThan(positions[1]);
  expect(shape.cleanups).toEqual([
    'Scan quote-notification diagnostics',
    'Scrub quote-notification diagnostics',
  ]);
  expect(shape.outerFinally).toBe(
    'if (effectiveSignal.aborted) await revokeOnAbort?.();',
  );
  expect(shape.throws.filter((text) => text === STAGE_THROW)).toHaveLength(1);
  expect(
    shape.throws.filter((text) => /failures|AggregateError/u.test(text)),
  ).toEqual([STAGE_THROW]);
}

/** Locate one node of the runner by predicate and replace its text (or delete it). */
function editRunner(source, edits) {
  const tree = treeOf(source);
  const nodes = allNodes(tree);
  const found = (predicate) => {
    const node = nodes.find(predicate);
    expect(node, 'mutation target exists').toBeDefined();
    return node;
  };
  const text = (node) => node.getText(tree);
  return applyEdits(
    source,
    edits(found, text, tree).map(([node, replacement]) => ({
      start: node.getStart(tree),
      end: node.getEnd(),
      text: replacement,
    })),
  );
}

const statementStartingWith = (prefix, tree) => (node) =>
  ts.isStatement(node) &&
  !ts.isBlock(node) &&
  node.getText(tree).startsWith(prefix);

describe('Android quote-notification teardown, must-run and redaction guards', () => {
  const RUN = 'r';
  const WRITER = {
    userId: '@qmw-r:localhost',
    username: 'qmw-r',
    password: 'writer-Pass-1!',
  };
  const ROOM = { id: '!Quote_room:localhost', name: 'Quote mentions r' };
  const EVENT = '$Quote_event';

  it('runs close then clear through finishQuoteNotificationStage, even when close throws', async () => {
    const { finishQuoteNotificationStage } = await loadJourneys();
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
    expect(await finishQuoteNotificationStage(client, device, failures)).toBe(
      true,
    );
    expect(order).toEqual(['close', 'clear:eu.qwky.trinity']);
    expect(failures).toHaveLength(1);
  });

  it('reports no cleanup failure when both teardown steps succeed', async () => {
    const { finishQuoteNotificationStage } = await loadJourneys();
    const failures = [];
    expect(
      await finishQuoteNotificationStage(
        { close: async () => {} },
        { clearApplicationData: async () => {} },
        failures,
      ),
    ).toBe(false);
    expect(failures).toHaveLength(0);
  });

  it('rethrows stage failures to the job log as redacted first lines only', async () => {
    const c = await loadContract();
    const { quoteNotificationSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = quoteNotificationSecrets('quoted-display-name', {
      accounts: [WRITER],
      rooms: [ROOM],
      texts: [c.answerText(RUN)],
      eventIds: [EVENT],
      transactions: [c.sourceTxn(RUN)],
    });
    const failure = new AssertionError({
      actual: EVENT,
      expected: '$Quote_expected',
      operator: 'strictEqual',
      message: `The row is the proved server event ${EVENT} ${ROOM.id} ${WRITER.password}`,
    });
    const error = redactStageFailure(
      'quoted-display-name',
      [new AggregateError([failure], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error.message).toContain(
      'Android quote-notification quoted-display-name failed',
    );
    expect(error.message).toContain('[REDACTED]');
    for (const value of [EVENT, ROOM.id, WRITER.password, '$Quote_expected'])
      expect(error.message).not.toContain(value);
    expect(error.message).not.toContain('actual');
    const [firstLine, ...appended] = failure.message.split('\n');
    expect(error.message.split('\n')).toContain(
      `AssertionError: ${firstLine.replace(EVENT, '[REDACTED]').replace(ROOM.id, '[REDACTED]').replace(WRITER.password, '[REDACTED]')}`,
    );
    for (const line of appended.map((fragment) => fragment.trim()))
      if (line.length >= 3) expect(error.message).not.toContain(line);
    expect(
      redactCleanupFailure(
        'fixtures',
        Object.assign(new Error(`leave ${ROOM.id}`), { status: 403 }),
      ).message,
    ).toBe('Quote-notification cleanup failed: fixtures (Error HTTP 403)');
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardQuoteNotificationCleanup } = await loadJourneys();
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
    guardQuoteNotificationCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    )('Room cleanup', async () => {
      throw new Error(`forget ${ROOM.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Quote-notification cleanup failed: Room cleanup (Error)',
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
    guardQuoteNotificationCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it('keeps every must-run step of the runner in place [rule d]', () => {
    const source = read(JOURNEYS);
    const shape = runnerShape(source);
    assertRunnerShape(shape);
    expect(shape.cleanups).toHaveLength(2);
  });

  const FINISH =
    'if (await finishQuoteNotificationStage(client, device, failures)) safety.cleanupFailed = true;';
  const MUTATIONS = {
    'delete the finishQuoteNotificationStage statement': (source) =>
      editRunner(source, (found, text, tree) => [
        [found(statementStartingWith(FINISH, tree)), ''],
      ]),
    'move finishQuoteNotificationStage into the try': (source) =>
      editRunner(source, (found, text, tree) => {
        const finish = found(statementStartingWith(FINISH, tree));
        const stageRun = found(
          statementStartingWith('await STAGE_RUNNERS[entry.id](context)', tree),
        );
        return [
          [finish, ''],
          [stageRun, `${text(stageRun)}\n              ${FINISH}`],
        ];
      }),
    'delete the Scan guardedCleanup registration': (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(
            statementStartingWith(
              "guardedCleanup('Scan quote-notification",
              tree,
            ),
          ),
          '',
        ],
      ]),
    'delete the Scrub guardedCleanup registration': (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(
            statementStartingWith(
              "guardedCleanup('Scrub quote-notification",
              tree,
            ),
          ),
          '',
        ],
      ]),
    'swap the two guardedCleanup registrations': (source) =>
      editRunner(source, (found, text, tree) => {
        const scan = found(
          statementStartingWith(
            "guardedCleanup('Scan quote-notification",
            tree,
          ),
        );
        const scrub = found(
          statementStartingWith(
            "guardedCleanup('Scrub quote-notification",
            tree,
          ),
        );
        return [
          [scan, text(scrub)],
          [scrub, text(scan)],
        ];
      }),
    'delete the revokeOnAbort line': (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(statementStartingWith('if (effectiveSignal.aborted)', tree)),
          '',
        ],
      ]),
    "delete client.capture('passed')": (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(statementStartingWith("await client.capture('passed')", tree)),
          '',
        ],
      ]),
    'swap capture with assertQuoteNotificationRecords': (source) =>
      editRunner(source, (found, text, tree) => {
        const check = found(
          statementStartingWith(
            'assertQuoteNotificationRecords(entry.id, records)',
            tree,
          ),
        );
        const capture = found(
          statementStartingWith("await client.capture('passed')", tree),
        );
        return [
          [check, text(capture)],
          [capture, text(check)],
        ];
      }),
    'replace the throw line with throw failures[0]': (source) =>
      editRunner(source, (found, text) => [
        [
          found(
            (node) => ts.isThrowStatement(node) && text(node) === STAGE_THROW,
          ),
          'throw failures[0];',
        ],
      ]),
  };
  for (const [name, mutate] of Object.entries(MUTATIONS))
    it(`fails the must-run guard when you ${name}`, () => {
      const source = read(JOURNEYS);
      const mutated = mutate(source);
      expect(mutated).not.toBe(source);
      expect(() => assertRunnerShape(runnerShape(mutated))).toThrow();
    });
});

/* -------------------------------------------------------------------------- */
/* Source rules: contract, artifacts and journeys                             */
/* -------------------------------------------------------------------------- */

const BANNED_TOKENS = [
  '.click(',
  '.focus(',
  'dispatchEvent',
  '.value =',
  'location.',
  'history.',
  '.fill(',
  '.press(',
  'requestSubmit',
  '.submit(',
  'preventDefault',
  'stopPropagation',
  'quote(',
  'onQuote',
  'new SharedStageAccount(',
  'input_method',
  'dumpsys',
  'pushrules',
];

function assertNoBannedTokens(source, name) {
  for (const token of BANNED_TOKENS)
    expect(source.includes(token), `${name} must not contain ${token}`).toBe(
      false,
    );
}

const NATIVE_CALLS = new Set([
  'tap',
  'tapCurrent',
  'longPressCurrent',
  'hideKeyboard',
  'appendNativeLine',
  'sendMessage',
  'login',
]);
const calleeName = (node, tree) =>
  node.expression.getText(tree).split('.').at(-1);
const enclosingFunction = (node) => {
  for (let at = node.parent; at; at = at.parent)
    if (ts.isFunctionDeclaration(at)) return at;
  return undefined;
};

/** Every native tap or long press sits in `tap()` or is immediately followed by `const x = Date.now();`. */
function assertTapsAnchorDateNow(source) {
  const tree = treeOf(source);
  for (const node of allNodes(tree)) {
    if (
      !ts.isCallExpression(node) ||
      !['tapCurrent', 'longPressCurrent'].includes(calleeName(node, tree))
    )
      continue;
    if (enclosingFunction(node)?.name?.text === 'tap') continue;
    let statement = node;
    while (statement.parent && !ts.isBlock(statement.parent))
      statement = statement.parent;
    const siblings = statement.parent.statements;
    const next = siblings[siblings.indexOf(statement) + 1];
    const declaration =
      next && ts.isVariableStatement(next)
        ? next.declarationList.declarations[0]
        : undefined;
    expect(
      declaration?.initializer?.getText(tree),
      `${node.getText(tree)} is followed by a Date.now() anchor`,
    ).toBe('Date.now()');
  }
}

/** No window anchor (`left(bound, anchor)`, `server(…, anchor, …)`, `timeoutMs: anchor`) was assigned before a native call it waits on. */
function assertWindowsAnchoredAfterNativeCalls(source) {
  const tree = treeOf(source);
  const stage = allNodes(tree).find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'runQuotedDisplayName',
  );
  expect(stage, 'runQuotedDisplayName is declared').toBeDefined();
  const inside = allNodes(stage);
  const natives = inside.filter(
    (node) =>
      ts.isCallExpression(node) && NATIVE_CALLS.has(calleeName(node, tree)),
  );
  const declarationOf = (name) =>
    inside.find(
      (node) =>
        ts.isVariableDeclaration(node) && node.name.getText(tree) === name,
    );
  let windows = 0;
  for (const node of inside) {
    const anchors = [];
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'left')
      anchors.push(...allNodes(node.arguments[1]).filter(ts.isIdentifier));
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'server')
      anchors.push(...allNodes(node.arguments[3]).filter(ts.isIdentifier));
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree) === 'timeoutMs'
    )
      anchors.push(...allNodes(node.initializer).filter(ts.isIdentifier));
    for (const anchor of anchors) {
      const declaration = declarationOf(anchor.text);
      if (!declaration) continue;
      windows++;
      const between = natives.filter(
        (call) =>
          call.getStart(tree) > declaration.getEnd() &&
          call.getEnd() < anchor.getStart(tree),
      );
      expect(
        between.map((call) => call.getText(tree)),
        `the ${anchor.text} anchor is assigned after every native call before its window`,
      ).toEqual([]);
    }
  }
  expect(windows, 'the stage has anchored windows').toBeGreaterThan(8);
}

describe('Android quote-notification source rules', () => {
  const TARGETS = {
    contract: CONTRACT_PATH,
    artifacts: ARTIFACTS_PATH,
    journeys: JOURNEYS,
  };

  it('keeps the contract, artifacts and journeys free of every banned token', () => {
    for (const path of Object.values(TARGETS))
      assertNoBannedTokens(read(path), path);
  });

  it('shows each banned-token rule effective under an in-memory insertion', () => {
    const journeys = read(JOURNEYS);
    for (const token of BANNED_TOKENS)
      expect(() =>
        assertNoBannedTokens(`${journeys}\n${token}`, JOURNEYS),
      ).toThrow();
  });

  it('anchors every native tap and long press with a Date.now() capture', () => {
    const journeys = read(JOURNEYS);
    assertTapsAnchorDateNow(journeys);
    const target =
      'await client.longPressCurrent(READY_ROW, { text: SOURCE_BODY });\n  const pressedAt = Date.now();';
    expect(journeys).toContain(target);
    for (const mutated of [
      journeys.replace(
        target,
        'await client.longPressCurrent(READY_ROW, { text: SOURCE_BODY });\n  await client.hideKeyboard();\n  const pressedAt = Date.now();',
      ),
      journeys.replace(
        target,
        'await client.longPressCurrent(READY_ROW, { text: SOURCE_BODY });',
      ),
      `${journeys}\nasync function sneaky(client: AccountWorkspaceClient): Promise<void> {\n  await client.tapCurrent('x', {});\n}\n`,
    ]) {
      expect(mutated).not.toBe(journeys);
      expect(() => assertTapsAnchorDateNow(mutated)).toThrow();
    }
  });

  it('never anchors a window before a native call or send it waits on', () => {
    const journeys = read(JOURNEYS);
    assertWindowsAnchoredAfterNativeCalls(journeys);
    for (const [from, to] of [
      [
        'const sentAt = await tap(context, SEND);',
        'const sentAt = Date.now();\n  await tap(context, SEND);',
      ],
      [
        'const probeSentAt = Date.now();',
        'const probeSentAt = Date.now() - 1;\n  await client.hideKeyboard();',
      ],
    ]) {
      expect(journeys).toContain(from);
      const mutated = journeys.replace(from, to);
      expect(() => assertWindowsAnchoredAfterNativeCalls(mutated)).toThrow();
    }
    const early = journeys
      .replace('const probeSentAt = Date.now();\n', '')
      .replace(
        'const probeId = await fixtures.sendMessage(writer, room.id, probe, probeTxn(run));',
        'const probeSentAt = Date.now();\n  const probeId = await fixtures.sendMessage(writer, room.id, probe, probeTxn(run));',
      );
    expect(early).not.toBe(journeys);
    expect(() => assertWindowsAnchoredAfterNativeCalls(early)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Hosted wiring, retention and parity ledger                                 */
/* -------------------------------------------------------------------------- */

const QUOTE_NX_COMMAND =
  '--suite=android.quote-notification --timeout-ms=900000 --entrypoint=e2e/android/quote-notification-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const QUOTE_CI_LINE =
  'if [ "${{ matrix.shard }}" = "3" ]; then echo \'quote-notification-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:quote-notification; fi';
const QUOTE_GATE_PATH =
  "-path '*/android.quote-notification/quote-notification/publication-safe'";
const QUOTE_UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.quote-notification-started == 'true' && steps.quote-notification-artifact-gate.outputs.quote-notification-safe == 'true' }}";

function quoteWiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
  };
}

/** Every hosted wiring rule for quote-notification, as a pure function of the files' text. */
function assertQuoteWiring({ project, pkg, workflow }) {
  const target = project.targets['quote-notification'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(QUOTE_NX_COMMAND);
  expect(pkg.scripts['e2e:android:quote-notification']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:quote-notification',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(QUOTE_CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(runner).toBeLessThan(
    lines.findIndex((line) => line.includes('pnpm e2e:android --')),
  );
  // Shard 3: directly after pinned-message-panel's own runner line.
  const panel = lines.findIndex((line) =>
    line.includes('pinned-message-panel-started=true'),
  );
  expect(panel).toBeGreaterThan(-1);
  expect(runner).toBe(panel + 1);
  expect(
    lines.filter((line) =>
      line.includes('trinity-e2e-android:quote-notification'),
    ),
  ).toHaveLength(1);
  const gate = workflow
    .split('      - name: Gate Android quote-notification diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: quote-notification-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.quote-notification-started == 'true' }}",
  );
  expect(gate).toContain(QUOTE_GATE_PATH);
  expect(gate).toContain(
    'echo \'quote-notification-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-quote-notification\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${QUOTE_UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.quote-notification/**',
  );
}

describe('Android quote-notification hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands on shard 3 after pinned-message-panel', async () => {
    assertQuoteWiring(quoteWiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.quote-notification',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:quote-notification',
      canonicalScript: 'e2e:android:quote-notification',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      CONTRACT_PATH,
      ARTIFACTS_PATH,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:quote-notification',
      ),
    ).toEqual([
      {
        name: 'e2e:android:quote-notification',
        command: 'nx run trinity-e2e-android:quote-notification',
        kind: 'canonical',
        suiteIds: ['android.quote-notification'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.quote-notification'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "3" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:quote-notification',
    );
    expect(read(JOURNEYS)).toContain('timeout: 900_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = quoteWiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['quote-notification']);
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
            'quote-notification-journeys.mts',
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
        delete inputs.pkg.scripts['e2e:android:quote-notification'];
        return inputs;
      })(),
      withText(
        'workflow',
        QUOTE_CI_LINE,
        QUOTE_CI_LINE.replace('= "3"', '= "4"'),
      ),
      withText(
        'workflow',
        QUOTE_CI_LINE,
        QUOTE_CI_LINE.replace('1200000', '600000'),
      ),
      withText('workflow', `${QUOTE_CI_LINE}\n`, ''),
      withText(
        'workflow',
        QUOTE_GATE_PATH,
        "-path '*/android.quote-notification/publication-safe'",
      ),
      withText(
        'workflow',
        QUOTE_UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.quote-notification-started == 'true' }}",
      ),
    ])
      expect(() => assertQuoteWiring(mutated)).toThrow();
    // Moved past the shard runner lines: present but wrongly placed.
    const late = clone();
    const lateLines = late.workflow.split('\n');
    const at = lateLines.findIndex((l) => l.trim() === QUOTE_CI_LINE);
    const [moved] = lateLines.splice(at, 1);
    const retained = lateLines.findIndex((l) =>
      l.includes('pnpm e2e:android --'),
    );
    lateLines.splice(retained + 1, 0, moved);
    late.workflow = lateLines.join('\n');
    expect(() => assertQuoteWiring(late)).toThrow();
    // Moved before pinned-message-panel's own runner line: wrongly ordered.
    const before = clone();
    const beforeLines = before.workflow.split('\n');
    const quoteAt = beforeLines.findIndex((l) => l.trim() === QUOTE_CI_LINE);
    const [quoteLine] = beforeLines.splice(quoteAt, 1);
    const panelAt = beforeLines.findIndex((l) =>
      l.includes('pinned-message-panel-started=true'),
    );
    beforeLines.splice(panelAt, 0, quoteLine);
    before.workflow = beforeLines.join('\n');
    expect(() => assertQuoteWiring(before)).toThrow();
  });

  it('keeps the predecessor enabled and unchanged', async () => {
    expect(sha256(readFileSync(resolve(root, PREDECESSOR)))).toBe(
      SOURCE_SHA256,
    );
    expect(read(PREDECESSOR)).toBe(blob());
    const source = read(PREDECESSOR);
    expect(source.match(/^ {2}test\('/gmu)).toHaveLength(1);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(1);
    for (const token of ['test.fixme', 'test.only', 'test.skip(true'])
      expect(source).not.toContain(token);
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/quote-mentions.spec.mts',
      ),
    ).toHaveLength(1);
    expect(read('e2e/android/playwright.config.mts')).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    const { RETIRED_PREDECESSORS } =
      await import('./retired-playwright-predecessors.mjs');
    expect(
      RETIRED_PREDECESSORS.filter((entry) => entry.path === PREDECESSOR),
    ).toHaveLength(0);
  });

  it('documents the 8 identities with their source lines, both hashes, the redaction sentence and the placement', () => {
    const section = read('e2e/android/MIGRATION.md')
      .split('## Quote-notification journey')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| ([0-9@]+) \| (direct|inherited) \| [^\n]+ \| `(quote-notification\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[3])).toEqual(ALL_IDENTITIES);
    expect(rows.map((row) => row[2])).toEqual(
      ALL_IDENTITIES.map((identity) =>
        identity.endsWith('.sheet-ready') ||
        identity.endsWith('.answer-send-enabled')
          ? 'inherited'
          : 'direct',
      ),
    );
    expect(rows.map((row) => row[1])).toEqual([
      '118',
      '123',
      '220@125',
      '132',
      '53@135',
      '136',
      '153',
      '173',
    ]);
    const flat = section.replace(/\s+/gu, ' ');
    expect(flat).toContain('6 direct + 2 inherited');
    expect(section).toContain(ISSUE_SHA256);
    expect(section).toContain(SOURCE_SHA256);
    expect(flat).toContain(
      'a failed teardown step is rethrown through `redactStageFailure`, and a failed guarded cleanup is rethrown through `redactCleanupFailure`, never as the raw error.',
    );
    expect(flat).toContain('Shard 3 runs it last, after pinned-message-panel');
    expect(section).toContain(
      'Predecessor status: enabled; after hosted acceptance the coordinator keeps the file as a desktop-only definition, skipped on Android (#839).',
    );
    expect(section).not.toContain('pnpm exec nx');
  });
});
