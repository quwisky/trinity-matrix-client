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
  'e2e/browser/journeys/conversations/message-markdown.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
const loadContract = () =>
  import('../e2e/android/message-markdown-contract.mts');
const loadObserver = () =>
  import('../e2e/android/message-markdown-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-markdown-artifacts.mts');
const loadJourneys = () =>
  import('../e2e/android/message-markdown-journeys.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-markdown-journeys.mts';
const OBSERVER = 'e2e/android/message-markdown-observer.mts';
const ARTIFACTS = 'e2e/android/message-markdown-artifacts.mts';
const CONTRACT = 'e2e/android/message-markdown-contract.mts';
const FLOW = 'e2e/android/flows/message-markdown-append.yaml';

const PREDECESSOR_SHA256 =
  '128f6ae2660c02a9f6e0d64726999ead4960454b66cb369306f9f27b3bb0baa8';
const SHARED_SHA256 = {
  'e2e/support/message-composer.mts':
    '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const READER_SPAN = [29, 47];
const ANDROID_BRANCH = 214;
const ANDROID_RETURN = 224;
const DESKTOP_TAIL = [225, 278];
const DESKTOP_TAIL_SITES = [276, 277];

/** Source-ordered stage ledger: the issue's identity table, verbatim. */
const STAGES = [
  {
    id: 'formatting',
    span: [52, 125],
    title:
      'renders formatting, keeps line breaks, and only sends HTML when it means something',
    direct: [86, 94, 95, 96, 114, 115, 116, 118, 119, 120, 124],
    inherited: [
      [13, 'openNamedRoom', 82],
      [75, 'sendComposerLines', 85],
      [53, 'sendComposerLines', 85],
      [75, 'sendComposerLines', 92],
      [53, 'sendComposerLines', 92],
      [178, 'waitForSent', 102, 1],
      [178, 'waitForSent', 102, 2],
    ],
    suffixes: [
      'room-ready',
      'plain-send-ready',
      'plain-send-enabled',
      'plain-visible',
      'rich-send-ready',
      'rich-send-enabled',
      'rich-visible',
      'bold-run',
      'one-break',
      'plain-server-echo',
      'rich-server-echo',
      'plain-body',
      'plain-no-format',
      'plain-no-formatted-body',
      'formatted-format',
      'formatted-break',
      'formatted-bold',
      'formatted-source',
    ],
  },
  {
    id: 'task-list',
    span: [127, 168],
    title: 'renders a task list as glyphs rather than dropping it',
    direct: [163, 164, 165, 167],
    inherited: [
      [13, 'openNamedRoom', 154],
      [75, 'sendComposerLines', 160],
      [53, 'sendComposerLines', 160],
    ],
    suffixes: [
      'room-ready',
      'send-ready',
      'send-enabled',
      'list-visible',
      'checked-glyph',
      'unchecked-glyph',
      'no-checkbox-input',
    ],
  },
  {
    id: 'code-caption',
    span: [170, 224],
    title: 'keeps the language caption clear of the hover toolbar',
    direct: [207, 212, 217, 218, 223],
    inherited: [
      [13, 'openNamedRoom', 197],
      [75, 'sendComposerLines', 202],
      [53, 'sendComposerLines', 202],
      [75, 'sendComposerLines', 204],
      [53, 'sendComposerLines', 204],
      [178, 'waitForSent', 208],
      [220, 'openMessageActionSheet', 223],
    ],
    suffixes: [
      'room-ready',
      'lead-send-ready',
      'lead-send-enabled',
      'code-send-ready',
      'code-send-enabled',
      'code-visible',
      'server-echo',
      'continuation-row',
      'no-hover-toolbar',
      'language-caption',
      'sheet-ready',
      'sheet-visible',
    ],
  },
];
const identities = (stage) =>
  stage.suffixes.map((suffix) => `message-markdown.${stage.id}.${suffix}`);
const ALL_IDENTITIES = STAGES.flatMap(identities);

/** The exact `sendComposerLines` arrays, in call order. */
const PREDECESSOR_DRAFTS = [
  ['plain one', 'plain two'],
  ['**bold one**', 'rich two'],
  ['- [x] shipped', 'pending'],
  ['setting up'],
  ['```python', 'x = 1', '```'],
];

const LINE_PINS = {
  30: 'async function roomEvents(',
  40: ')}/messages?dir=b&limit=50`,',
  45: ".filter((e) => (e as Record<string, unknown>)['type'] === 'm.room.message')",
  46: '.reverse();',
  101: "for (const text of ['plain one', 'rich two']) {",
  110: 'const [plain, formatted] = events as unknown as {',
  203: 'await page.waitForTimeout(500);',
  214: 'if (isAndroidE2E) {',
  223: 'await expect(await openMessageActionSheet(page, row)).toBeVisible();',
  224: 'return;',
  227: 'await pre.hover();',
};

const IMPORTS = `import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  waitForSent,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';`;

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
 * when its symbol is a named import from a relative helper module, so a
 * shadowing local of the same name never expands.
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
  const visit = (node, loop) => {
    let nextLoop = loop;
    if (ts.isForOfStatement(node)) {
      const items = ts.isArrayLiteralExpression(node.expression)
        ? node.expression.elements
        : null;
      nextLoop =
        items && items.every((item) => ts.isStringLiteral(item))
          ? { line: lineOf(tree, node), count: items.length }
          : { line: lineOf(tree, node), count: null };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = checker.getSymbolAtLocation(node.expression)
        ?.declarations?.[0];
      if (declaration && ts.isImportSpecifier(declaration)) {
        const specifier = declaration.parent.parent.parent.moduleSpecifier.text;
        calls.push({
          name: (declaration.propertyName ?? declaration.name).text,
          specifier,
          line: lineOf(tree, node),
          loop,
        });
      } else if (declaration && !ts.isFunctionDeclaration(declaration)) {
        shadowed.push({ name: node.expression.text, line: lineOf(tree, node) });
      } else if (declaration && ts.isFunctionDeclaration(declaration)) {
        calls.push({
          name: node.expression.text,
          specifier: null,
          line: lineOf(tree, node),
          loop,
        });
      }
    }
    ts.forEachChild(node, (child) =>
      visit(
        child,
        ts.isForOfStatement(node) && child === node.statement ? nextLoop : loop,
      ),
    );
  };
  visit(tree, null);
  return { calls, shadowed };
}

/** Every `expect` line a helper reaches, following module-local and relative imports. */
function helperExpectLines(module, name, seen = new Set()) {
  const key = `${module}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const source = read(module);
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
        ? helperExpectLines(module, call.name, seen)
        : call.specifier.startsWith('.')
          ? helperExpectLines(
              repositoryPath(module, call.specifier),
              call.name,
              seen,
            )
          : [],
    );
  return [...own, ...nested];
}

/**
 * Expand each definition's helper calls into inherited sites. A call inside a
 * `for…of` over a literal string array runs, and expands, once per item.
 */
function expandDefinitions(source, spans = STAGES.map((stage) => stage.span)) {
  const { calls } = importedCalls(source);
  return spans.map(([from, to]) => {
    const inherited = calls
      .filter(
        (call) =>
          call.line >= from &&
          call.line <= to &&
          call.specifier?.startsWith('../../../support/'),
      )
      .flatMap((call) => {
        const module = repositoryPath(predecessor, call.specifier);
        const lines = helperExpectLines(module, call.name);
        if (call.loop && call.loop.count === null)
          throw new Error(`Unbounded loop around helper call ${call.line}`);
        const runs = call.loop ? call.loop.count : 1;
        return Array.from({ length: runs }, (_, index) =>
          lines.map(({ line }) => ({
            kind: 'inherited',
            line,
            helper: call.name,
            call: call.line,
            ...(call.loop ? { iteration: index + 1 } : {}),
          })),
        ).flat();
      });
    const direct = assertionLines(source, from, to).map((line) => ({
      kind: 'direct',
      line,
    }));
    const key = (site) =>
      site.kind === 'direct'
        ? [site.line, 1, 0]
        : [site.call, 0, site.iteration ?? 0];
    return [...inherited, ...direct].sort((a, b) => {
      const [left, right] = [key(a), key(b)];
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });
  });
}

const siteTuple = (site) =>
  site.kind === 'direct'
    ? ['direct', site.line]
    : [
        'inherited',
        site.line,
        site.helper,
        site.call,
        ...(site.iteration === undefined ? [] : [site.iteration]),
      ];
const ledgerTuples = (stage) => {
  const inherited = stage.inherited.map(([line, helper, call, iteration]) => [
    'inherited',
    line,
    helper,
    call,
    ...(iteration === undefined ? [] : [iteration]),
  ]);
  const key = (tuple) =>
    tuple[0] === 'direct' ? [tuple[1], 1, 0] : [tuple[3], 0, tuple[4] ?? 0];
  return [...inherited, ...stage.direct.map((line) => ['direct', line])].sort(
    (a, b) => {
      const [left, right] = [key(a), key(b)];
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    },
  );
};

/** The array-literal argument of every `sendComposerLines` call, in order. */
function predecessorDrafts(source) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const drafts = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'sendComposerLines'
    ) {
      const [, lines] = node.arguments;
      expect(ts.isArrayLiteralExpression(lines)).toBe(true);
      drafts.push(
        lines.elements.map((element) => {
          expect(ts.isStringLiteral(element)).toBe(true);
          return element.text;
        }),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return drafts;
}

const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

/** Every text-level predecessor pin, independent of the byte hash. */
function assertPredecessorShape(source, { codeSpan = STAGES[2].span } = {}) {
  expect(source.split('\n')).toHaveLength(280);
  expect(source.split('\n').slice(0, 19).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line))).toBe(text);
  for (const stage of STAGES)
    expect(source.split('\n')[stage.span[0] - 1]).toContain(
      `test('${stage.title}'`,
    );
  expect(lineAt(source, READER_SPAN[1])).toBe('}');
  expect(lineAt(source, ANDROID_BRANCH)).toBe('if (isAndroidE2E) {');
  expect(lineAt(source, ANDROID_RETURN)).toBe('return;');
  expect(assertionLines(source, ...READER_SPAN)).toEqual([]);
  expect(assertionLines(source, ...DESKTOP_TAIL)).toEqual(DESKTOP_TAIL_SITES);
  const spans = STAGES.map((stage, index) =>
    index === 2 ? codeSpan : stage.span,
  );
  const direct = spans.map((span) => assertionLines(source, ...span));
  expect(direct).toEqual(STAGES.map((stage) => stage.direct));
  expect(direct.flat()).toHaveLength(20);
  const expanded = expandDefinitions(source, spans);
  expect(expanded.map((sites) => sites.map(siteTuple))).toEqual(
    STAGES.map(ledgerTuples),
  );
  expect(
    expanded.map(
      (sites) => sites.filter((site) => site.kind === 'inherited').length,
    ),
  ).toEqual([7, 3, 7]);
  expect(expanded.flat()).toHaveLength(37);
  expect(predecessorDrafts(source)).toEqual(PREDECESSOR_DRAFTS);
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-markdown predecessor pins', () => {
  it('pins the unchanged predecessor and three shared helper sources by SHA-256', () => {
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

  it('pins the same sources, spans and Android return in the contract', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_MARKDOWN_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_MARKDOWN_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_MARKDOWN_SOURCE_LINES).toBe(279);
    expect(contract.MESSAGE_MARKDOWN_SHARED_SOURCE_SHA256).toEqual(
      SHARED_SHA256,
    );
    expect(contract.MESSAGE_MARKDOWN_SPANS).toEqual({
      reader: { from: 29, to: 47 },
      definitions: Object.fromEntries(
        STAGES.map((stage) => [
          stage.id,
          { from: stage.span[0], to: stage.span[1] },
        ]),
      ),
      androidBranchLine: ANDROID_BRANCH,
      androidReturnLine: ANDROID_RETURN,
      excludedTail: { from: 225, to: 278 },
    });
    expect(contract.MESSAGE_MARKDOWN_EXCLUDED_TAIL_SITES).toEqual(
      DESKTOP_TAIL_SITES,
    );
  });

  it('keeps the predecessor enabled in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-markdown.spec.mts',
      ),
    ).toHaveLength(1);
    const android = read('e2e/android/playwright.config.mts');
    expect(android).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    for (const config of [android, read('e2e/browser/playwright.config.mts')]) {
      expect(config).not.toContain('testIgnore');
      expect(config).not.toContain('message-markdown');
    }
    const source = read(predecessor);
    expect(source).not.toMatch(/test\.(?:fixme|only)\(|test\.skip\(true/u);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(1);
    expect(source.match(/^ {2}test\('/gmu)).toHaveLength(3);
  });

  it('maps the exact direct and helper assertion sites with the house AST rule', () => {
    const source = read(predecessor);
    assertPredecessorShape(source);
    for (const stage of STAGES)
      expect(assertionLines(source, ...stage.span)).toEqual(stage.direct);
  });

  it('rejects the whole third definition 170–278 because it counts the desktop tail', () => {
    const source = read(predecessor);
    expect(assertionLines(source, 170, 278)).toHaveLength(7);
    expect(
      [...STAGES.slice(0, 2).map((stage) => stage.span), [170, 278]]
        .map((span) => assertionLines(source, ...span).length)
        .reduce((sum, count) => sum + count, 0),
    ).toBe(22);
    expect(() =>
      assertPredecessorShape(source, { codeSpan: [170, 278] }),
    ).toThrow();
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = read(predecessor);
    const mutations = [
      // The Android branch or its return moves or disappears.
      mutateLine(source, 213, (line) => `${line}\n`),
      mutateLine(source, ANDROID_RETURN, () => '      void 0;'),
      mutateLine(source, ANDROID_BRANCH, () => '    if (!isAndroidE2E) {'),
      // A desktop-tail site would become an Android record.
      mutateLine(source, ANDROID_RETURN, () => '      expect(1).toBe(1);'),
      // A helper call or its loop drifts.
      mutateLine(
        source,
        101,
        () => "    for (const text of ['plain one', 'rich two', 'extra']) {",
      ),
      source.replace(
        "    await waitForSent(\n      page.locator('.scroll .msg[data-mid]', { hasText: 'x = 1' }).first(),\n    );",
        '    void 0;',
      ),
      source.replace(
        "sendComposerLines(page, ['- [x] shipped', 'pending'])",
        "sendComposerLines(page, ['- [x] shipped', '- [ ] pending'])",
      ),
      // The authoritative reader changes.
      mutateLine(source, 40, (line) => line.replace('limit=50', 'limit=20')),
      mutateLine(source, 46, () => '    ;'),
      // A definition title, import or direct site drifts.
      source.replace(
        "test('renders a task list as glyphs",
        "test('renders a task list as boxes",
      ),
      source.replace(
        'import { registerUser }',
        'import { registerUser as register }',
      ),
      mutateLine(source, 167, () => '    void list;'),
      mutateLine(source, 227, () => '    await pre.click();'),
    ];
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source);
      expect(() => assertPredecessorShape(mutated)).toThrow();
    }
  });
});

describe('Android message-markdown helper expansion by binding', () => {
  it('resolves imported helper calls through the TypeChecker', () => {
    const { calls } = importedCalls(read(predecessor));
    const helpers = calls
      .filter((call) => call.specifier?.startsWith('../../../support/'))
      .map((call) => [call.name, call.line, call.loop?.count ?? 1]);
    expect(helpers).toEqual([
      // Module level (line 27), outside every owned definition.
      ['synapseSession', 27, 1],
      ['registerUser', 62, 1],
      ['login', 81, 1],
      ['openNamedRoom', 82, 1],
      ['sendComposerLines', 85, 1],
      ['sendComposerLines', 92, 1],
      ['waitForSent', 102, 2],
      ['registerUser', 137, 1],
      ['login', 153, 1],
      ['openNamedRoom', 154, 1],
      ['sendComposerLines', 160, 1],
      ['registerUser', 180, 1],
      ['login', 196, 1],
      ['openNamedRoom', 197, 1],
      ['sendComposerLines', 202, 1],
      ['sendComposerLines', 204, 1],
      ['waitForSent', 208, 1],
      ['openMessageActionSheet', 223, 1],
    ]);
  });

  it('follows helper-internal calls and proves registration, login and touch press add no sites', () => {
    expect(
      helperExpectLines('e2e/support/message-composer.mts', 'openNamedRoom'),
    ).toEqual([{ module: 'e2e/support/message-composer.mts', line: 13 }]);
    expect(
      helperExpectLines(
        'e2e/support/message-composer.mts',
        'sendComposerLines',
      ),
    ).toEqual([
      // The composer-send control, then sendComposerDraft's mobile Send button.
      { module: 'e2e/support/message-composer.mts', line: 75 },
      { module: 'e2e/support/message-composer.mts', line: 53 },
    ]);
    expect(helperExpectLines('e2e/support/app.mts', 'waitForSent')).toEqual([
      { module: 'e2e/support/app.mts', line: 178 },
    ]);
    expect(
      helperExpectLines('e2e/support/app.mts', 'openMessageActionSheet'),
    ).toEqual([{ module: 'e2e/support/app.mts', line: 220 }]);
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
    expect(
      helperExpectLines('e2e/support/touch-platform.mts', 'touchLongPress'),
    ).toEqual([]);
    expect(
      helperExpectLines('e2e/support/namespace.mts', 'testResourceId'),
    ).toEqual([]);
  });

  it('excludes a shadowing local helper and proves binding matters against a naive count', () => {
    const source = read(predecessor);
    const shadowed = source.replace(
      "    for (const text of ['plain one', 'rich two']) {",
      "    const waitForSent = async (_row: unknown) => {};\n    for (const text of ['plain one', 'rich two']) {",
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    expect(locals.map((call) => call.name)).toEqual(['waitForSent']);
    expect(
      calls.filter((call) => call.name === 'waitForSent').map((c) => c.line),
    ).toEqual([209]);
    // Spelling alone still sees two helper calls, one of them in the loop.
    expect(shadowed.match(/\bwaitForSent\(/gu)).toHaveLength(2);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
  });

  it('expands 3 Room readiness + 10 send readiness + 3 server echoes + 1 action sheet = 17', () => {
    const expanded = expandDefinitions(read(predecessor)).flat();
    const inherited = expanded.filter((site) => site.kind === 'inherited');
    const byHelper = (helper) =>
      inherited.filter((site) => site.helper === helper).length;
    expect([
      byHelper('openNamedRoom'),
      byHelper('sendComposerLines'),
      byHelper('waitForSent'),
      byHelper('openMessageActionSheet'),
    ]).toEqual([3, 10, 3, 1]);
    expect(inherited).toHaveLength(17);
    expect(byHelper('login')).toBe(0);
    expect(byHelper('registerUser')).toBe(0);
    expect(expanded.filter((site) => site.kind === 'direct')).toHaveLength(20);
  });

  it('matches the contract sites, identities and helper roles exactly', async () => {
    const contract = await loadContract();
    const expanded = expandDefinitions(read(predecessor));
    expect(
      contract.MESSAGE_MARKDOWN_STAGES.map((entry) =>
        entry.sites.map(siteTuple),
      ),
    ).toEqual(expanded.map((sites) => sites.map(siteTuple)));
    expect(
      contract.MESSAGE_MARKDOWN_STAGES.flatMap((entry) => entry.assertions),
    ).toEqual(ALL_IDENTITIES);
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_MARKDOWN_HELPERS,
    ))
      expect(helperExpectLines(module, helper)).toEqual(
        expectLines.map((line) => ({ module, line })),
      );
    const dropped = expanded.map((sites, index) =>
      index === 0 ? sites.slice(0, -1) : sites,
    );
    expect(
      contract.MESSAGE_MARKDOWN_STAGES.map((entry) =>
        entry.sites.map(siteTuple),
      ),
    ).not.toEqual(dropped.map((sites) => sites.map(siteTuple)));
  });
});

/* ------------------------------------------------------------------------ */
/* Contract ledger                                                           */
/* ------------------------------------------------------------------------ */

describe('Android message-markdown contract ledger', () => {
  it('owns three ordered stages, 20 direct + 17 inherited = 37 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_MARKDOWN_STAGES.map((entry) => entry.id)).toEqual(
      STAGES.map((stage) => stage.id),
    );
    expect(
      contract.MESSAGE_MARKDOWN_STAGES.map((entry) => entry.source),
    ).toEqual(
      STAGES.map((stage) => `${predecessor}:${stage.span[0]}-${stage.span[1]}`),
    );
    expect(contract.MESSAGE_MARKDOWN_STAGE_COUNTS).toEqual([18, 7, 12]);
    expect(contract.MESSAGE_MARKDOWN_DIRECT_COUNTS).toEqual([11, 4, 5]);
    expect(contract.MESSAGE_MARKDOWN_INHERITED_COUNTS).toEqual([7, 3, 7]);
    expect(contract.MESSAGE_MARKDOWN_ASSERTION_RECORDS).toBe(37);
    expect(new Set(ALL_IDENTITIES).size).toBe(37);
    expect(
      contract.MESSAGE_MARKDOWN_STAGES.map((entry) => entry.title),
    ).toEqual(STAGES.map((stage) => stage.title));
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    for (const stage of STAGES) {
      const valid = identities(stage);
      expect(() =>
        contract.assertMessageMarkdownRecords(stage.id, valid),
      ).not.toThrow();
      for (const invalid of [
        [],
        valid.slice(0, -1),
        [...valid, valid.at(-1)],
        [...valid].reverse(),
        valid.map((identity, index) => (index === 1 ? valid[0] : identity)),
      ])
        expect(() =>
          contract.assertMessageMarkdownRecords(stage.id, invalid),
        ).toThrow();
    }
    expect(() =>
      contract.messageMarkdownAssertion('formatting', 'not-owned'),
    ).toThrow();
    expect(() =>
      contract.messageMarkdownAssertion('task-list', 'plain-body'),
    ).toThrow();
  });

  it('types exactly the predecessor drafts, one real line per array item', async () => {
    const { MESSAGE_MARKDOWN_DRAFTS, needsSentinel, ...bodies } =
      await loadContract();
    const drafts = Object.values(MESSAGE_MARKDOWN_DRAFTS);
    expect(drafts.map((draft) => draft.lines)).toEqual(
      predecessorDrafts(read(predecessor)),
    );
    for (const draft of drafts) {
      expect(draft.first).toBe(draft.lines[0]);
      expect(draft.breaks.map((step) => step.typed)).toEqual(
        draft.lines.slice(1),
      );
      expect(draft.value.split('\n')).toHaveLength(draft.lines.length);
      for (const line of draft.lines) expect(line).not.toMatch(/[\r\n]/u);
    }
    expect(MESSAGE_MARKDOWN_DRAFTS.plain.value).toBe(bodies.PLAIN_BODY);
    expect(MESSAGE_MARKDOWN_DRAFTS.rich.value).toBe(bodies.FORMATTED_BODY);
    expect(MESSAGE_MARKDOWN_DRAFTS.task.value).toBe(bodies.TASK_BODY);
    expect(MESSAGE_MARKDOWN_DRAFTS.lead.value).toBe(bodies.LEAD_BODY);
    expect(MESSAGE_MARKDOWN_DRAFTS.code.value).toBe(bodies.CODE_BODY);
    // The predecessor's own expected wire bodies (114, 124).
    const source = read(predecessor);
    expect(lineAt(source, 114)).toBe(
      "expect(plain.content.body).toBe('plain one\\nplain two');",
    );
    expect(lineAt(source, 124)).toBe(
      "expect(formatted.content.body).toBe('**bold one**\\nrich two');",
    );
    // Composer continuation: a mobile Enter carries `- [ ] ` onto the next line.
    expect(MESSAGE_MARKDOWN_DRAFTS.task.breaks[0].afterBreak).toBe(
      '- [x] shipped\n- [ ] ',
    );
    expect(
      [
        'plain two',
        'rich two',
        'pending',
        'x = 1',
        '```',
        '**bold one**',
        '- [x] shipped',
      ].map(needsSentinel),
    ).toEqual([true, true, true, true, false, false, false]);
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertMessageMarkdownReceiptName } = await loadContract();
    for (const name of [
      'plain-sent',
      'authoritative-events',
      'lead-server-event',
    ])
      expect(() => assertMessageMarkdownReceiptName(name)).not.toThrow();
    for (const name of [
      'message-markdown.formatting.room-ready',
      'message-markdown-x',
      'Plain Sent',
      'a/b',
      '',
    ])
      expect(() => assertMessageMarkdownReceiptName(name)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Native input: a simulated composer driven through the exact journey code  */
/* ------------------------------------------------------------------------ */

const PLAIN_ROUTE =
  'https://localhost/rooms/IVJvb206ZXhhbXBsZS50ZXN0?account=%40md%3Aexample.test&view=rooms';

/**
 * A device and WebView model of the composer textarea: Android capitalises a
 * letter typed at a paragraph start, Enter inserts a line break or continues
 * a list marker, and only the Send button sends. Reads are read-only snapshots; a
 * settled unacceptable state aborts the signal instead of waiting 15 s.
 */
function simulatedComposer({
  capitalizeParagraphs = true,
  lineBreak = true,
  continuation = true,
  sendClears = true,
  sendDisabled = false,
} = {}) {
  const state = {
    value: '',
    caret: 0,
    focused: false,
    keyboard: false,
    keys: [],
    sent: [],
  };
  const controller = new AbortController();
  let last = '';
  let stale = 0;
  const insert = (text) => {
    const paragraphStart =
      state.caret === 0 || state.value[state.caret - 1] === '\n';
    const typed =
      capitalizeParagraphs && paragraphStart && /^[a-z]/u.test(text)
        ? `${text[0].toUpperCase()}${text.slice(1)}`
        : text;
    state.value =
      state.value.slice(0, state.caret) +
      typed +
      state.value.slice(state.caret);
    state.caret += typed.length;
  };
  const snapshot = () => ({
    count: 1,
    visible: true,
    focused: state.focused,
    value: state.value,
    placeholder: 'Message #Markdown run',
    selectionStart: state.caret,
    selectionEnd: state.caret,
    sendCount: 1,
    sendDisabled: sendDisabled || state.value.trim() === '',
    href: PLAIN_ROUTE,
  });
  const client = {
    workspaceRoot: root,
    applicationId: 'eu.qwky.trinity',
    signal: controller.signal,
    webview: {
      diagnostics: {
        send: async () => {
          const current = JSON.stringify(snapshot());
          if (current === last && ++stale > 3)
            controller.abort(new Error('Simulated composer settled'));
          if (current !== last) stale = 0;
          last = current;
          return { result: { value: snapshot() } };
        },
      },
    },
    async focusCurrent(selector) {
      assert.equal(selector, '[data-testid="composer-input"]');
      state.focused = true;
      state.keyboard = true;
      state.keys.push('tap-composer');
    },
    async hideKeyboard() {
      state.keyboard = false;
      state.keys.push('hide-keyboard');
    },
    async tapCurrent(selector) {
      assert.equal(selector, '[data-testid="composer-send"]');
      // A bottom tap under the on-screen keyboard misses the WebView.
      assert(!state.keyboard, 'Send is tapped with the keyboard dismissed');
      state.keys.push('tap-send');
      if (snapshot().sendDisabled) return;
      state.sent.push(state.value);
      if (sendClears) {
        state.value = '';
        state.caret = 0;
      }
    },
    async focused() {
      assert(state.focused, 'composer focused');
    },
    async fillFocused(selector, value, sentinel = 'x') {
      assert.equal(selector, '[data-testid="composer-input"]');
      assert(state.focused, 'focused fill requires focus');
      state.keys.push(`focused-fill:${value}`);
      // accounts-focused-fill.yaml, Ctrl+Home, Forward Delete, Ctrl+End. On the
      // emulator Gboard corrected the `x`-joined `xplain` to `Explain`, so
      // deleting the first character left `xplain one` in the composer.
      state.value = '';
      state.caret = 0;
      insert(`${sentinel}${value}`.replace(/^xplain\b/u, 'Explain'));
      state.value = state.value.slice(1);
      state.caret = state.value.length;
    },
    async keyCombination(combination) {
      state.keys.push(combination);
      if (combination === 'documentEnd') state.caret = state.value.length;
    },
    async key(key) {
      state.keys.push(key);
      if (key === 'arrowLeft') state.caret = Math.max(0, state.caret - 1);
      if (key === 'backspace' && state.caret > 0) {
        state.value =
          state.value.slice(0, state.caret - 1) +
          state.value.slice(state.caret);
        state.caret -= 1;
      }
      if (key !== 'enter' || !lineBreak) return;
      const lineStart = state.value.lastIndexOf('\n', state.caret - 1) + 1;
      const line = state.value.slice(lineStart, state.caret);
      const marker = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?/u.exec(line);
      const carried =
        continuation && marker && line.slice(marker[0].length).trim()
          ? `${marker[1]}${marker[2]} ${marker[3] ? '[ ] ' : ''}`
          : '';
      state.value =
        state.value.slice(0, state.caret) +
        `\n${carried}` +
        state.value.slice(state.caret);
      state.caret += 1 + carried.length;
    },
    device: {
      async runFlow(file, variables) {
        state.keys.push(`flow:${basename(file)}:${variables.SECRET_TEXT}`);
        expect(variables.APP_ID).toBe('eu.qwky.trinity');
        insert(variables.SECRET_TEXT);
      },
    },
    async record() {},
  };
  return { client, state };
}

const simulatedContext = async (client, stageIndex = 0) => {
  const { MESSAGE_MARKDOWN_STAGES } = await loadContract();
  return {
    entry: MESSAGE_MARKDOWN_STAGES[stageIndex],
    records: [],
    identities: new Set(),
    receipts: 0,
    client,
  };
};

describe('Android message-markdown native multiline input', () => {
  it('types every predecessor draft exactly despite paragraph capitalisation', async () => {
    const { MESSAGE_MARKDOWN_DRAFTS } = await loadContract();
    const { enterNativeDraft } = await loadJourneys();
    for (const draft of Object.values(MESSAGE_MARKDOWN_DRAFTS)) {
      const { client, state } = simulatedComposer();
      await enterNativeDraft(await simulatedContext(client), draft);
      expect(state.value).toBe(draft.value);
      expect(state.caret).toBe(draft.value.length);
    }
  });

  it('uses the exact native key sequence for each line break and line', async () => {
    const { MESSAGE_MARKDOWN_DRAFTS } = await loadContract();
    const { enterNativeDraft } = await loadJourneys();
    const flow = 'message-markdown-append.yaml';
    const expected = {
      plain: [
        'tap-composer',
        'focused-fill:plain one',
        'enter',
        `flow:${flow}:1plain two`,
        ...Array(9).fill('arrowLeft'),
        'backspace',
        'documentEnd',
      ],
      task: [
        'tap-composer',
        'focused-fill:- [x] shipped',
        'enter',
        `flow:${flow}:1pending`,
        ...Array(7).fill('arrowLeft'),
        'backspace',
        'documentEnd',
      ],
      code: [
        'tap-composer',
        'focused-fill:```python',
        'enter',
        `flow:${flow}:1x = 1`,
        ...Array(5).fill('arrowLeft'),
        'backspace',
        'documentEnd',
        'enter',
        `flow:${flow}:\`\`\``,
      ],
      lead: ['tap-composer', 'focused-fill:setting up'],
    };
    for (const [name, keys] of Object.entries(expected)) {
      const { client, state } = simulatedComposer();
      await enterNativeDraft(
        await simulatedContext(client),
        MESSAGE_MARKDOWN_DRAFTS[name],
      );
      expect(state.keys, name).toEqual(keys);
      expect(state.sent, name).toEqual([]);
    }
  });

  it('models the hazard: without the sentinel Android would capitalise the new line', async () => {
    const { ANTI_CAPITALIZATION_SENTINEL } = await loadContract();
    const { client, state } = simulatedComposer();
    await client.focusCurrent('[data-testid="composer-input"]');
    await client.fillFocused(
      '[data-testid="composer-input"]',
      'plain one',
      ANTI_CAPITALIZATION_SENTINEL,
    );
    await client.key('enter');
    await client.device.runFlow(FLOW, {
      APP_ID: 'eu.qwky.trinity',
      SECRET_TEXT: 'plain two',
    });
    expect(state.value).toBe('plain one\nPlain two');
  });

  it('models the hazard: an x-sentinel first line autocorrects and keeps a stray x', async () => {
    const { client, state } = simulatedComposer();
    await client.focusCurrent('[data-testid="composer-input"]');
    await client.fillFocused('[data-testid="composer-input"]', 'plain one');
    expect(state.value).toBe('xplain one');
  });

  it('types every first line behind the digit sentinel', async () => {
    const { ANTI_CAPITALIZATION_SENTINEL, MESSAGE_MARKDOWN_DRAFTS } =
      await loadContract();
    const { enterNativeDraft } = await loadJourneys();
    const { client } = simulatedComposer();
    const sentinels = [];
    const fill = client.fillFocused;
    client.fillFocused = (selector, value, sentinel) => {
      sentinels.push(sentinel);
      return fill(selector, value, sentinel);
    };
    const drafts = Object.values(MESSAGE_MARKDOWN_DRAFTS);
    for (const draft of drafts) {
      await enterNativeDraft(await simulatedContext(client), draft);
    }
    expect(sentinels).toEqual(drafts.map(() => ANTI_CAPITALIZATION_SENTINEL));
  });

  it('uses a digit sentinel, which Gboard neither capitalises nor autocorrects', async () => {
    const { ANTI_CAPITALIZATION_SENTINEL } = await loadContract();
    // On the emulator `x` joined `plain` into a word Gboard corrected to `Explain`.
    expect(ANTI_CAPITALIZATION_SENTINEL).toBe('1');
  });

  it('fails a draft whose line break never arrives, is not a real newline, or loses the task continuation', async () => {
    const { MESSAGE_MARKDOWN_DRAFTS } = await loadContract();
    const { enterNativeDraft } = await loadJourneys();
    for (const [options, draft] of [
      [{ lineBreak: false }, MESSAGE_MARKDOWN_DRAFTS.plain],
      [{ lineBreak: false }, MESSAGE_MARKDOWN_DRAFTS.code],
      [{ continuation: false }, MESSAGE_MARKDOWN_DRAFTS.task],
    ]) {
      const { client } = simulatedComposer(options);
      await expect(
        enterNativeDraft(await simulatedContext(client), draft),
      ).rejects.toThrow();
    }
  });

  it('records composer-send readiness only for the exact enabled draft, then taps Send with the keyboard dismissed', async () => {
    const { MESSAGE_MARKDOWN_DRAFTS } = await loadContract();
    const { sendDraft } = await loadJourneys();
    const { client, state } = simulatedComposer();
    const written = [];
    client.record = async (name, value) => written.push({ name, value });
    const context = await simulatedContext(client);
    context.records.push('message-markdown.formatting.room-ready');
    await sendDraft(context, MESSAGE_MARKDOWN_DRAFTS.plain, 'plain-send-ready');
    expect(context.records.slice(-2)).toEqual([
      'message-markdown.formatting.plain-send-ready',
      'message-markdown.formatting.plain-send-enabled',
    ]);
    expect(state.sent).toEqual(['plain one\nplain two']);
    expect(state.keys.slice(-2)).toEqual(['hide-keyboard', 'tap-send']);
    expect(written.map((entry) => entry.name)).toContain(
      'message-markdown.formatting.plain-send-ready',
    );
    for (const options of [{ sendDisabled: true }, { sendClears: false }]) {
      const failing = simulatedComposer(options);
      const failingContext = await simulatedContext(failing.client);
      failingContext.records.push('message-markdown.formatting.room-ready');
      await expect(
        sendDraft(
          failingContext,
          MESSAGE_MARKDOWN_DRAFTS.plain,
          'plain-send-ready',
        ),
      ).rejects.toThrow();
      if (options.sendDisabled) {
        expect(failing.state.sent).toEqual([]);
        expect(failingContext.records).toHaveLength(1);
      }
    }
  });

  it('sends the task draft under its bare send-ready suffix', async () => {
    const { MESSAGE_MARKDOWN_DRAFTS } = await loadContract();
    const { sendDraft } = await loadJourneys();
    const { client, state } = simulatedComposer();
    const context = await simulatedContext(client, 1);
    context.records.push('message-markdown.task-list.room-ready');
    await sendDraft(context, MESSAGE_MARKDOWN_DRAFTS.task, 'send-ready');
    expect(context.records.slice(-2)).toEqual([
      'message-markdown.task-list.send-ready',
      'message-markdown.task-list.send-enabled',
    ]);
    expect(state.sent).toEqual(['- [x] shipped\n- [ ] pending']);
  });

  it('rejects wrong, capitalised, CRLF, unfocused or mid-draft composer values', async () => {
    const { MESSAGE_MARKDOWN_DRAFTS, assertSendReady, parseComposer } =
      await loadContract();
    const draft = MESSAGE_MARKDOWN_DRAFTS.plain;
    const valid = {
      count: 1,
      visible: true,
      focused: true,
      value: draft.value,
      placeholder: 'Message #Markdown run',
      selectionStart: draft.value.length,
      selectionEnd: draft.value.length,
      sendCount: 1,
      sendDisabled: false,
      href: PLAIN_ROUTE,
    };
    expect(() => assertSendReady(parseComposer(valid), draft)).not.toThrow();
    for (const change of [
      { value: 'plain one plain two' },
      { value: 'plain one\nPlain two' },
      { value: 'plain one\r\nplain two' },
      { value: 'Plain one\nplain two' },
      { value: 'plain one\n\nplain two' },
      { focused: false },
      { selectionStart: 3 },
      { selectionEnd: 3 },
      { sendDisabled: true },
      { sendCount: 0 },
      { sendCount: 2 },
      { count: 2 },
    ])
      expect(() =>
        assertSendReady(parseComposer({ ...valid, ...change }), draft),
      ).toThrow();
    for (const malformed of [
      null,
      { ...valid, count: -1 },
      { ...valid, focused: 'yes' },
      { ...valid, sendDisabled: 'no' },
      { ...valid, href: undefined },
    ])
      expect(() => parseComposer(malformed)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Authoritative server events                                               */
/* ------------------------------------------------------------------------ */

const ROOM = '!Room-AbC:example.test';
const SENDER = '@md:example.test';
const PLAIN_ID = '$Plain_A+b/C=d';
const RICH_ID = '$Rich_E+f/G=h';
const plainEvent = () => ({
  event_id: PLAIN_ID,
  room_id: ROOM,
  sender: SENDER,
  type: 'm.room.message',
  content: {
    msgtype: 'm.text',
    body: 'plain one\nplain two',
    'm.mentions': {},
  },
});
const richEvent = () => ({
  event_id: RICH_ID,
  room_id: ROOM,
  sender: SENDER,
  type: 'm.room.message',
  content: {
    msgtype: 'm.text',
    body: '**bold one**\nrich two',
    format: 'org.matrix.custom.html',
    formatted_body: '<p><strong>bold one</strong><br>rich two</p>\n',
    'm.mentions': {},
  },
});
const messagesPage = (...events) => ({
  chunk: [
    ...[...events].reverse(),
    { type: 'm.room.member', event_id: '$member', content: {} },
    { type: 'm.room.create', event_id: '$create', content: {} },
  ],
});

describe('Android message-markdown authoritative wire contract', () => {
  it('reads the room like lines 29–47: m.room.message only, oldest first', async () => {
    const { authoritativeRoomMessages } = await loadContract();
    const events = authoritativeRoomMessages(
      messagesPage(plainEvent(), richEvent()),
    );
    expect(events.map((event) => event.event_id)).toEqual([PLAIN_ID, RICH_ID]);
    for (const malformed of [null, {}, { chunk: {} }, { chunk: [null] }])
      expect(() => authoritativeRoomMessages(malformed)).toThrow();
    const fixtures = read('e2e/android/account-workspace-fixtures.mts');
    expect(fixtures).toContain(
      '`/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`',
    );
  });

  it('requires the plain-versus-formatted distinction, exact break, bold and source', async () => {
    const contract = await loadContract();
    const expectation = [
      { eventId: PLAIN_ID, roomId: ROOM, sender: SENDER },
      { eventId: RICH_ID, roomId: ROOM, sender: SENDER },
    ];
    const checks = (events) => {
      const wire = contract.assertFormattingEvents(events, ...expectation);
      contract.assertPlainBody(wire.plain);
      contract.assertPlainNoFormat(wire.plain);
      contract.assertPlainNoFormattedBody(wire.plain);
      contract.assertFormattedFormat(wire.formatted);
      contract.assertFormattedBreak(wire.formatted);
      contract.assertFormattedBold(wire.formatted);
      contract.assertFormattedSource(wire.formatted);
    };
    expect(() => checks([plainEvent(), richEvent()])).not.toThrow();
    const plain = (content) => {
      const event = plainEvent();
      Object.assign(event.content, content);
      return [event, richEvent()];
    };
    const rich = (content) => {
      const event = richEvent();
      Object.assign(event.content, content);
      return [plainEvent(), event];
    };
    const dropped = (key) => {
      const event = richEvent();
      delete event.content[key];
      return [plainEvent(), event];
    };
    for (const events of [
      [plainEvent()],
      [plainEvent(), richEvent(), plainEvent()],
      [richEvent(), plainEvent()],
      [{ ...plainEvent(), event_id: '~!room:txn' }, richEvent()],
      [plainEvent(), { ...richEvent(), sender: '@other:example.test' }],
      [plainEvent(), { ...richEvent(), room_id: '!other:example.test' }],
      // The plain message was promoted to HTML just because of its newline.
      plain({
        format: 'org.matrix.custom.html',
        formatted_body: '<p>plain one<br>plain two</p>',
      }),
      plain({ formatted_body: 'plain one<br>plain two' }),
      plain({ format: 'org.matrix.custom.html' }),
      plain({ body: 'plain one plain two' }),
      plain({ body: 'Plain one\nplain two' }),
      plain({ 'm.relates_to': { rel_type: 'm.replace', event_id: '$x' } }),
      // The formatted message lost its break, bold run, format or source.
      rich({ formatted_body: '<p><strong>bold one</strong> rich two</p>' }),
      rich({ formatted_body: '<p><strong>bold one</strong><br/>rich two</p>' }),
      rich({
        formatted_body: '<p><strong>bold one</strong><br><br>rich two</p>',
      }),
      rich({ formatted_body: '<p><b>bold one</b><br>rich two</p>' }),
      rich({ formatted_body: '<p><strong>bold</strong> one<br>rich two</p>' }),
      rich({ format: 'org.matrix.custom.markdown' }),
      rich({ body: 'bold one\nrich two' }),
      rich({ body: '**bold one** rich two' }),
      rich({ msgtype: 'm.notice' }),
      dropped('format'),
      dropped('formatted_body'),
    ])
      expect(() => checks(events)).toThrow();
  });

  it('requires ready task, lead and code events with the exact sources', async () => {
    const contract = await loadContract();
    const expected = { eventId: '$Task', roomId: ROOM, sender: SENDER };
    const task = {
      event_id: '$Task',
      room_id: ROOM,
      sender: SENDER,
      type: 'm.room.message',
      content: {
        msgtype: 'm.text',
        body: '- [x] shipped\n- [ ] pending',
        format: 'org.matrix.custom.html',
        formatted_body: '<ul>\n<li>☑ shipped</li>\n<li>☐ pending</li>\n</ul>\n',
      },
    };
    expect(() => contract.assertTaskEvent(task, expected)).not.toThrow();
    for (const content of [
      { body: '- [x] shipped\npending' },
      { body: '- [x] shipped\n- [ ] - [ ] pending' },
      {
        formatted_body:
          '<ul><li><input type="checkbox" checked> shipped</li></ul>',
      },
      { formatted_body: '<ul><li>shipped</li><li>pending</li></ul>' },
    ])
      expect(() =>
        contract.assertTaskEvent(
          { ...task, content: { ...task.content, ...content } },
          expected,
        ),
      ).toThrow();
    expect(() =>
      contract.assertTaskEvent({ ...task, event_id: '~pending' }, expected),
    ).toThrow();
    const lead = {
      ...task,
      event_id: '$Lead',
      content: { msgtype: 'm.text', body: 'setting up' },
    };
    const leadExpected = { ...expected, eventId: '$Lead' };
    expect(() => contract.assertLeadEvent(lead, leadExpected)).not.toThrow();
    for (const content of [
      { msgtype: 'm.text', body: 'Setting up' },
      {
        msgtype: 'm.text',
        body: 'setting up',
        format: 'org.matrix.custom.html',
        formatted_body: '<p>setting up</p>',
      },
    ])
      expect(() =>
        contract.assertLeadEvent({ ...lead, content }, leadExpected),
      ).toThrow();
    const code = {
      ...task,
      event_id: '$Code',
      content: {
        msgtype: 'm.text',
        body: '```python\nx = 1\n```',
        format: 'org.matrix.custom.html',
        formatted_body:
          '<pre><code class="language-python">x = 1\n</code></pre>\n',
      },
    };
    const codeExpected = { ...expected, eventId: '$Code' };
    expect(() => contract.assertCodeEvent(code, codeExpected)).not.toThrow();
    for (const content of [
      { body: '```python\nX = 1\n```' },
      { formatted_body: '<pre><code>x = 1\n</code></pre>' },
      { formatted_body: '<pre><code class="language-js">x = 1\n</code></pre>' },
      { format: undefined },
    ])
      expect(() =>
        contract.assertCodeEvent(
          { ...code, content: { ...code.content, ...content } },
          codeExpected,
        ),
      ).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Read-only renderer expressions against production-shaped markup (jsdom)   */
/* ------------------------------------------------------------------------ */

const CODE_ID = '$Code_I+j/K=l';
const LEAD_ID = '$Lead_M+n/O=p';
const TASK_ID = '$Task_Q+r/S=t';

const plainRow = (id = PLAIN_ID, cls = '') =>
  `<div class="msg ${cls}" data-mid="${id}"><trn-avatar class="msg__avatar"></trn-avatar><div class="msg__body"><div class="msg__content"><p class="msg__text">plain one\nplain two</p></div></div></div>`;
const richRow = (
  inner = '<p><strong>bold one</strong><br>rich two</p>',
  id = RICH_ID,
) =>
  `<div class="msg msg--cont" data-mid="${id}"><span class="msg__gutter">12:00</span><div class="msg__body"><div class="msg__content"><div class="msg__text msg__text--html">${inner}</div></div></div></div>`;
const taskRow = (
  inner = '<ul><li class="mx-task">☑ shipped</li><li class="mx-task">☐ pending</li></ul>',
  id = TASK_ID,
) =>
  `<div class="msg" data-mid="${id}"><trn-avatar class="msg__avatar"></trn-avatar><div class="msg__body"><div class="msg__content"><div class="msg__text msg__text--html">${inner}</div></div></div></div>`;
const leadRow = (id = LEAD_ID) =>
  `<div class="msg" data-mid="${id}"><trn-avatar class="msg__avatar"></trn-avatar><div class="msg__body"><div class="msg__content"><p class="msg__text">setting up</p></div></div></div>`;
const codeRow = ({
  id = CODE_ID,
  cls = 'msg--cont',
  language = 'python',
  toolbar = '',
} = {}) =>
  `<div class="msg ${cls}" data-mid="${id}"><span class="msg__padding-touch" aria-hidden="true"></span><span class="msg__gutter">12:01</span><div class="msg__body"><div class="msg__content"><div class="msg__text msg__text--html"><pre${language === null ? '' : ` language="${language}"`}><code class="language-python"><span class="hljs-attr">x</span> = <span class="hljs-number">1</span>\n</code></pre></div></div></div>${toolbar}</div>`;
const eventRow =
  '<div class="msg msg--event" data-mid="$create"><span class="msg__event-text">created the room</span></div>';

/** Run one exact observer expression with only `document` in scope. */
function evaluateIn(body, expression, styles = {}) {
  const dom = new JSDOM(`<main>${body}</main>`, { url: PLAIN_ROUTE });
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = /width:\s*0|display:\s*none/u.test(
      this.getAttribute('style') ?? '',
    );
    return { width: hidden ? 0 : 120, height: hidden ? 0 : 20 };
  };
  window.matchMedia = (query) => ({ matches: query === '(hover: none)' });
  const computed = window.getComputedStyle.bind(window);
  // The production stylesheet's relevant rules: plain text keeps pre-wrap, and a
  // `pre[language]` caption is generated from the attribute.
  window.getComputedStyle = (element, pseudo) => {
    if (pseudo === '::after') {
      const language = element.getAttribute('language');
      return {
        content:
          styles.caption ?? (language === null ? 'none' : `"${language}"`),
        opacity: '1',
        display: 'block',
      };
    }
    const style = computed(element);
    return {
      visibility:
        element.closest('[style*="visibility:hidden"]') !== null
          ? 'hidden'
          : 'visible',
      whiteSpace:
        styles.whiteSpace ??
        (element.matches('.msg__text:not(.msg__text--html)')
          ? 'pre-wrap'
          : style.whiteSpace || 'normal'),
    };
  };
  const focus = window.document.querySelector('textarea');
  if (focus) focus.focus();
  // Runtime.evaluate returnByValue hands the journey a JSON copy of the value.
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

const scroll = (...rows) => `<div class="scroll">${rows.join('')}</div>`;

describe('Android message-markdown read-only renderer observation (jsdom)', () => {
  it('observes the plain row, bold run and one real break in production markup', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const observe = (body, styles) =>
      contract.parseTimeline(evaluateIn(body, timelineExpression(), styles));
    const production = observe(scroll(eventRow, plainRow(), richRow()));
    expect(() => contract.assertPlainRow(production)).not.toThrow();
    const rich = contract.assertRichVisible(production);
    expect(() => contract.assertBoldRun(rich)).not.toThrow();
    expect(() => contract.assertOneBreak(rich)).not.toThrow();
    expect(contract.assertServerEcho(production, 'plain one').id).toBe(
      PLAIN_ID,
    );
    // The plain row became HTML, lost pre-wrap or its newline, or doubled.
    for (const timeline of [
      observe(
        scroll(richRow('<p>plain one<br>plain two</p>', PLAIN_ID), richRow()),
      ),
      observe(scroll(plainRow(), richRow()), { whiteSpace: 'normal' }),
      // Same text, pre-wrap and no <br>, but rendered as HTML.
      observe(scroll(richRow('plain one\nplain two', PLAIN_ID), richRow()), {
        whiteSpace: 'pre-wrap',
      }),
      observe(scroll(plainRow().replace('\n', ' '), richRow())),
      observe(scroll(plainRow(), plainRow('$Other'), richRow())),
      observe(
        scroll(
          plainRow().replace(
            'class="msg ',
            'style="visibility:hidden" class="msg ',
          ),
          richRow(),
        ),
      ),
    ])
      expect(() => contract.assertPlainRow(timeline)).toThrow();
    // The rich row lost its bold run or break, or a wrapped line faked one.
    for (const inner of [
      '<p>bold one<br>rich two</p>',
      '<p><strong>bold one</strong><strong>x</strong><br>rich two</p>',
      '<p><strong>bold</strong> one<br>rich two</p>',
    ]) {
      const timeline = observe(scroll(plainRow(), richRow(inner)));
      expect(() =>
        contract.assertBoldRun(contract.assertRichVisible(timeline)),
      ).toThrow();
    }
    for (const inner of [
      '<p><strong>bold one</strong> rich two</p>',
      '<p><strong>bold one</strong><br><br>rich two</p>',
      '<p><strong>bold one</strong></p><p>rich two</p>',
    ]) {
      const timeline = observe(scroll(plainRow(), richRow(inner)));
      expect(() =>
        contract.assertOneBreak(contract.assertRichVisible(timeline)),
      ).toThrow();
    }
    expect(() =>
      contract.assertRichVisible(
        observe(
          scroll(
            plainRow(),
            plainRow(RICH_ID).replace(
              'plain one\nplain two',
              'bold one rich two',
            ),
          ),
        ),
      ),
    ).toThrow();
    // A local echo is never a server echo.
    expect(() =>
      contract.assertServerEcho(
        observe(scroll(plainRow('~!room:txn1'), richRow())),
        'plain one',
      ),
    ).toThrow();
  });

  it('observes exact task glyphs and rejects dropped, swapped or interactive boxes', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const observe = (inner) =>
      contract.parseTimeline(
        evaluateIn(scroll(taskRow(inner)), timelineExpression()),
      );
    const production = observe();
    const list = contract.assertTaskListVisible(production);
    expect(() => contract.assertCheckedGlyph(list)).not.toThrow();
    expect(() => contract.assertUncheckedGlyph(list)).not.toThrow();
    expect(() => contract.assertNoCheckboxInput(list)).not.toThrow();
    const failing = (inner, check) =>
      expect(() =>
        check(contract.assertTaskListVisible(observe(inner))),
      ).toThrow();
    failing(
      '<ul><li>shipped</li><li>☐ pending</li></ul>',
      contract.assertCheckedGlyph,
    );
    failing(
      '<ul><li>☐ shipped</li><li>☐ pending</li></ul>',
      contract.assertCheckedGlyph,
    );
    failing(
      '<ul><li>☑ shipped</li><li>☑ pending</li></ul>',
      contract.assertUncheckedGlyph,
    );
    failing(
      '<ul><li>☑ shipped</li><li>pending</li></ul>',
      contract.assertUncheckedGlyph,
    );
    failing(
      '<ul><li>☑ shipped<ul><li>☐ pending</li></ul></li></ul>',
      contract.assertUncheckedGlyph,
    );
    failing(
      '<ul><li><input type="checkbox" checked disabled> shipped</li><li>☐ pending</li></ul>',
      contract.assertNoCheckboxInput,
    );
    failing(
      '<ul><li>☑ shipped<input readonly></li><li>☐ pending</li></ul>',
      contract.assertNoCheckboxInput,
    );
    failing(
      '<ul><li><span role="checkbox" aria-checked="true">☑</span> shipped</li><li>☐ pending</li></ul>',
      contract.assertNoCheckboxInput,
    );
    expect(() =>
      contract.assertTaskListVisible(
        contract.parseTimeline(
          evaluateIn(
            scroll(
              taskRow().replace(
                'class="msg"',
                'style="visibility:hidden" class="msg"',
              ),
            ),
            timelineExpression(),
          ),
        ),
      ),
    ).toThrow();
  });

  it('observes a ready continuation code row, its caption and no toolbar', async () => {
    const contract = await loadContract();
    const { timelineExpression } = await loadObserver();
    const observe = (body, styles) =>
      contract.parseTimeline(evaluateIn(body, timelineExpression(), styles));
    const production = observe(scroll(eventRow, leadRow(), codeRow()));
    const code = contract.assertCodeVisible(production);
    expect(code.row.id).toBe(CODE_ID);
    const row = contract.assertContinuationRow(production, CODE_ID, LEAD_ID);
    expect(() => contract.assertNoHoverToolbar(row)).not.toThrow();
    expect(() => contract.assertLanguageCaption(code.pre)).not.toThrow();
    expect(production.toolbarCount).toBe(0);
    expect(production.hoverNone).toBe(true);
    // Not a continuation, not ready, not after the lead, or two blocks.
    for (const [body, codeId] of [
      [scroll(leadRow(), codeRow({ cls: '' })), CODE_ID],
      [scroll(leadRow(), codeRow({ id: '~!room:txn2' })), '~!room:txn2'],
      [
        scroll(leadRow(), plainRow('$Between', 'msg--cont'), codeRow()),
        CODE_ID,
      ],
      [scroll(codeRow(), leadRow()), CODE_ID],
    ])
      expect(() =>
        contract.assertContinuationRow(observe(body), codeId, LEAD_ID),
      ).toThrow();
    expect(() =>
      contract.assertCodeVisible(
        observe(scroll(leadRow(), codeRow(), codeRow({ id: '$Two' }))),
      ),
    ).toThrow();
    // The desktop hover toolbar is painted on the row.
    const withToolbar = observe(
      scroll(
        leadRow(),
        codeRow({
          toolbar:
            '<trn-message-toolbar class="msg__toolbar"></trn-message-toolbar>',
        }),
      ),
    );
    expect(() =>
      contract.assertNoHoverToolbar(
        contract.assertContinuationRow(withToolbar, CODE_ID, LEAD_ID),
      ),
    ).toThrow();
    // The caption is missing, generic, or another language.
    for (const [options, styles] of [
      [{ language: null }, {}],
      [{ language: 'js' }, {}],
      [{}, { caption: 'none' }],
      [{}, { caption: 'attr(language)' }],
      [{}, { caption: '"python3"' }],
    ])
      expect(() =>
        contract.assertLanguageCaption(
          contract.assertCodeVisible(
            observe(scroll(leadRow(), codeRow(options)), styles),
          ).pre,
        ),
      ).toThrow();
  });

  it('observes the native composer and its send control without touching them', async () => {
    const contract = await loadContract();
    const { composerExpression } = await loadObserver();
    const composer = (value, disabled = false) =>
      `<textarea data-testid="composer-input" placeholder="Message #Markdown run">${value}</textarea><button data-testid="composer-send"${disabled ? ' disabled' : ''}></button>`;
    const observed = contract.parseComposer(
      evaluateIn(composer('plain one\nplain two'), composerExpression()),
    );
    expect(observed).toMatchObject({
      count: 1,
      visible: true,
      focused: true,
      value: 'plain one\nplain two',
      sendCount: 1,
      sendDisabled: false,
      href: PLAIN_ROUTE,
    });
    expect(
      contract.parseComposer(
        evaluateIn(composer('', true), composerExpression()),
      ).sendDisabled,
    ).toBe(true);
  });

  it('parses only complete renderer observations', async () => {
    const { parseTimeline } = await loadContract();
    const valid = {
      hoverNone: true,
      toolbarCount: 0,
      rows: [
        {
          id: '$x',
          event: false,
          continuation: false,
          visible: true,
          text: 'x',
          toolbarCount: 0,
          texts: [],
        },
      ],
    };
    expect(parseTimeline(valid).rows).toHaveLength(1);
    for (const invalid of [
      null,
      { ...valid, rows: {} },
      { ...valid, toolbarCount: -1 },
      { ...valid, rows: [{ ...valid.rows[0], id: 1 }] },
      { ...valid, rows: [{ ...valid.rows[0], texts: [{ html: true }] }] },
    ])
      expect(() => parseTimeline(invalid)).toThrow();
  });

  it('proves the action sheet exactly as the message-forward suite does', async () => {
    const { assertNativeSheetReady, assertSheetVisible } = await loadContract();
    const forward = read('e2e/android/message-forward-contract.mts');
    const body = (source) =>
      source
        .slice(source.indexOf('export function assertNativeSheetReady('))
        .split('\n}\n')[0]
        .split('\n')
        .filter((line) => line.trim().startsWith('assert'))
        .join('\n');
    expect(body(read(CONTRACT))).toBe(body(forward));
    const visible = { visible: true };
    expect(() => assertNativeSheetReady([visible], [visible])).not.toThrow();
    for (const [dialogs, actions] of [
      [[], [visible]],
      [[visible, visible], [visible]],
      [[{ visible: false }], [visible]],
      [[visible], []],
      [[visible], [{ visible: false }]],
    ])
      expect(() => assertNativeSheetReady(dialogs, actions)).toThrow();
    expect(() => assertSheetVisible([visible])).not.toThrow();
    for (const dialogs of [[], [{ visible: false }], [visible, visible]])
      expect(() => assertSheetVisible(dialogs)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Diagnostics safety                                                        */
/* ------------------------------------------------------------------------ */

const ARTIFACT_IDS = {
  run: 'trn-md-formatting-0a1b2cmd',
  account: {
    userId: '@trn_md_formatting_0a1b2c:localhost',
    username: 'trn_md_formatting_0a1b2c',
    password: 'md-pass"word\\token',
  },
  room: {
    id: '!Room_Ab+c/d:localhost',
    name: 'Markdown trn-md-formatting-0a1b2cmd',
  },
  eventIds: [PLAIN_ID, RICH_ID],
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

describe('Android message-markdown diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read(JOURNEYS);
    const current = recordProofViolations(journey);
    // 21 stage-body records plus the Room, two send and server-echo helpers.
    expect(current.records).toBe(25);
    expect(current.violations).toEqual([]);
    for (const [from, to] of [
      ['() => assertPlainBody(wire.plain)', '() => {}'],
      ['() => assertLanguageCaption(pre)', '() => void pre'],
      ['() => assertSendReady(ready, draft)', 'undefined'],
    ]) {
      expect(journey).toContain(from);
      expect(
        recordProofViolations(journey.replace(from, to)).violations,
      ).toHaveLength(1);
    }
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_MARKDOWN_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_MARKDOWN_STAGES[2],
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
      name: 'message-markdown.code-caption.room-ready',
      value: {
        assertion: 'message-markdown.code-caption.room-ready',
        observation: { ready: true },
      },
    });
    await expect(
      record(
        context,
        'lead-send-ready',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    await expect(record(context, 'room-ready', () => {}, {})).rejects.toThrow();
    await expect(
      record(context, 'sheet-visible', () => {}, {}),
    ).rejects.toThrow();
    await expect(record(context, 'plain-body', () => {}, {})).rejects.toThrow();
    expect(written).toHaveLength(1);
    await receipt(context, 'lead-server-event', { ok: true });
    expect(written.at(-1).name).toBe('receipt-01-lead-server-event');
    for (const name of ['message-markdown.code-caption.room-ready', 'Lead', ''])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messageMarkdownSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageMarkdownSecrets('formatting', ARTIFACT_IDS);
    const segment = Buffer.from(ARTIFACT_IDS.room.id).toString('base64url');
    const failure = new AssertionError({
      actual: `/rooms/${segment}?account=${encodeURIComponent(ARTIFACT_IDS.account.userId)}`,
      expected: `/rooms/${ARTIFACT_IDS.room.id}`,
      operator: 'strictEqual',
      message: 'Native navigation reached the exact Room',
    });
    const leaked = new Error(
      `Timed out on ${PLAIN_ID} in ${ARTIFACT_IDS.room.name}`,
    );
    const error = redactStageFailure(
      'formatting',
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain(
      'Android message-markdown formatting failed',
    );
    expect(error.message).toContain('Native navigation reached the exact Room');
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ARTIFACT_IDS.room.id,
      segment,
      PLAIN_ID,
      ARTIFACT_IDS.room.name,
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
      'Message-markdown cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardMessageMarkdownCleanup } = await loadJourneys();
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
    const guarded = guardMessageMarkdownCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ARTIFACT_IDS.room.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-markdown cleanup failed: Room cleanup (Error)',
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

  it('registers every identifier form per stage, never the bare server name', async () => {
    const { messageMarkdownSecrets } = await loadArtifacts();
    const secrets = messageMarkdownSecrets('formatting', ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_MARKDOWN_FORMATTING_'),
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
      PLAIN_ID,
      encodeURIComponent(PLAIN_ID),
      RICH_ID,
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(messageMarkdownSecrets('task-list', { run: 'trn-md-tl' })),
    ).toEqual(['SECRET_MARKDOWN_TASK_LIST_RUN']);
    expect(() => messageMarkdownSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messageMarkdownSecrets('formatting', { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
    const journey = read(JOURNEYS);
    for (const step of [
      'protect(context, { room: { name } });',
      'protect(context, { account });',
      'protect(context, { room: { id: room.id } });',
      'protect(context, { eventIds: [row.id] });',
      'protect(context, { eventIds: [leadId] });',
    ])
      expect(journey).toContain(step);
    expect(
      journey.indexOf('context.safety.unsafeSecrets = false;'),
    ).toBeGreaterThan(
      journey.indexOf('protect(context, { room: { id: room.id } });'),
    );
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier and credential', async () => {
    const { messageMarkdownSecrets, scanMessageMarkdownArtifacts } =
      await loadArtifacts();
    const secrets = messageMarkdownSecrets('formatting', ARTIFACT_IDS);
    await withOutput('trinity-markdown-scan-', async (output) => {
      await mkdir(join(output, 'formatting'));
      const receipt = join(output, 'formatting', 'receipt-01-plain-sent.json');
      for (const unsafe of [
        `GET /rooms/${ARTIFACT_IDS.room.id}/messages`,
        JSON.stringify({ password: ARTIFACT_IDS.account.password }),
        `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_IDS.room.id))}/event/${mixedCase(encodeURIComponent(PLAIN_ID))}`,
        `double=${encodeURIComponent(encodeURIComponent(ARTIFACT_IDS.room.id))}`,
        `route=/rooms/${Buffer.from(ARTIFACT_IDS.room.id).toString('base64url')}`,
        `slice=${ARTIFACT_IDS.room.id.slice(1)}`,
        `selector=.scroll .msg[data-mid="${RICH_ID}"]`,
        `name=${ARTIFACT_IDS.room.name}`,
        `run=${ARTIFACT_IDS.run}`,
        `account=${encodeURIComponent(ARTIFACT_IDS.account.userId)}`,
        'Authorization: Bearer unregistered-token',
        'token=syt_dW5yZWdpc3RlcmVk_abc',
        '<map><string name="CapacitorStorage.trinity">{}</string></map>',
        'pluginId: Preferences, methodName: get, methodData: {"key":"trinity.appearance.mode"}',
      ]) {
        await writeFile(receipt, unsafe);
        await expect(
          scanMessageMarkdownArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        receipt,
        '{"body":"plain one\\nplain two","server":"localhost"}\n',
      );
      await expect(
        scanMessageMarkdownArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of ['capture.png', 'capture.PNG', 'opaque.bin'])
        await withOutput('trinity-markdown-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(
            scanMessageMarkdownArtifacts(other, {}),
          ).rejects.toThrow();
        });
    });
  });

  it('scrubs raw and encoded identifiers, deletes rasters and then scans clean', async () => {
    const {
      messageMarkdownSecrets,
      scrubMessageMarkdownArtifacts,
      scanMessageMarkdownArtifacts,
    } = await loadArtifacts();
    const secrets = messageMarkdownSecrets('formatting', ARTIFACT_IDS);
    await withOutput('trinity-markdown-scrub-', async (output) => {
      const stage = join(output, 'formatting');
      await mkdir(stage);
      const path = join(stage, 'long-press-1.json');
      await writeFile(
        path,
        [
          `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_IDS.room.id))}/messages`,
          `selector=.scroll .msg[data-mid=${JSON.stringify(RICH_ID)}]`,
          JSON.stringify({ password: ARTIFACT_IDS.account.password }),
          `route=/rooms/${Buffer.from(ARTIFACT_IDS.room.id).toString('base64url')}`,
          'unchanged=plain one\\nplain two',
        ].join('\n'),
      );
      await writeFile(join(stage, 'passed.png'), 'raster');
      await scrubMessageMarkdownArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe(
        'unchanged=plain one\\nplain two',
      );
      for (const leaked of [ARTIFACT_IDS.room.id, RICH_ID, 'md-pass'])
        expect(scrubbed).not.toContain(leaked);
      expect(scrubbed).toContain('[REDACTED]');
      expect(existsSync(join(stage, 'passed.png'))).toBe(false);
      await expect(
        scanMessageMarkdownArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
    // The suite's own pass removes rasters even before any secret is registered.
    await withOutput('trinity-markdown-scrub-raster-', async (output) => {
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        await writeFile(join(output, name), 'raster');
      await scrubMessageMarkdownArtifacts(output, {});
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        expect(existsSync(join(output, name))).toBe(false);
      await expect(
        scanMessageMarkdownArtifacts(output, {}),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried three-stage 37-record run', async () => {
    const artifacts = await loadArtifacts();
    const { MESSAGE_MARKDOWN_STAGES } = await loadContract();
    const { PIXEL_5_ACCOUNT_PROFILE } = await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 3,
      expectedAssertionRecords: 37,
      attempt: 1,
      retries: 0,
      stages: MESSAGE_MARKDOWN_STAGES.map((entry) => ({
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
    await withOutput('trinity-markdown-gate-', async (output) => {
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
        for (const entry of MESSAGE_MARKDOWN_STAGES) {
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
          artifacts.markMessageMarkdownDiagnosticsSafe(
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
      await artifacts.markMessageMarkdownDiagnosticsSafe(
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
        mutate((value) => (value.stages[1].status = 'failed')),
        mutate((value) => (value.stages[2].retries = 1)),
        mutate((value) => (value.stages[0].failureCount = 1)),
        mutate((value) => {
          value.stages[0].assertions.pop();
          value.stages[0].assertionRecords = 15;
        }),
        mutate((value) => {
          value.stages[2].assertions[9] = value.stages[2].assertions[8];
        }),
        mutate((value) => value.stages.reverse()),
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
        join('task-list', 'profile-applied.json'),
        join('code-caption', 'passed-ui.json'),
        'runtime-provenance.json',
      ]) {
        await arrange();
        await rm(join(output, missing));
        await refused(report());
      }
      await arrange();
      await write(join('formatting', 'profile-applied.json'), {
        requested: { ...PIXEL_5_ACCOUNT_PROFILE, width: 1280 },
      });
      await refused(report());
      await arrange();
      await write('runtime-provenance.json', {
        ...provenance,
        profile: { ...provenance.profile, requested: { width: 393 } },
      });
      await refused(report());
      await arrange();
      await write(join('formatting', 'passed-surface.json'), {
        url: `https://localhost/rooms/${Buffer.from(ARTIFACT_IDS.room.id).toString('base64url')}`,
      });
      await refused(report(), {
        secrets: artifacts.messageMarkdownSecrets('formatting', ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, 'code-caption', 'passed.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const {
      runMessageMarkdownStageCleanup,
      revokeMessageMarkdownPublicationOnAbort,
    } = await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessageMarkdownStageCleanup(
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
    await withOutput('trinity-markdown-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [
          { status: 'passed', failureCount: 0 },
          { status: 'passed', failureCount: 0 },
        ],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageMarkdownPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageMarkdownPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-markdown publication',
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
  '--suite=android.message-markdown --timeout-ms=1800000 --entrypoint=e2e/android/message-markdown-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "5" ]; then echo \'message-markdown-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 2100000 -- pnpm exec nx run trinity-e2e-android:message-markdown; fi';
const GATE_PATH =
  "-path '*/android.message-markdown/message-markdown/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-markdown-started == 'true' && steps.message-markdown-artifact-gate.outputs.message-markdown-safe == 'true' }}";

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
  const target = project.targets['message-markdown'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-markdown']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-markdown',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(
    lines.filter((line) =>
      line.includes('trinity-e2e-android:message-markdown'),
    ),
  ).toHaveLength(1);
  expect(lines[runner - 1]).toContain("echo 'sso-recovery-reset-started=true'");
  expect(
    lines
      .filter((line) => line.startsWith('if [ "${{ matrix.shard }}" = "5" ]'))
      .at(-1),
  ).toBe(CI_LINE);
  const gate = workflow
    .split('      - name: Gate Android message-markdown diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-markdown-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-markdown-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain(
    'echo \'message-markdown-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-markdown\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-markdown/**',
  );
  expect(ciSpec).toContain('expect(uploads.length).toBe(75);');
  expect(ciSpec).toContain('expect(lines).toHaveLength(68);');
  expect(ciSpec).toContain("step.with.surface === 'android-message-markdown'");
  expect(ciSpec).toContain(
    'runs message-markdown after SSO recovery reset at the end of shard 5',
  );
}

describe('Android message-markdown hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-markdown',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-markdown',
      canonicalScript: 'e2e:android:message-markdown',
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
        (item) => item.name === 'e2e:android:message-markdown',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-markdown',
        command: 'nx run trinity-e2e-android:message-markdown',
        kind: 'canonical',
        suiteIds: ['android.message-markdown'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-markdown'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "5" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-markdown',
    );
    expect(read(JOURNEYS)).toContain('timeout: 1_500_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-markdown']);
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
            'message-markdown-journeys.mts',
            'message-linkify-journeys.mts',
          )),
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:message-markdown'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "5"', '= "2"')),
      withText('workflow', CI_LINE, CI_LINE.replace('2100000', '1200000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-markdown/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-markdown-started == 'true' }}",
      ),
      withText(
        'ciSpec',
        'expect(uploads.length).toBe(75);',
        'expect(uploads.length).toBe(74);',
      ),
      withText(
        'ciSpec',
        'expect(lines).toHaveLength(68);',
        'expect(lines).toHaveLength(67);',
      ),
    ])
      expect(() => assertWiring(mutated)).toThrow();
    // The runner moved before SSO recovery reset.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === CI_LINE);
    const [line] = lines.splice(index, 1);
    lines.splice(index - 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 37 identities with their source lines and the 20/17 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-Markdown journeys')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-markdown\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[4])).toEqual(ALL_IDENTITIES);
    const ledgerCell = (stage) =>
      ledgerTuples(stage).map((tuple) =>
        tuple[0] === 'direct'
          ? String(tuple[1])
          : tuple[4] === undefined
            ? `${tuple[1]}@${tuple[3]}`
            : `${tuple[1]}@${tuple[3]}#${tuple[4]}`,
      );
    expect(rows.map((row) => row[2].trim())).toEqual(
      STAGES.flatMap(ledgerCell),
    );
    expect(rows.map((row) => row[1])).toEqual(
      STAGES.flatMap((stage) => stage.suffixes.map(() => stage.id)),
    );
    expect(rows.map((row) => row[3])).toEqual(
      STAGES.flatMap((stage) => ledgerTuples(stage).map((tuple) => tuple[0])),
    );
    expect(section).toContain('20 direct + 17');
    expect(section).toContain('18/7/12');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-markdown`');
    expect(section).toContain('`return;` on line 224');
    expect(section).toContain('Enter inserts a line break on a mobile device');
    expect(section).toMatch(/remains enabled and untouched/u);
    expect(section).not.toContain('pnpm exec nx');
  });
});

/* ------------------------------------------------------------------------ */
/* Source rules: journeys, observer, artifacts and the append flow           */
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
  ['REST message seed', /sendMessage\(|\/send\/m\.room\.message/u],
  ['hover toolbar tail', /\.hover\(|mouseover|pointerenter/iu],
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
      if (called === 'readComposer' || called === 'readTimeline') {
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

const STAGE_FUNCTIONS = ['runFormatting', 'runTaskList', 'runCodeCaption'];

/** The per-stage native order and invariants required by the issue. */
function assertJourneyRules(journeys) {
  assertNoForbiddenTokens(journeys, JOURNEYS);
  assertReadOnlyObserver(journeys);
  assertBoundedWaits(journeys, JOURNEYS);
  expect(journeys).not.toMatch(/evaluateNative|webview\./u);
  expect(journeys).not.toMatch(/client\.(?:fill|replace|tap)\(/u);
  const stage = Object.fromEntries(
    STAGE_FUNCTIONS.map((name) => [name, functionSource(journeys, name)]),
  );
  for (const name of STAGE_FUNCTIONS)
    assertOrder(
      stage[name],
      [
        callOf('arrangeStage'),
        callOf('startNative'),
        /client\.login\(account\)/u,
        /client\.hideKeyboard\(\)/u,
        callOf('openRoom'),
      ],
      name,
    );
  assertOrder(
    stage.runFormatting,
    [
      /sendDraft\(context, MESSAGE_MARKDOWN_DRAFTS\.plain, 'plain-send-ready'\)/u,
      recordOf('plain-visible'),
      /sendDraft\(context, MESSAGE_MARKDOWN_DRAFTS\.rich, 'rich-send-ready'\)/u,
      recordOf('rich-visible'),
      recordOf('bold-run'),
      recordOf('one-break'),
      /serverEcho\(context, 'plain one', 'plain-server-echo'\)/u,
      /serverEcho\(context, 'rich two', 'rich-server-echo'\)/u,
      /fixtures\.roomMessages\(account, room\.id\)/u,
      callOf('assertFormattingEvents'),
      recordOf('plain-body'),
      recordOf('plain-no-format'),
      recordOf('plain-no-formatted-body'),
      recordOf('formatted-format'),
      recordOf('formatted-break'),
      recordOf('formatted-bold'),
      recordOf('formatted-source'),
    ],
    'runFormatting',
  );
  assertOrder(
    stage.runTaskList,
    [
      /sendDraft\(context, MESSAGE_MARKDOWN_DRAFTS\.task, 'send-ready'\)/u,
      recordOf('list-visible'),
      recordOf('checked-glyph'),
      recordOf('unchecked-glyph'),
      recordOf('no-checkbox-input'),
      /assertTaskEvent\(await fixtures\.roomEvent\(account, room\.id, row\.id\)/u,
    ],
    'runTaskList',
  );
  assertOrder(
    stage.runCodeCaption,
    [
      /sendDraft\(context, MESSAGE_MARKDOWN_DRAFTS\.lead, 'lead-send-ready'\)/u,
      callOf('assertLeadEvent'),
      /sendDraft\(context, MESSAGE_MARKDOWN_DRAFTS\.code, 'code-send-ready'\)/u,
      recordOf('code-visible'),
      /serverEcho\(context, 'x = 1', 'server-echo'\)/u,
      callOf('assertCodeEvent'),
      recordOf('continuation-row'),
      recordOf('no-hover-toolbar'),
      recordOf('language-caption'),
      /client\.hideKeyboard\(\)/u,
      /client\.longPressCurrent\('\.scroll \.msg\[data-mid\^="\$"\]', \{ text: 'x = 1' \}\)/u,
      /client\.waitElements\(SHEET/u,
      /client\.elements\(FORWARD\)/u,
      recordOf('sheet-ready'),
      recordOf('sheet-visible'),
    ],
    'runCodeCaption',
  );
  // No sheet action and no desktop tail is ever taken.
  expect(stage.runCodeCaption).not.toMatch(
    /tapCurrent\(|sheet-(?:reply|forward)"\]'\)/u,
  );
  expect(stage.runCodeCaption.match(/longPressCurrent\(/gu)).toHaveLength(1);
  // Native actions log their selectors to stdout, the published job log and
  // process.log, which the artifact scan does not cover: no selector may carry
  // a Room or event identifier.
  expect(journeys).not.toMatch(
    /data-mid(?:\^|\$|\*)?=(?:\$\{|"\$\{|\\?"\$\{)/u,
  );
  for (const call of journeys.matchAll(/client\.(?:\w+)\(([^;]*?)\);/gsu))
    expect(call[1], call[0]).not.toMatch(/\$\{[^}]*(?:Id|\.id)\b[^}]*\}/u);
  const enter = functionSource(journeys, 'enterNativeDraft');
  assertOrder(
    enter,
    [
      /client\.focusCurrent\(COMPOSER\)/u,
      /client\.fillFocused\(COMPOSER, draft\.first, ANTI_CAPITALIZATION_SENTINEL\)/u,
      /for \(const step of draft\.breaks\)/u,
      /client\.key\('enter'\)/u,
      /appendNativeLine\(client, step\.afterBreak, step\.typed\)/u,
    ],
    'enterNativeDraft',
  );
  const append = functionSource(journeys, 'appendNativeLine');
  assertOrder(
    append,
    [
      /needsSentinel\(line\)/u,
      /client\.device\.runFlow\(join\(client\.workspaceRoot, APPEND_FLOW\)/u,
      /client\.key\('arrowLeft'\)/u,
      /client\.key\('backspace'\)/u,
      /client\.keyCombination\('documentEnd'\)/u,
    ],
    'appendNativeLine',
  );
  expect(append).not.toMatch(/hideKeyboard|client\.key\('enter'\)/u);
  const send = functionSource(journeys, 'sendDraft');
  assertOrder(
    send,
    [
      callOf('enterNativeDraft'),
      /record\(context, suffix, \(\) => assertSendReady\(ready, draft\)/u,
      /client\.hideKeyboard\(\)/u,
      /record\(context, enabledSuffix, \(\) => assertSendEnabled\(enabled, draft\)/u,
      /client\.tapCurrent\('\[data-testid="composer-send"\]'\)/u,
      callOf('assertDraftSent'),
    ],
    'sendDraft',
  );
  // On a mobile device Enter is only a line break; the Send button sends.
  expect(send).not.toMatch(/client\.key\(/u);
  expect(journeys.match(/client\.key\('enter'\)/gu)).toHaveLength(1);
  expect(journeys.match(/composer-send/gu)).toHaveLength(1);
  expect(journeys).toContain(
    "const APPEND_FLOW = 'e2e/android/flows/message-markdown-append.yaml';",
  );
  const runner = functionSource(journeys, 'runMessageMarkdownSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /createAccountFixtures\(/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /MESSAGE_MARKDOWN_STAGES/u,
      /runMessageMarkdownStageCleanup\(/u,
      /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
    ],
    'runMessageMarkdownSuite',
  );
  for (const required of [
    'expectedStages: 3',
    'expectedAssertionRecords: 37',
    'attempt: 1',
    'retries: 0',
    'markMessageMarkdownDiagnosticsSafe(',
    'scrubMessageMarkdownArtifacts(',
    'revokeMessageMarkdownPublicationOnAbort(',
    "client.capture('passed')",
    "client.capture('failed')",
    'client.reset(PIXEL_5_ACCOUNT_PROFILE)',
    'profile: PIXEL_5_ACCOUNT_PROFILE',
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  ])
    expect(journeys).toContain(required);
}

describe('Android message-markdown source rules', () => {
  it('keeps the observer and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [OBSERVER, ARTIFACTS, CONTRACT]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    assertReadOnlyObserver(read(OBSERVER));
    expect(read(ARTIFACTS)).not.toMatch(
      /message-links-artifacts|message-linkify-artifacts/u,
    );
  });

  it('fails the forbidden-token and read-only rules under each effective mutation', () => {
    const observer = read(OBSERVER);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'input.value = "plain one"',
      "document.execCommand('insertText', false, 'x')",
      'element.dispatchEvent(new KeyboardEvent("keydown"))',
      'row.classList.add("msg--cont")',
      'pre.setAttribute("language", "python")',
      'pre.style.opacity = "1"',
      'window.location = "/rooms"',
      'await pre.hover()',
      'await fixtures.sendMessage(account, room.id, "plain one", "txn")',
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

  it('drives every product action natively in source order in each stage', () => {
    const journeys = read(JOURNEYS);
    assertJourneyRules(journeys);
    const replace = (from, to) => {
      expect(journeys).toMatch(from);
      return journeys.replace(from, to);
    };
    for (const mutated of [
      // REST seeding, DOM input or an extra send key.
      `${journeys}\nawait fixtures.sendMessage(account, room.id, 'plain one', 'txn');`,
      `${journeys}\nawait evaluateNative(client.webview, 'x');`,
      `${journeys}\nawait client.fill(COMPOSER, draft.value);`,
      `${journeys}\nawait client.key('enter');`,
      // The native line break is replaced or dropped.
      replace(/client\.key\('enter'\)/u, "client.key('space')"),
      replace(/await client\.key\('enter'\);\n/u, ''),
      // The Send tap is made under the keyboard, or replaced by Enter.
      replace(
        /await client\.hideKeyboard\(\);\n(\s*)const enabled/u,
        '$1const enabled',
      ),
      replace(
        /client\.tapCurrent\('\[data-testid="composer-send"\]'\)/u,
        "client.key('enter')",
      ),
      // The anti-capitalisation sentinel is no longer removed.
      replace(/await client\.key\('backspace'\);\n/u, ''),
      // The authoritative reader, a wire record or the continuation proof is lost.
      replace(
        /fixtures\.roomMessages\(account, room\.id\)/u,
        'fixtures.roomEvent(account, room.id, plainId)',
      ),
      replace(
        /record\(context, 'formatted-break'/u,
        "receipt(context, 'formatted-break'",
      ),
      replace(
        /record\(context, 'continuation-row'/u,
        "receipt(context, 'continuation-row'",
      ),
      // The sheet is proved before the long press, or an action is tapped.
      replace(/await client\.longPressCurrent\(/u, 'await client.tapCurrent('),
      `${journeys.replace(
        "await record(context, 'sheet-visible'",
        "await client.tapCurrent('[data-testid=\"sheet-forward\"]');\n  await record(context, 'sheet-visible'",
      )}`,
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });

  it('appends a line at the caret without erasing or dismissing the keyboard', () => {
    const flow = read(FLOW);
    expect(flow).toBe(
      [
        'appId: ${APP_ID}',
        '---',
        '# Append one Markdown line at the focused composer caret, after a native',
        '# Enter. It never erases and never calls hideKeyboard, which Maestro',
        '# implements as an unconditional Android Back.',
        '- inputText: ${SECRET_TEXT}',
        '',
      ].join('\n'),
    );
    const commands = flow.split('\n').filter((line) => line.startsWith('- '));
    expect(commands).toEqual(['- inputText: ${SECRET_TEXT}']);
    for (const forbidden of [
      '- hideKeyboard',
      '- eraseText',
      '- pressKey',
      '- back',
    ])
      expect(flow).not.toContain(forbidden);
    expect(existsSync(resolve(root, dirname(FLOW)))).toBe(true);
  });
});
