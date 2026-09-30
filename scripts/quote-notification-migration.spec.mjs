import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
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
